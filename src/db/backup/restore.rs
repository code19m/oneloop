//! Restoring a backup into a new or empty data directory.

use super::owner::{
    OwnerLock, WorkOwner, claim_abandoned, names_claimed_file, reclaim_partial_copies,
    remove_claimed_marker, remove_set_aside_markers,
};
use super::*;
use crate::db::{RESTORE_MARKER, create_private_directories};

/// Inside a restore's target: the folder the restore fills before it
/// publishes, followed by a UUID.
pub(super) const RESTORE_WORKING_PREFIX: &str = ".oneloop-restore-";

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
    create_private_directories(parent)?;
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
    create_private_directories(&target)?;
    // Check again: creating directories can change where the path leads.
    ensure_restore_target(&target)?;
    let marker = target.join(RESTORE_MARKER);
    let working = format!("{RESTORE_WORKING_PREFIX}{}", Uuid::now_v7());
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

/// Clears an interrupted restore from `target` when its marker proves the
/// restore is gone, so that the restore can start again. It removes only the
/// working folder and the names the marker lists as published, then the
/// marker. Otherwise it changes nothing, and the target stays refused.
pub(super) fn reclaim_interrupted_restore(target: &Path) -> AppResult<()> {
    remove_set_aside_markers(target)?;
    let marker = target.join(RESTORE_MARKER);
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
        name.strip_prefix(RESTORE_WORKING_PREFIX)
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
    notice!(
        "removed what an interrupted restore left in {}; restoring again",
        target.display()
    );
    Ok(())
}

/// A single file or folder name, with no path separators or dot segments.
pub(super) fn is_plain_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(part)) if part == name)
        && components.next().is_none()
}

pub(super) fn invalidate_restored_credentials(database_path: &Path) -> AppResult<()> {
    let mut connection = open_connection(database_path)?;
    let now = unix_now()?;
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

pub(super) fn ensure_restore_target(target: &Path) -> AppResult<()> {
    DataLayout::new(target).ensure_restore_complete()?;
    ensure_new_or_empty(target)
}

pub(super) fn ensure_new_or_empty(path: &Path) -> AppResult<()> {
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
