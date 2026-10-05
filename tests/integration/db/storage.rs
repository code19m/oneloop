use std::{
    fs::{self},
    sync::mpsc,
    time::Duration,
};

use oneloop::{
    Db,
    db::{create_backup, migrate, restore_backup},
};

use super::initialize;
use crate::support;

#[cfg(unix)]
#[test]
fn initialization_creates_private_directories_without_changing_existing_parent() {
    use std::os::unix::fs::PermissionsExt;

    let parent = support::scratch_dir();
    fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o750)).unwrap();
    let data = parent.path().join("instance");
    migrate(&data, None).unwrap();
    for path in [
        data.clone(),
        data.join("files"),
        data.join("staging"),
        data.join("keys"),
    ] {
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
    }
    assert_eq!(
        fs::metadata(parent.path()).unwrap().permissions().mode() & 0o777,
        0o750
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_writer_keeps_its_permit_until_commit_and_does_not_block_reads() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, gate) = mpsc::channel();
    let first = db.clone();
    let write = tokio::spawn(async move {
        first
            .transaction(move |tx| {
                tx.execute(
                    "INSERT INTO app_metadata VALUES('first-writer','committed',1)",
                    [],
                )?;
                let _ = started.send(());
                gate.recv().unwrap();
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    write.abort();
    let second = db.clone();
    let mut following = tokio::spawn(async move {
        second
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO app_metadata VALUES('second-writer','committed',1)",
                    [],
                )?;
                Ok(())
            })
            .await
    });
    let readers = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM app_metadata WHERE key='first-writer'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(readers, 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut following)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    following.await.unwrap().unwrap();
    let count = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM app_metadata WHERE key IN ('first-writer','second-writer')",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn connections_enable_durable_sync_and_collect_planner_statistics() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    db.run(|connection| {
        for pragma in ["fullfsync", "checkpoint_fullfsync", "foreign_keys"] {
            assert_eq!(connection.pragma_query_value::<i64, _>(None, pragma, |r| r.get(0))?, 1);
        }
        assert_eq!(connection.pragma_query_value::<i64, _>(None, "synchronous", |r| r.get(0))?, 2);
        assert_eq!(connection.pragma_query_value::<i64, _>(None, "journal_size_limit", |r| r.get(0))?, 67_108_864);
        connection.execute_batch("CREATE TABLE planner_fixture(id INTEGER PRIMARY KEY, owner INTEGER); CREATE INDEX planner_owner ON planner_fixture(owner);
            WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO planner_fixture SELECT x,x%10 FROM n;")?;
        Ok(())
    }).await.unwrap();
    drop(db);
    let reopened = Db::open(root.path()).unwrap();
    reopened
        .run(|connection| {
            assert!(connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_stat1 WHERE idx='planner_owner')",
                [],
                |r| r.get::<_, bool>(0)
            )?);
            Ok(())
        })
        .await
        .unwrap();
}

#[cfg(unix)]
#[test]
fn fresh_database_sidecars_locks_and_restores_are_private() {
    use sha2::Digest;
    use std::os::unix::fs::PermissionsExt;
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    fs::set_permissions(&live, fs::Permissions::from_mode(0o755)).unwrap();
    migrate(&live, None).unwrap();
    let db = Db::open(&live).unwrap();
    let _guard = db.layout().try_server_lock().unwrap();
    for name in [
        "oneloop.sqlite3",
        "oneloop.sqlite3-wal",
        "oneloop.sqlite3-shm",
        ".oneloop-data.lock",
        ".oneloop-instance.lock",
        ".oneloop-server.lock",
        "previews",
    ] {
        assert_eq!(
            fs::metadata(live.join(name)).unwrap().permissions().mode() & 0o077,
            0,
            "{name}"
        );
    }
    assert_eq!(
        fs::metadata(&live).unwrap().permissions().mode() & 0o777,
        0o755,
        "preserve operator-owned directory mode"
    );
    // An attachment in its shard folders and a Knowledge key.
    fs::create_dir_all(live.join("files/ab/cd")).unwrap();
    fs::write(live.join("files/ab/cd/abcd"), b"attachment").unwrap();
    fs::write(live.join("keys/knowledge.key"), b"key").unwrap();
    rusqlite::Connection::open(live.join("oneloop.sqlite3"))
        .unwrap()
        .execute(
            "INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
             VALUES('blob','ab/cd/abcd',?1,10,'text/plain','available',1)",
            [hex::encode(sha2::Sha256::digest(b"attachment"))],
        )
        .unwrap();
    let backup = root.path().join("backup");
    create_backup(&live, &backup).unwrap();
    let restored = root.path().join("restored");
    restore_backup(backup, &restored).unwrap();
    for (name, mode) in [
        ("oneloop.sqlite3", 0o600),
        ("files", 0o700),
        ("files/ab", 0o700),
        ("files/ab/cd", 0o700),
        ("files/ab/cd/abcd", 0o600),
        ("keys", 0o700),
        ("keys/knowledge.key", 0o600),
    ] {
        assert_eq!(
            fs::metadata(restored.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            mode,
            "{name}"
        );
    }
}

#[tokio::test]
#[ignore = "manual local disk commit-latency measurement"]
async fn measure_fullfsync_commit_latency() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    db.run(|connection| {
        for enabled in [false, true] {
            connection.pragma_update(None, "fullfsync", enabled)?;
            connection.pragma_update(None, "checkpoint_fullfsync", enabled)?;
            let mut samples = vec![];
            for i in 0..200 {
                let start = std::time::Instant::now();
                let tx = connection.transaction()?;
                tx.execute("INSERT INTO app_metadata VALUES('sync-latency',?1,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [i.to_string()])?;
                tx.commit()?;
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            samples.sort_by(f64::total_cmp);
            println!("fullfsync={enabled}: 200 commits, p50={:.3}ms p95={:.3}ms", samples[100], samples[190]);
        }
        Ok(())
    }).await.unwrap();
}
