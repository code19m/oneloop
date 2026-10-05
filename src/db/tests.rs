use super::*;

/// The database file's path, for the child process that probes its locks.
#[cfg(unix)]
const LOCK_PROBE_ENV: &str = "SQLITE_LOCK_PROBE_DATABASE";

/// SQLite's shared-lock bytes on the database file (`SHARED_FIRST`,
/// `SHARED_SIZE`). A WAL connection keeps a read lock there while it is open,
/// and a closing SQLite client treats a free range as "no one else is using
/// the WAL", so it checkpoints and deletes it.
#[cfg(unix)]
const SHARED_RANGE: (u64, u64) = (0x4000_0002, 510);

#[cfg(unix)]
#[tokio::test]
async fn growing_the_pool_keeps_sqlite_lock_on_the_database_file() {
    let root = tempfile::tempdir_in("target").unwrap();
    migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    // Hold the pool's only connection, so the next operation opens another.
    let (taken, wait_until_taken) = tokio::sync::oneshot::channel();
    let (release, wait_for_release) = std::sync::mpsc::channel::<()>();
    let holder = tokio::spawn({
        let db = db.clone();
        async move {
            db.run(move |_| {
                let _ = taken.send(());
                let _ = wait_for_release.recv();
                Ok(())
            })
            .await
        }
    });
    wait_until_taken.await.unwrap();
    let users: i64 = db
        .run(|connection| {
            Ok(connection.query_row("SELECT count(*) FROM users", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(users, 0);

    // A process never conflicts with its own POSIX locks, so ask from another.
    let probe = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "db::tests::report_database_lock_holder",
            "--nocapture",
        ])
        .env(LOCK_PROBE_ENV, db.layout().database())
        .output()
        .unwrap();
    release.send(()).unwrap();
    holder.await.unwrap().unwrap();
    let stdout = String::from_utf8_lossy(&probe.stdout);
    assert!(probe.status.success(), "{stdout}");
    assert!(
        stdout.contains(&format!("lock holder: {}\n", std::process::id())),
        "{stdout}"
    );
}

/// Runs only as the child process of the test above.
#[cfg(unix)]
#[test]
fn report_database_lock_holder() {
    use rustix::process::{Flock, FlockOffsetType, FlockType, fcntl_getlk};
    let Some(path) = std::env::var_os(LOCK_PROBE_ENV) else {
        return;
    };
    let file = File::open(path).unwrap();
    let holder = fcntl_getlk(
        &file,
        &Flock {
            start: SHARED_RANGE.0,
            length: SHARED_RANGE.1,
            pid: None,
            typ: FlockType::WriteLock,
            offset_type: FlockOffsetType::Set,
        },
    )
    .unwrap();
    match holder {
        Some(lock) if lock.typ == FlockType::ReadLock => println!(
            "lock holder: {}",
            lock.pid.map_or(0, |pid| pid.as_raw_nonzero().get())
        ),
        other => println!("no read lock: {other:?}"),
    }
}
