use super::*;

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
