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
