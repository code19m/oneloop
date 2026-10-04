use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    time::Duration,
};

use oneloop::{
    AppError, Db,
    db::{create_backup, migrate, restore_backup, validate_backup},
};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use super::initialize;
use crate::support;

#[tokio::test]
async fn database_calls_stay_responsive_while_backup_holds_the_file_lock() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".oneloop-data.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO app_metadata VALUES('during-backup','ok',1)",
                [],
            )?;
            Ok(())
        }),
    )
    .await
    .expect("ordinary writes must not wait for backup file coordination")
    .unwrap();
    let started = std::time::Instant::now();
    assert!(matches!(
        db.acquire_data_lease().await,
        Err(AppError::Unavailable(_))
    ));
    assert!(started.elapsed() < Duration::from_secs(7));
    drop(lock);
    db.acquire_data_lease().await.unwrap();
}

#[tokio::test]
async fn backup_is_complete_validated_atomic_and_restore_revokes_credentials() {
    let support::TestInstance {
        root: live,
        db,
        owner,
    } = support::TestInstance::new().await;
    drop(db);
    let oneloop::auth::ActorSource::BrowserSession { session_id } = owner.actor.source else {
        panic!("fixture login must issue a browser session");
    };
    let database_path = live.path().join("oneloop.sqlite3");
    let connection = Connection::open(&database_path).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    // Grant/token rows stay explicit: this test exercises restored credential
    // invalidation without needing an OAuth client or network connection.
    connection
        .execute(
            "INSERT INTO mcp_grants
             (id,user_id,client_id,client_name,created_at,updated_at,expires_at)
             VALUES ('g1',?1,'client','Client',1,1,200)",
            [&owner.actor.user_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO mcp_tokens
             (id,grant_id,family_id,kind,token_hash,issued_at,expires_at)
             VALUES ('t1','g1','family','access','mcp-hash',1,200)",
            [],
        )
        .unwrap();
    let content = b"durable attachment bytes";
    let checksum = hex::encode(Sha256::digest(content));
    fs::create_dir_all(live.path().join("files/ab")).unwrap();
    let mut file = File::create(live.path().join("files/ab/blob")).unwrap();
    file.write_all(content).unwrap();
    file.sync_all().unwrap();
    connection
        .execute(
            "INSERT INTO file_blobs
             (id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
             VALUES ('blob','ab/blob',?1,?2,'application/octet-stream','available',1)",
            params![checksum, i64::try_from(content.len()).unwrap()],
        )
        .unwrap();
    connection.execute("INSERT INTO idempotency_keys(id,actor_user_id,idempotency_key,operation,request_hash,state,created_at,updated_at,expires_at) VALUES('upload',?1,'stable-key','attachment.upload','hash','running',1,1,9999999999),('done-upload',?1,'done-key','attachment.upload','hash','succeeded',1,1,9999999999),('other',?1,'other-key','task.create','hash','running',1,1,9999999999)",[&owner.actor.user_id]).unwrap();
    connection.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('reservation-project','Project','RES',1,1)",[]).unwrap();
    connection.execute("INSERT INTO upload_reservations(id,project_id,user_id,size_bytes,staging_key,created_at,expires_at) VALUES('upload','reservation-project',?1,1,'pending',1,9999999999)",[&owner.actor.user_id]).unwrap();
    drop(connection);

    let backup_parent = support::scratch_dir();
    let backup = backup_parent.path().join("snapshot");
    create_backup(live.path(), &backup).expect("create backup");
    let manifest = validate_backup(&backup).expect("valid backup");
    assert!(
        manifest
            .files
            .iter()
            .any(|file| file.path == "data/files/ab/blob")
    );

    let restore_parent = support::scratch_dir();
    let restored = restore_parent.path().join("restored");
    restore_backup(&backup, &restored).expect("restore backup");
    let connection = Connection::open(restored.join("oneloop.sqlite3")).unwrap();
    let session_revoked: Option<i64> = connection
        .query_row(
            "SELECT revoked_at FROM sessions WHERE id=?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap();
    let grant_revoked: Option<i64> = connection
        .query_row(
            "SELECT revoked_at FROM mcp_grants WHERE id='g1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let token_revoked: Option<i64> = connection
        .query_row(
            "SELECT revoked_at FROM mcp_tokens WHERE id='t1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let states: Vec<(String, String)> = connection
        .prepare("SELECT id,state FROM idempotency_keys ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        states,
        vec![
            ("done-upload".into(), "succeeded".into()),
            ("other".into(), "running".into()),
            ("upload".into(), "failed".into())
        ]
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM upload_reservations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(session_revoked.is_some());
    assert!(grant_revoked.is_some());
    assert!(token_revoked.is_some());
    assert_eq!(fs::read(restored.join("files/ab/blob")).unwrap(), content);
    validate_backup(&backup).expect("restore does not mutate backup");

    let occupied = restore_parent.path().join("occupied");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("keep"), b"user data").unwrap();
    let error = restore_backup(&backup, &occupied).unwrap_err();
    assert!(error.to_string().contains("not empty"));
    assert_eq!(fs::read(occupied.join("keep")).unwrap(), b"user data");

    fs::write(
        backup.join("data/files/ab/blob"),
        b"tampered attachment bytes",
    )
    .unwrap();
    let error = validate_backup(&backup).unwrap_err();
    assert!(error.to_string().contains("checksum") || error.to_string().contains("wrong size"));
}

#[test]
fn invalid_backup_never_publishes_a_destination() {
    let live = support::scratch_dir();
    initialize(&live);
    let connection = Connection::open(live.path().join("oneloop.sqlite3")).unwrap();
    connection
        .execute(
            "INSERT INTO file_blobs
             (id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
             VALUES ('missing','no/such/file',?1,4,'text/plain','available',1)",
            ["0".repeat(64)],
        )
        .unwrap();
    connection.execute("INSERT INTO users(id,username,display_name,password_hash,password_changed_at,avatar_blob_id,created_at,updated_at) VALUES('avatar-owner','avatar-owner','Avatar Owner','hash',1,'missing',1,1)", []).unwrap();
    drop(connection);

    let parent = support::scratch_dir();
    let destination = parent.path().join("snapshot");
    let error = create_backup(live.path(), &destination)
        .unwrap_err()
        .to_string();
    assert!(error.contains("avatar for user avatar-owner"), "{error}");
    assert!(
        error.contains("earlier backup") && error.contains("UI"),
        "{error}"
    );
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
}

#[test]
fn final_backup_validation_rejects_foreign_key_corruption_before_publication() {
    let parent = support::scratch_dir();
    let data = tempfile::tempdir_in(parent.path()).unwrap();
    drop(initialize(&data));
    let connection = Connection::open(data.path().join("oneloop.sqlite3")).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
        INSERT INTO project_memberships(project_id,user_id,created_at,updated_at)
        VALUES('missing-project','missing-user',1,1);",
        )
        .unwrap();
    drop(connection);
    let destination = parent.path().join("corrupt-backup");
    let error = create_backup(data.path(), &destination).unwrap_err();
    assert!(
        error.to_string().contains("foreign-key check failed"),
        "{error}"
    );
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn restore_preserves_preprovisioned_directory_and_rejects_incomplete_publication() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    migrate(&live, None).unwrap();
    let backup = root.path().join("backup");
    create_backup(&live, &backup).unwrap();
    let parent = root.path().join("volume-parent");
    let target = parent.join("volume");
    fs::create_dir_all(&target).unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o500)).unwrap();
        fs::metadata(&target).unwrap().ino()
    };
    let result = restore_backup(&backup, &target);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
    }
    result.unwrap();
    assert!(!target.join(".oneloop-restore-incomplete").exists());
    drop(Db::open(&target).unwrap());
    fs::write(target.join(".oneloop-restore-incomplete"), b"").unwrap();
    assert!(
        Db::open(&target)
            .err()
            .unwrap()
            .to_string()
            .contains("incomplete restore")
    );
    assert!(
        Db::check(&target)
            .unwrap_err()
            .to_string()
            .contains("incomplete restore")
    );
    assert!(
        migrate(&target, None)
            .unwrap_err()
            .to_string()
            .contains("incomplete restore")
    );
    assert!(
        restore_backup(&backup, &target)
            .unwrap_err()
            .to_string()
            .contains("incomplete restore")
    );
    // Creating a missing folder can make a path reach the marked directory.
    assert!(
        migrate(parent.join("missing/../volume"), None)
            .unwrap_err()
            .to_string()
            .contains("incomplete restore")
    );
}

#[test]
fn restore_refuses_a_nonempty_target_named_through_a_missing_folder() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    migrate(&live, None).unwrap();
    let backup = root.path().join("backup");
    create_backup(&live, &backup).unwrap();
    let entries = || {
        let mut names: Vec<_> = fs::read_dir(&live)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let before = entries();
    let error = restore_backup(&backup, root.path().join("missing/../live")).unwrap_err();
    assert!(error.to_string().contains("not empty"), "{error}");
    assert_eq!(entries(), before);
}

#[test]
fn backup_and_restore_report_partial_copies_without_removing_them() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    migrate(&live, None).unwrap();
    let partial = root.path().join(".old.partial-example");
    let old_restore = root.path().join(".oneloop-restore-old");
    for dir in [&partial, &old_restore] {
        fs::create_dir(dir).unwrap();
        fs::write(dir.join("private-copy"), b"private").unwrap();
    }
    let backup = root.path().join("backup");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_oneloop"))
        .env("ONELOOP_DATA_DIR", &live)
        .args(["backup", "create"])
        .arg(&backup)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(".old.partial-example")
            && stderr.contains("7 bytes")
            && stderr.contains("remove this directory manually"),
        "{stderr}"
    );
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_oneloop"))
        .env("ONELOOP_DATA_DIR", root.path().join("restored"))
        .args(["backup", "restore"])
        .arg(&backup)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains(".oneloop-restore-old"));
    assert_eq!(fs::read(partial.join("private-copy")).unwrap(), b"private");
    assert!(old_restore.exists());
}
