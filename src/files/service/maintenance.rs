//! Upkeep of stored files: recovery after a crash, room for new files, and
//! deletion jobs that are safe to run twice.
use super::*;

/// Cleanup starts when used storage reaches this share of the limit, and
/// frees space down to the lower one.
const CLEANUP_HIGH_PERCENT: u64 = 80;
const CLEANUP_LOW_PERCENT: u64 = 70;

/// `percent` of `limit`, exact for any limit.
fn share_of(limit: u64, percent: u64) -> u64 {
    // At most the limit, so the result fits.
    (u128::from(limit) * u128::from(percent) / 100) as u64
}

/// Bytes of stored files, from a covering index.
const STORED_BYTES_SQL: &str = "SELECT coalesce(sum(size_bytes),0) FROM file_blobs
     WHERE state IN ('pending','available','deleting')";

/// Stored bytes and the bytes that uploads under way have reserved.
const CAPACITY_USED_SQL: &str = "SELECT
       coalesce((SELECT sum(size_bytes) FROM file_blobs
                 WHERE state IN ('pending','available','deleting')),0) +
       coalesce((SELECT sum(size_bytes) FROM upload_reservations
                 WHERE committed_at IS NULL AND expires_at>?1),0)";

/// The available files of tasks and attachments deleted up to `?1`, and
/// files that nothing refers to: their blob, key and deletion reason. Deleted
/// tasks are few, so their files are found from the deleted tasks.
const DELETION_CANDIDATES_SQL: &str = "SELECT b.id,b.storage_key,'manual' FROM tasks t
     CROSS JOIN task_attachments a ON a.task_id=t.id
     JOIN file_blobs b ON b.id=a.blob_id
     WHERE t.deleted_at IS NOT NULL AND t.deleted_at<=?1 AND b.state='available'
     UNION ALL
     SELECT b.id,b.storage_key,'manual' FROM task_attachments a
     JOIN file_blobs b ON b.id=a.blob_id
     WHERE a.deleted_at IS NOT NULL AND a.deleted_at<=?1 AND b.state='available'
     UNION ALL
     SELECT b.id,b.storage_key,'orphan' FROM file_blobs b
     WHERE b.state='available'
       AND NOT EXISTS(SELECT 1 FROM task_attachments a WHERE a.blob_id=b.id)
       AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_blob_id=b.id)";

#[derive(Default)]
pub(super) struct CapacityUsage {
    blob_bytes: u64,
    reserved_bytes: u64,
    staging_bytes: u64,
    preview_bytes: u64,
    unreserved_staging_bytes: u64,
}

impl CapacityUsage {
    pub(super) fn total(&self) -> u64 {
        self.blob_bytes
            .saturating_add(self.reserved_bytes)
            .saturating_add(self.preview_bytes)
            .saturating_add(self.unreserved_staging_bytes)
    }

    fn non_database_bytes(&self) -> u64 {
        self.preview_bytes
            .saturating_add(self.unreserved_staging_bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UploadCleanupDecision {
    PreserveCommitted,
    RemoveUncommitted,
}

struct DeletionCompletion {
    cleanup_run_id: Option<String>,
    reason: String,
    activity: Option<(DeleteActivityContext, Option<Actor>)>,
}

impl FileService {
    /// Used storage from which cleanup runs.
    pub(super) fn high_watermark(&self) -> u64 {
        share_of(self.storage_limit_bytes, CLEANUP_HIGH_PERCENT)
    }

    /// Used storage that cleanup frees space down to.
    fn low_watermark(&self) -> u64 {
        share_of(self.storage_limit_bytes, CLEANUP_LOW_PERCENT)
    }

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

    pub async fn reconcile(&self) -> AppResult<FileRuntimeReport> {
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
        // The rest removes only files that no backup copies: orphans,
        // thumbnails and staging files, each checked again under the gate. So
        // the scans of a large folder don't hold the lease, and a command that
        // waits for the data lock isn't held up by them.
        drop(lease);
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
        for path in self
            .unreferenced_files(self.store.layout().files(), referenced)
            .await?
        {
            report.orphan_files_removed += u64::from(self.remove_if_unreferenced(&path).await?);
        }
        for path in orphan_thumbnails {
            report.orphan_files_removed +=
                u64::from(self.remove_thumbnail_if_orphaned(&path).await?);
        }
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

    /// A backup that was stopped leaves links to the files it copied, which
    /// keep deleted files on disk. They go at startup and in every
    /// reconciliation once no backup runs; a failure is only reported.
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

    pub(super) async fn remove_if_unreferenced(&self, path: &Path) -> AppResult<bool> {
        let _maintenance_gate = self.acquire_file_maintenance_gate().await?;
        let key = path
            .strip_prefix(self.store.layout().files())
            .map_err(|_| AppError::internal("file escaped storage root"))?
            .to_string_lossy()
            .replace('\\', "/");
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
        self.store.remove_file_if_present(path).await?;
        Ok(true)
    }

    /// Makes room before `size` new bytes are written: cleanup runs when
    /// usage passed the high watermark, or when the disk is short of space.
    /// Returns the bytes outside the database, for `require_capacity`.
    pub(super) async fn admit(&self, size: u64) -> AppResult<u64> {
        self.store.ensure_directories().await?;
        let mut usage = self.capacity_usage().await?;
        if self.cleanup_for_usage(&usage).await?.bytes_reclaimed > 0 {
            usage = self.capacity_usage().await?;
        }
        let deficit = self.disk.deficit(size)?;
        if deficit > 0 && self.cleanup_for_deficit(deficit).await?.bytes_reclaimed > 0 {
            usage = self.capacity_usage().await?;
        }
        Ok(usage.non_database_bytes())
    }

    pub async fn cleanup_if_needed(&self) -> AppResult<FileRuntimeReport> {
        self.cleanup_for_usage(&self.capacity_usage().await?).await
    }

    /// Storage cleanup that an administrator asked for.
    pub async fn cleanup_for(&self, actor: &Actor) -> AppResult<FileRuntimeReport> {
        actor.require_admin()?;
        let actor = actor.clone();
        self.db
            .run(move |connection| refresh_actor_connection(connection, &actor)?.require_admin())
            .await?;
        self.cleanup_if_needed().await
    }

    pub(super) async fn cleanup_for_usage(
        &self,
        usage: &CapacityUsage,
    ) -> AppResult<FileRuntimeReport> {
        if usage.total() < self.high_watermark() {
            return Ok(FileRuntimeReport::default());
        }
        if usage.preview_bytes == 0 {
            let now = unix_now()?;
            // An indexed existence probe stays fresh after retention edits and reads;
            // unlike a cached timestamp it cannot miss newly eligible files.
            let eligible = self.db.run(move |connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
                     WHERE a.is_ephemeral=1 AND a.last_accessed_at<=?1 AND a.created_at<=?1
                       AND b.state='available' AND a.deleted_at IS NULL
                       AND NOT EXISTS(SELECT 1 FROM file_leases l WHERE l.blob_id=b.id AND l.expires_at>?2))",
                    params![now-ACCESS_GRACE_SECONDS,now], |r| r.get::<_,bool>(0))?)
            }).await?;
            if !eligible {
                return Ok(FileRuntimeReport::default());
            }
        }
        self.cleanup_to_low_watermark().await
    }

    pub async fn storage_usage(&self, actor: &Actor) -> AppResult<StorageUsage> {
        actor.require_admin()?;
        let actor = actor.clone();
        let (permanent, temporary, pending_deletion, cleaned, projects, recent_cleanup) = self
            .db
            .run(move |connection| {
                refresh_actor_connection(connection, &actor)?.require_admin()?;
                let permanent: i64 = connection.query_row(
                    "SELECT coalesce(sum(b.size_bytes),0) FROM task_attachments a
                     JOIN file_blobs b ON b.id=a.blob_id JOIN tasks t ON t.id=a.task_id
                     WHERE a.is_ephemeral=0 AND b.state='available'
                       AND a.deleted_at IS NULL AND t.deleted_at IS NULL",
                    [],
                    |r| r.get(0),
                )?;
                let temporary: i64 = connection.query_row(
                    "SELECT coalesce(sum(b.size_bytes),0) FROM task_attachments a
                     JOIN file_blobs b ON b.id=a.blob_id JOIN tasks t ON t.id=a.task_id
                     WHERE a.is_ephemeral=1 AND b.state='available'
                       AND a.deleted_at IS NULL AND t.deleted_at IS NULL",
                    [],
                    |r| r.get(0),
                )?;
                // Deleted attachments, and the files of deleted tasks, keep
                // their bytes for the Undo window.
                let pending_deletion: i64 = connection.query_row(
                    "SELECT coalesce(sum(b.size_bytes),0) FROM file_blobs b WHERE b.state='deleting'
                       OR (b.state='available' AND EXISTS(SELECT 1 FROM task_attachments a
                           JOIN tasks t ON t.id=a.task_id
                           WHERE a.blob_id=b.id
                             AND (a.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL)))",
                    [],
                    |r| r.get(0),
                )?;
                let cleaned: i64 = connection.query_row(
                    "SELECT count(*) FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
                     WHERE b.state='cleaned' AND a.deleted_at IS NULL",
                    [],
                    |r| r.get(0),
                )?;
                let projects = {
                    let mut statement = connection.prepare(
                        "SELECT p.id,p.name,count(b.id),coalesce(sum(b.size_bytes),0) FROM projects p
                         LEFT JOIN task_attachments a ON a.project_id=p.id
                         LEFT JOIN file_blobs b ON b.id=a.blob_id AND b.state IN ('available','deleting')
                         WHERE p.deleted_at IS NULL GROUP BY p.id,p.name
                         HAVING count(b.id)>0 ORDER BY sum(b.size_bytes) DESC,p.name,p.id",
                    )?;
                    statement
                        .query_map([], |row| {
                            Ok(StorageProjectUsage {
                                project_id: row.get(0)?,
                                project_name: row.get(1)?,
                                file_count: row.get::<_, i64>(2)?.max(0) as u64,
                                bytes: row.get::<_, i64>(3)?.max(0) as u64,
                            })
                        })?
                        .collect::<Result<Vec<_>, _>>()?
                };
                let recent_cleanup = {
                    let mut statement = connection.prepare(
                        "SELECT started_at,files,bytes FROM storage_cleanup_runs
                         WHERE files > 0 OR bytes > 0 ORDER BY started_at DESC,id DESC LIMIT 5",
                    )?;
                    statement
                        .query_map([], |row| {
                            Ok(StorageCleanupRun {
                                at: row.get(0)?,
                                file_count: row.get::<_, i64>(1)?.max(0) as u64,
                                bytes: row.get::<_, i64>(2)?.max(0) as u64,
                            })
                        })?
                        .collect::<Result<Vec<_>, _>>()?
                };
                Ok((
                    permanent.max(0) as u64,
                    temporary.max(0) as u64,
                    pending_deletion.max(0) as u64,
                    cleaned.max(0) as u64,
                    projects,
                    recent_cleanup,
                ))
            })
            .await?;
        let capacity = self.capacity_usage().await?;
        Ok(StorageUsage {
            budget_bytes: self.storage_limit_bytes,
            used_bytes: capacity.total(),
            reserved_bytes: capacity.reserved_bytes,
            staging_bytes: capacity.staging_bytes,
            preview_bytes: capacity.preview_bytes,
            permanent_bytes: permanent,
            temporary_bytes: temporary,
            pending_deletion_bytes: pending_deletion,
            cleaned_records: cleaned,
            high_watermark_bytes: self.high_watermark(),
            low_watermark_bytes: self.low_watermark(),
            projects,
            recent_cleanup,
        })
    }

    pub async fn cleanup_to_low_watermark(&self) -> AppResult<FileRuntimeReport> {
        self.cleanup_files(Some(self.low_watermark()), 0).await
    }

    pub(super) async fn cleanup_for_deficit(&self, deficit: u64) -> AppResult<FileRuntimeReport> {
        self.cleanup_files(None, deficit).await
    }

    pub(super) async fn cleanup_files(
        &self,
        target: Option<u64>,
        deficit: u64,
    ) -> AppResult<FileRuntimeReport> {
        // The data lease comes before any gate, as on every other file path.
        let _lease = self.db.acquire_data_lease().await?;
        // A lock per data directory also covers separately constructed services.
        let cleanup = self.take_lock(DataLayout::try_cleanup_lock).await?;
        let Some(_cleanup) = cleanup else {
            return Ok(FileRuntimeReport::default());
        };
        let mut report = FileRuntimeReport::default();
        let usage = self.capacity_usage().await?.total();
        let mut needed = target.map_or(deficit, |target| usage.saturating_sub(target));
        let previews = self.regular_files(self.store.previews()).await?;
        let now = unix_now()?;
        let candidates = self.db.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT a.blob_id,b.storage_key,b.size_bytes,a.revision FROM task_attachments a
                 JOIN file_blobs b ON b.id=a.blob_id
                 WHERE a.is_ephemeral=1 AND b.state='available' AND a.deleted_at IS NULL
                   AND a.created_at<=?1 AND a.last_accessed_at<=?1
                   AND NOT EXISTS(SELECT 1 FROM file_leases l WHERE l.blob_id=b.id AND l.expires_at>?2)
                 ORDER BY a.last_accessed_at,a.id")?;
            Ok(statement.query_map(params![now-ACCESS_GRACE_SECONDS,now], |row| {
                Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,i64>(2)?.max(0) as u64, row.get::<_,i64>(3)?))
            })?.collect::<Result<Vec<_>,_>>()?)
        }).await?;
        let eligible = candidates
            .iter()
            .map(|row| row.2)
            .chain(previews.iter().map(|row| row.1))
            .fold(0_u64, u64::saturating_add);
        if deficit > eligible {
            return Err(AppError::rule(
                crate::error::RuleKind::StorageFull,
                "storage safety floor cannot be recovered from eligible temporary files",
            ));
        }
        if needed == 0 && previews.is_empty() {
            return Ok(report);
        }
        let run_id = Uuid::now_v7().to_string();
        let run_tx = run_id.clone();
        self.db
            .transaction(move |tx| {
                tx.execute(
                    "INSERT INTO storage_cleanup_runs(id,started_at,trigger) VALUES(?1,?2,?3)",
                    params![
                        run_tx,
                        now,
                        if target.is_some() {
                            "watermark"
                        } else {
                            "disk_floor"
                        }
                    ],
                )?;
                Ok(())
            })
            .await?;
        for (path, size) in previews {
            if deficit > 0 && needed == 0 {
                break;
            }
            self.store.remove_file_if_present(&path).await?;
            report.bytes_reclaimed = report.bytes_reclaimed.saturating_add(size);
            needed = needed.saturating_sub(size);
        }
        let preview_bytes = report.bytes_reclaimed;
        if preview_bytes > 0 {
            let run_tx = run_id.clone();
            self.db
                .transaction(move |tx| {
                    tx.execute(
                        "UPDATE storage_cleanup_runs SET bytes=bytes+?2 WHERE id=?1",
                        params![run_tx, preview_bytes as i64],
                    )?;
                    Ok(())
                })
                .await?;
        }
        // One library scan; short claim/completion transactions per batch. Each
        // claim rechecks access, retention and state against concurrent edits.
        for batch in candidates.chunks(200) {
            if needed == 0 {
                break;
            }
            let batch = batch.to_vec();
            let run_tx = run_id.clone();
            let jobs = self.db.transaction(move |tx| {
                let now = unix_now()?;
                let mut jobs = Vec::new();
                let mut claimed = 0_u64;
                for (blob, key, size, revision) in batch {
                    if claimed >= needed { break; }
                    let changed = tx.execute(
                        "UPDATE file_blobs SET state='deleting' WHERE id=?1 AND state='available'
                         AND EXISTS(SELECT 1 FROM task_attachments a WHERE a.blob_id=?1
                           AND a.is_ephemeral=1 AND a.created_at<=?2 AND a.last_accessed_at<=?2
                           AND a.revision=?4 AND a.deleted_at IS NULL)
                         AND NOT EXISTS(SELECT 1 FROM file_leases WHERE blob_id=?1 AND expires_at>?3)",
                        params![blob, now-ACCESS_GRACE_SECONDS, now, revision])?;
                    if changed == 0 { continue; }
                    let id = insert_deletion_job(tx, &blob, &key, "cleanup", Some(&run_tx), now)?;
                    jobs.push((DeletionJob { id, blob_id: blob, storage_key: key }, size));
                    claimed = claimed.saturating_add(size);
                }
                Ok(jobs)
            }).await?;
            let (count, bytes) = self.complete_deletion_jobs(jobs).await?;
            report.temporary_files_cleaned += count;
            report.bytes_reclaimed = report.bytes_reclaimed.saturating_add(bytes);
            needed = needed.saturating_sub(bytes);
        }
        self.db
            .transaction(move |tx| {
                tx.execute(
                    "UPDATE storage_cleanup_runs SET finished_at=?2 WHERE id=?1",
                    params![run_id, unix_now()?],
                )?;
                Ok(())
            })
            .await?;
        Ok(report)
    }

    pub(super) async fn cleanup_upload_attempt(
        &self,
        reservation_id: &str,
        idempotency_id: &str,
        storage_key: &str,
        staging_path: &Path,
        _data_lease: &DataLease,
    ) -> AppResult<()> {
        let reservation_id = reservation_id.to_owned();
        let idempotency_id = idempotency_id.to_owned();
        let storage_key = storage_key.to_owned();
        let destination = self.store.file_path(&storage_key);
        let decision = self
            .db
            .transaction(move |tx| {
                let committed: bool = tx.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM file_blobs b
                       JOIN task_attachments a ON a.blob_id=b.id
                       WHERE b.storage_key=?1 AND b.state='available'
                     )",
                    [&storage_key],
                    |row| row.get(0),
                )?;
                let succeeded: bool = tx.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM idempotency_keys
                       WHERE id=?1 AND state='succeeded'
                     )",
                    [&idempotency_id],
                    |row| row.get(0),
                )?;
                if committed || succeeded {
                    return Ok(UploadCleanupDecision::PreserveCommitted);
                }
                release_upload_rows(tx, &reservation_id, &idempotency_id)?;
                Ok(UploadCleanupDecision::RemoveUncommitted)
            })
            .await?;
        if decision == UploadCleanupDecision::PreserveCommitted {
            return Ok(());
        }

        self.store.remove_file_if_present(staging_path).await?;
        let destination = destination?;
        let destination_existed = fs::metadata(&destination).await.is_ok();
        self.store.remove_file_if_present(&destination).await?;
        if destination_existed {
            FileStore::sync_parent(destination).await?;
        }
        Ok(())
    }

    /// Frees the reservation and retry key of an upload that never started to
    /// publish its file, when the data lease is unavailable, for example
    /// during a backup. The next reconciliation removes the staging file, which
    /// no reservation owns any more.
    pub(super) async fn release_upload_reservation(
        &self,
        reservation_id: &str,
        idempotency_id: &str,
    ) -> AppResult<()> {
        let reservation_id = reservation_id.to_owned();
        let idempotency_id = idempotency_id.to_owned();
        self.db
            .transaction(move |tx| release_upload_rows(tx, &reservation_id, &idempotency_id))
            .await
    }

    pub(super) async fn release_file_lease(&self, lease_id: String) -> AppResult<()> {
        self.db
            .transaction(move |connection| {
                connection.execute("DELETE FROM file_leases WHERE id=?1", [lease_id])?;
                Ok(())
            })
            .await
    }

    pub(super) async fn remove_pending_blob(&self, blob_id: &str) -> AppResult<()> {
        let blob_id = blob_id.to_owned();
        self.db
            .transaction(move |connection| {
                connection.execute(
                    "DELETE FROM file_blobs WHERE id=?1 AND state='pending'",
                    [blob_id],
                )?;
                Ok(())
            })
            .await
    }

    pub(super) async fn record_deletion_failure(&self, job_id: &str, error: &str) -> AppResult<()> {
        let job_id = job_id.to_owned();
        let error = error.chars().take(500).collect::<String>();
        self.db
            .transaction(move |connection| {
                // A failed job waits longer after each attempt, up to an hour.
                connection.execute(
                    "UPDATE file_deletion_jobs SET attempt_count=attempt_count+1,
                     available_at=unixepoch()+min(3600,30*(1<<min(attempt_count,7))),last_error=?1
                     WHERE id=?2",
                    params![error, job_id],
                )?;
                Ok(())
            })
            .await
    }

    pub(super) async fn schedule_blob_deletion(
        &self,
        blob_id: &str,
        reason: &str,
    ) -> AppResult<()> {
        let blob_id = blob_id.to_owned();
        let reason = reason.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                let key: Option<String> = tx
                    .query_row(
                        "SELECT storage_key FROM file_blobs WHERE id=?1 AND state='available'",
                        [&blob_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(key) = key {
                    tx.execute(
                        "UPDATE file_blobs SET state='deleting' WHERE id=?1",
                        [&blob_id],
                    )?;
                    insert_deletion_job(tx, &blob_id, &key, &reason, None, now)?;
                }
                Ok(())
            })
            .await
    }

    pub(super) async fn schedule_deleted_parent_files(&self) -> AppResult<()> {
        // A deleted task or attachment keeps its files for the Undo window.
        let restorable_after = unix_now()? - UNDO_WINDOW_SECONDS;
        // A deleted attachment without bytes only needs its row removed.
        loop {
            let removed = self
                .db
                .transaction(move |tx| {
                    Ok(tx.execute(
                        "DELETE FROM task_attachments WHERE id IN (
                    SELECT a.id FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
                    WHERE a.deleted_at IS NOT NULL AND a.deleted_at<=?1 AND b.state='cleaned'
                    LIMIT 500)",
                        [restorable_after],
                    )?)
                })
                .await?;
            if removed < 500 {
                break;
            }
        }
        // Retain cleaned attachment rows while referenced, but reclaim metadata
        // once a hard-deleted task/project has removed the final owner.
        loop {
            let removed = self
                .db
                .transaction(|tx| {
                    Ok(tx.execute(
                        "DELETE FROM file_blobs WHERE id IN (
                    SELECT b.id FROM file_blobs b WHERE b.state='cleaned'
                    AND NOT EXISTS(SELECT 1 FROM task_attachments a WHERE a.blob_id=b.id)
                    AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_blob_id=b.id)
                    AND NOT EXISTS(SELECT 1 FROM file_deletion_jobs j WHERE j.blob_id=b.id)
                    AND NOT EXISTS(SELECT 1 FROM file_leases l WHERE l.blob_id=b.id)
                    LIMIT 500)",
                        [],
                    )?)
                })
                .await?;
            if removed < 500 {
                break;
            }
        }
        let candidates = self.deletion_candidates(restorable_after).await?;
        self.claim_for_deletion(candidates).await
    }

    /// The available files of tasks and attachments deleted before
    /// `restorable_after`, and files that nothing refers to: their blob, key
    /// and deletion reason.
    pub(super) async fn deletion_candidates(
        &self,
        restorable_after: i64,
    ) -> AppResult<Vec<(String, String, String)>> {
        self.db
            .run(move |connection| {
                let mut statement = connection.prepare(DELETION_CANDIDATES_SQL)?;
                Ok(statement
                    .query_map([restorable_after], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?)
            })
            .await
    }

    /// Hands candidates from an earlier scan to deletion jobs, checking each
    /// again first.
    pub(super) async fn claim_for_deletion(
        &self,
        candidates: Vec<(String, String, String)>,
    ) -> AppResult<()> {
        for batch in candidates.chunks(500) {
            let batch = batch.to_vec();
            self.db.transaction(move |tx| {
                let now = unix_now()?;
                for (blob,key,reason) in batch {
                    // The claim rechecks the window: a restore that committed
                    // since the scan keeps the files.
                    let changed = tx.execute(
                        "UPDATE file_blobs SET state='deleting' WHERE id=?1 AND state='available'
                         AND (EXISTS(SELECT 1 FROM task_attachments a JOIN tasks t ON t.id=a.task_id
                                     WHERE a.blob_id=?1 AND t.deleted_at IS NOT NULL AND t.deleted_at<=?3)
                              OR EXISTS(SELECT 1 FROM task_attachments a
                                     WHERE a.blob_id=?1 AND a.deleted_at IS NOT NULL AND a.deleted_at<=?3)
                              OR (NOT EXISTS(SELECT 1 FROM task_attachments WHERE blob_id=?1)
                                  AND NOT EXISTS(SELECT 1 FROM users WHERE avatar_blob_id=?1)))
                         AND NOT EXISTS(SELECT 1 FROM file_leases WHERE blob_id=?1 AND expires_at>?2)",
                        params![blob,now,now-UNDO_WINDOW_SECONDS])?;
                    if changed == 1 {
                        insert_deletion_job(tx, &blob, &key, &reason, None, now)?;
                    }
                }
                Ok(())
            }).await?;
        }
        Ok(())
    }

    pub(super) async fn process_deletion_jobs(&self) -> AppResult<u64> {
        let started = std::time::Instant::now();
        let mut completed = 0;
        let mut attempted = 0;
        // Time is checked between batches, so one slow filesystem operation may
        // exceed it. Failed jobs get backoff rather than spinning in this loop.
        while attempted < 5_000 && started.elapsed() < std::time::Duration::from_secs(2) {
            let now = unix_now()?;
            let jobs = self
                .db
                .run(move |connection| {
                    let mut statement = connection.prepare(
                        "SELECT id,blob_id,storage_key FROM file_deletion_jobs
                         WHERE available_at<=?1 AND locked_at IS NULL
                         ORDER BY available_at,id LIMIT 200",
                    )?;
                    Ok(statement
                        .query_map([now], |r| {
                            Ok(DeletionJob {
                                id: r.get(0)?,
                                blob_id: r.get(1)?,
                                storage_key: r.get(2)?,
                            })
                        })?
                        .collect::<Result<Vec<_>, _>>()?)
                })
                .await?;
            if jobs.is_empty() {
                break;
            }
            attempted += jobs.len();
            let jobs = jobs.into_iter().map(|job| (job, 0)).collect();
            completed += self.complete_deletion_jobs(jobs).await?.0;
        }
        Ok(completed)
    }

    /// Removes each job's file and thumbnail, syncs each folder once, and
    /// finishes the jobs whose file is gone in one transaction. A job comes
    /// with the bytes it frees. Returns how many jobs this call finished, and
    /// the bytes freed, which count even when another worker finished a job.
    async fn complete_deletion_jobs(&self, jobs: Vec<(DeletionJob, u64)>) -> AppResult<(u64, u64)> {
        let mut removed = Vec::new();
        let mut parents = HashMap::new();
        for (job, size) in jobs {
            let path = self.store.file_path(&job.storage_key)?;
            if let Err(error) = self.store.remove_file_if_present(&path).await {
                self.record_deletion_failure(&job.id, &error.to_string())
                    .await?;
                continue;
            }
            self.remove_thumbnail(&job.storage_key).await;
            parents.insert(path.parent().expect("managed shard").to_path_buf(), path);
            removed.push((job, size));
        }
        for path in parents.into_values() {
            FileStore::sync_parent(path).await?;
        }
        self.db
            .transaction(move |tx| {
                let (mut count, mut bytes) = (0, 0_u64);
                for (job, size) in removed {
                    bytes = bytes.saturating_add(size);
                    count += u64::from(finish_deletion_job(tx, &job)?);
                }
                Ok((count, bytes))
            })
            .await
    }

    pub(super) async fn capacity_usage(&self) -> AppResult<CapacityUsage> {
        let now = unix_now()?;
        let (blob_bytes, reserved_bytes, staging_keys) = self
            .db
            .run(move |connection| {
                let blob: i64 = connection.query_row(STORED_BYTES_SQL, [], |r| r.get(0))?;
                let mut statement = connection.prepare(
                    "SELECT staging_key,size_bytes FROM upload_reservations
                     WHERE committed_at IS NULL AND expires_at>?1",
                )?;
                let rows = statement
                    .query_map([now], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let reserved = rows.iter().fold(0_u64, |total, (_, size)| {
                    total.saturating_add((*size).max(0) as u64)
                });
                let reservations = rows
                    .into_iter()
                    .map(|(key, size)| (key, size.max(0) as u64))
                    .collect::<HashMap<_, _>>();
                let mut staging = reservations.keys().cloned().collect::<HashSet<_>>();
                let mut pending = connection
                    .prepare("SELECT id || '.upload' FROM file_blobs WHERE state='pending'")?;
                staging.extend(
                    pending
                        .query_map([], |row| row.get(0))?
                        .collect::<Result<Vec<String>, _>>()?,
                );
                Ok((blob.max(0) as u64, reserved, staging))
            })
            .await?;
        let mut staging_bytes = 0_u64;
        let mut unreserved_staging_bytes = 0_u64;
        for (path, size) in self.regular_files(self.store.layout().staging()).await? {
            staging_bytes = staging_bytes.saturating_add(size);
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_none_or(|name| !staging_keys.contains(name))
            {
                unreserved_staging_bytes = unreserved_staging_bytes.saturating_add(size);
            }
        }
        Ok(CapacityUsage {
            blob_bytes,
            reserved_bytes,
            staging_bytes,
            preview_bytes: self.tree_bytes(self.store.previews()).await?,
            unreserved_staging_bytes,
        })
    }
}

/// Queues the removal of a blob's bytes. The caller has just marked the blob
/// `deleting`, so it has no job yet.
fn insert_deletion_job(
    tx: &Transaction<'_>,
    blob_id: &str,
    storage_key: &str,
    reason: &str,
    cleanup_run_id: Option<&str>,
    now: i64,
) -> AppResult<String> {
    let id = Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO file_deletion_jobs
         (id,blob_id,storage_key,reason,scheduled_at,available_at,cleanup_run_id)
         VALUES(?1,?2,?3,?4,?5,?5,?6)",
        params![id, blob_id, storage_key, reason, now, cleanup_run_id],
    )?;
    Ok(id)
}

/// Fails when `size` more bytes would take file storage past `limit`.
pub(super) fn require_capacity(
    tx: &Transaction<'_>,
    now: i64,
    non_database_bytes: u64,
    size: u64,
    limit: u64,
) -> AppResult<()> {
    let used: i64 = tx.query_row(CAPACITY_USED_SQL, [now], |row| row.get(0))?;
    if (used.max(0) as u64)
        .saturating_add(non_database_bytes)
        .saturating_add(size)
        > limit
    {
        return Err(AppError::rule(
            crate::error::RuleKind::StorageFull,
            "attachment storage capacity is exhausted",
        ));
    }
    Ok(())
}

fn release_upload_rows(
    tx: &Transaction<'_>,
    reservation_id: &str,
    idempotency_id: &str,
) -> AppResult<()> {
    tx.execute(
        "DELETE FROM upload_reservations WHERE id=?1 AND committed_at IS NULL",
        [reservation_id],
    )?;
    tx.execute(
        "UPDATE idempotency_keys
         SET state='failed',updated_at=unixepoch()
         WHERE id=?1 AND state='running'
           AND resource_type='upload_reservation' AND resource_id=?2",
        params![idempotency_id, reservation_id],
    )?;
    Ok(())
}

impl FileService {
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

    pub(super) async fn unreferenced_files(
        &self,
        root: PathBuf,
        referenced: HashSet<String>,
    ) -> AppResult<Vec<PathBuf>> {
        self.scans
            .run(move || {
                let mut orphans = Vec::new();
                walk_regular_files_blocking(root.clone(), |path, _| {
                    let key = path
                        .strip_prefix(&root)
                        .map_err(|_| AppError::internal("file escaped storage root"))?
                        .to_string_lossy()
                        .replace('\\', "/");
                    if !referenced.contains(&key) {
                        orphans.push(path);
                    }
                    Ok(())
                })?;
                Ok(orphans)
            })
            .await?
    }

    async fn tree_bytes(&self, root: PathBuf) -> AppResult<u64> {
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

struct DeletionJob {
    id: String,
    blob_id: String,
    storage_key: String,
}

fn finish_deletion_job(tx: &Transaction<'_>, job: &DeletionJob) -> AppResult<bool> {
    // The delete is the completion claim. Rollback restores it on any failure.
    // Concurrent workers may unlink twice, but metadata/activity change once.
    let completion = tx
        .query_row(
            "DELETE FROM file_deletion_jobs WHERE id=?1 RETURNING cleanup_run_id,
                actor_user_id,actor_mcp_grant_id,actor_name,project_id,task_id,attachment_id,attachment_name,reason",
            [&job.id],
            deletion_completion_row,
        )
        .optional()?;
    let Some(completion) = completion else {
        return Ok(false);
    };
    if let Some(run) = completion.cleanup_run_id {
        tx.execute(
            "UPDATE storage_cleanup_runs SET files=files+1,
            bytes=bytes+coalesce((SELECT size_bytes FROM file_blobs WHERE id=?2),0)
            WHERE id=?1",
            params![run, job.blob_id],
        )?;
    }
    let blob = &job.blob_id;
    let reason = &completion.reason;
    let now = unix_now()?;
    if reason == "cleanup" {
        let attachment: Option<(String, u64)> = tx
            .query_row(
                "SELECT a.id,b.size_bytes FROM task_attachments a
                 JOIN file_blobs b ON b.id=a.blob_id WHERE a.blob_id=?1",
                [&blob],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)?.max(0) as u64)),
            )
            .optional()?;
        tx.execute(
            "UPDATE file_blobs SET state='cleaned',storage_key=NULL,cleaned_at=?1 WHERE id=?2",
            params![now, blob],
        )?;
        tx.execute(
            "UPDATE task_attachments SET updated_at=?1,revision=revision+1 WHERE blob_id=?2",
            params![now, blob],
        )?;
        if let Some((attachment, size)) = attachment {
            record_system_cleanup(tx, &attachment, size, now)?;
        }
    } else if let Some((attachment, actor)) = completion.activity {
        // Only jobs that 0.1.0-rc.2 or earlier queued name an attachment:
        // migration 0003 filled it in, and since Undo the deletion itself
        // records the activity. Remove this branch when upgrades from rc.2
        // end.
        record_attachment_deletion(tx, &attachment, actor.as_ref(), now)?;
        tx.execute(
            "UPDATE idempotency_keys SET state='succeeded',updated_at=?1
             WHERE operation='attachment.delete' AND resource_type='attachment' AND resource_id=?2",
            params![now, attachment.id],
        )?;
        tx.execute("DELETE FROM task_attachments WHERE blob_id=?1", [&blob])?;
        tx.execute("DELETE FROM file_blobs WHERE id=?1", [&blob])?;
    } else {
        tx.execute("DELETE FROM task_attachments WHERE blob_id=?1", [&blob])?;
        tx.execute("DELETE FROM file_blobs WHERE id=?1", [&blob])?;
    }
    Ok(true)
}

fn deletion_completion_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeletionCompletion> {
    let activity = if let Some(id) = row.get::<_, Option<String>>(6)? {
        let actor = if let Some(user_id) = row.get::<_, Option<String>>(1)? {
            Some(Actor {
                user_id,
                username: String::new(),
                display_name: row.get(3)?,
                is_admin: false,
                must_change_password: false,
                authenticated_at: 0,
                source: row.get::<_, Option<String>>(2)?.map_or_else(
                    || ActorSource::BrowserSession {
                        session_id: String::new(),
                    },
                    |grant_id| ActorSource::McpGrant { grant_id },
                ),
            })
        } else {
            None
        };
        Some((
            DeleteActivityContext {
                id,
                project_id: row.get(4)?,
                task_id: row.get(5)?,
                name: row.get(7)?,
            },
            actor,
        ))
    } else {
        None
    };
    Ok(DeletionCompletion {
        cleanup_run_id: row.get(0)?,
        reason: row.get(8)?,
        activity,
    })
}

fn record_system_cleanup(
    tx: &Transaction<'_>,
    attachment_id: &str,
    size: u64,
    now: i64,
) -> AppResult<()> {
    let row: (String, String, String, i64) = tx.query_row(
        "SELECT project_id,task_id,original_name,revision FROM task_attachments WHERE id=?1",
        [attachment_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    record_system_activity_tx(
        tx,
        ActivityInput {
            project_id: Some(&row.0),
            entity_type: "attachment",
            entity_id: attachment_id,
            task_id: Some(&row.1),
            event_type: "attachment.cleaned",
            // Cleanup is a distinct lifecycle event. Leaving it unstructured
            // closes any open retention chain and prevents cleanup from being
            // folded into ordinary attachment edits.
            field_key: None,
            before: Some(json!("available")),
            after: Some(json!("cleaned")),
            metadata: json!({"name":row.2,"size":size}),
            entity_revision: Some(row.3),
        },
        now,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The query plan of `sql`, one step per line.
    fn plan(connection: &rusqlite::Connection, sql: &str, values: impl rusqlite::Params) -> String {
        connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(values, |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n")
    }

    #[test]
    fn file_queries_use_their_indexes() {
        let (_root, connection) = crate::db::migrated_connection();
        for (sql, values) in [(STORED_BYTES_SQL, vec![]), (CAPACITY_USED_SQL, vec![0])] {
            let plan = plan(&connection, sql, rusqlite::params_from_iter(values));
            assert!(
                plan.contains("COVERING INDEX file_blobs_state_size_idx"),
                "{sql}\n{plan}"
            );
        }
        // Deleted tasks are few; their files must not be found by scanning
        // every stored file.
        let plan = plan(&connection, DELETION_CANDIDATES_SQL, [0]);
        assert!(
            plan.contains("SCAN t USING INDEX tasks_deleted_idx")
                && !plan.contains("file_blobs_cleanup_idx"),
            "{plan}"
        );
    }
}
