//! Room for new files: the watermarks of the storage limit, admission before
//! bytes are written, cleanup of temporary files and the storage report.

use std::collections::{HashMap, HashSet};

use rusqlite::{Transaction, params};
use uuid::Uuid;

use super::{FileRuntimeReport, FileService, deletion::insert_deletion_job};
use crate::{
    AppError, AppResult,
    auth::{Actor, refresh_actor_connection},
    clock::unix_now,
    db::DataLayout,
    error::RuleKind,
    files::{ACCESS_GRACE_SECONDS, StorageCleanupRun, StorageProjectUsage, StorageUsage},
};

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

/// Stored files and unfinished uploads, which uploads and the minute's check
/// compare with the limit. Measuring thumbnails walks every one, so only the
/// Storage report, cleanup and the thumbnail worker add them.
#[derive(Default)]
pub(super) struct CapacityUsage {
    blob_bytes: u64,
    reserved_bytes: u64,
    staging_bytes: u64,
    unreserved_staging_bytes: u64,
}

impl CapacityUsage {
    pub(super) fn total(&self) -> u64 {
        self.blob_bytes
            .saturating_add(self.reserved_bytes)
            .saturating_add(self.unreserved_staging_bytes)
    }
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

    /// Makes room before `size` new bytes are written: cleanup runs when
    /// usage passed the high watermark, or when the disk is short of space.
    /// Returns the bytes outside the database, for `require_capacity`.
    pub(super) async fn admit(&self, size: u64) -> AppResult<u64> {
        self.store.ensure_directories().await?;
        let mut usage = self.capacity_usage().await?;
        if self.cleanup_at(usage.total()).await?.bytes_reclaimed > 0 {
            usage = self.capacity_usage().await?;
        }
        let deficit = self.disk.deficit(size)?;
        if deficit > 0 && self.cleanup_for_deficit(deficit).await?.bytes_reclaimed > 0 {
            usage = self.capacity_usage().await?;
        }
        Ok(usage.unreserved_staging_bytes)
    }

    pub async fn cleanup_if_needed(&self) -> AppResult<FileRuntimeReport> {
        self.cleanup_at(self.capacity_usage().await?.total()).await
    }

    /// Storage cleanup that an administrator asked for. It counts thumbnails,
    /// as the Storage report that offers it does.
    pub async fn cleanup_for(&self, actor: &Actor) -> AppResult<FileRuntimeReport> {
        actor.require_admin()?;
        let actor = actor.clone();
        self.db
            .run(move |connection| refresh_actor_connection(connection, &actor)?.require_admin())
            .await?;
        let used = self.capacity_usage().await?.total();
        self.cleanup_at(used.saturating_add(self.thumbnail_bytes().await?))
            .await
    }

    async fn cleanup_at(&self, used: u64) -> AppResult<FileRuntimeReport> {
        if used < self.high_watermark() {
            return Ok(FileRuntimeReport::default());
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
        let preview_bytes = self.thumbnail_bytes().await?;
        Ok(StorageUsage {
            budget_bytes: self.storage_limit_bytes,
            used_bytes: capacity.total().saturating_add(preview_bytes),
            reserved_bytes: capacity.reserved_bytes,
            staging_bytes: capacity.staging_bytes,
            preview_bytes,
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

    async fn cleanup_for_deficit(&self, deficit: u64) -> AppResult<FileRuntimeReport> {
        self.cleanup_files(None, deficit).await
    }

    async fn cleanup_files(
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
        // Thumbnails count here, measured by the walk that finds them.
        let previews = self.regular_files(self.store.previews()).await?;
        let usage = previews
            .iter()
            .map(|(_, size)| *size)
            .fold(self.capacity_usage().await?.total(), u64::saturating_add);
        let mut needed = target.map_or(deficit, |target| usage.saturating_sub(target));
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
                RuleKind::StorageFull,
                "storage safety floor cannot be recovered from eligible temporary files",
            ));
        }
        // With nothing to remove, no run is recorded.
        if previews.is_empty() && (needed == 0 || candidates.is_empty()) {
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
                    let job = insert_deletion_job(tx, &blob, &key, "cleanup", Some(&run_tx), now)?;
                    jobs.push((job, size));
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
            unreserved_staging_bytes,
        })
    }

    /// Bytes of thumbnails, from a walk of the previews folder.
    pub(super) async fn thumbnail_bytes(&self) -> AppResult<u64> {
        self.tree_bytes(self.store.previews()).await
    }
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
            RuleKind::StorageFull,
            "attachment storage capacity is exhausted",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_queries_read_a_covering_index() {
        let (_root, connection) = crate::db::migrated_connection();
        for sql in [STORED_BYTES_SQL, CAPACITY_USED_SQL] {
            let plan = crate::db::query_plan(&connection, sql);
            assert!(
                plan.contains("COVERING INDEX file_blobs_state_size_idx"),
                "{sql}\n{plan}"
            );
        }
    }
}
