//! The owner record of a backup's working folder or a restore's target, and
//! the cleanup of work that an interrupted command left behind.

use super::restore::RESTORE_WORKING_PREFIX;
use super::*;
use crate::db::{RESTORE_MARKER, private_file_options};

/// Inside a backup's working folder: the record of the process that writes it.
/// A restore keeps the same record in its restore marker.
pub(super) const OWNER_FILE: &str = ".oneloop-owner";
pub(super) const MAX_OWNER_BYTES: u64 = 64 * 1024;

/// Who writes a backup's working folder or a restore's target. The writer
/// holds an exclusive lock on the record until it publishes or removes its
/// work, so a later command can tell an interrupted operation from a running
/// one.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct WorkOwner {
    pub(super) kind: String,
    pub(super) host: String,
    pub(super) pid: u32,
    pub(super) data_dir: String,
    pub(super) started_at: i64,
    /// Restores: the working folder inside the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) working: Option<String>,
    /// Restores: the names that publication moves into the target.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) publishes: Vec<String>,
}

impl WorkOwner {
    pub(super) fn new(kind: &str, data_dir: &Path) -> AppResult<Self> {
        Ok(Self {
            kind: kind.to_owned(),
            host: host_name(),
            pid: std::process::id(),
            data_dir: data_dir.display().to_string(),
            started_at: unix_now()?,
            working: None,
            publishes: Vec::new(),
        })
    }
}

/// An owner record, kept open and locked while this process works.
pub(super) struct OwnerLock(File);

impl OwnerLock {
    pub(super) fn create(path: &Path, owner: &WorkOwner) -> AppResult<Self> {
        let file = private_file_options()
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

    pub(super) fn write(&self, owner: &WorkOwner) -> AppResult<()> {
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
pub(super) fn claim_abandoned(path: &Path) -> Option<(File, WorkOwner)> {
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

pub(super) fn host_name() -> String {
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
pub(super) fn process_alive(pid: u32) -> bool {
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

/// Removes working folders that interrupted backups left in `parent`, when
/// their owner record proves the backup is gone (see `claim_abandoned`).
/// Other working folders are only reported: another process may still be
/// writing them, or they come from another computer or an older version.
pub(super) fn reclaim_partial_copies(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(RESTORE_WORKING_PREFIX)
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
                    notice!(
                        "removed the copy of an interrupted backup of {}: {}",
                        owner.data_dir,
                        path.display()
                    );
                }
                Err(error) => notice!(
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
        notice!(
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
pub(super) fn remove_claimed(path: &Path, lock: File) -> std::io::Result<()> {
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

/// Whether `path` still names the file `claimed` has open. Another restore
/// may have removed a claimed marker and written its own in its place.
pub(super) fn names_claimed_file(path: &Path, claimed: &File) -> std::io::Result<bool> {
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
pub(super) fn remove_claimed_marker(marker: &Path, lock: File) -> std::io::Result<bool> {
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
pub(super) fn remove_set_aside_markers(target: &Path) -> std::io::Result<()> {
    let prefix = format!("{}.removed-", RESTORE_MARKER);
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
pub(super) fn set_aside_claimed_marker(
    marker: &Path,
    lock: &File,
) -> std::io::Result<Option<PathBuf>> {
    if !names_claimed_file(marker, lock)? {
        return Ok(None);
    }
    let aside = marker.with_file_name(format!("{}.removed-{}", RESTORE_MARKER, Uuid::now_v7()));
    fs::rename(marker, &aside)?;
    Ok(Some(aside))
}
