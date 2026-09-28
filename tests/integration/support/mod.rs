//! The only helpers shared between areas: data directories, accounts, actors,
//! a seeded project, test configuration, HTTP helpers and waiting.
//!
//! Accounts that sign in are created through the application's own account
//! and session services. Seeded projects insert rows directly for speed; their
//! users cannot sign in.

pub mod http;
mod project;

use std::{
    io::Write,
    path::Path,
    sync::{
        OnceLock,
        atomic::{AtomicU16, Ordering},
    },
    time::{Duration, Instant},
};

use oneloop::{
    Config, Db,
    auth::{Actor, ActorSource, AuthService, IssuedSession, LoginResult, NewUser, create_user},
    db::{DataLayout, migrate},
};
use tempfile::TempDir;

pub use project::{SeededProject, seeded_project};

const PASSWORD: &str = "test-only-password-012345";

/// The current Unix time in seconds, as the application records it.
pub fn now() -> i64 {
    oneloop::auth::unix_now().unwrap()
}

/// An empty private directory under Cargo's scratch directory for integration tests.
pub fn scratch_dir() -> TempDir {
    let mut builder = tempfile::Builder::new();
    builder.prefix("oneloop-");
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    builder.tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// A data directory holding a freshly migrated database.
///
/// The schema is migrated once per test process and each test receives a
/// private copy of the resulting database file, which is much cheaper than
/// replaying the migration. Migration tests call `migrate` directly.
pub fn data_dir() -> TempDir {
    static TEMPLATE: OnceLock<Vec<u8>> = OnceLock::new();
    let template = TEMPLATE.get_or_init(|| {
        let root = scratch_dir();
        migrate(root.path(), None).expect("migrate the template database");
        let wal = root.path().join("oneloop.sqlite3-wal");
        assert!(
            std::fs::metadata(&wal).map_or(true, |metadata| metadata.len() == 0),
            "the template database must be fully checkpointed"
        );
        std::fs::read(DataLayout::new(root.path()).database()).expect("read the template")
    });
    let root = scratch_dir();
    let layout = DataLayout::new(root.path());
    // Creating the runtime directories up front lets `Db::open` skip its
    // durable directory syncs, which dominate fixture cost on macOS.
    for directory in [
        layout.files(),
        layout.staging(),
        layout.keys(),
        root.path().join("previews"),
    ] {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(directory).unwrap();
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(layout.database())
        .unwrap()
        .write_all(template)
        .unwrap();
    root
}

/// A fresh migrated data directory and an open database handle.
pub fn database() -> (TempDir, Db) {
    let root = data_dir();
    let db = Db::open(root.path()).expect("open current database");
    (root, db)
}

/// Configuration for an in-process application backed by `root`.
pub fn config(root: &Path, public_url: &str, extra: &[(&str, &str)]) -> Config {
    let mut values = vec![
        ("ONELOOP_PUBLIC_URL", public_url),
        ("ONELOOP_DATA_DIR", root.to_str().unwrap()),
    ];
    values.extend_from_slice(extra);
    Config::from_os_iter(values).unwrap()
}

/// A loopback port that is free now, from the range reserved for servers
/// started by local tests. Ports are handed out once per test process.
pub fn free_port() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(19800);
    loop {
        let port = NEXT.fetch_add(1, Ordering::Relaxed);
        assert!(port < 19900, "no free test port in 19800-19899");
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

/// Waits for the effect of a detached background task that has no completion
/// signal, such as cleanup spawned when a handle is dropped. `check` returns
/// `Some` once the effect is visible; the wait fails after ten seconds.
pub async fn eventually<T>(what: &str, mut check: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = check().await {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// A cached browser actor, for tests that deliberately bypass authentication
/// or exercise stale credentials.
pub fn browser_actor(
    id: &str,
    display_name: &str,
    session_id: &str,
    authenticated_at: i64,
) -> Actor {
    Actor {
        user_id: id.into(),
        username: id.into(),
        display_name: display_name.into(),
        is_admin: false,
        must_change_password: false,
        authenticated_at,
        source: ActorSource::BrowserSession {
            session_id: session_id.into(),
        },
    }
}

/// Creates an account whose display name is its username, then signs it in.
pub async fn add_user(db: &Db, username: &str, admin: bool) -> IssuedSession {
    let input = NewUser {
        display_name: username.to_owned(),
        username: username.to_owned(),
        password: PASSWORD.into(),
        is_admin: admin,
        must_change_password: false,
    };
    db.transaction(move |tx| create_user(tx, input, now()))
        .await
        .unwrap();
    match AuthService::new(db.clone())
        .login(username, PASSWORD, Default::default(), None)
        .await
        .unwrap()
    {
        LoginResult::Authenticated(session) => session,
        LoginResult::SessionLimit { .. } => panic!("fixture reached the session limit"),
    }
}

/// A migrated instance with one signed-in administrator named `owner`.
pub struct TestInstance {
    pub root: TempDir,
    pub db: Db,
    pub owner: IssuedSession,
}

impl TestInstance {
    pub async fn new() -> Self {
        let (root, db) = database();
        let owner = add_user(&db, "owner", true).await;
        Self { root, db, owner }
    }
}
