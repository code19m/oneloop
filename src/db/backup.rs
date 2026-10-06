use crate::clock::unix_now as unix_timestamp;
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
    config::normalize_path,
    db::{DataLayout, integrity_check, migration, open_connection},
    error::{AppError, AppResult},
};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024 * 1024;
/// Inside the data directory: links to the files a running backup copies.
const PINS: &str = ".oneloop-backup-pins";

const BACKUP_FORMAT_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
/// Inside a backup's working folder: the record of the process that writes it.
/// A restore keeps the same record in its restore marker.
const OWNER_FILE: &str = ".oneloop-owner";
const MAX_OWNER_BYTES: u64 = 64 * 1024;

/// Who writes a backup's working folder or a restore's target. The writer
/// holds an exclusive lock on the record until it publishes or removes its
/// work, so a later command can tell an interrupted operation from a running
/// one.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct WorkOwner {
    kind: String,
    host: String,
    pid: u32,
    data_dir: String,
    started_at: i64,
    /// Restores: the working folder inside the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    working: Option<String>,
    /// Restores: the names that publication moves into the target.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    publishes: Vec<String>,
}

impl WorkOwner {
    fn new(kind: &str, data_dir: &Path) -> AppResult<Self> {
        Ok(Self {
            kind: kind.to_owned(),
            host: host_name(),
            pid: std::process::id(),
            data_dir: data_dir.display().to_string(),
            started_at: unix_timestamp()?,
            working: None,
            publishes: Vec::new(),
        })
    }
}

/// An owner record, kept open and locked while this process works.
struct OwnerLock(File);

impl OwnerLock {
    fn create(path: &Path, owner: &WorkOwner) -> AppResult<Self> {
        let file = super::private_file_options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)?;
        // Waits only while a later command inspects the new, still empty record.
        file.lock()?;
        let lock = Self(file);
        lock.write(owner)?;
        Ok(lock)
    }

    fn write(&self, owner: &WorkOwner) -> AppResult<()> {
        let bytes = serde_json::to_vec(owner)
            .map_err(|error| AppError::internal(format!("serialize owner record: {error}")))?;
        let mut file = &self.0;
        file.set_len(0)?;
        std::io::Seek::rewind(&mut file)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    }
}

/// The lock and record of an owner file whose writer is gone: it ran on this
/// host, nothing holds its lock and its process no longer exists. None when
/// the work may still be in use, or when that can't be proven.
fn claim_abandoned(path: &Path) -> Option<(File, WorkOwner)> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .ok()?;
    file.try_lock().ok()?;
    let mut text = String::new();
    (&file)
        .take(MAX_OWNER_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    let owner: WorkOwner = serde_json::from_str(&text).ok()?;
    // A lock alone can't prove much on filesystems that ignore locks, or for
    // a process on another computer that shares the folder.
    (owner.host == host_name() && !process_alive(owner.pid)).then_some((file, owner))
}

fn host_name() -> String {
    #[cfg(unix)]
    {
        rustix::system::uname()
            .nodename()
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

/// Whether a process with this ID exists. A process of another account
/// counts as running.
fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Some(pid) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return true;
        };
        !matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

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
            created_at: unix_timestamp()?,
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

pub fn restore_backup(
    backup: impl AsRef<Path>,
    data_dir: impl Into<PathBuf>,
) -> AppResult<PathBuf> {
    let backup = absolute_path(backup.as_ref())?;
    let target = absolute_path(&data_dir.into())?;
    if backup.starts_with(&target) || target.starts_with(&backup) {
        return Err(AppError::PreconditionFailed(
            "backup source cannot be inside the restore target".to_owned(),
        ));
    }
    // Check the backup before removing anything, so that a wrong backup path
    // leaves an interrupted restore as it is.
    let manifest = validate_backup(&backup)?;
    if let Some(parent) = target.parent().filter(|path| path.is_dir()) {
        reclaim_partial_copies(parent);
    }
    if target.is_dir() {
        reclaim_interrupted_restore(&target)?;
        reclaim_partial_copies(&target);
    }
    ensure_restore_target(&target)?;
    let parent = target.parent().ok_or_else(|| {
        AppError::validation(
            "data directory",
            "restore target must have a parent directory",
        )
    })?;
    super::create_private_directories(parent)?;
    let canonical_backup = fs::canonicalize(&backup)?;
    let canonical_target = fs::canonicalize(parent)?.join(
        target
            .file_name()
            .ok_or_else(|| AppError::validation("data directory", "file name is required"))?,
    );
    if canonical_target.starts_with(&canonical_backup) {
        return Err(AppError::PreconditionFailed(
            "restore target cannot be inside the backup source".to_owned(),
        ));
    }
    // Stage on the target filesystem without replacing an operator-owned
    // directory or mount point. The durable marker prevents partial publication
    // from being mistaken for an initialized instance after a crash.
    super::create_private_directories(&target)?;
    // Check again: creating directories can change where the path leads.
    ensure_restore_target(&target)?;
    let marker = target.join(super::RESTORE_MARKER);
    let working = format!(".oneloop-restore-{}", Uuid::now_v7());
    let mut owner = WorkOwner::new("restore", &target)?;
    owner.working = Some(working.clone());
    let marker_lock = OwnerLock::create(&marker, &owner).map_err(|error| {
        AppError::PreconditionFailed(format!(
            "restore target {} must be writable: {error}",
            target.display()
        ))
    })?;
    sync_directory(&target)?;
    let partial = target.join(&working);
    let mut publishing = false;
    let result = (|| {
        fs::create_dir(&partial)?;
        secure_directory(&partial)?;
        for entry in &manifest.files {
            let source = backup.join(&entry.path);
            let relative = Path::new(&entry.path).strip_prefix("data").map_err(|_| {
                AppError::PreconditionFailed(format!(
                    "backup entry is outside data/: {}",
                    entry.path
                ))
            })?;
            if relative
                .components()
                .next()
                .is_some_and(|part| part.as_os_str().to_string_lossy().starts_with(".oneloop-"))
            {
                return Err(AppError::PreconditionFailed(
                    "backup entry uses a reserved restore path".to_owned(),
                ));
            }
            copy_regular_file(&source, &partial.join(relative))?;
        }
        invalidate_restored_credentials(&partial.join("oneloop.sqlite3"))?;
        DataLayout::new(&partial).ensure_runtime_directories()?;
        sync_tree_directories(&partial)?;
        // Record what publication adds to the target before it starts, so a
        // later restore can remove exactly that after an interruption.
        owner.publishes = fs::read_dir(&partial)?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<_>>()?;
        marker_lock.write(&owner)?;
        publishing = true;
        for entry in fs::read_dir(&partial)? {
            let entry = entry?;
            let destination = target.join(entry.file_name());
            if destination.try_exists()? {
                return Err(AppError::PreconditionFailed(format!(
                    "restore destination appeared during publication: {}",
                    destination.display()
                )));
            }
            fs::rename(entry.path(), destination)?;
        }
        fs::remove_dir(&partial)?;
        sync_directory(&target)?;
        fs::remove_file(&marker)?;
        sync_directory(&target)?;
        Ok(target.clone())
    })();

    if result.is_err() && !publishing {
        // Only remove the marker once the unpublished staging tree is gone.
        if !partial.exists() || fs::remove_dir_all(&partial).is_ok() {
            let _ = fs::remove_file(&marker);
            let _ = sync_directory(&target);
        }
    }
    drop(marker_lock);
    result
}

/// Removes working folders that interrupted backups left in `parent`, when
/// their owner record proves the backup is gone (see `claim_abandoned`).
/// Other working folders are only reported: another process may still be
/// writing them, or they come from another computer or an older version.
fn reclaim_partial_copies(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(".oneloop-restore-")
            || (name.starts_with('.') && name.contains(".partial-")))
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let path = entry.path();
        if let Some((lock, owner)) = claim_abandoned(&path.join(OWNER_FILE)) {
            match remove_claimed(&path, lock) {
                Ok(()) => {
                    let _ = sync_directory(parent);
                    eprintln!(
                        "removed the copy of an interrupted backup of {}: {}",
                        owner.data_dir,
                        path.display()
                    );
                }
                Err(error) => eprintln!(
                    "warning: cannot remove the copy of an interrupted backup {}: {error}",
                    path.display()
                ),
            }
            continue;
        }
        let mut bytes = 0_u64;
        let mut incomplete = false;
        for item in WalkDir::new(&path).follow_links(false) {
            match item {
                Ok(item) if item.file_type().is_file() => match item.metadata() {
                    Ok(metadata) => bytes = bytes.saturating_add(metadata.len()),
                    Err(_) => incomplete = true,
                },
                Err(_) => incomplete = true,
                _ => {}
            }
        }
        eprintln!(
            "possible interrupted backup/restore copy: {} ({} bytes{}); after confirming no backup or restore is running, remove this directory manually",
            path.display(),
            bytes,
            if incomplete { ", size incomplete" } else { "" }
        );
    }
}

/// Removes a claimed working folder. Its owner record goes last, and only
/// after its lock is closed: network filesystems keep a deleted file that is
/// still open under another name, which would keep the folder in place. When
/// something can't be removed, the record stays, so that a later command can
/// claim the folder again and finish.
fn remove_claimed(path: &Path, lock: File) -> std::io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_name() == OWNER_FILE {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    drop(lock);
    fs::remove_file(path.join(OWNER_FILE))?;
    fs::remove_dir(path)
}

/// Clears an interrupted restore from `target` when its marker proves the
/// restore is gone, so that the restore can start again. It removes only the
/// working folder and the names the marker lists as published, then the
/// marker. Otherwise it changes nothing, and the target stays refused.
fn reclaim_interrupted_restore(target: &Path) -> AppResult<()> {
    remove_set_aside_markers(target)?;
    let marker = target.join(super::RESTORE_MARKER);
    if !marker.try_exists()? {
        return Ok(());
    }
    let refused = || {
        AppError::PreconditionFailed(format!(
            "incomplete restore at {}; another restore may still be running, or the interrupted one ran on another computer or with an older oneloop; when no restore is running, empty the directory, including hidden files, and restore again",
            target.display()
        ))
    };
    let Some((lock, owner)) = claim_abandoned(&marker) else {
        return Err(refused());
    };
    let working = owner.working.as_deref().filter(|name| {
        name.strip_prefix(".oneloop-restore-")
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
    });
    let published = owner
        .publishes
        .iter()
        .all(|name| is_plain_name(name) && !name.starts_with(".oneloop-"));
    if owner.kind != "restore"
        || working.is_none()
        || !published
        || !names_claimed_file(&marker, &lock)?
    {
        return Err(refused());
    }
    for name in working
        .into_iter()
        .chain(owner.publishes.iter().map(String::as_str))
    {
        let path = target.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&path)?,
            Ok(_) => fs::remove_file(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if !remove_claimed_marker(&marker, lock)? {
        return Err(refused());
    }
    sync_directory(target)?;
    eprintln!(
        "removed what an interrupted restore left in {}; restoring again",
        target.display()
    );
    Ok(())
}

/// Whether `path` still names the file `claimed` has open. Another restore
/// may have removed a claimed marker and written its own in its place.
fn names_claimed_file(path: &Path, claimed: &File) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let claimed = claimed.metadata()?;
        match fs::symlink_metadata(path) {
            Ok(current) => Ok(current.dev() == claimed.dev() && current.ino() == claimed.ino()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = claimed;
        Ok(path.exists())
    }
}

/// Closes a claimed restore marker and removes it (see `remove_claimed`),
/// unless the path names another file by now.
fn remove_claimed_marker(marker: &Path, lock: File) -> std::io::Result<bool> {
    let Some(aside) = set_aside_claimed_marker(marker, &lock)? else {
        return Ok(false);
    };
    drop(lock);
    match fs::remove_file(aside) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(true),
    }
}

/// Removes markers that a restore set aside and couldn't remove, because it
/// ended in between (see `set_aside_claimed_marker`). Nothing holds them.
fn remove_set_aside_markers(target: &Path) -> std::io::Result<()> {
    let prefix = format!("{}.removed-", super::RESTORE_MARKER);
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        let set_aside = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix(&prefix))
            .is_some_and(|id| Uuid::parse_str(id).is_ok());
        if !set_aside || !entry.file_type()?.is_file() {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// Renames a claimed restore marker to a name of its own, unless the path
/// names another file by now, and returns the new name. While the claimed
/// file is open and locked, no other restore can claim or replace it, so the
/// check holds for the rename. Once the lock is closed, the marker's path is
/// already free: removing the renamed file can't take a marker that another
/// restore writes meanwhile.
fn set_aside_claimed_marker(marker: &Path, lock: &File) -> std::io::Result<Option<PathBuf>> {
    if !names_claimed_file(marker, lock)? {
        return Ok(None);
    }
    let aside = marker.with_file_name(format!(
        "{}.removed-{}",
        super::RESTORE_MARKER,
        Uuid::now_v7()
    ));
    fs::rename(marker, &aside)?;
    Ok(Some(aside))
}

/// A single file or folder name, with no path separators or dot segments.
fn is_plain_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(part)) if part == name)
        && components.next().is_none()
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
            eprintln!(
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

fn invalidate_restored_credentials(database_path: &Path) -> AppResult<()> {
    let mut connection = open_connection(database_path)?;
    let now = unix_timestamp()?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?1)",
        [now],
    )?;
    transaction.execute(
        "UPDATE mcp_grants SET revoked_at = COALESCE(revoked_at, ?1), revision = revision + 1",
        [now],
    )?;
    transaction.execute(
        "UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, ?1)",
        [now],
    )?;
    // A restored unused authorization code could otherwise mint a new grant
    // after a credential was revoked in the source instance. Legacy schema-1 backups
    // predate these short-lived authorization and transfer tables.
    for table in [
        "oauth_authorization_codes",
        "oauth_authorization_requests",
        "mcp_file_transfers",
    ] {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?;
        if exists {
            transaction.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    transaction.execute("DELETE FROM file_leases", [])?;
    transaction.execute(
        "UPDATE idempotency_keys SET state='failed', updated_at=?1
         WHERE operation='attachment.upload' AND state='running'",
        [now],
    )?;
    transaction.execute(
        "DELETE FROM upload_reservations WHERE committed_at IS NULL",
        [],
    )?;
    transaction.execute(
        "INSERT INTO app_metadata(key, value, updated_at) VALUES ('restored_at', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![now.to_string(), now],
    )?;
    transaction.commit()?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    integrity_check(&connection)?;
    Ok(())
}

fn ensure_restore_target(target: &Path) -> AppResult<()> {
    DataLayout::new(target).ensure_restore_complete()?;
    ensure_new_or_empty(target)
}

fn ensure_new_or_empty(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::PreconditionFailed(format!(
            "restore target is not an empty directory: {}",
            path.display()
        )));
    }
    if fs::read_dir(path)?.next().transpose()?.is_some() {
        return Err(AppError::PreconditionFailed(format!(
            "restore target is not empty: {}",
            path.display()
        )));
    }
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

fn sync_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
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
