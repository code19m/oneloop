use super::*;

#[test]
fn backup_validation_requires_every_available_blob_to_match_the_snapshot() {
    for replacement in [None, Some(&b"changed!"[..]), Some(&b"short"[..])] {
        let root = tempfile::tempdir_in("target").unwrap();
        let live = root.path().join("live");
        migration::migrate(&live, None).unwrap();
        fs::create_dir_all(live.join("files/aa")).unwrap();
        fs::write(live.join("files/aa/blob"), b"original").unwrap();
        let db = Connection::open(live.join("oneloop.sqlite3")).unwrap();
        db.execute(
            "INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
             VALUES('blob','aa/blob',?1,8,'text/plain','available',1)",
            [hex::encode(Sha256::digest(b"original"))],
        ).unwrap();
        drop(db);
        let backup = root.path().join("backup");
        create_backup(&live, &backup).unwrap();
        let mut manifest = validate_backup(&backup).unwrap();
        let path = backup.join("data/files/aa/blob");
        manifest
            .files
            .retain(|entry| entry.path != "data/files/aa/blob");
        if let Some(bytes) = replacement {
            fs::write(&path, bytes).unwrap();
            manifest.files.push(manifest_entry(&backup, &path).unwrap());
            manifest.files.sort_by(|a, b| a.path.cmp(&b.path));
        } else {
            fs::remove_file(&path).unwrap();
        }
        fs::remove_file(backup.join(MANIFEST_FILE)).unwrap();
        write_manifest(&backup, &manifest).unwrap();
        let error = validate_backup(&backup).unwrap_err().to_string();
        assert!(error.contains("aa/blob"), "{error}");
        let restored = root.path().join("restored");
        assert!(restore_backup(&backup, &restored).is_err());
        assert!(!restored.join("oneloop.sqlite3").exists());
    }
}

#[test]
fn backup_requires_the_knowledge_key_only_when_credentials_exist() {
    for credential in ["token", "deploy key"] {
        let root = tempfile::tempdir_in("target").unwrap();
        let live = root.path().join("live");
        migration::migrate(&live, None).unwrap();
        fs::remove_dir(live.join("keys")).unwrap();
        create_backup(&live, root.path().join("keyless")).unwrap();
        let db = Connection::open(live.join("oneloop.sqlite3")).unwrap();
        db.execute_batch(
            "INSERT INTO projects(id,name,task_prefix,created_at,updated_at)
            VALUES('p','Project','P',1,1);",
        )
        .unwrap();
        if credential == "token" {
            db.execute_batch("INSERT INTO knowledge_sources(project_id,url,branch,folder,token_ciphertext,state,created_at,updated_at,generation)
                VALUES('p','https://example.com/repo','main','',X'01','pending',1,1,'g');").unwrap();
        } else {
            db.execute_batch("INSERT INTO knowledge_deploy_keys VALUES('p','public',X'01',1);")
                .unwrap();
        }
        drop(db);
        let destination = root.path().join("missing-key");
        let error = create_backup(&live, &destination).unwrap_err().to_string();
        assert!(error.contains("knowledge.key"), "{credential}: {error}");
        assert!(!destination.exists());
        fs::create_dir(live.join("keys")).unwrap();
        fs::write(live.join("keys/knowledge.key"), [7; 32]).unwrap();
        create_backup(&live, &destination).unwrap();
        let mut manifest = validate_backup(&destination).unwrap();
        manifest
            .files
            .retain(|entry| entry.path != "data/keys/knowledge.key");
        fs::remove_file(destination.join("data/keys/knowledge.key")).unwrap();
        fs::remove_file(destination.join(MANIFEST_FILE)).unwrap();
        write_manifest(&destination, &manifest).unwrap();
        assert!(
            validate_backup(&destination)
                .unwrap_err()
                .to_string()
                .contains("knowledge.key")
        );
        assert!(restore_backup(&destination, root.path().join("restored")).is_err());
    }
}

#[test]
fn pinned_original_survives_deletion_and_manifest_preflight_fails_early() {
    let root = tempfile::tempdir_in("target").unwrap();
    let layout = DataLayout::new(root.path().join("live"));
    layout.ensure_runtime_directories().unwrap();
    let original = layout.files().join("aa/bb/blob");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::write(&original, b"original").unwrap();
    let blobs = vec![ReferencedBlob {
        key: "aa/bb/blob".into(),
        size: 8,
        checksum: hex::encode(Sha256::digest(b"original")),
        owner: "task TEST-1, attachment note.txt".into(),
    }];
    assert!(
        preflight_manifest(&blobs, &layout.keys(), 4096)
            .unwrap_err()
            .to_string()
            .contains("no originals were copied")
    );
    preflight_manifest(&blobs, &layout.keys(), MAX_MANIFEST_BYTES).unwrap();
    let pins = BackupPins::new(layout.root().join("pins")).unwrap();
    pin_blobs(&layout, &pins.0, &blobs).unwrap();
    fs::remove_file(original).unwrap();
    let mut entries = vec![];
    copy_referenced_blobs(&pins.0, &root.path().join("backup"), &blobs, &mut entries).unwrap();
    assert_eq!(entries[0].sha256, blobs[0].checksum);
    assert_eq!(
        fs::read(root.path().join("backup/data/files/aa/bb/blob")).unwrap(),
        b"original"
    );
    fs::write(pins.0.join("aa/bb/blob"), b"corrupt!").unwrap();
    let error = copy_referenced_blobs(&pins.0, &root.path().join("corrupt"), &blobs, &mut vec![])
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("TEST-1") && error.contains("note.txt") && error.contains("earlier backup")
    );
}

#[test]
#[ignore = "manual 100,000-file filesystem scale regression"]
fn validate_a_hundred_thousand_file_manifest_above_old_limit() {
    let root = tempfile::tempdir_in("target").unwrap();
    let live = root.path().join("live");
    migration::migrate(&live, None).unwrap();
    let backup = root.path().join("backup");
    create_backup(&live, &backup).unwrap();
    let mut manifest = validate_backup(&backup).unwrap();
    let empty = root.path().join("empty");
    fs::write(&empty, []).unwrap();
    let checksum = hex::encode(Sha256::digest([]));
    for shard in 0..100 {
        fs::create_dir_all(backup.join(format!("data/files/{shard:02}/ab"))).unwrap();
        for leaf in 0..1000 {
            let path = format!("data/files/{shard:02}/ab/{leaf:048x}");
            fs::hard_link(&empty, backup.join(&path)).unwrap();
            manifest.files.push(BackupFile {
                path,
                size_bytes: 0,
                sha256: checksum.clone(),
            });
        }
    }
    manifest.files.sort_by(|a, b| a.path.cmp(&b.path));
    fs::remove_file(backup.join(MANIFEST_FILE)).unwrap();
    write_manifest(&backup, &manifest).unwrap();
    assert!(fs::metadata(backup.join(MANIFEST_FILE)).unwrap().len() > 16 * 1024 * 1024);
    assert_eq!(validate_backup(&backup).unwrap().files.len(), 100_001);
}

/// The ID of a process that has exited, as an interrupted backup's would be.
fn exited_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

fn owner(kind: &str, pid: u32) -> WorkOwner {
    WorkOwner {
        kind: kind.into(),
        host: host_name(),
        pid,
        data_dir: "/srv/oneloop".into(),
        started_at: 1,
        working: None,
        publishes: Vec::new(),
    }
}

fn plant(path: &Path, owner: &WorkOwner) {
    fs::write(path, serde_json::to_vec(owner).unwrap()).unwrap();
}

/// Retries `step` for up to two seconds until it reports success. A process
/// that another test starts holds a copy of every lock this process holds
/// until the child runs its program, so a lock released here can stay taken
/// for a moment. Backup and restore start no processes.
fn soon(mut step: impl FnMut() -> bool) -> bool {
    (0..200).any(|_| {
        step() || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            false
        }
    })
}

#[test]
fn only_a_writer_that_is_gone_from_this_host_gives_up_its_work() {
    let root = tempfile::tempdir_in("target").unwrap();
    let record = root.path().join(OWNER_FILE);
    let gone = exited_pid();
    plant(&record, &owner("backup", gone));
    let (lock, found) = claim_abandoned(&record).unwrap();
    assert_eq!(found.pid, gone);
    // A lock belongs to one open file, so a second open of the record sees it.
    assert!(claim_abandoned(&record).is_none());
    drop(lock);
    fs::remove_file(&record).unwrap();
    let writer = OwnerLock::create(&record, &owner("backup", gone)).unwrap();
    assert!(
        claim_abandoned(&record).is_none(),
        "the writer still holds its lock"
    );
    drop(writer);
    assert!(soon(|| claim_abandoned(&record).is_some()));
    plant(&record, &owner("backup", std::process::id()));
    assert!(claim_abandoned(&record).is_none(), "the process still runs");
    let mut elsewhere = owner("backup", gone);
    elsewhere.host.push_str("-elsewhere");
    plant(&record, &elsewhere);
    assert!(claim_abandoned(&record).is_none(), "another computer");
    fs::write(&record, b"").unwrap();
    assert!(
        claim_abandoned(&record).is_none(),
        "a record from an older version"
    );
    fs::remove_file(&record).unwrap();
    assert!(claim_abandoned(&record).is_none());
}

#[test]
fn a_backup_removes_only_copies_whose_writer_is_gone() {
    let root = tempfile::tempdir_in("target").unwrap();
    let live = root.path().join("live");
    migration::migrate(&live, None).unwrap();
    let parent = root.path().join("backups");
    fs::create_dir(&parent).unwrap();
    let copy = |name: &str| {
        let path = parent.join(format!(".{name}.partial-{}", Uuid::now_v7()));
        fs::create_dir_all(path.join("data")).unwrap();
        fs::write(path.join("data/oneloop.sqlite3"), b"partial").unwrap();
        path
    };
    let (abandoned, running, unowned) = (copy("nightly"), copy("other"), copy("old"));
    plant(&abandoned.join(OWNER_FILE), &owner("backup", exited_pid()));
    let _writer =
        OwnerLock::create(&running.join(OWNER_FILE), &owner("backup", exited_pid())).unwrap();
    let published = create_backup(&live, parent.join("new")).unwrap();
    assert!(!abandoned.exists());
    assert!(running.exists() && unowned.exists());
    assert!(!published.join(OWNER_FILE).exists());
    validate_backup(&published).unwrap();
}

#[test]
fn a_cleanup_that_stops_halfway_keeps_the_record_for_another_try() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir_in("target").unwrap();
    let gone = exited_pid();
    // Filesystems list a folder by name, by creation in either direction, or
    // by a hash of the names. Each copy has its own name for the part that
    // can't be removed, on either side of the record's name, and half the
    // copies get their record first. Whichever way a folder is listed,
    // removing a record before the rest would lose some of them.
    let copies = (0..16)
        .map(|index| {
            let copy = root
                .path()
                .join(format!(".copy{index}.partial-{}", Uuid::now_v7()));
            let stuck = copy.join(format!(
                "{}stuck-{index}",
                if index % 2 == 0 { "-" } else { "" }
            ));
            fs::create_dir(&copy).unwrap();
            let record_first = index % 4 < 2;
            if record_first {
                plant(&copy.join(OWNER_FILE), &owner("backup", gone));
            }
            fs::create_dir(&stuck).unwrap();
            fs::write(stuck.join("oneloop.sqlite3"), b"partial").unwrap();
            if !record_first {
                plant(&copy.join(OWNER_FILE), &owner("backup", gone));
            }
            fs::set_permissions(&stuck, fs::Permissions::from_mode(0o500)).unwrap();
            (copy, stuck)
        })
        .collect::<Vec<_>>();
    let unlock = || {
        for (_, stuck) in &copies {
            fs::set_permissions(stuck, fs::Permissions::from_mode(0o700)).unwrap();
        }
    };
    if fs::write(copies[0].1.join("probe"), b"").is_ok() {
        // Root ignores the permissions this test relies on.
        unlock();
        return;
    }
    reclaim_partial_copies(root.path());
    for (copy, _) in &copies {
        assert!(
            copy.join(OWNER_FILE).exists(),
            "{}: the record goes only after everything else",
            copy.display()
        );
    }
    unlock();
    assert!(soon(|| {
        reclaim_partial_copies(root.path());
        copies.iter().all(|(copy, _)| !copy.exists())
    }));
}

#[test]
fn a_restore_removes_only_the_marker_it_claimed() {
    let root = tempfile::tempdir_in("target").unwrap();
    let marker = root.path().join(crate::db::RESTORE_MARKER);
    plant(&marker, &owner("restore", exited_pid()));
    let (lock, _) = claim_abandoned(&marker).unwrap();
    // Another restore removed the old marker and wrote its own meanwhile.
    fs::remove_file(&marker).unwrap();
    plant(&marker, &owner("restore", std::process::id()));
    assert!(!remove_claimed_marker(&marker, lock).unwrap());
    assert_eq!(
        serde_json::from_slice::<WorkOwner>(&fs::read(&marker).unwrap())
            .unwrap()
            .pid,
        std::process::id(),
        "the other restore keeps its marker"
    );
    // The marker this restore claimed goes.
    plant(&marker, &owner("restore", exited_pid()));
    let mut claimed = None;
    assert!(soon(|| {
        claimed = claim_abandoned(&marker);
        claimed.is_some()
    }));
    assert!(remove_claimed_marker(&marker, claimed.unwrap().0).unwrap());
    assert!(!marker.exists());
}

#[test]
fn a_claimed_marker_leaves_its_path_before_its_lock_is_released() {
    let root = tempfile::tempdir_in("target").unwrap();
    let marker = root.path().join(crate::db::RESTORE_MARKER);
    plant(&marker, &owner("restore", exited_pid()));
    let (lock, _) = claim_abandoned(&marker).unwrap();
    let aside = set_aside_claimed_marker(&marker, &lock).unwrap().unwrap();
    // The lock still holds, and another restore can already write its marker.
    assert!(!marker.exists());
    assert!(claim_abandoned(&aside).is_none(), "the claim still holds");
    plant(&marker, &owner("restore", std::process::id()));
    drop(lock);
    fs::remove_file(&aside).unwrap();
    assert_eq!(
        serde_json::from_slice::<WorkOwner>(&fs::read(&marker).unwrap())
            .unwrap()
            .pid,
        std::process::id(),
        "the other restore keeps its marker"
    );
    // Removing a claimed marker leaves nothing behind.
    fs::remove_file(&marker).unwrap();
    plant(&marker, &owner("restore", exited_pid()));
    let mut claimed = None;
    assert!(soon(|| {
        claimed = claim_abandoned(&marker);
        claimed.is_some()
    }));
    assert!(remove_claimed_marker(&marker, claimed.unwrap().0).unwrap());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn restoring_again_removes_only_what_an_interrupted_restore_left() {
    let root = tempfile::tempdir_in("target").unwrap();
    let live = root.path().join("live");
    migration::migrate(&live, None).unwrap();
    let backup = root.path().join("backup");
    create_backup(&live, &backup).unwrap();
    // A restore stopped while it moved its copy into place.
    let interrupted = |target: &Path, publishes: &[&str]| {
        fs::create_dir_all(target).unwrap();
        let working = format!(".oneloop-restore-{}", Uuid::now_v7());
        fs::create_dir_all(target.join(&working).join("files")).unwrap();
        fs::write(target.join("oneloop.sqlite3"), b"half published").unwrap();
        let mut record = owner("restore", exited_pid());
        record.working = Some(working.clone());
        record.publishes = publishes.iter().map(|name| (*name).to_owned()).collect();
        plant(&target.join(crate::db::RESTORE_MARKER), &record);
        working
    };
    let target = root.path().join("target");
    let working = interrupted(&target, &["oneloop.sqlite3", "files"]);
    restore_backup(&backup, &target).unwrap();
    assert!(!target.join(&working).exists());
    assert!(!target.join(crate::db::RESTORE_MARKER).exists());
    drop(crate::db::Db::open(&target).unwrap());

    // Anything the restore did not publish stays, so the target stays refused.
    let kept = root.path().join("kept");
    interrupted(&kept, &["oneloop.sqlite3"]);
    fs::write(kept.join("notes.txt"), b"mine").unwrap();
    let error = restore_backup(&backup, &kept).unwrap_err().to_string();
    assert!(error.contains("not empty"), "{error}");
    assert_eq!(fs::read(kept.join("notes.txt")).unwrap(), b"mine");

    // A record that names anything outside the target removes nothing.
    let escape = root.path().join("escape");
    interrupted(&escape, &["../live"]);
    let error = restore_backup(&backup, &escape).unwrap_err().to_string();
    assert!(error.contains("incomplete restore"), "{error}");
    assert!(live.join("oneloop.sqlite3").exists());
    assert!(escape.join("oneloop.sqlite3").exists());

    // A wrong backup path stops the restore before it removes anything.
    let mistyped = root.path().join("mistyped");
    let working = interrupted(&mistyped, &["oneloop.sqlite3", "files"]);
    let error = restore_backup(root.path().join("no-such-backup"), &mistyped)
        .unwrap_err()
        .to_string();
    assert!(mistyped.join(&working).exists());
    assert!(mistyped.join(crate::db::RESTORE_MARKER).exists());
    assert!(error.contains("backup directory does not exist"), "{error}");

    // A marker from an older version has no record and stays refused.
    let older = root.path().join("older");
    fs::create_dir(&older).unwrap();
    fs::write(older.join(crate::db::RESTORE_MARKER), b"").unwrap();
    let error = restore_backup(&backup, &older).unwrap_err().to_string();
    assert!(error.contains("incomplete restore"), "{error}");
    assert!(older.join(crate::db::RESTORE_MARKER).exists());
}
