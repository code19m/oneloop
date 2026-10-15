//! Deletion jobs, which remove the files of deleted tasks and attachments
//! after the Undo window, orphans and cleaned temporary files. Each step is
//! safe to run twice.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::json;
use uuid::Uuid;

use super::{DeleteActivityContext, FileService, record_attachment_deletion};
use crate::{
    AppResult,
    auth::{Actor, ActorSource},
    clock::unix_now,
    collaboration::{ActivityInput, record_system_activity_tx},
    domain::UNDO_WINDOW_SECONDS,
    files::FileStore,
};

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

struct DeletionCompletion {
    cleanup_run_id: Option<String>,
    reason: String,
    activity: Option<(DeleteActivityContext, Option<Actor>)>,
}

impl FileService {
    async fn record_deletion_failure(&self, job_id: &str, error: &str) -> AppResult<()> {
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
    async fn deletion_candidates(
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
    async fn claim_for_deletion(&self, candidates: Vec<(String, String, String)>) -> AppResult<()> {
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
    pub(super) async fn complete_deletion_jobs(
        &self,
        jobs: Vec<(DeletionJob, u64)>,
    ) -> AppResult<(u64, u64)> {
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
}

/// Queues the removal of a blob's bytes. The caller has just marked the blob
/// `deleting`, so it has no job yet.
pub(super) fn insert_deletion_job(
    tx: &Transaction<'_>,
    blob_id: &str,
    storage_key: &str,
    reason: &str,
    cleanup_run_id: Option<&str>,
    now: i64,
) -> AppResult<DeletionJob> {
    let job = DeletionJob {
        id: Uuid::now_v7().to_string(),
        blob_id: blob_id.to_owned(),
        storage_key: storage_key.to_owned(),
    };
    tx.execute(
        "INSERT INTO file_deletion_jobs
         (id,blob_id,storage_key,reason,scheduled_at,available_at,cleanup_run_id)
         VALUES(?1,?2,?3,?4,?5,?5,?6)",
        params![job.id, blob_id, storage_key, reason, now, cleanup_run_id],
    )?;
    Ok(job)
}

pub(super) struct DeletionJob {
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

    #[tokio::test]
    async fn the_purge_claim_keeps_files_restored_since_its_scan() {
        let (_root, db) = crate::db::migrated_db();
        let service = FileService::new(db.clone(), 1_000_000, 0);
        let window = crate::domain::UNDO_WINDOW_SECONDS;
        let deleted_at = unix_now().unwrap() - window - 1;
        db.transaction(move |tx| {
            tx.execute_batch(
                "INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                     VALUES('u','u','U','x',1,1,1);
                 INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
                 INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
                 INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at)
                     VALUES('e','p','tr','Epic','2026-11-01',0,1,1);
                 INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
                     VALUES('t','p','e',1,'ONE-1','Task','planning',0,1,1);",
            )?;
            tx.execute(
                "INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                 VALUES('b','key',?1,1,'text/plain','available',1)",
                ["0".repeat(64)],
            )?;
            tx.execute(
                "INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,position,
                                              created_at,last_accessed_at,updated_at,deleted_at)
                 VALUES('a','p','t','b','a.txt','u',0,1,1,1,?1)",
                [deleted_at],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let candidates = service
            .deletion_candidates(unix_now().unwrap() - window)
            .await
            .unwrap();
        assert_eq!(candidates.len(), 1);
        // A restore commits between the scan and the claim.
        db.transaction(|tx| {
            tx.execute("UPDATE task_attachments SET deleted_at=NULL", [])?;
            Ok(())
        })
        .await
        .unwrap();
        service.claim_for_deletion(candidates).await.unwrap();
        let (state, jobs): (String, i64) = db
            .run(|connection| {
                Ok(connection.query_row(
                    "SELECT (SELECT state FROM file_blobs WHERE id='b'),(SELECT count(*) FROM file_deletion_jobs)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .await
            .unwrap();
        assert_eq!((state.as_str(), jobs), ("available", 0));
    }

    #[test]
    fn deletion_candidates_start_from_the_deleted_tasks() {
        let (_root, connection) = crate::db::migrated_connection();
        // Deleted tasks are few; their files must not be found by scanning
        // every stored file.
        let plan = crate::db::query_plan(&connection, DELETION_CANDIDATES_SQL);
        assert!(
            plan.contains("SCAN t USING INDEX tasks_deleted_idx")
                && !plan.contains("file_blobs_cleanup_idx"),
            "{plan}"
        );
    }
}
