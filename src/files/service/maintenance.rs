//! Crash recovery, capacity admission and idempotent leased deletion; full reconciliation remains supported.
use super::*;

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

    pub async fn reconcile(&self) -> AppResult<FileRuntimeReport> {
        self.store.ensure_directories().await?;
        let _lease = self.db.acquire_data_lease().await?;
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
        for path in unreferenced_files(self.store.layout().files(), referenced).await? {
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
        for (path, _) in regular_files(self.store.layout().staging()).await? {
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

    pub(super) async fn prepare_capacity(&self) -> AppResult<CapacityUsage> {
        let usage = self.capacity_usage().await?;
        let report = self.cleanup_for_usage(&usage).await?;
        if report.bytes_reclaimed > 0 {
            self.capacity_usage().await
        } else {
            Ok(usage)
        }
    }

    pub async fn cleanup_if_needed(&self) -> AppResult<FileRuntimeReport> {
        self.cleanup_for_usage(&self.capacity_usage().await?).await
    }

    pub(super) async fn cleanup_for_usage(
        &self,
        usage: &CapacityUsage,
    ) -> AppResult<FileRuntimeReport> {
        if usage.total()
            < self
                .storage_limit_bytes
                .saturating_mul(CLEANUP_HIGH_PERCENT)
                / 100
        {
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
        let check_actor = actor.clone();
        self.db
            .run(move |connection| {
                let is_admin = require_actor_identity_raw(connection, &check_actor, unix_now()?)?;
                if !is_admin {
                    return Err(AppError::Forbidden);
                }
                Ok(())
            })
            .await?;
        let limit = self.storage_limit_bytes;
        let (permanent, temporary, pending_deletion, cleaned, projects, recent_cleanup) = self
            .db
            .run(move |connection| {
                let permanent: i64 =
                    connection.query_row(SELECT_TASK_ATTACHMENTS_SQL, [], |r| r.get(0))?;
                let temporary: i64 =
                    connection.query_row(SELECT_TASK_ATTACHMENTS_2_SQL, [], |r| r.get(0))?;
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
                let cleaned: i64 =
                    connection.query_row(SELECT_TASK_ATTACHMENTS_3_SQL, [], |r| r.get(0))?;
                let projects = {
                    let mut statement = connection.prepare(SELECT_PROJECTS_SQL)?;
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
                    let mut statement = connection.prepare(SELECT_CLEANUP_RUNS_SQL)?;
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
            budget_bytes: limit,
            used_bytes: capacity.total(),
            reserved_bytes: capacity.reserved_bytes,
            staging_bytes: capacity.staging_bytes,
            preview_bytes: capacity.preview_bytes,
            permanent_bytes: permanent,
            temporary_bytes: temporary,
            pending_deletion_bytes: pending_deletion,
            cleaned_records: cleaned,
            high_watermark_bytes: limit * CLEANUP_HIGH_PERCENT / 100,
            low_watermark_bytes: limit * CLEANUP_LOW_PERCENT / 100,
            projects,
            recent_cleanup,
        })
    }

    pub async fn cleanup_to_low_watermark(&self) -> AppResult<FileRuntimeReport> {
        self.cleanup_to_target(self.storage_limit_bytes.saturating_mul(CLEANUP_LOW_PERCENT) / 100)
            .await
    }

    pub(super) async fn cleanup_to_target(&self, target: u64) -> AppResult<FileRuntimeReport> {
        self.cleanup_files(Some(target), 0).await
    }

    pub(super) async fn cleanup_for_deficit(&self, deficit: u64) -> AppResult<FileRuntimeReport> {
        self.cleanup_files(None, deficit).await
    }

    pub(super) async fn cleanup_files(
        &self,
        target: Option<u64>,
        deficit: u64,
    ) -> AppResult<FileRuntimeReport> {
        // A per-directory cross-process gate also covers separately constructed services.
        let path = self.store.layout().root().join(".oneloop-cleanup.lock");
        let gate =
            tokio::task::spawn_blocking(move || -> AppResult<Option<FileMaintenanceGate>> {
                let mut options = std::fs::OpenOptions::new();
                options.create(true).truncate(false).read(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let file = options.open(path)?;
                match file.try_lock() {
                    Ok(()) => Ok(Some(FileMaintenanceGate { _lock: file })),
                    Err(std::fs::TryLockError::WouldBlock) => Ok(None),
                    Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
                }
            })
            .await
            .map_err(|error| AppError::internal(format!("cleanup gate failed: {error}")))??;
        let Some(_gate) = gate else {
            return Ok(FileRuntimeReport::default());
        };
        let mut report = FileRuntimeReport::default();
        let _lease = self.db.acquire_data_lease().await?;
        let usage = self.capacity_usage().await?.total();
        let mut needed = target.map_or(deficit, |target| usage.saturating_sub(target));
        let previews = regular_files(self.store.previews()).await?;
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
                    let id = Uuid::now_v7().to_string();
                    tx.execute(
                        "INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at,cleanup_run_id)
                         VALUES(?1,?2,?3,'cleanup',?4,?4,?5)", params![id,blob,key,now,run_tx])?;
                    jobs.push((DeletionJob { id, blob_id: blob, storage_key: key }, size));
                    claimed = claimed.saturating_add(size);
                }
                Ok(jobs)
            }).await?;
            let mut removed = Vec::new();
            let mut parents = HashMap::new();
            for (job, size) in jobs {
                let path = self.store.file_path(&job.storage_key)?;
                match self.store.remove_file_if_present(&path).await {
                    Ok(()) => {
                        self.remove_thumbnail(&job.storage_key).await;
                        parents.insert(path.parent().expect("managed shard").to_path_buf(), path);
                        removed.push((job, size));
                    }
                    Err(error) => {
                        self.record_deletion_failure(&job.id, &error.to_string())
                            .await?
                    }
                }
            }
            for path in parents.into_values() {
                FileStore::sync_deletion_parent(path).await?;
            }
            let (count, bytes) = self
                .db
                .transaction(move |tx| {
                    let mut count = 0;
                    let mut bytes = 0_u64;
                    for (job, size) in removed {
                        // Count physical progress even if another reconciler completed it.
                        bytes = bytes.saturating_add(size);
                        count += u64::from(finish_deletion_job(tx, &job)?);
                    }
                    Ok((count, bytes))
                })
                .await?;
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
                connection.execute(UPDATE_FILE_DELETION_JOBS_SQL, params![error, job_id])?;
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
                    tx.execute(
                        INSERT_FILE_DELETION_JOBS_SQL,
                        params![Uuid::now_v7().to_string(), blob_id, key, reason, now],
                    )?;
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
                let mut statement = connection.prepare(
                    "SELECT b.id,b.storage_key,'manual' FROM tasks t
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
                   AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_blob_id=b.id)",
                )?;
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
                        tx.execute(
                            "INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at)
                             VALUES(?1,?2,?3,?4,?5,?5)",
                            params![Uuid::now_v7().to_string(),blob,key,reason,now])?;
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
                    let mut statement = connection.prepare(SELECT_FILE_DELETION_JOBS_SQL)?;
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
            let mut removed = Vec::new();
            let mut parents = HashMap::new();
            for job in jobs {
                let path = self.store.file_path(&job.storage_key)?;
                if let Err(error) = self.store.remove_file_if_present(&path).await {
                    self.record_deletion_failure(&job.id, &error.to_string())
                        .await?;
                    continue;
                }
                self.remove_thumbnail(&job.storage_key).await;
                parents.insert(path.parent().expect("managed shard").to_path_buf(), path);
                removed.push(job);
            }
            for path in parents.into_values() {
                FileStore::sync_deletion_parent(path).await?;
            }
            completed += self
                .db
                .transaction(move |tx| {
                    let mut count = 0;
                    for job in removed {
                        count += u64::from(finish_deletion_job(tx, &job)?);
                    }
                    Ok(count)
                })
                .await?;
        }
        Ok(completed)
    }

    pub(super) async fn capacity_usage(&self) -> AppResult<CapacityUsage> {
        let now = unix_now()?;
        let (blob_bytes, reserved_bytes, staging_keys) = self
            .db
            .run(move |connection| {
                let blob: i64 = connection.query_row(SELECT_FILE_BLOBS_2_SQL, [], |r| r.get(0))?;
                let mut statement = connection.prepare(SELECT_UPLOAD_RESERVATIONS_2_SQL)?;
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
        for (path, size) in regular_files(self.store.layout().staging()).await? {
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
            preview_bytes: tree_bytes(self.store.previews()).await?,
            unreserved_staging_bytes,
        })
    }
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
