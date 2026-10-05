//! Bounded SQLite execution with foreign keys, WAL snapshots and explicit migrations. Writes and their durable audit/outbox commit atomically.

mod backup;
mod migration;

use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::error::{AppError, AppResult};

pub use backup::{BackupManifest, create_backup, restore_backup, validate_backup};
pub use migration::{CURRENT_SCHEMA_VERSION, MigrationOutcome, migrate};

pub(crate) const RESTORE_MARKER: &str = ".oneloop-restore-incomplete";

const DATABASE_FILE: &str = "oneloop.sqlite3";
const DATA_LOCK_FILE: &str = ".oneloop-data.lock";
const INSTANCE_LOCK_FILE: &str = ".oneloop-instance.lock";
const DEFAULT_POOL_SIZE: usize = 8;
const MAX_PENDING_OPERATIONS: usize = 256;
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct DataLayout {
    root: PathBuf,
}

impl DataLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn ensure_restore_complete(&self) -> AppResult<()> {
        if self.root.join(RESTORE_MARKER).try_exists()? {
            return Err(AppError::PreconditionFailed(format!(
                "incomplete restore at {}; stop all instance commands, remove the interrupted restore contents and retry into an empty directory; do not remove only {RESTORE_MARKER}",
                self.root.display()
            )));
        }
        Ok(())
    }

    pub fn database(&self) -> PathBuf {
        self.root.join(DATABASE_FILE)
    }

    pub fn files(&self) -> PathBuf {
        self.root.join("files")
    }

    pub fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn keys(&self) -> PathBuf {
        self.root.join("keys")
    }

    pub fn data_lock(&self) -> PathBuf {
        self.root.join(DATA_LOCK_FILE)
    }

    pub fn instance_lock(&self) -> PathBuf {
        self.root.join(INSTANCE_LOCK_FILE)
    }

    pub fn ensure_runtime_directories(&self) -> AppResult<()> {
        create_private_directories(&self.root)?;
        create_private_directories(&self.files())?;
        create_private_directories(&self.staging())?;
        create_private_directories(&self.keys())?;
        create_private_directories(&self.root.join("previews"))?;
        Ok(())
    }

    pub(crate) fn open_shared_lock(&self) -> AppResult<File> {
        let file = open_lock_file(&self.data_lock())?;
        wait_for_lock(&file, false, &self.data_lock())?;
        Ok(file)
    }

    pub(crate) fn open_exclusive_lock(&self) -> AppResult<File> {
        let file = open_lock_file(&self.data_lock())?;
        wait_for_lock(&file, true, &self.data_lock())?;
        Ok(file)
    }

    pub(crate) fn backup_lock(&self) -> AppResult<File> {
        let path = self.root.join(".oneloop-backup.lock");
        let file = open_lock_file(&path)?;
        wait_for_lock(&file, true, &path)?;
        Ok(file)
    }

    pub fn try_server_lock(&self) -> AppResult<File> {
        let file = open_lock_file(&self.root.join(".oneloop-server.lock"))?;
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::Error(error) => AppError::from(error),
            std::fs::TryLockError::WouldBlock => AppError::PreconditionFailed(format!(
                "another oneloop server is already using {}",
                self.root.display()
            )),
        })?;
        Ok(file)
    }

    fn check_writable(&self) -> AppResult<()> {
        for path in [
            self.database(),
            self.root.join("oneloop.sqlite3-wal"),
            self.root.join("oneloop.sqlite3-shm"),
        ] {
            if path.exists() {
                ensure_writable_without_opening(&path)?;
                warn_public_permissions(&path)?;
            }
        }
        // Probes must not be copied into a backup or raced by orphan cleanup.
        // Ordinary database reads and writes do not take this filesystem lock.
        let _probe_lock = self.open_exclusive_lock()?;
        for path in [
            self.root.clone(),
            self.files(),
            self.staging(),
            self.keys(),
            self.root.join("previews"),
        ] {
            // Missing runtime directories will be created on startup. Probe their parent.
            let directory = if path.exists() {
                path.as_path()
            } else {
                self.root()
            };
            let probe = directory.join(format!(".oneloop-write-check-{}", uuid::Uuid::now_v7()));
            let file = private_file_options()
                .write(true)
                .create_new(true)
                .open(&probe)
                .map_err(|error| writable_error(directory, error))?;
            drop(file);
            fs::remove_file(&probe).map_err(|error| writable_error(directory, error))?;
            warn_public_permissions(directory)?;
        }
        Ok(())
    }

    pub(crate) fn open_instance_shared_lock(&self) -> AppResult<File> {
        self.ensure_restore_complete()?;
        let file = open_lock_file(&self.instance_lock())?;
        match file.try_lock_shared() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                eprintln!(
                    "waiting for exclusive maintenance (db migrate) to finish at {}",
                    self.root.display()
                );
            }
            Err(error) => {
                return Err(AppError::Io(format!(
                    "lock instance {}: {error}",
                    self.root.display()
                )));
            }
        }
        file.lock_shared().map_err(|error| {
            AppError::Io(format!("lock instance {}: {error}", self.root.display()))
        })?;
        Ok(file)
    }

    pub(crate) fn try_instance_exclusive_lock(&self) -> AppResult<File> {
        let file = open_lock_file(&self.instance_lock())?;
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::Error(error) => AppError::from(error),
            std::fs::TryLockError::WouldBlock => AppError::PreconditionFailed(
                "exclusive data access is unavailable; stop the oneloop server first".into(),
            ),
        })?;
        Ok(file)
    }
}

#[derive(Clone)]
pub struct Db {
    inner: Arc<DbInner>,
}

/// Cross-process guard for a filesystem operation that must remain consistent
/// with SQLite metadata and online backups.
pub struct DataLease {
    _lock: File,
}

struct DbInner {
    layout: DataLayout,
    _instance_lock: File,
    connections: Mutex<Vec<Connection>>,
    permits: Arc<Semaphore>,
    admission: Arc<Semaphore>,
    writer: Arc<Semaphore>,
    changes: Arc<Notify>,
    max_connections: usize,
}

impl Db {
    pub fn check(data_dir: impl Into<PathBuf>) -> AppResult<()> {
        let layout = DataLayout::new(data_dir);
        layout.ensure_restore_complete()?;
        if !layout.database().is_file() {
            return Err(AppError::PreconditionFailed(format!(
                "database is not initialized at {}; run `oneloop db migrate`",
                layout.database().display()
            )));
        }
        layout.check_writable()?;
        let connection = Connection::open_with_flags(
            layout.database(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migration::ensure_current_schema(&connection)?;
        integrity_check(&connection)
    }

    pub fn open(data_dir: impl Into<PathBuf>) -> AppResult<Self> {
        Self::open_with_pool_size(data_dir, DEFAULT_POOL_SIZE)
    }

    pub fn open_with_pool_size(
        data_dir: impl Into<PathBuf>,
        max_connections: usize,
    ) -> AppResult<Self> {
        if max_connections == 0 {
            return Err(AppError::Config(
                "database pool size must be greater than zero".to_owned(),
            ));
        }
        let layout = DataLayout::new(data_dir);
        layout.ensure_restore_complete()?;
        if !layout.database().is_file() {
            return Err(AppError::PreconditionFailed(format!(
                "database is not initialized at {}; run `oneloop db migrate`",
                layout.database().display()
            )));
        }
        let instance_lock = layout.open_instance_shared_lock()?;
        layout.check_writable()?;
        layout.ensure_runtime_directories()?;
        let connection = open_connection(&layout.database())?;
        migration::ensure_current_schema(&connection)?;

        Ok(Self {
            inner: Arc::new(DbInner {
                layout,
                _instance_lock: instance_lock,
                connections: Mutex::new(vec![connection]),
                permits: Arc::new(Semaphore::new(max_connections)),
                admission: Arc::new(Semaphore::new(max_connections + MAX_PENDING_OPERATIONS)),
                writer: Arc::new(Semaphore::new(1)),
                changes: Arc::new(Notify::new()),
                max_connections,
            }),
        })
    }

    pub fn layout(&self) -> &DataLayout {
        &self.inner.layout
    }

    pub async fn acquire_data_lease(&self) -> AppResult<DataLease> {
        let layout = self.inner.layout.clone();
        tokio::task::spawn_blocking(move || {
            Ok(DataLease {
                _lock: layout.open_shared_lock()?,
            })
        })
        .await
        .map_err(|error| AppError::internal(format!("data lease worker failed: {error}")))?
    }

    pub async fn run<T, F>(&self, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
    {
        let admission = self.admit()?;
        self.run_admitted(admission, operation).await
    }

    /// Execute dependent reads against one WAL snapshot without reserving the writer.
    pub(crate) async fn snapshot<T, F>(&self, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    {
        self.run(move |connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
            let result = operation(&tx)?;
            tx.commit()?;
            Ok(result)
        })
        .await
    }

    fn admit(&self) -> AppResult<OwnedSemaphorePermit> {
        self.inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::Unavailable("database is busy; try again shortly".to_owned()))
    }

    async fn run_admitted<T, F>(
        &self,
        admission: OwnedSemaphorePermit,
        operation: F,
    ) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
    {
        let queued_at = Instant::now();
        let permit = tokio::time::timeout(
            ADMISSION_TIMEOUT,
            self.inner.permits.clone().acquire_owned(),
        )
        .await
        .map_err(|_| AppError::Unavailable("database is busy; try again shortly".to_owned()))?
        .map_err(|_| AppError::Unavailable("database executor is shutting down".to_owned()))?;
        let queue_ms = queued_at.elapsed().as_secs_f64() * 1_000.0;
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let started = Instant::now();
            let _admission = admission;
            let _permit = permit;
            let mut connection = take_connection(&inner)?;
            let result = operation(&mut connection);
            tracing::debug!(target: "oneloop::db::timing", queue_ms,
                execution_ms = started.elapsed().as_secs_f64() * 1_000.0,
                failed = result.is_err(), "database operation");
            return_connection(&inner, connection);
            result
        })
        .await
        .map_err(|error| AppError::internal(format!("database worker failed: {error}")))?
    }

    /// Activity timestamps are coalesced and never delay authentication behind a writer.
    pub(crate) async fn try_activity_write<F>(&self, operation: F) -> AppResult<()>
    where
        F: FnOnce(&Transaction<'_>) -> AppResult<()> + Send + 'static,
    {
        let Ok(writer) = self.inner.writer.clone().try_acquire_owned() else {
            return Ok(());
        };
        let Ok(admission) = self.admit() else {
            return Ok(());
        };
        let result = self
            .run_admitted(admission, move |connection| {
                let _writer = writer;
                connection.busy_timeout(Duration::ZERO)?;
                let result = (|| {
                    let tx =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    operation(&tx)?;
                    tx.commit()?;
                    Ok(())
                })();
                connection.busy_timeout(Duration::from_secs(5))?;
                result
            })
            .await;
        match result {
            Err(AppError::Unavailable(_)) => Ok(()),
            result => result,
        }
    }

    pub async fn transaction<T, F>(&self, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> AppResult<T> + Send + 'static,
    {
        self.transaction_inner(operation, true).await
    }

    pub(crate) async fn delivery_transaction<T, F>(&self, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> AppResult<T> + Send + 'static,
    {
        self.transaction_inner(operation, false).await
    }

    pub(crate) async fn wait_for_changes(&self) {
        self.inner.changes.notified().await;
    }

    async fn transaction_inner<T, F>(&self, operation: F, notify: bool) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> AppResult<T> + Send + 'static,
    {
        let admission = self.admit()?;
        let waiting = Instant::now();
        let writer =
            tokio::time::timeout(ADMISSION_TIMEOUT, self.inner.writer.clone().acquire_owned())
                .await
                .map_err(|_| {
                    AppError::Unavailable("database writer is busy; try again shortly".to_owned())
                })?
                .map_err(|_| {
                    AppError::Unavailable("database executor is shutting down".to_owned())
                })?;
        let writer_wait_ms = waiting.elapsed().as_secs_f64() * 1_000.0;
        let changes = self.inner.changes.clone();
        self.run_admitted(admission, move |connection| {
            // A cancelled HTTP future must not admit another writer while its
            // already-started blocking operation is still running.
            let _writer = writer;
            let started = Instant::now();
            let changed_before = connection.total_changes();
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let lock_ms = started.elapsed().as_secs_f64() * 1_000.0;
            let executing = Instant::now();
            let result = operation(&transaction)?;
            let sql_ms = executing.elapsed().as_secs_f64() * 1_000.0;
            let committing = Instant::now();
            transaction.commit()?;
            // A hint only: the durable outbox remains authoritative. Delivery
            // transactions do not wake themselves or create an idle busy loop.
            if notify && connection.total_changes() != changed_before {
                changes.notify_one();
            }
            tracing::debug!(target: "oneloop::db::timing", writer_wait_ms, lock_ms, sql_ms,
                commit_ms = committing.elapsed().as_secs_f64() * 1_000.0,
                "database transaction");
            Ok(result)
        })
        .await
    }
}

fn take_connection(inner: &DbInner) -> AppResult<Connection> {
    if let Some(connection) = inner
        .connections
        .lock()
        .map_err(|_| AppError::internal("database connection pool was poisoned"))?
        .pop()
    {
        return Ok(connection);
    }
    open_connection(&inner.layout.database())
}

fn return_connection(inner: &DbInner, connection: Connection) {
    if let Ok(mut connections) = inner.connections.lock()
        && connections.len() < inner.max_connections
    {
        connections.push(connection);
    }
}

/// Opens an existing database. Only SQLite may open the database file, -wal
/// or -shm in a process that can hold connections: closing any other
/// descriptor of them drops every POSIX lock the process holds there. An older
/// SQLite client then believes no one uses the WAL and deletes it, so later
/// writes are lost.
pub(crate) fn open_connection(path: &Path) -> AppResult<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if connection.is_readonly(rusqlite::MAIN_DB)? {
        return Err(writable_error(path, "SQLite opened the database read-only"));
    }
    configure_connection(&connection).map_err(|error| {
        if matches!(error, AppError::Unavailable(_)) { return error; }
        AppError::PreconditionFailed(format!("cannot configure database {} (check database, -wal, -shm and directory permissions): {error}", path.display()))
    })?;
    Ok(connection)
}

pub(crate) fn configure_connection(connection: &Connection) -> AppResult<()> {
    connection.set_prepared_statement_cache_capacity(64);
    connection.create_scalar_function(
        "oneloop_lower",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |context| Ok(context.get_raw(0).as_str()?.to_lowercase()),
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA fullfsync = ON;
         PRAGMA checkpoint_fullfsync = ON;
         PRAGMA journal_size_limit = 67108864;
         PRAGMA temp_store = MEMORY;",
    )?;
    // Pool expansion must not wait behind an active writer merely to refresh
    // statistics. The supervised hourly pass retries any deferred work.
    connection.busy_timeout(Duration::ZERO)?;
    let optimize = connection.execute_batch("PRAGMA optimize=0x10002;");
    connection.busy_timeout(Duration::from_secs(5))?;
    match optimize {
        Ok(()) => {}
        Err(rusqlite::Error::SqliteFailure(error, _))
            if matches!(
                error.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub(crate) fn integrity_check(connection: &Connection) -> AppResult<()> {
    let result: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if result != "ok" {
        return Err(AppError::Database(format!(
            "SQLite integrity check failed: {result}"
        )));
    }
    let foreign_key_error: Option<(String, i64)> = connection
        .query_row(
            "SELECT \"table\", rowid FROM pragma_foreign_key_check LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((table, rowid)) = foreign_key_error {
        return Err(AppError::Database(format!(
            "foreign-key check failed for {table} row {rowid}"
        )));
    }
    Ok(())
}

/// Restrict newly created data directories without changing operator-owned paths.
pub(crate) fn create_private_directories(path: &Path) -> std::io::Result<()> {
    if path.is_dir() || path.as_os_str().is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        create_private_directories(parent)?;
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(error),
    }
    sync_directory(path)?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        sync_directory(parent)?;
    }
    Ok(())
}

pub(crate) fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

pub(crate) fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Creates a missing database file with private permissions, which SQLite
/// copies to the -wal and -shm files. An existing file is never opened here.
pub(crate) fn create_database_file(path: &Path) -> AppResult<()> {
    match private_file_options()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => {
            drop(file);
            if let Some(parent) = path.parent() {
                sync_directory(parent)?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(writable_error(path, error)),
    }
}

/// Checks write access by path, without a descriptor (see `open_connection`).
fn ensure_writable_without_opening(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    let result =
        rustix::fs::access(path, rustix::fs::Access::WRITE_OK).map_err(std::io::Error::from);
    #[cfg(not(unix))]
    let result = OpenOptions::new().write(true).open(path).map(drop);
    result.map_err(|error| writable_error(path, error))
}

fn writable_error(path: &Path, error: impl std::fmt::Display) -> AppError {
    AppError::PreconditionFailed(format!(
        "{} is not writable by this process; check owner/mode of the file, -wal, -shm and data directory: {error}",
        path.display()
    ))
}

fn warn_public_permissions(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
            eprintln!(
                "warning: {} has group/other permissions; keep instance data private to the service account",
                path.display()
            );
        }
    }
    Ok(())
}

fn wait_for_lock(file: &File, exclusive: bool, path: &Path) -> AppResult<()> {
    let start = Instant::now();
    loop {
        let result = if exclusive {
            file.try_lock()
        } else {
            file.try_lock_shared()
        };
        match result {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                if start.elapsed() >= ADMISSION_TIMEOUT {
                    return Err(AppError::Unavailable(format!(
                        "data lease is busy at {}; retry shortly",
                        path.display()
                    )));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(AppError::Io(format!("lock {}: {error}", path.display()))),
        }
    }
}

fn open_lock_file(path: &Path) -> AppResult<File> {
    if let Some(parent) = path.parent() {
        create_private_directories(parent)?;
    }
    private_file_options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(AppError::from)
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests;
