//! Creating and validating backups: a consistent copy of the database and of
//! the files it references, with a manifest of their checksums.

use std::{
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use rusqlite::{
    Connection,
    backup::{Backup, StepResult},
    params,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    build_info,
    clock::unix_now,
    config::normalize_path,
    db::{DataLayout, integrity_check, migration, open_connection, sync_directory},
    error::{AppError, AppResult},
};

mod owner;
mod restore;

use owner::*;
pub use restore::restore_backup;
use restore::*;

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024 * 1024;
/// Inside the data directory: links to the files a running backup copies.
const PINS: &str = ".oneloop-backup-pins";

const BACKUP_FORMAT_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupManifest {
    pub format_version: u32,
    pub application_version: String,
    pub application_revision: String,
    pub schema_version: i64,
    pub created_at: i64,
    pub files: Vec<BackupFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

pub fn create_backup(
    data_dir: impl Into<PathBuf>,
    destination: impl AsRef<Path>,
) -> AppResult<PathBuf> {
    let layout = DataLayout::new(data_dir);
    if !layout.database().is_file() {
        return Err(AppError::PreconditionFailed(format!(
            "database is not initialized at {}; check ONELOOP_DATA_DIR",
            layout.database().display()
        )));
    }
    let _instance = layout.open_instance_shared_lock()?;
    let _backup = layout.backup_lock()?;
    if let Some(parent) = absolute_path(destination.as_ref())?.parent() {
        reclaim_partial_copies(parent);
    }
    let lock = layout.open_exclusive_lock()?;
    let connection = open_connection(&layout.database())?;
    migration::ensure_current_schema(&connection)?;
    create_backup_inner(&layout, destination.as_ref(), &connection, Some(lock))
}

pub(crate) fn create_backup_while_locked(
    layout: &DataLayout,
    destination: &Path,
    source_connection: &Connection,
) -> AppResult<PathBuf> {
    let _backup = layout.backup_lock()?;
    if let Some(parent) = absolute_path(destination)?.parent() {
        reclaim_partial_copies(parent);
    }
    create_backup_inner(layout, destination, source_connection, None)
}

fn create_backup_inner(
    layout: &DataLayout,
    destination: &Path,
    source_connection: &Connection,
    data_lock: Option<File>,
) -> AppResult<PathBuf> {
    let destination = absolute_path(destination)?;
    let data_root = absolute_path(layout.root())?;
    if destination.exists() {
        return Err(AppError::Conflict(format!(
            "backup destination already exists: {}",
            destination.display()
        )));
    }
    let parent = destination.parent().ok_or_else(|| {
        AppError::validation(
            "destination",
            "backup destination must have a parent directory",
        )
    })?;
    if !parent.is_dir() {
        return Err(AppError::PreconditionFailed(format!(
            "backup destination parent does not exist: {}",
            parent.display()
        )));
    }
    let canonical_data_root = fs::canonicalize(&data_root)?;
    let canonical_destination = fs::canonicalize(parent)?.join(
        destination
            .file_name()
            .ok_or_else(|| AppError::validation("destination", "file name is required"))?,
    );
    if destination.starts_with(&data_root)
        || canonical_destination.starts_with(&canonical_data_root)
    {
        return Err(AppError::PreconditionFailed(
            "backup destination cannot be inside the live data directory".to_owned(),
        ));
    }
    let partial = parent.join(format!(
        ".{}.partial-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("oneloop-backup"),
        Uuid::now_v7()
    ));

    // Only one backup uses this area at a time. Reclaim pins left by an interrupted
    // process before starting; pins are links, never the live original directory.
    let pins = BackupPins::new(layout.root().join(PINS))?;
    let mut partial_created = false;
    let result = (|| {
        fs::create_dir(&partial)?;
        partial_created = true;
        secure_directory(&partial)?;
        let owner = OwnerLock::create(
            &partial.join(OWNER_FILE),
            &WorkOwner::new("backup", &data_root)?,
        )?;
        let backup_data = partial.join("data");
        fs::create_dir(&backup_data)?;
        secure_directory(&backup_data)?;
        let database_target = backup_data.join("oneloop.sqlite3");
        snapshot_database(source_connection, &database_target)?;

        let snapshot = Connection::open_with_flags(
            &database_target,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let blobs = referenced_blobs(&snapshot)?;
        preflight_manifest(&blobs, &layout.keys(), MAX_MANIFEST_BYTES)?;
        pin_blobs(layout, &pins.0, &blobs)?;
        // Keys are small and are copied while file coordination is still held.
        let mut files = Vec::new();
        copy_regular_tree(
            &layout.keys(),
            &backup_data.join("keys"),
            &partial,
            &mut files,
        )?;
        drop(data_lock);
        // All metadata comes from the snapshot, never from a later live query.
        files.push(manifest_entry(&partial, &database_target)?);
        copy_referenced_blobs(&pins.0, &partial, &blobs, &mut files)?;
        files.sort_by(|left, right| left.path.cmp(&right.path));

        let manifest = BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            application_version: build_info::VERSION.to_owned(),
            application_revision: build_info::REVISION.to_owned(),
            schema_version: migration::inspect_schema_version(&snapshot)?,
            created_at: unix_now()?,
            files,
        };
        write_manifest(&partial, &manifest)?;
        validate_backup(&partial)?;
        // The published backup has no owner record; the lock lasts until it is.
        fs::remove_file(partial.join(OWNER_FILE))?;
        sync_tree_directories(&partial)?;
        fs::rename(&partial, &destination)?;
        drop(owner);
        sync_directory(parent)?;
        Ok(destination.clone())
    })();

    if result.is_err() && partial_created && partial.exists() {
        let _ = fs::remove_dir_all(&partial);
    }
    result
}

pub fn validate_backup(path: impl AsRef<Path>) -> AppResult<BackupManifest> {
    let root = path.as_ref();
    if !root.is_dir() {
        return Err(AppError::PreconditionFailed(format!(
            "backup directory does not exist: {}",
            root.display()
        )));
    }
    let manifest_path = root.join(MANIFEST_FILE);
    let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
        AppError::PreconditionFailed(format!(
            "cannot read backup manifest {}: {error}",
            manifest_path.display()
        ))
    })?;
    if !manifest_metadata.file_type().is_file() || manifest_metadata.len() > MAX_MANIFEST_BYTES {
        return Err(AppError::PreconditionFailed(
            "backup manifest must be a regular file no larger than 1 GiB".to_owned(),
        ));
    }
    let bytes = fs::read(&manifest_path).map_err(|error| {
        AppError::PreconditionFailed(format!(
            "cannot read backup manifest {}: {error}",
            manifest_path.display()
        ))
    })?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::PreconditionFailed(format!("backup manifest is invalid: {error}"))
    })?;
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(AppError::PreconditionFailed(format!(
            "unsupported backup format {}",
            manifest.format_version
        )));
    }
    if manifest.files.is_empty() {
        return Err(AppError::PreconditionFailed(
            "backup manifest contains no files".to_owned(),
        ));
    }

    let canonical_root = fs::canonicalize(root)?;
    let mut previous: Option<&str> = None;
    for entry in &manifest.files {
        validate_relative_path(&entry.path)?;
        if previous.is_some_and(|path| path >= entry.path.as_str()) {
            return Err(AppError::PreconditionFailed(
                "backup manifest paths must be unique and sorted".to_owned(),
            ));
        }
        previous = Some(&entry.path);
        let file_path = root.join(&entry.path);
        let metadata = fs::symlink_metadata(&file_path).map_err(|error| {
            AppError::PreconditionFailed(format!("backup file {} is missing: {error}", entry.path))
        })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::PreconditionFailed(format!(
                "backup entry {} is not a regular file",
                entry.path
            )));
        }
        let canonical_file = fs::canonicalize(&file_path)?;
        if !canonical_file.starts_with(&canonical_root) {
            return Err(AppError::PreconditionFailed(format!(
                "backup entry {} escapes the backup directory",
                entry.path
            )));
        }
        if metadata.len() != entry.size_bytes {
            return Err(AppError::PreconditionFailed(format!(
                "backup file {} has the wrong size",
                entry.path
            )));
        }
        if hash_file(&file_path)? != entry.sha256 {
            return Err(AppError::PreconditionFailed(format!(
                "backup file {} failed checksum validation",
                entry.path
            )));
        }
    }
    if !manifest
        .files
        .iter()
        .any(|file| file.path == "data/oneloop.sqlite3")
    {
        return Err(AppError::PreconditionFailed(
            "backup does not contain the database".to_owned(),
        ));
    }
    let database = Connection::open_with_flags(
        root.join("data/oneloop.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let actual_schema_version = migration::ensure_supported_schema(&database)?;
    if actual_schema_version != manifest.schema_version {
        return Err(AppError::PreconditionFailed(format!(
            "backup manifest schema {} does not match database schema {actual_schema_version}",
            manifest.schema_version
        )));
    }
    integrity_check(&database)?;
    // The snapshot defines completeness; a self-consistent manifest alone can
    // omit an available blob or the key needed to decrypt stored credentials.
    for blob in referenced_blobs(&database)? {
        validate_relative_path(&blob.key)?;
        let path = format!("data/files/{}", blob.key);
        let entry = manifest
            .files
            .binary_search_by(|entry| entry.path.cmp(&path))
            .ok()
            .map(|index| &manifest.files[index])
            .ok_or_else(|| blob.failure("is missing from the backup manifest"))?;
        if entry.size_bytes != blob.size || entry.sha256 != blob.checksum {
            return Err(blob.failure("does not match the snapshot's size/checksum"));
        }
    }
    // Pre-Knowledge backups remain valid, including the frozen legacy chain.
    let has_knowledge: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='knowledge_sources')",
        [], |row| row.get(0),
    )?;
    if has_knowledge {
        let encrypted_credentials: bool = database.query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_sources WHERE token_ciphertext IS NOT NULL)
             OR EXISTS(SELECT 1 FROM knowledge_deploy_keys)",
            [],
            |row| row.get(0),
        )?;
        if encrypted_credentials
            && !manifest
                .files
                .iter()
                .any(|entry| entry.path == "data/keys/knowledge.key")
        {
            return Err(AppError::PreconditionFailed(
                "backup requires keys/knowledge.key to decrypt stored Knowledge credentials"
                    .to_owned(),
            ));
        }
    }
    Ok(manifest)
}

fn snapshot_database(source: &Connection, destination: &Path) -> AppResult<()> {
    super::private_file_options()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut target = Connection::open(destination)?;
    target.execute_batch(
        "PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA synchronous=FULL;",
    )?;
    {
        let backup = Backup::new(source, &mut target)?;
        let started = Instant::now();
        loop {
            match backup.step(-1)? {
                StepResult::Done => break,
                StepResult::Busy | StepResult::Locked
                    if started.elapsed() < Duration::from_secs(5) =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    return Err(AppError::Unavailable(
                        "database snapshot is busy; retry backup shortly".to_owned(),
                    ));
                }
            }
        }
    }
    target.pragma_update(None, "journal_mode", "DELETE")?;
    // The complete backup is validated after file pins release the live data
    // lock, before publication. Do not duplicate that expensive scan here.
    drop(target);
    sync_file(destination)
}

/// Removes the links that an interrupted backup left in the data directory,
/// unless a backup runs now. They would keep deleted files on disk until the
/// next backup. Returns whether there were any.
pub(crate) fn remove_abandoned_backup_pins(layout: &DataLayout) -> AppResult<bool> {
    let pins = layout.root().join(PINS);
    if !pins.try_exists()? {
        return Ok(false);
    }
    let Some(_backup) = layout.try_backup_lock()? else {
        return Ok(false);
    };
    fs::remove_dir_all(&pins)?;
    Ok(true)
}

struct BackupPins(PathBuf);

impl BackupPins {
    fn new(path: PathBuf) -> AppResult<Self> {
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }
        fs::create_dir(&path)?;
        secure_directory(&path)?;
        Ok(Self(path))
    }
}

impl Drop for BackupPins {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            notice!(
                "warning: cannot remove backup pins {}: {error}; the next backup will retry",
                self.0.display()
            );
        }
    }
}

struct ReferencedBlob {
    key: String,
    size: u64,
    checksum: String,
    owner: String,
}

impl ReferencedBlob {
    fn failure(&self, reason: impl std::fmt::Display) -> AppError {
        AppError::PreconditionFailed(format!(
            "referenced file {} ({}) {reason}; restore this file from an earlier backup or remove the attachment/avatar in the UI, then retry",
            self.key, self.owner
        ))
    }
}

fn referenced_blobs(connection: &Connection) -> AppResult<Vec<ReferencedBlob>> {
    let mut statement = connection.prepare(
        "SELECT b.storage_key,b.size_bytes,b.checksum_sha256,
         CASE WHEN a.id IS NOT NULL THEN 'task ' || t.task_key || ', attachment ' || a.original_name
              WHEN u.id IS NOT NULL THEN 'avatar for user ' || u.username
              ELSE 'unlinked blob ' || b.id END
         FROM file_blobs b
         LEFT JOIN task_attachments a ON a.blob_id=b.id
         LEFT JOIN tasks t ON t.id=a.task_id
         LEFT JOIN users u ON u.avatar_blob_id=b.id
         WHERE b.state='available' ORDER BY b.storage_key",
    )?;
    let blobs = statement
        .query_map([], |row| {
            Ok(ReferencedBlob {
                key: row.get(0)?,
                size: row.get::<_, i64>(1)?.max(0) as u64,
                checksum: row.get(2)?,
                owner: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(blobs)
}

fn preflight_manifest(blobs: &[ReferencedBlob], keys: &Path, limit: u64) -> AppResult<()> {
    // Conservative upper bound, including JSON escaping and envelope fields.
    // Do this before linking/copying any originals, not after a large backup.
    let mut estimate = 4096_u64;
    for blob in blobs {
        estimate = estimate.saturating_add(256 + (blob.key.len() as u64).saturating_mul(6));
    }
    if keys.exists() {
        for item in WalkDir::new(keys).follow_links(false) {
            let item = item.map_err(|error| AppError::Io(error.to_string()))?;
            if item.file_type().is_file() {
                estimate = estimate
                    .saturating_add(256 + (item.path().as_os_str().len() as u64).saturating_mul(6));
            }
        }
    }
    if estimate > limit {
        return Err(AppError::PreconditionFailed(format!(
            "backup manifest estimate {estimate} bytes exceeds the {limit}-byte safety limit; no originals were copied"
        )));
    }
    Ok(())
}

fn pin_blobs(layout: &DataLayout, pins: &Path, blobs: &[ReferencedBlob]) -> AppResult<()> {
    for blob in blobs {
        validate_relative_path(&blob.key)?;
        let source = layout.files().join(&blob.key);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| blob.failure(format!("is unavailable: {error}")))?;
        if !metadata.file_type().is_file() || metadata.len() != blob.size {
            return Err(blob.failure("does not match its metadata"));
        }
        let destination = pins.join(&blob.key);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::hard_link(&source, &destination).is_err() {
            // Preserve backups on filesystems without hard links or a separate
            // files mount. This slower fallback still only pauses file operations.
            copy_regular_file(&source, &destination)
                .map_err(|error| blob.failure(format!("cannot be pinned for backup: {error}")))?;
        }
    }
    Ok(())
}

fn copy_referenced_blobs(
    pins: &Path,
    backup_root: &Path,
    blobs: &[ReferencedBlob],
    entries: &mut Vec<BackupFile>,
) -> AppResult<()> {
    for blob in blobs {
        let destination = backup_root.join("data/files").join(&blob.key);
        let (size, checksum) = copy_and_hash(&pins.join(&blob.key), &destination)?;
        if size != blob.size || checksum != blob.checksum {
            return Err(blob.failure("failed checksum/size validation"));
        }
        entries.push(BackupFile {
            path: format!("data/files/{}", blob.key),
            size_bytes: size,
            sha256: checksum,
        });
    }
    Ok(())
}

fn copy_and_hash(source: &Path, destination: &Path) -> AppResult<(u64, String)> {
    create_private_parent(destination)?;
    let mut input = File::open(source)?;
    let mut output = super::private_file_options()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        size += read as u64;
    }
    output.sync_all()?;
    Ok((size, hex::encode(digest.finalize())))
}

fn sync_tree_directories(root: &Path) -> AppResult<()> {
    for entry in WalkDir::new(root).contents_first(true).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(error.to_string()))?;
        if entry.file_type().is_dir() {
            sync_directory(entry.path())?;
        }
    }
    Ok(())
}

fn copy_regular_tree(
    source_root: &Path,
    destination_root: &Path,
    backup_root: &Path,
    entries: &mut Vec<BackupFile>,
) -> AppResult<()> {
    if !source_root.exists() {
        return Ok(());
    }
    for item in WalkDir::new(source_root).follow_links(false) {
        let item = item.map_err(|error| AppError::Io(error.to_string()))?;
        if item.path() == source_root {
            continue;
        }
        let relative = item.path().strip_prefix(source_root).map_err(|error| {
            AppError::internal(format!("cannot relativize backup path: {error}"))
        })?;
        let destination = destination_root.join(relative);
        if item.file_type().is_dir() {
            create_private_dir_all(&destination)?;
        } else if item.file_type().is_file() {
            copy_regular_file(item.path(), &destination)?;
            entries.push(manifest_entry(backup_root, &destination)?);
        } else {
            return Err(AppError::PreconditionFailed(format!(
                "backup source contains a symlink or special file: {}",
                item.path().display()
            )));
        }
    }
    Ok(())
}

fn manifest_entry(root: &Path, path: &Path) -> AppResult<BackupFile> {
    let relative = path.strip_prefix(root).map_err(|error| {
        AppError::internal(format!("cannot create backup manifest path: {error}"))
    })?;
    let path_string = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    let metadata = fs::metadata(path)?;
    Ok(BackupFile {
        path: path_string,
        size_bytes: metadata.len(),
        sha256: hash_file(path)?,
    })
}

fn write_manifest(root: &Path, manifest: &BackupManifest) -> AppResult<()> {
    let path = root.join(MANIFEST_FILE);
    let mut writer = BufWriter::new(
        super::private_file_options()
            .write(true)
            .create_new(true)
            .open(&path)?,
    );
    serde_json::to_writer(&mut writer, manifest)
        .map_err(|error| AppError::internal(format!("serialize backup manifest: {error}")))?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(())
}

fn validate_relative_path(raw: &str) -> AppResult<()> {
    if raw.is_empty() || raw.contains('\\') {
        return Err(AppError::PreconditionFailed(format!(
            "unsafe backup path: {raw:?}"
        )));
    }
    let path = Path::new(raw);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::PreconditionFailed(format!(
            "unsafe backup path: {raw:?}"
        )));
    }
    Ok(())
}

fn copy_regular_file(source: &Path, destination: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.file_type().is_file() {
        return Err(AppError::PreconditionFailed(format!(
            "source is not a regular file: {}",
            source.display()
        )));
    }
    create_private_parent(destination)?;
    fs::copy(source, destination)?;
    secure_file(destination)?;
    sync_file(destination)
}

fn create_private_parent(path: &Path) -> AppResult<()> {
    match path.parent() {
        Some(parent) => create_private_dir_all(parent),
        None => Ok(()),
    }
}

/// Creates missing folders that only the owner can open, like the live data
/// directory's. Callers sync the whole copied tree once when it is complete.
fn create_private_dir_all(path: &Path) -> AppResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

fn secure_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn secure_file(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn sync_file(path: &Path) -> AppResult<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn absolute_path(path: &Path) -> AppResult<PathBuf> {
    if path.is_absolute() {
        normalize_path(path)
    } else {
        normalize_path(&std::env::current_dir()?.join(path))
    }
}

#[cfg(test)]
mod tests;
