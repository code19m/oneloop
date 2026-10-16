//! Recovery after a crash, the minute's upkeep of uploads and deletion jobs,
//! and reconciliation, which also removes files that nothing refers to.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use rusqlite::params;

use super::{FileRuntimeReport, FileService};
use crate::{AppError, AppResult, clock::unix_now, files::UPLOAD_RESERVATION_SECONDS};

impl FileService {
    /// Only call before accepting traffic while holding the server lock.
    pub(crate) async fn recover_interrupted_uploads(&self) -> AppResult<()> {
        let now = unix_now()?;
        self.db
            .transaction(move |tx| {
                tx.execute(
                    "UPDATE idempotency_keys SET state='failed',updated_at=?1
                WHERE operation='attachment.upload' AND resource_type='upload_reservation'
                AND state='running' AND resource_id IN
                (SELECT id FROM upload_reservations WHERE committed_at IS NULL)",
                    [now],
                )?;
                // This runs under the exclusive server lock: no live HTTP read owns these.
                // Backup pins use the separate data/backup locks, not these rows.
                tx.execute(
                    "DELETE FROM file_leases WHERE lease_kind IN ('download','preview')",
                    [],
                )?;
                // Interrupted avatar writes have no live owner either.
                tx.execute(
                    "UPDATE file_blobs SET created_at=min(created_at,?1) WHERE state='pending'",
                    [now - UPLOAD_RESERVATION_SECONDS],
                )?;
                // Retain rows until reconciliation removes staging bytes successfully.
                // Repeating startup after another crash remains safe.
                tx.execute(
                    "UPDATE upload_reservations SET expires_at=?1 WHERE committed_at IS NULL",
                    [now],
                )?;
                Ok(())
            })
            .await
    }

    /// The minute's upkeep: expired uploads, deletion jobs and staging files
    /// that no upload owns. It reads the database and the flat staging folder.
    pub async fn maintain(&self) -> AppResult<FileRuntimeReport> {
        self.store.ensure_directories().await?;
        self.remove_abandoned_backup_pins().await;
        let lease = self.db.acquire_data_lease().await?;
        let mut report = FileRuntimeReport::default();
        let now = unix_now()?;
        let expired = self.db.run(move |connection| {
            let mut statement=connection.prepare("SELECT id,staging_key FROM upload_reservations WHERE committed_at IS NULL AND expires_at<=?1")?;
            Ok(statement.query_map([now],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?)
        }).await?;
        for (id, key) in expired {
            self.store
                .remove_file_if_present(&self.store.staging_path(&key)?)
                .await?;
            self.db
                .transaction(move |tx| {
                    tx.execute(
                        "DELETE FROM upload_reservations WHERE id=?1 AND committed_at IS NULL",
                        [&id],
                    )?;
                    tx.execute(
                        "UPDATE idempotency_keys SET state='failed',updated_at=?1
                         WHERE operation='attachment.upload' AND resource_type='upload_reservation'
                           AND resource_id=?2 AND state='running'",
                        params![now, id],
                    )?;
                    Ok(())
                })
                .await?;
            report.expired_uploads_removed += 1;
        }
        let stale_pending = self
            .db
            .run(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT id,storage_key FROM file_blobs
                     WHERE state='pending' AND created_at<=?1",
                )?;
                Ok(statement
                    .query_map([now - UPLOAD_RESERVATION_SECONDS], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?)
            })
            .await?;
        for (blob_id, key) in stale_pending {
            self.store
                .remove_file_if_present(&self.store.file_path(&key)?)
                .await?;
            self.db
                .transaction(move |connection| {
                    connection.execute(
                        "DELETE FROM file_blobs WHERE id=?1 AND state='pending'",
                        [blob_id],
                    )?;
                    Ok(())
                })
                .await?;
            report.expired_uploads_removed += 1;
        }
        self.schedule_deleted_parent_files().await?;
        report.deletion_jobs_completed += self.process_deletion_jobs().await?;
        // Staging files are never in a backup, and each is checked again
        // under the gate, so this needs no lease.
        drop(lease);
        let active_staging: HashSet<String> = self
            .db
            .run(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT staging_key FROM upload_reservations
                     WHERE committed_at IS NULL AND expires_at>?1
                     UNION ALL SELECT id || '.upload' FROM file_blobs WHERE state='pending'",
                )?;
                Ok(statement
                    .query_map([now], |row| row.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .await?;
        for (path, _) in self.regular_files(self.store.layout().staging()).await? {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                self.store.remove_file_if_present(&path).await?;
                report.orphan_files_removed += 1;
                continue;
            };
            if !active_staging.contains(name) {
                let _maintenance_gate = self.acquire_file_maintenance_gate().await?;
                let candidate = name.to_owned();
                let active_now: bool = self
                    .db
                    .run(move |connection| {
                        Ok(connection.query_row(
                            "SELECT EXISTS(
                               SELECT 1 FROM upload_reservations
                               WHERE staging_key=?1 AND committed_at IS NULL AND expires_at>?2
                               UNION ALL
                               SELECT 1 FROM file_blobs
                               WHERE id || '.upload'=?1 AND state='pending'
                             )",
                            params![candidate, now],
                            |row| row.get(0),
                        )?)
                    })
                    .await?;
                if !active_now {
                    self.store.remove_file_if_present(&path).await?;
                    report.orphan_files_removed += 1;
                }
            }
        }
        Ok(report)
    }

    /// The upkeep, then the scans of `files/` and `previews/` for files that
    /// nothing refers to, such as what a crash left. The scans walk every
    /// stored file, so the server runs them at startup and once an hour.
    pub async fn reconcile(&self) -> AppResult<FileRuntimeReport> {
        let mut report = self.maintain().await?;
        // No backup copies orphans or thumbnails, and each is checked again
        // under the gate, so the scans of a large folder don't hold the lease
        // and a command that waits for the data lock isn't held up by them.
        let referenced: HashSet<String> = self
            .db
            .run(|connection| {
                let mut s = connection
                    .prepare("SELECT storage_key FROM file_blobs WHERE storage_key IS NOT NULL")?;
                Ok(s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
            })
            .await?;
        let orphan_thumbnails = self.orphan_thumbnail_candidates(&referenced).await?;
        // Scan without blocking publication. Only apparent orphans need the gate;
        // their reference is rechecked under it before unlinking, so an upload
        // committed after the snapshot is never mistaken for an orphan.
        for path in self.unreferenced_files(referenced).await? {
            let key = self.store.file_key(&path);
            report.orphan_files_removed +=
                u64::from(self.remove_unless_referenced(&path, key).await?);
        }
        for path in orphan_thumbnails {
            let key = self.store.thumbnail_key(&path);
            report.orphan_files_removed +=
                u64::from(self.remove_unless_referenced(&path, key).await?);
        }
        Ok(report)
    }

    /// A backup that was stopped leaves links to the files it copied, which
    /// keep deleted files on disk. They go at startup and in every upkeep
    /// once no backup runs; a failure is only reported.
    async fn remove_abandoned_backup_pins(&self) {
        let layout = self.store.layout().clone();
        let removed =
            tokio::task::spawn_blocking(move || crate::db::remove_abandoned_backup_pins(&layout))
                .await;
        match removed {
            Ok(Ok(true)) => tracing::warn!("removed the file links an interrupted backup left"),
            Ok(Ok(false)) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "cannot remove the file links an interrupted backup left; will retry");
            }
            Err(error) => {
                tracing::warn!(%error, "backup link cleanup failed; will retry");
            }
        }
    }

    /// Removes an orphan from an older snapshot unless a stored file has its
    /// `key` now, rechecked under the gate that publication and thumbnail
    /// writes hold. A file without a key isn't one oneloop stored, and goes.
    async fn remove_unless_referenced(&self, path: &Path, key: Option<String>) -> AppResult<bool> {
        let _maintenance_gate = self.acquire_file_maintenance_gate().await?;
        if let Some(key) = key {
            let referenced_now: bool = self
                .db
                .run(move |connection| {
                    Ok(connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM file_blobs WHERE storage_key=?1)",
                        [key],
                        |row| row.get(0),
                    )?)
                })
                .await?;
            if referenced_now {
                return Ok(false);
            }
        }
        self.store.remove_file_if_present(path).await?;
        Ok(true)
    }

    pub(super) async fn regular_files(&self, root: PathBuf) -> AppResult<Vec<(PathBuf, u64)>> {
        self.scans
            .run(move || {
                let mut files = Vec::new();
                walk_regular_files_blocking(root, |path, size| {
                    files.push((path, size));
                    Ok(())
                })?;
                Ok(files)
            })
            .await?
    }

    /// Stored files that no file in the `referenced` snapshot has, and files
    /// in `files/` that aren't stored files at all.
    async fn unreferenced_files(&self, referenced: HashSet<String>) -> AppResult<Vec<PathBuf>> {
        let store = self.store.clone();
        self.scans
            .run(move || {
                let mut orphans = Vec::new();
                walk_regular_files_blocking(store.layout().files(), |path, _| {
                    if store
                        .file_key(&path)
                        .is_none_or(|key| !referenced.contains(&key))
                    {
                        orphans.push(path);
                    }
                    Ok(())
                })?;
                Ok(orphans)
            })
            .await?
    }

    pub(super) async fn tree_bytes(&self, root: PathBuf) -> AppResult<u64> {
        self.scans
            .run(move || {
                let mut total = 0_u64;
                walk_regular_files_blocking(root, |_, size| {
                    total = total.saturating_add(size);
                    Ok(())
                })?;
                Ok(total)
            })
            .await?
    }
}

fn walk_regular_files_blocking(
    root: PathBuf,
    mut visit: impl FnMut(PathBuf, u64) -> AppResult<()>,
) -> AppResult<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error)
                if error
                    .io_error()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(AppError::Io(error.to_string())),
        };
        if entry.file_type().is_symlink() {
            return Err(AppError::Io(format!(
                "symbolic link found in managed file storage: {}",
                entry.path().display()
            )));
        }
        if entry.file_type().is_file() {
            let size = match entry.metadata() {
                Ok(metadata) => metadata.len(),
                Err(error)
                    if error
                        .io_error()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    continue;
                }
                Err(error) => return Err(AppError::Io(error.to_string())),
            };
            visit(entry.into_path(), size)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_command_gets_the_data_lock_while_reconciliation_scans_for_orphans() {
        let (_root, db) = crate::db::migrated_db();
        let service = FileService::new(db.clone(), 1_000_000, 0);
        let stored = async |name: &[u8]| {
            let key = service.store.new_storage_key().unwrap();
            let path = service.store.prepare_file_parent(&key).await.unwrap();
            std::fs::write(&path, name).unwrap();
            (key, path)
        };
        // A stale pending upload goes early in the pass, so its file shows how far
        // the pass got. An orphan then waits for the gate, which this test holds.
        let (stale, stale_path) = stored(b"stale").await;
        db.transaction(move |tx| {
            tx.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                VALUES('stale',?1,?2,5,'text/plain','pending',1)", params![stale, "0".repeat(64)])?;
            Ok(())
        })
        .await
        .unwrap();
        let (_, orphan_path) = stored(b"orphan").await;
        let gate = service.acquire_file_maintenance_gate().await.unwrap();
        let reconcile = tokio::spawn({
            let service = service.clone();
            async move { service.reconcile().await }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while stale_path.exists() && std::time::Instant::now() < deadline {
            tokio::task::yield_now().await;
        }
        // A backup that starts now gets the data lock while the scan waits.
        let layout = db.layout().clone();
        let command = tokio::task::spawn_blocking(move || layout.open_exclusive_lock())
            .await
            .unwrap();
        assert!(command.is_ok(), "{:?}", command.err());
        drop(command);
        drop(gate);
        reconcile.await.unwrap().unwrap();
        assert!(!orphan_path.exists());
    }

    #[tokio::test]
    async fn recovery_scan_does_not_lock_publication_and_rechecks_old_snapshots() {
        let (_root, db) = crate::db::migrated_db();
        let service = FileService::new(db.clone(), 1000000, 0);
        let key = service.store.new_storage_key().unwrap();
        let path = service.store.prepare_file_parent(&key).await.unwrap();
        std::fs::write(&path, b"x").unwrap();
        let candidates = service.unreferenced_files(HashSet::new()).await.unwrap();
        assert_eq!(candidates, vec![path.clone()]);
        db.transaction(move |tx| {
            tx.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                VALUES('new-blob',?1,?2,1,'image/png','pending',unixepoch())",params![key,"0".repeat(64)])?;
            Ok(())
        }).await.unwrap();
        assert!(
            !service
                .remove_unless_referenced(&path, service.store.file_key(&path))
                .await
                .unwrap(),
            "a stale snapshot cannot remove a published reference"
        );
        let gate = service.acquire_file_maintenance_gate().await.unwrap();
        let report = tokio::time::timeout(std::time::Duration::from_secs(2), service.reconcile())
            .await
            .expect("healthy scan must not wait for the publication gate")
            .unwrap();
        assert_eq!(report.orphan_files_removed, 0);
        assert!(path.exists());
        drop(gate);
    }
}
