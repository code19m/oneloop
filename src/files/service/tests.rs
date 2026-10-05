use super::*;

#[tokio::test]
async fn image_decodes_run_one_at_a_time_and_survive_request_cancellation() {
    // A thumbnail decode holds the only permit, so an avatar upload waits.
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
