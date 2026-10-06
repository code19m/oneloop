use super::*;

#[tokio::test(start_paused = true)]
async fn image_decodes_run_one_at_a_time_and_survive_request_cancellation() {
    // A thumbnail decode holds the only permit, so avatar uploads wait.
    let held = IMAGE_DECODE_PERMITS.acquire().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let service = FileService::new(Db::open(root.path()).unwrap(), 1_000_000, 0);
    let actor = Actor {
        user_id: "test".into(),
        username: "test".into(),
        display_name: "Test".into(),
        is_admin: false,
        must_change_password: false,
        authenticated_at: 0,
        source: ActorSource::BrowserSession {
            session_id: "test".into(),
        },
    };
    let upload = || {
        let (service, actor) = (service.clone(), actor.clone());
        tokio::spawn(async move { service.upload_avatar(&actor, vec![1]).await })
    };
    let waiting = (0..4).map(|_| upload()).collect::<Vec<_>>();
    // Only a few wait; holding their images in memory, more are turned away.
    tokio::task::yield_now().await;
    assert!(matches!(
        upload().await.unwrap(),
        Err(AppError::Unavailable(_))
    ));
    // Those that wait outlast a slow decode, then decode their own image.
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    assert!(waiting.iter().all(|upload| !upload.is_finished()));
    drop(held);
    for upload in waiting {
        let result = upload.await.unwrap();
        assert!(
            matches!(result, Err(AppError::Validation { .. })),
            "{result:?}"
        );
    }
    // A decode that doesn't end turns an upload away after a while.
    let held = IMAGE_DECODE_PERMITS.acquire().await.unwrap();
    assert!(matches!(
        service.upload_avatar(&actor, vec![1]).await,
        Err(AppError::Unavailable(_))
    ));
    drop(held);

    let permit = avatar_decode_permit().await.unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            drop(_permit);
            done_tx.send(()).unwrap();
        })
        .await
        .unwrap();
    });
    started_rx.await.unwrap();
    request.abort();
    let _ = request.await;
    assert_eq!(IMAGE_DECODE_PERMITS.available_permits(), 0);
    release_tx.send(()).unwrap();
    done_rx.await.unwrap();
    assert_eq!(IMAGE_DECODE_PERMITS.available_permits(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_gets_the_data_lock_while_reconciliation_scans_for_orphans() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    let service = FileService::new(db.clone(), 1_000_000, 0);
    let stored = async |name: &[u8]| {
        let key = service.store.new_storage_key().unwrap();
        let path = service.store.prepare_file_parent(&key).await.unwrap();
        std::fs::write(&path, name).unwrap();
        (key, path)
    };
    // A stale pending upload goes early in the pass, so its file shows how far
    // the pass got. An orphan then waits for the gate, which this test holds.
    let (stale, stale_path) = stored(b"stale").await;
    db.transaction(move |tx| {
        tx.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
            VALUES('stale',?1,?2,5,'text/plain','pending',1)", params![stale, "0".repeat(64)])?;
        Ok(())
    })
    .await
    .unwrap();
    let (_, orphan_path) = stored(b"orphan").await;
    let gate = service.acquire_file_maintenance_gate().await.unwrap();
    let reconcile = tokio::spawn({
        let service = service.clone();
        async move { service.reconcile().await }
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while stale_path.exists() && std::time::Instant::now() < deadline {
        tokio::task::yield_now().await;
    }
    // A backup that starts now gets the data lock while the scan waits.
    let layout = db.layout().clone();
    let command = tokio::task::spawn_blocking(move || layout.open_exclusive_lock())
        .await
        .unwrap();
    assert!(command.is_ok(), "{:?}", command.err());
    drop(command);
    drop(gate);
    reconcile.await.unwrap().unwrap();
    assert!(!orphan_path.exists());
}

#[tokio::test]
async fn recovery_scan_does_not_lock_publication_and_rechecks_old_snapshots() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    let service = FileService::new(db.clone(), 1000000, 0);
    let key = service.store.new_storage_key().unwrap();
    let path = service.store.prepare_file_parent(&key).await.unwrap();
    std::fs::write(&path, b"x").unwrap();
    let candidates = unreferenced_files(service.store.layout().files(), HashSet::new())
        .await
        .unwrap();
    assert_eq!(candidates, vec![path.clone()]);
    db.transaction(move |tx| {
        tx.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
            VALUES('new-blob',?1,?2,1,'image/png','pending',unixepoch())",params![key,"0".repeat(64)])?;
        Ok(())
    }).await.unwrap();
    assert!(
        !service.remove_if_unreferenced(&path).await.unwrap(),
        "a stale snapshot cannot remove a published reference"
    );
    let gate = service.acquire_file_maintenance_gate().await.unwrap();
    let report = tokio::time::timeout(std::time::Duration::from_secs(2), service.reconcile())
        .await
        .expect("healthy scan must not wait for the publication gate")
        .unwrap();
    assert_eq!(report.orphan_files_removed, 0);
    assert!(path.exists());
    drop(gate);
}

#[tokio::test]
async fn the_purge_claim_keeps_files_restored_since_its_scan() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    let service = FileService::new(db.clone(), 1_000_000, 0);
    let window = crate::domain::UNDO_WINDOW_SECONDS;
    let deleted_at = unix_now().unwrap() - window - 1;
    db.transaction(move |tx| {
        tx.execute_batch(
            "INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                 VALUES('u','u','U','x',1,1,1);
             INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
             INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
             INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at)
                 VALUES('e','p','tr','Epic','2026-11-01',0,1,1);
             INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
                 VALUES('t','p','e',1,'ONE-1','Task','planning',0,1,1);",
        )?;
        tx.execute(
            "INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
             VALUES('b','key',?1,1,'text/plain','available',1)",
            ["0".repeat(64)],
        )?;
        tx.execute(
            "INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,position,
                                          created_at,last_accessed_at,updated_at,deleted_at)
             VALUES('a','p','t','b','a.txt','u',0,1,1,1,?1)",
            [deleted_at],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let candidates = service
        .deletion_candidates(unix_now().unwrap() - window)
        .await
        .unwrap();
    assert_eq!(candidates.len(), 1);
    // A restore commits between the scan and the claim.
    db.transaction(|tx| {
        tx.execute("UPDATE task_attachments SET deleted_at=NULL", [])?;
        Ok(())
    })
    .await
    .unwrap();
    service.claim_for_deletion(candidates).await.unwrap();
    let (state, jobs): (String, i64) = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT state FROM file_blobs WHERE id='b'),(SELECT count(*) FROM file_deletion_jobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!((state.as_str(), jobs), ("available", 0));
}

#[test]
fn text_inspection_preserves_utf8_across_every_chunk_boundary() {
    struct Chunks<'a> {
        bytes: &'a [u8],
        size: usize,
    }
    impl std::io::Read for Chunks<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let n = self.bytes.len().min(self.size).min(out.len());
            out[..n].copy_from_slice(&self.bytes[..n]);
            self.bytes = &self.bytes[n..];
            Ok(n)
        }
    }
    for size in 1..=8 {
        for bytes in ["aé世界👩‍💻\r\n\t\u{c}".as_bytes(), b"plain", b""] {
            assert!(detect::valid_text_reader(Chunks { bytes, size }).unwrap());
        }
        for bytes in [
            b"a\xe2\x82".as_slice(),
            b"a\xff",
            b"a\0",
            b"a\xe2X\x82",
            b"a\x7f\x01",
        ] {
            assert!(!detect::valid_text_reader(Chunks { bytes, size }).unwrap());
        }
    }
}
