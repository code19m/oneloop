//! File lifecycle coordination. Authentication, DB metadata and leases protect every byte path; durable jobs make filesystem changes recoverable.

mod detect;
use detect::preview_kind_from_metadata;
pub(crate) use detect::validate_original_name;
mod avatar;
mod maintenance;
mod read;
pub use read::ReadMode;
mod upload;

use super::BlobState;
use super::disk::{DiskAdmission, DiskReservation};
use crate::{auth::unix_now, idempotency::validate_key as validate_idempotency_key};
use std::{
    collections::{HashMap, HashSet},
    io::Cursor,
    path::{Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};

use image::{ImageEncoder, ImageFormat, ImageReader, Limits};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncWriteExt, ReadBuf},
};
use uuid::Uuid;

use crate::{
    AppError, AppResult, Db,
    auth::{Actor, ActorSource},
    collaboration::{ActivityInput, record_activity_tx, record_system_activity_tx},
    db::DataLease,
};

use super::{
    ACCESS_GRACE_SECONDS, AttachmentList, AttachmentPatch, AttachmentReorder, AttachmentView,
    FILE_LEASE_SECONDS, FileStore, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TASK,
    MAX_AVATAR_BYTES, MAX_HTML_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES, PreviewKind,
    StorageCleanupRun, StorageProjectUsage, StorageUsage, StoredFile, UPLOAD_RESERVATION_SECONDS,
};

const CLEANUP_HIGH_PERCENT: u64 = 80;
const CLEANUP_LOW_PERCENT: u64 = 70;

const PREFIX_INSPECTION_BYTES: usize = MAX_HTML_PREVIEW_BYTES as usize;
const AVATAR_SIDE: u32 = 256;
const AVATAR_MAX_DIMENSION: u32 = 8192;
const AVATAR_MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const FILE_MAINTENANCE_LOCK_FILE: &str = ".oneloop-files.lock";

#[derive(Clone)]
pub struct FileService {
    db: Db,
    store: FileStore,
    storage_limit_bytes: u64,
    disk: DiskAdmission,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRuntimeReport {
    pub expired_uploads_removed: u64,
    pub orphan_files_removed: u64,
    pub deletion_jobs_completed: u64,
    pub temporary_files_cleaned: u64,
    pub bytes_reclaimed: u64,
}

pub enum UploadStart {
    Replayed(Box<AttachmentView>),
    Pending(Box<PendingAttachmentUpload>),
}

pub struct PendingAttachmentUpload {
    disk: Option<DiskReservation>,
    service: FileService,
    actor: Actor,
    reservation_id: String,
    idempotency_id: String,
    task_id: String,
    project_id: String,
    original_name: String,
    is_ephemeral: bool,
    claimed_size: u64,
    staging_path: PathBuf,
    storage_key: String,
    file: Option<File>,
    written: u64,
    hasher: Sha256,
    inspection: Vec<u8>,
    finished: bool,
}

struct FinalizeAttachmentUpload {
    disk: Option<DiskReservation>,
    service: FileService,
    actor: Actor,
    data_lease: DataLease,
    reservation_id: String,
    idempotency_id: String,
    task_id: String,
    project_id: String,
    original_name: String,
    is_ephemeral: bool,
    staging_path: PathBuf,
    storage_key: String,
    file: Option<File>,
    written: u64,
    hasher: Sha256,
    inspection: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UploadCleanupDecision {
    PreserveCommitted,
    RemoveUncommitted,
}

struct FileMaintenanceGate {
    _lock: std::fs::File,
}

pub struct FileRead {
    pub file: LeasedFile,
    pub attachment: AttachmentView,
    pub media_type: String,
    pub byte_limit: Option<u64>,
}

pub(crate) enum ConditionalRead {
    Modified(Box<FileRead>),
    NotModified(String),
}

pub(crate) fn file_etag(checksum: &str, source: bool) -> String {
    if source {
        format!("\"{checksum}-source-{MAX_TEXT_PREVIEW_BYTES}\"")
    } else {
        format!("\"{checksum}\"")
    }
}

pub(crate) fn etag_matches(request: Option<&str>, etag: &str) -> bool {
    request.is_some_and(|value| {
        value.split(',').any(|tag| {
            let tag = tag.trim();
            tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
        })
    })
}

pub struct LeasedFile {
    file: File,
    db: Db,
    lease_id: Option<String>,
}

impl AsyncRead for LeasedFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.file).poll_read(context, buffer)
    }
}

impl AsyncSeek for LeasedFile {
    fn start_seek(mut self: Pin<&mut Self>, position: std::io::SeekFrom) -> std::io::Result<()> {
        Pin::new(&mut self.file).start_seek(position)
    }

    fn poll_complete(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<u64>> {
        Pin::new(&mut self.file).poll_complete(context)
    }
}

impl Drop for LeasedFile {
    fn drop(&mut self) {
        let Some(lease_id) = self.lease_id.take() else {
            return;
        };
        let db = self.db.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Err(error) = db
                    .transaction(move |connection| {
                        connection.execute("DELETE FROM file_leases WHERE id=?1", [lease_id])?;
                        Ok(())
                    })
                    .await
                {
                    tracing::warn!(%error, "file lease release failed; expiry cleanup will retry");
                }
            });
        }
    }
}

#[derive(Default)]
struct CapacityUsage {
    blob_bytes: u64,
    reserved_bytes: u64,
    staging_bytes: u64,
    preview_bytes: u64,
    unreserved_staging_bytes: u64,
}

struct DeleteActivityContext {
    id: String,
    project_id: Option<String>,
    task_id: Option<String>,
    name: String,
}

struct DeletionCompletion {
    cleanup_run_id: Option<String>,
    reason: String,
    activity: Option<(DeleteActivityContext, Option<Actor>)>,
}

impl CapacityUsage {
    fn total(&self) -> u64 {
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

impl FileService {
    pub fn new(db: Db, storage_limit_bytes: u64, disk_min_free_bytes: u64) -> Self {
        let store = FileStore::new(db.layout().clone());
        let disk = DiskAdmission::new(db.layout().root(), disk_min_free_bytes);
        Self {
            db,
            store,
            storage_limit_bytes,
            disk,
        }
    }

    pub fn store(&self) -> &FileStore {
        &self.store
    }

    async fn acquire_file_maintenance_gate(&self) -> AppResult<FileMaintenanceGate> {
        let path = self.db.layout().root().join(FILE_MAINTENANCE_LOCK_FILE);
        tokio::task::spawn_blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.create(true).truncate(false).read(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path)?;
            file.lock().map_err(|error| {
                AppError::Io(format!("lock file maintenance {}: {error}", path.display()))
            })?;
            Ok(FileMaintenanceGate { _lock: file })
        })
        .await
        .map_err(|error| AppError::internal(format!("file maintenance worker failed: {error}")))?
    }

    pub async fn list_attachments(
        &self,
        actor: &Actor,
        task_id: &str,
    ) -> AppResult<AttachmentList> {
        let actor = actor.clone();
        let task_id = task_id.to_owned();
        let items = self
            .db
            .run(move |connection| {
                let project_id = task_project(connection, &task_id)?;
                require_file_access_connection(connection, &actor, &project_id, false, false)?;
                attachment_views(connection, &task_id)
            })
            .await?;
        Ok(AttachmentList { items })
    }

    pub async fn set_ephemeral(
        &self,
        actor: &Actor,
        attachment_id: &str,
        patch: AttachmentPatch,
    ) -> AppResult<AttachmentView> {
        if patch.expected_revision < 1 {
            return Err(AppError::validation("expectedRevision", "must be positive"));
        }
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                let stored = attachment_by_id(tx, &attachment_id)?;
                require_file_access_tx(
                    tx,
                    &actor,
                    &stored.attachment.project_id,
                    true,
                    false,
                    now,
                )?;
                // Already set: a retry of an applied change succeeds, while a
                // stale request for the other value still conflicts below.
                if stored.attachment.is_ephemeral == patch.is_ephemeral {
                    return Ok(stored.attachment);
                }
                if stored.attachment.state != BlobState::Available {
                    return Err(AppError::Conflict(
                        "cleaned attachments cannot change retention".into(),
                    ));
                }
                if stored.attachment.revision != patch.expected_revision {
                    return Err(AppError::revision(
                        patch.expected_revision,
                        stored.attachment.revision,
                    ));
                }
                let revision = patch.expected_revision + 1;
                tx.execute(
                    "UPDATE task_attachments SET is_ephemeral=?1,updated_at=?2,revision=?3
                     WHERE id=?4 AND revision=?5",
                    params![
                        patch.is_ephemeral,
                        now,
                        revision,
                        attachment_id,
                        patch.expected_revision
                    ],
                )?;
                record_activity_tx(
                    tx,
                    &actor,
                    ActivityInput {
                        project_id: Some(&stored.attachment.project_id),
                        entity_type: "attachment",
                        entity_id: &attachment_id,
                        task_id: Some(&stored.attachment.task_id),
                        event_type: "attachment.retention.updated",
                        field_key: Some("retention"),
                        before: Some(json!(stored.attachment.is_ephemeral)),
                        after: Some(json!(patch.is_ephemeral)),
                        metadata: json!({"name": stored.attachment.name}),
                        entity_revision: Some(revision),
                    },
                    now,
                )?;
                Ok(attachment_by_id(tx, &attachment_id)?.attachment)
            })
            .await
    }

    pub async fn reorder(
        &self,
        actor: &Actor,
        task_id: &str,
        input: AttachmentReorder,
    ) -> AppResult<AttachmentList> {
        validate_idempotency_key(&input.idempotency_key)?;
        if input.expected_revision < 1 {
            return Err(AppError::validation("expectedRevision", "must be positive"));
        }
        let actor = actor.clone();
        let task_id = task_id.to_owned();
        let request_hash = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!({
                "taskId": task_id,
                "attachmentId": input.attachment_id,
                "targetId": input.target_id,
                "after": input.after,
                "expectedRevision": input.expected_revision,
            }))
            .expect("serializable reorder hash"),
        ));
        let idempotency_id = Uuid::now_v7().to_string();
        let list = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let project_id = task_project(tx, &task_id)?;
                require_file_access_tx(tx, &actor, &project_id, true, false, now)?;
                if let Some(existing) =
                    reorder_idempotency_replay(tx, &actor, &input.idempotency_key, &request_hash)?
                {
                    return Ok(existing);
                }
                let actual_id = upsert_running_idempotency(
                    tx,
                    &actor,
                    &idempotency_id,
                    &input.idempotency_key,
                    "attachment.reorder",
                    &request_hash,
                    now,
                )?;
                let mut current = attachment_views(tx, &task_id)?;
                let previous_positions = current
                    .iter()
                    .map(|item| (item.id.clone(), (item.position, item.revision)))
                    .collect::<HashMap<_, _>>();
                let moving = current
                    .iter()
                    .position(|item| item.id == input.attachment_id)
                    .ok_or(AppError::NotFound {
                        resource: "attachment",
                    })?;
                if current[moving].revision != input.expected_revision {
                    return Err(AppError::revision(input.expected_revision, current[moving].revision));
                }
                if input.attachment_id == input.target_id {
                    let result = AttachmentList { items: current };
                    finish_reorder_idempotency(tx, &actual_id, &input.attachment_id, &result, now)?;
                    return Ok(result);
                }
                let item = current.remove(moving);
                let target = current
                    .iter()
                    .position(|entry| entry.id == input.target_id)
                    .ok_or(AppError::NotFound {
                        resource: "attachment",
                    })?;
                current.insert(target + usize::from(input.after), item);
                let before = attachment_views(tx, &task_id)?
                    .into_iter()
                    .map(|item| item.id)
                    .collect::<Vec<_>>();
                let after = current
                    .iter()
                    .map(|item| item.id.clone())
                    .collect::<Vec<_>>();
                if before == after {
                    let result = AttachmentList { items: current };
                    finish_reorder_idempotency(tx, &actual_id, &input.attachment_id, &result, now)?;
                    return Ok(result);
                }
                tx.execute(
                    "UPDATE task_attachments SET position=position+1000000 WHERE task_id=?1",
                    [&task_id],
                )?;
                for (position, item) in current.iter().enumerate() {
                    let (old_position, old_revision) = previous_positions
                        .get(&item.id)
                        .copied()
                        .ok_or_else(|| AppError::internal("attachment order changed unexpectedly"))?;
                    let revision = old_revision + i64::from(old_position != position as i64);
                    tx.execute(
                        "UPDATE task_attachments SET position=?1,updated_at=?2,revision=?3 WHERE id=?4",
                        params![position as i64, now, revision, item.id],
                    )?;
                }
                record_activity_tx(
                    tx,
                    &actor,
                    ActivityInput {
                        project_id: Some(&project_id),
                        entity_type: "task",
                        entity_id: &task_id,
                        task_id: Some(&task_id),
                        event_type: "attachment.reordered",
                        field_key: Some("attachment-order"),
                        before: Some(json!(before)),
                        after: Some(json!(after)),
                        metadata: json!({}),
                        entity_revision: None,
                    },
                    now,
                )?;
                let result = AttachmentList {
                    items: attachment_views(tx, &task_id)?,
                };
                finish_reorder_idempotency(tx, &actual_id, &input.attachment_id, &result, now)?;
                Ok(result)
            })
            .await?;
        Ok(list)
    }

    pub async fn delete_attachment(
        &self,
        actor: &Actor,
        attachment_id: &str,
        expected_revision: i64,
        idempotency_key: &str,
    ) -> AppResult<()> {
        if expected_revision < 1 {
            return Err(AppError::validation("expectedRevision", "must be positive"));
        }
        validate_idempotency_key(idempotency_key)?;
        let _lease = self.db.acquire_data_lease().await?;
        let actor_owned = actor.clone();
        let attachment_id_owned = attachment_id.to_owned();
        let key_owned = idempotency_key.to_owned();
        let request_hash = hex::encode(Sha256::digest(
            serde_json::to_vec(
                &json!({"attachmentId":attachment_id,"expectedRevision":expected_revision}),
            )
            .expect("serializable delete hash"),
        ));
        let idempotency_id = Uuid::now_v7().to_string();
        enum DeleteStart {
            Done,
            Pending {
                stored: Box<StoredFile>,
                storage_key: String,
                job_id: String,
                idempotency_id: String,
            },
        }
        let start = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                if let Some(replay)=delete_idempotency_replay(tx,&actor_owned,&key_owned,&request_hash)?{
                    require_file_access_tx(tx,&actor_owned,&replay.0,false,true,now)?;
                    return Ok(DeleteStart::Done);
                }
                let stored = attachment_by_id(tx, &attachment_id_owned)?;
                require_file_access_tx(
                    tx,
                    &actor_owned,
                    &stored.attachment.project_id,
                    true,
                    true,
                    now,
                )?;
                if stored.attachment.revision != expected_revision {
                    return Err(AppError::revision(expected_revision, stored.attachment.revision));
                }
                let actual_id=upsert_running_idempotency(tx,&actor_owned,&idempotency_id,&key_owned,"attachment.delete",&request_hash,now)?;
                let leased: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM file_leases WHERE blob_id=?1 AND expires_at>?2)",
                    params![stored.blob_id, now],
                    |row| row.get(0),
                )?;
                if leased {
                    return Err(AppError::Conflict(
                        "the attachment is currently being transferred; retry shortly".into(),
                    ));
                }
                let response = json!({"projectId":stored.attachment.project_id,"taskId":stored.attachment.task_id}).to_string();
                let Some(storage_key) = stored.storage_key.as_deref() else {
                    // Cleaned files have no bytes to unlink, so their deletion,
                    // audit record and receipt complete in this transaction.
                    let removed = tx.execute("DELETE FROM task_attachments WHERE id=?1", [&attachment_id_owned])?;
                    tx.execute("DELETE FROM file_blobs WHERE id=?1", [&stored.blob_id])?;
                    if removed > 0 {
                        record_attachment_deletion(tx, &DeleteActivityContext {
                            id: attachment_id_owned.clone(), project_id: Some(stored.attachment.project_id.clone()),
                            task_id: Some(stored.attachment.task_id.clone()), name: stored.attachment.name.clone(),
                        }, Some(&actor_owned), now)?;
                    }
                    crate::idempotency::succeed(tx, &actual_id, crate::idempotency::Receipt {
                        status: 204, response: &response,
                        resource_type: Some("attachment"), resource_id: Some(&attachment_id_owned),
                        project_id: Some(&stored.attachment.project_id),
                    }, now)?;
                    return Ok(DeleteStart::Done);
                };
                tx.execute("UPDATE file_blobs SET state='deleting' WHERE id=?1", [&stored.blob_id])?;
                tx.execute("INSERT OR IGNORE INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at)
                    VALUES(?1,?2,?3,'manual',?4,?4)", params![Uuid::now_v7().to_string(), stored.blob_id, storage_key, now])?;
                let job_id: String = tx.query_row("SELECT id FROM file_deletion_jobs WHERE blob_id=?1", [&stored.blob_id], |r| r.get(0))?;
                // Freeze the first deleting actor. A retry must not replace it.
                // A previously queued cleanup becomes a manual deletion.
                tx.execute("UPDATE file_deletion_jobs SET reason='manual',actor_user_id=?2,actor_mcp_grant_id=?3,
                    actor_name=?4,project_id=?5,task_id=?6,attachment_id=?7,attachment_name=?8
                    WHERE id=?1 AND attachment_id IS NULL",
                    params![job_id, actor_owned.user_id, actor_owned.mcp_grant_id(), actor_owned.display_name,
                        stored.attachment.project_id, stored.attachment.task_id, stored.attachment.id, stored.attachment.name])?;

                tx.execute(
                    "UPDATE idempotency_keys SET resource_type='attachment',resource_id=?1,response_json=?2
                     WHERE id=?3",
                    params![attachment_id_owned, response, actual_id],
                )?;
                let storage_key = storage_key.to_owned();
                Ok(DeleteStart::Pending { stored: Box::new(stored), storage_key, job_id, idempotency_id: actual_id })
            })
            .await?;

        let DeleteStart::Pending {
            stored,
            storage_key,
            job_id,
            idempotency_id,
        } = start
        else {
            return Ok(());
        };

        let path = self.store.file_path(&storage_key)?;
        if let Err(error) = self.store.remove_file_if_present(&path).await {
            log_cleanup_failure(
                self.record_deletion_failure(&job_id, &error.to_string())
                    .await,
            );
            log_cleanup_failure(self.fail_idempotency(&idempotency_id).await);
            return Err(AppError::Unavailable(
                "attachment deletion is pending and will be retried".into(),
            ));
        }
        FileStore::sync_deletion_parent(path).await?;

        // If this fails, reconciliation finishes the job and the receipt.
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                finish_deletion_job(tx, &DeletionJob {
                    id: job_id, blob_id: stored.blob_id.clone(), storage_key,
                })?;
                crate::idempotency::succeed(tx, &idempotency_id, crate::idempotency::Receipt {
                    status: 204,
                    response: &json!({"projectId":stored.attachment.project_id,"taskId":stored.attachment.task_id}).to_string(),
                    resource_type: Some("attachment"), resource_id: Some(&attachment_id),
                    project_id: Some(&stored.attachment.project_id),
                }, now)?;
                Ok(())
            })
            .await
    }
}

enum ReserveOutcome {
    Replay(Box<AttachmentView>),
    Reserved(String, String),
}

fn task_project(connection: &rusqlite::Connection, task_id: &str) -> AppResult<String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
            [task_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "task" })
}

fn require_file_access_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
    write: bool,
    destructive: bool,
) -> AppResult<()> {
    require_file_access_raw(
        connection,
        actor,
        project_id,
        write,
        destructive,
        unix_now()?,
    )
}
fn require_file_access_tx(
    tx: &Transaction<'_>,
    actor: &Actor,
    project_id: &str,
    write: bool,
    destructive: bool,
    now: i64,
) -> AppResult<()> {
    require_file_access_raw(tx, actor, project_id, write, destructive, now)
}
fn require_file_access_raw(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
    write: bool,
    destructive: bool,
    _now: i64,
) -> AppResult<()> {
    crate::access::require_project(
        connection,
        actor,
        project_id,
        crate::access::Need::Attachments { write },
        destructive,
    )
    .map_err(|error| {
        if !write && matches!(error, AppError::Forbidden) {
            AppError::NotFound {
                resource: "attachment",
            }
        } else {
            error
        }
    })
}

fn require_actor_identity_raw(
    connection: &rusqlite::Connection,
    actor: &Actor,
    _now: i64,
) -> AppResult<bool> {
    Ok(crate::auth::refresh_actor_connection(connection, actor)?.is_admin)
}

fn attachment_by_id(connection: &rusqlite::Connection, id: &str) -> AppResult<StoredFile> {
    connection
        .query_row(SELECT_TASK_ATTACHMENTS_4_SQL, [id], stored_file_row)
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "attachment",
        })
}
fn attachment_views(
    connection: &rusqlite::Connection,
    task_id: &str,
) -> AppResult<Vec<AttachmentView>> {
    let mut s=connection.prepare("SELECT a.id,a.project_id,a.task_id,a.original_name,b.size_bytes,b.media_type,\
                     b.checksum_sha256,a.is_ephemeral,a.position,a.uploaded_by,a.created_at,a.last_accessed_at,\
                     b.state,a.revision,b.id,b.storage_key FROM task_attachments a JOIN file_blobs b ON \
                     b.id=a.blob_id WHERE a.task_id=?1 ORDER BY a.position,a.id")?;
    Ok(s.query_map([task_id], stored_file_row)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|x| x.attachment)
        .collect())
}
fn stored_file_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredFile> {
    let id: String = row.get(0)?;
    let name: String = row.get(3)?;
    let size = row.get::<_, i64>(4)?.max(0) as u64;
    let media: String = row.get(5)?;
    let state: BlobState = row.get(12)?;
    let preview = preview_kind_from_metadata(&name, &media)
        .filter(|kind| *kind != PreviewKind::Html || size <= MAX_HTML_PREVIEW_BYTES);
    let available = state == BlobState::Available;
    Ok(StoredFile {
        attachment: AttachmentView {
            id: id.clone(),
            project_id: row.get(1)?,
            task_id: row.get(2)?,
            name,
            size,
            media_type: media,
            checksum: row.get(6)?,
            is_ephemeral: row.get(7)?,
            position: row.get(8)?,
            uploaded_by: row.get(9)?,
            uploaded_at: row.get(10)?,
            last_accessed_at: row.get(11)?,
            state,
            revision: row.get(13)?,
            preview_kind: preview,
            download_url: available.then(|| format!("/api/attachments/{id}/download")),
            content_url: (available
                && matches!(preview, Some(PreviewKind::Image | PreviewKind::Pdf)))
            .then(|| format!("/api/attachments/{id}/content")),
            source_url: (available
                && matches!(
                    preview,
                    Some(PreviewKind::Text | PreviewKind::Markdown | PreviewKind::Html)
                ))
            .then(|| format!("/api/attachments/{id}/source")),
            html_preview_url: (available && preview == Some(PreviewKind::Html))
                .then(|| format!("/api/attachments/{id}/preview/html")),
        },
        blob_id: row.get(14)?,
        storage_key: row.get(15)?,
    })
}

fn upload_request_hash(task: &str, name: &str, size: u64, ephemeral: bool) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(&json!({"taskId":task,"name":name,"size":size,"ephemeral":ephemeral}))
            .expect("serializable upload hash"),
    ))
}
fn idempotency_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    key: &str,
    operation: &str,
    hash: &str,
) -> AppResult<Option<AttachmentView>> {
    crate::idempotency::replay(tx, actor, key, operation, hash)
}
fn delete_idempotency_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    key: &str,
    hash: &str,
) -> AppResult<Option<(String, String)>> {
    let value: Option<serde_json::Value> =
        crate::idempotency::replay(tx, actor, key, "attachment.delete", hash)?;
    value
        .map(|value| {
            Ok((
                value["projectId"]
                    .as_str()
                    .ok_or_else(|| AppError::internal("deletion replay lacks project"))?
                    .to_owned(),
                value["taskId"]
                    .as_str()
                    .ok_or_else(|| AppError::internal("deletion replay lacks task"))?
                    .to_owned(),
            ))
        })
        .transpose()
}

fn reorder_idempotency_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    key: &str,
    hash: &str,
) -> AppResult<Option<AttachmentList>> {
    crate::idempotency::replay(tx, actor, key, "attachment.reorder", hash)
}

fn finish_reorder_idempotency(
    tx: &Transaction<'_>,
    idempotency_id: &str,
    attachment_id: &str,
    result: &AttachmentList,
    now: i64,
) -> AppResult<()> {
    let response = serde_json::to_string(result)
        .map_err(|error| AppError::internal(format!("serialize reorder response: {error}")))?;
    crate::idempotency::succeed(
        tx,
        idempotency_id,
        crate::idempotency::Receipt {
            status: 200,
            response: &response,
            resource_type: Some("attachment"),
            resource_id: Some(attachment_id),
            project_id: None,
        },
        now,
    )?;
    Ok(())
}
fn upsert_running_idempotency(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    key: &str,
    operation: &str,
    hash: &str,
    now: i64,
) -> AppResult<String> {
    crate::idempotency::start(tx, actor, id, key, operation, hash, now)
}

fn record_attachment_deletion(
    tx: &Transaction<'_>,
    attachment: &DeleteActivityContext,
    actor: Option<&Actor>,
    now: i64,
) -> AppResult<()> {
    let mut metadata = json!({"name": attachment.name});
    if actor.is_none() {
        // Only pre-upgrade jobs whose receipt was already lost lack an actor.
        metadata["attributionUnavailable"] = json!(true);
    }
    let input = ActivityInput {
        project_id: attachment.project_id.as_deref(),
        entity_type: "attachment",
        entity_id: &attachment.id,
        task_id: attachment.task_id.as_deref(),
        event_type: "attachment.deleted",
        field_key: None,
        before: Some(json!({"name":attachment.name})),
        after: None,
        metadata,
        entity_revision: None,
    };
    match actor {
        Some(actor) => record_activity_tx(tx, actor, input, now)?,
        None => record_system_activity_tx(tx, input, now)?,
    };
    Ok(())
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

static FILE_SCAN_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

async fn regular_files(root: PathBuf) -> AppResult<Vec<(PathBuf, u64)>> {
    let permit = FILE_SCAN_PERMITS
        .acquire()
        .await
        .map_err(|_| AppError::Unavailable("file scanner is shutting down".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        regular_files_blocking(root)
    })
    .await
    .map_err(|error| AppError::internal(format!("file scanner failed: {error}")))?
}

fn regular_files_blocking(root: PathBuf) -> AppResult<Vec<(PathBuf, u64)>> {
    let mut files = Vec::new();
    walk_regular_files_blocking(root, |path, size| {
        files.push((path, size));
        Ok(())
    })?;
    Ok(files)
}

async fn unreferenced_files(root: PathBuf, referenced: HashSet<String>) -> AppResult<Vec<PathBuf>> {
    let permit = FILE_SCAN_PERMITS
        .acquire()
        .await
        .map_err(|_| AppError::Unavailable("file scanner is shutting down".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
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
    .await
    .map_err(|error| AppError::internal(format!("file scanner failed: {error}")))?
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
async fn tree_bytes(root: PathBuf) -> AppResult<u64> {
    let permit = FILE_SCAN_PERMITS
        .acquire()
        .await
        .map_err(|_| AppError::Unavailable("file scanner is shutting down".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut total = 0_u64;
        walk_regular_files_blocking(root, |_, size| {
            total = total.saturating_add(size);
            Ok(())
        })?;
        Ok(total)
    })
    .await
    .map_err(|error| AppError::internal(format!("file scanner failed: {error}")))?
}

fn normalize_avatar(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let format = image::guess_format(bytes)
        .map_err(|_| AppError::validation("avatar", "must be a valid PNG, JPEG or WebP image"))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(AppError::validation(
            "avatar",
            "must be a PNG, JPEG or WebP image",
        ));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(AVATAR_MAX_DIMENSION);
    limits.max_image_height = Some(AVATAR_MAX_DIMENSION);
    limits.max_alloc = Some(AVATAR_MAX_DECODE_BYTES);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| {
        AppError::validation("avatar", "image data is invalid or exceeds safe dimensions")
    })?;
    let normalized = image
        .resize_to_fill(
            AVATAR_SIDE,
            AVATAR_SIDE,
            image::imageops::FilterType::Lanczos3,
        )
        .to_rgba8();
    let mut output = Vec::new();
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(
            &normalized,
            AVATAR_SIDE,
            AVATAR_SIDE,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| AppError::validation("avatar", "image could not be normalized"))?;
    Ok(output)
}

/// Remove direct-navigation and nested browsing primitives before applying the
/// response-header sandbox. This lexical pass is intentionally conservative;
/// the CSP remains the primary execution boundary.
pub fn sanitize_html_preview(bytes: &[u8]) -> Vec<u8> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return b"<!doctype html><meta charset=utf-8><p>This HTML file is not valid UTF-8.</p>"
            .to_vec();
    };
    let mut output = String::with_capacity(source.len());
    let lower = source.to_ascii_lowercase();
    let mut cursor = 0;
    let mut dead_states = vec![0_u8; source.len()];
    let mut visited = Vec::new();
    while let Some(relative) = lower[cursor..].find('<') {
        let start = cursor + relative;
        output.push_str(&source[cursor..start]);
        let Some(tag_end) = find_tag_end(source.as_bytes(), start, &mut dead_states, &mut visited)
        else {
            output.push_str("&lt;");
            cursor = start + 1;
            continue;
        };
        let end = tag_end + 1;
        let tag = &lower[start + 1..end - 1];
        let normalized = tag.trim_start().trim_start_matches('/').trim_start();
        let name = normalized
            .split(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("");
        let remove = matches!(
            name,
            "iframe"
                | "frame"
                | "frameset"
                | "object"
                | "embed"
                | "base"
                | "portal"
                | "fencedframe"
        ) || (name == "meta" && tag.contains("http-equiv"));
        if !remove {
            output.push_str(&source[start..end]);
        }
        cursor = end;
    }
    output.push_str(&source[cursor..]);
    output.into_bytes()
}
fn find_tag_end(
    bytes: &[u8],
    start: usize,
    dead: &mut [u8],
    visited: &mut Vec<(usize, u8)>,
) -> Option<usize> {
    // States: attribute/name, after '=', unquoted value, single/double quote.
    // Failed (position, state) pairs are visited at most once across all tags.
    // Successful scans cover disjoint output ranges, so total work is O(bytes).
    let mut state = 0;
    visited.clear();
    for (index, &ch) in bytes.iter().enumerate().skip(start + 1) {
        let bit = 1 << state;
        if dead[index] & bit != 0 {
            break;
        }
        visited.push((index, bit));
        state = match (state, ch) {
            (3, b'\'') | (4, b'"') => 0,
            (3 | 4, _) => state,
            (_, b'>') => return Some(index),
            (1, b'\'') => 3,
            (1, b'"') => 4,
            (1, ch) if ch.is_ascii_whitespace() => 1,
            (1, _) => 2,
            (_, ch) if ch.is_ascii_whitespace() => 0,
            (0, b'=') => 1,
            _ => state,
        };
    }
    for &(index, bit) in visited.iter() {
        dead[index] |= bit;
    }
    None
}

static HTML_PREVIEW_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Sanitize HTML for the sandboxed preview frame, at most two files at once.
pub(crate) async fn sanitized_html_preview(bytes: Vec<u8>) -> AppResult<Vec<u8>> {
    let permit = HTML_PREVIEW_PERMITS
        .acquire()
        .await
        .map_err(|_| AppError::Unavailable("preview worker is shutting down".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        sanitize_html_preview(&bytes)
    })
    .await
    .map_err(|error| AppError::internal(format!("preview worker failed: {error}")))
}

/// The media type and preview kind of complete file contents, decided as for
/// uploads: by content first, with the name only choosing among text formats.
pub(crate) fn classify_bytes(name: &str, bytes: &[u8]) -> (String, Option<PreviewKind>) {
    let media = detect::detected_media_type(bytes, detect::detect_preview(name, bytes));
    let preview = preview_kind_from_metadata(name, &media)
        .filter(|kind| *kind != PreviewKind::Html || bytes.len() as u64 <= MAX_HTML_PREVIEW_BYTES);
    (media, preview)
}
static AVATAR_DECODE_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

async fn avatar_decode_permit() -> AppResult<tokio::sync::SemaphorePermit<'static>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        AVATAR_DECODE_PERMITS.acquire(),
    )
    .await
    .map_err(|_| AppError::Unavailable("avatar processing is busy; retry shortly".into()))?
    .map_err(|_| AppError::Unavailable("avatar worker is shutting down".into()))
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
            .query_row(SELECT_TASK_ATTACHMENTS_5_SQL, [&blob], |r| {
                Ok((r.get(0)?, r.get::<_, i64>(1)?.max(0) as u64))
            })
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
        record_attachment_deletion(tx, &attachment, actor.as_ref(), now)?;
        tx.execute("UPDATE idempotency_keys SET state='succeeded',response_status=204,updated_at=?1 WHERE \
                     operation='attachment.delete' AND resource_type='attachment' AND resource_id=?2",params![now,attachment.id])?;
        tx.execute("DELETE FROM task_attachments WHERE blob_id=?1", [&blob])?;
        tx.execute("DELETE FROM file_blobs WHERE id=?1", [&blob])?;
    } else {
        tx.execute("DELETE FROM task_attachments WHERE blob_id=?1", [&blob])?;
        tx.execute("DELETE FROM file_blobs WHERE id=?1", [&blob])?;
    }
    Ok(true)
}

// SQL is kept outside calls so rustfmt can format the surrounding control flow.
const SELECT_FILE_BLOBS_SQL: &str = "SELECT
                       coalesce((SELECT sum(size_bytes) FROM file_blobs WHERE state IN ('pending','available','deleting')),0) +
                       coalesce((SELECT sum(size_bytes) FROM upload_reservations
                                 WHERE committed_at IS NULL AND expires_at>?1),0)";
const SELECT_PROJECT_MEMBERSHIPS_SQL: &str = "SELECT EXISTS(SELECT 1 FROM project_memberships a JOIN project_memberships b ON \
                     b.project_id=a.project_id JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL \
                     WHERE a.user_id=?1 AND b.user_id=?2)";
const SELECT_USERS_SQL: &str = "SELECT b.storage_key,b.size_bytes,b.checksum_sha256,b.id FROM users u JOIN file_blobs b \
                     ON b.id=u.avatar_blob_id WHERE u.id=?1 AND u.is_active=1 AND b.state='available'";
const INSERT_FILE_LEASES_SQL: &str = "INSERT INTO file_leases(id,blob_id,lease_kind,owner,created_at,expires_at) VALUES(?1,?2,\
                     'preview',?3,?4,?5)";
const SELECT_TASK_ATTACHMENTS_SQL: &str = "SELECT coalesce(sum(b.size_bytes),0) FROM task_attachments a JOIN file_blobs b ON \
                     b.id=a.blob_id WHERE a.is_ephemeral=0 AND b.state='available'";
const SELECT_TASK_ATTACHMENTS_2_SQL: &str = "SELECT coalesce(sum(b.size_bytes),0) FROM task_attachments a JOIN file_blobs b ON \
                     b.id=a.blob_id WHERE a.is_ephemeral=1 AND b.state='available'";
const SELECT_TASK_ATTACHMENTS_3_SQL: &str = "SELECT count(*) FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id WHERE \
                     b.state='cleaned'";
const UPDATE_FILE_DELETION_JOBS_SQL: &str = "UPDATE file_deletion_jobs SET attempt_count=attempt_count+1,\
                     available_at=unixepoch()+min(3600,30*(1<<min(attempt_count,7))),last_error=?1 WHERE id=?2";
const INSERT_FILE_DELETION_JOBS_SQL: &str = "INSERT OR IGNORE INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,\
                     available_at) VALUES(?1,?2,?3,?4,?5,?5)";
const SELECT_FILE_DELETION_JOBS_SQL: &str = "SELECT id,blob_id,storage_key FROM file_deletion_jobs WHERE available_at<=?1 AND \
                     locked_at IS NULL ORDER BY available_at,id LIMIT 200";
const SELECT_FILE_BLOBS_2_SQL: &str = "SELECT coalesce(sum(size_bytes),0) FROM file_blobs WHERE state IN ('pending','available',\
                     'deleting')";
const SELECT_UPLOAD_RESERVATIONS_SQL: &str = "SELECT EXISTS(SELECT 1 FROM upload_reservations WHERE id=?1 AND committed_at IS NULL AND \
                     expires_at>?2)";
const INSERT_TASK_ATTACHMENTS_SQL: &str = "INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,\
                     is_ephemeral,position,created_at,last_accessed_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,\
                     ?8,?9,?9,?9)";
const SELECT_TASK_ATTACHMENTS_4_SQL: &str = "SELECT a.id,a.project_id,a.task_id,a.original_name,b.size_bytes,b.media_type,\
                     b.checksum_sha256,a.is_ephemeral,a.position,a.uploaded_by,a.created_at,a.last_accessed_at,\
                     b.state,a.revision,b.id,b.storage_key FROM task_attachments a JOIN file_blobs b ON \
                     b.id=a.blob_id JOIN tasks t ON t.id=a.task_id WHERE a.id=?1 AND t.deleted_at IS NULL";
const SELECT_TASK_ATTACHMENTS_5_SQL: &str = "SELECT a.id,b.size_bytes FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id \
                     WHERE a.blob_id=?1";

const INSERT_ATTACHMENT_BLOB_SQL: &str = "INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,\
                     created_at) VALUES(?1,?2,?3,?4,?5,'available',?6)";

const SELECT_FILE_BLOBS_3_SQL: &str = "SELECT
                       coalesce((SELECT sum(size_bytes) FROM file_blobs
                                 WHERE state IN ('pending','available','deleting')),0) +
                       coalesce((SELECT sum(size_bytes) FROM upload_reservations
                                 WHERE committed_at IS NULL AND expires_at>?1),0)";
const INSERT_FILE_BLOBS_SQL: &str = "INSERT INTO file_blobs
                     (id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                     VALUES(?1,?2,?3,?4,'image/png','pending',?5)";
const UPDATE_FILE_BLOBS_SQL: &str =
    "UPDATE file_blobs SET state='available' WHERE id=?1 AND state='pending'";
const UPDATE_USERS_SQL: &str =
    "UPDATE users SET avatar_blob_id=?1,updated_at=?2,revision=revision+1 WHERE id=?3";
const UPDATE_USERS_2_SQL: &str =
    "UPDATE users SET avatar_blob_id=NULL,updated_at=unixepoch(),revision=revision+1 WHERE id=?1";
const SELECT_PROJECTS_SQL: &str = "SELECT p.id,p.name,count(b.id),coalesce(sum(b.size_bytes),0) FROM projects p LEFT JOIN \
                     task_attachments a ON a.project_id=p.id LEFT JOIN file_blobs b ON b.id=a.blob_id AND \
                     b.state IN ('available','deleting') WHERE p.deleted_at IS NULL GROUP BY p.id,p.name \
                     HAVING count(b.id)>0 ORDER BY sum(b.size_bytes) DESC,p.name,p.id";
const SELECT_CLEANUP_RUNS_SQL: &str = "SELECT started_at,files,bytes FROM storage_cleanup_runs
    WHERE files > 0 OR bytes > 0 ORDER BY started_at DESC,id DESC LIMIT 5";
const SELECT_UPLOAD_RESERVATIONS_2_SQL: &str = "SELECT staging_key,size_bytes FROM upload_reservations WHERE committed_at IS NULL AND \
                     expires_at>?1";

#[cfg(test)]
mod tests;

// Cleanup must never hide the original write/commit failure. Recovery retries
// durable pending state if the volume is too full even for the cleanup write.
fn log_cleanup_failure(result: AppResult<()>) {
    if let Err(error) = result {
        tracing::warn!(%error, "file cleanup failed; reconciliation will retry");
    }
}
