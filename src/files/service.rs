//! The file service: commands, reads and upkeep of attachments and avatars.
//! Each file operation checks access and metadata in SQLite first, and
//! durable jobs make the changes on disk recoverable.

mod detect;
use detect::preview_kind_from_metadata;
pub(crate) use detect::validate_original_name;
mod avatar;
mod decode;
mod maintenance;
use maintenance::require_capacity;
mod read;
pub use read::ReadMode;
mod thumbnail;
pub(crate) use thumbnail::ThumbnailRead;
mod upload;
pub use upload::PendingAttachmentUpload;

use super::BlobState;
use crate::disk::{DiskAdmission, DiskReservation};
use crate::{
    auth::unix_now,
    idempotency::{Envelope, Resource, validate_key as validate_idempotency_key},
};
use std::{
    collections::{HashMap, HashSet},
    io::Cursor,
    path::{Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};

use image::{ImageEncoder, ImageFormat, ImageReader, Limits};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncWriteExt, ReadBuf},
};
use uuid::Uuid;

use crate::{
    AppError, AppResult, Db,
    auth::{Actor, ActorSource, refresh_actor_connection},
    blocking::Lane,
    collaboration::{ActivityInput, record_activity_tx, record_system_activity_tx},
    db::{DataLayout, DataLease},
    domain::UNDO_WINDOW_SECONDS,
};

use super::{
    ACCESS_GRACE_SECONDS, AttachmentList, AttachmentPatch, AttachmentReorder, AttachmentRestore,
    AttachmentView, FILE_LEASE_SECONDS, FileStore, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TASK,
    MAX_AVATAR_BYTES, MAX_HTML_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES, PreviewKind,
    StorageCleanupRun, StorageProjectUsage, StorageUsage, StoredFile, UPLOAD_RESERVATION_SECONDS,
};

const CLEANUP_HIGH_PERCENT: u64 = 80;
const CLEANUP_LOW_PERCENT: u64 = 70;

const PREFIX_INSPECTION_BYTES: usize = MAX_HTML_PREVIEW_BYTES as usize;
const AVATAR_SIDE: u32 = 256;

#[derive(Clone)]
pub struct FileService {
    db: Db,
    store: FileStore,
    storage_limit_bytes: u64,
    disk: DiskAdmission,
    thumbnails: std::sync::Arc<thumbnail::ThumbnailQueue>,
    /// People with an avatar upload under way, one upload each.
    avatar_uploaders: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
    scans: Lane,
    /// One image decode at a time, for avatar uploads and thumbnails together,
    /// so their memory never adds up.
    decodes: Lane,
    inspections: Lane,
}

/// A place for one avatar upload, kept from its first byte through its
/// decode, while the upload keeps its image in memory.
pub struct AvatarSlot {
    uploaders: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
    user_id: String,
}

impl Drop for AvatarSlot {
    fn drop(&mut self) {
        self.uploaders
            .lock()
            .expect("avatar uploads lock")
            .remove(&self.user_id);
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UploadCleanupDecision {
    PreserveCommitted,
    RemoveUncommitted,
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
        let disk = db.disk_admission(disk_min_free_bytes);
        Self {
            db,
            store,
            storage_limit_bytes,
            disk,
            thumbnails: Default::default(),
            avatar_uploaders: Default::default(),
            scans: Lane::new("file scanner", 2),
            decodes: Lane::new("image decoder", 1),
            inspections: Lane::new("text inspection", 2),
        }
    }

    /// A place for an avatar upload, taken before its bytes arrive. A
    /// person has one place at most, so no one can take them all. When all
    /// are taken, the upload is told to retry at once.
    pub fn avatar_slot(&self, actor: &Actor) -> AppResult<AvatarSlot> {
        let mut uploaders = self.avatar_uploaders.lock().expect("avatar uploads lock");
        if uploaders.contains(&actor.user_id) {
            return Err(AppError::RateLimited { retry_after: 1 });
        }
        if uploaders.len() >= AVATAR_UPLOADS {
            return Err(AppError::Unavailable(
                "avatar processing is busy; retry shortly".into(),
            ));
        }
        uploaders.insert(actor.user_id.clone());
        Ok(AvatarSlot {
            uploaders: self.avatar_uploaders.clone(),
            user_id: actor.user_id.clone(),
        })
    }

    async fn acquire_file_maintenance_gate(&self) -> AppResult<std::fs::File> {
        self.take_lock(DataLayout::file_maintenance_lock).await
    }

    /// Takes a lock of the data directory off the async workers.
    async fn take_lock<T: Send + 'static>(
        &self,
        take: fn(&DataLayout) -> AppResult<T>,
    ) -> AppResult<T> {
        let layout = self.db.layout().clone();
        tokio::task::spawn_blocking(move || take(&layout))
            .await
            .map_err(|error| AppError::internal(format!("file lock worker failed: {error}")))?
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
                require_file_access(connection, &actor, &project_id, false, false)?;
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
                require_file_access(tx, &actor, &stored.attachment.project_id, true, false)?;
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
        let envelope = Envelope::request(
            "attachment.reorder",
            &input.idempotency_key,
            &json!({
                "taskId": task_id,
                "attachmentId": input.attachment_id,
                "targetId": input.target_id,
                "after": input.after,
                "expectedRevision": input.expected_revision,
            }),
        )?;
        if input.expected_revision < 1 {
            return Err(AppError::validation("expectedRevision", "must be positive"));
        }
        let actor = actor.clone();
        let task_id = task_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                let project_id = task_project(tx, &task_id)?;
                require_file_access(tx, &actor, &project_id, true, false)?;
                envelope.once(
                    tx,
                    &actor,
                    now,
                    |_, _| Ok(()),
                    |actor| {
                        let resource = Resource {
                            kind: "attachment",
                            id: Some(input.attachment_id.clone()),
                            project_id: None,
                        };
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
                            return Err(AppError::revision(
                                input.expected_revision,
                                current[moving].revision,
                            ));
                        }
                        if input.attachment_id == input.target_id {
                            return Ok((AttachmentList { items: current }, resource));
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
                            return Ok((AttachmentList { items: current }, resource));
                        }
                        // Every file of the task, deleted ones too, first moves to a
                        // negative position, so a new position never meets an old one.
                        tx.execute(
                            "UPDATE task_attachments SET position=-position-1 WHERE task_id=?1",
                            [&task_id],
                        )?;
                        for (position, item) in current.iter().enumerate() {
                            let (old_position, old_revision) =
                                previous_positions.get(&item.id).copied().ok_or_else(|| {
                                    AppError::internal("attachment order changed unexpectedly")
                                })?;
                            let revision =
                                old_revision + i64::from(old_position != position as i64);
                            tx.execute(
                                "UPDATE task_attachments SET position=?1,updated_at=?2,revision=?3
                             WHERE id=?4",
                                params![position as i64, now, revision, item.id],
                            )?;
                        }
                        // Deleted files follow in their order, so Undo puts one after
                        // the others. Their revisions stay, so Undo still applies.
                        let deleted = tx
                            .prepare(
                                "SELECT id FROM task_attachments
                             WHERE task_id=?1 AND deleted_at IS NOT NULL ORDER BY position DESC",
                            )?
                            .query_map([&task_id], |row| row.get::<_, String>(0))?
                            .collect::<Result<Vec<_>, _>>()?;
                        for (offset, id) in deleted.iter().enumerate() {
                            tx.execute(
                                "UPDATE task_attachments SET position=?1 WHERE id=?2",
                                params![(current.len() + offset) as i64, id],
                            )?;
                        }
                        record_activity_tx(
                            tx,
                            actor,
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
                        let items = attachment_views(tx, &task_id)?;
                        Ok((AttachmentList { items }, resource))
                    },
                )
            })
            .await
    }

    /// Deletes an attachment for the Undo window: reads hide it at once, and
    /// file maintenance removes its bytes and metadata after the window.
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
        let envelope = Envelope::request(
            "attachment.delete",
            idempotency_key,
            &json!({"attachmentId": attachment_id, "expectedRevision": expected_revision}),
        )?;
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.once(
                    tx,
                    &actor,
                    now,
                    |actor, deleted: &mut DeletedAttachment| {
                        require_file_access(tx, actor, &deleted.project_id, false, true)
                    },
                    |actor| {
                        let stored = attachment_by_id(tx, &attachment_id)?.attachment;
                        require_file_access(tx, actor, &stored.project_id, true, true)?;
                        if stored.revision != expected_revision {
                            return Err(AppError::revision(expected_revision, stored.revision));
                        }
                        if stored.state == BlobState::Deleting {
                            // Cleanup, or a deletion from before Undo, is removing the bytes.
                            return Err(AppError::Conflict(
                                "the attachment is being removed; try again shortly".into(),
                            ));
                        }
                        tx.execute(
                            "UPDATE task_attachments SET deleted_at=?1,updated_at=?1,revision=revision+1
                             WHERE id=?2 AND revision=?3 AND deleted_at IS NULL",
                            params![now, attachment_id, expected_revision],
                        )?;
                        record_attachment_deletion(
                            tx,
                            &DeleteActivityContext {
                                id: attachment_id.clone(),
                                project_id: Some(stored.project_id.clone()),
                                task_id: Some(stored.task_id.clone()),
                                name: stored.name,
                            },
                            Some(actor),
                            now,
                        )?;
                        let resource = Resource {
                            kind: "attachment",
                            id: Some(attachment_id.clone()),
                            project_id: Some(stored.project_id.clone()),
                        };
                        let deleted = DeletedAttachment {
                            project_id: stored.project_id,
                            task_id: stored.task_id,
                        };
                        Ok((deleted, resource))
                    },
                )?;
                Ok(())
            })
            .await
    }

    /// Undoes a deletion within the Undo window, for the people who could
    /// delete the attachment. It returns to its place unless the files were
    /// reordered since.
    pub async fn restore_attachment(
        &self,
        actor: &Actor,
        attachment_id: &str,
        input: AttachmentRestore,
    ) -> AppResult<AttachmentView> {
        let envelope = Envelope::request(
            "attachment.restore",
            &input.idempotency_key,
            &json!({"attachmentId": attachment_id, "expectedRevision": input.expected_revision}),
        )?;
        if input.expected_revision < 1 {
            return Err(AppError::validation("expectedRevision", "must be positive"));
        }
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.once(
                    tx,
                    &actor,
                    now,
                    |actor, view: &mut AttachmentView| {
                        require_file_access(tx, actor, &view.project_id, false, true)
                    },
                    |actor| {
                        let (stored, deleted_at) = attachment_with_deletion(tx, &attachment_id)?;
                        let stored = stored.attachment;
                        require_file_access(tx, actor, &stored.project_id, true, true)?;
                        let Some(deleted_at) = deleted_at else {
                            return Err(AppError::Conflict("the attachment is not deleted".into()));
                        };
                        if stored.revision != input.expected_revision {
                            return Err(AppError::revision(input.expected_revision, stored.revision));
                        }
                        crate::domain::require_undo_window("attachment", deleted_at, now)?;
                        if stored.state == BlobState::Deleting {
                            return Err(AppError::Conflict(
                                "the attachment is being removed and can no longer be restored"
                                    .into(),
                            ));
                        }
                        if stored.state == BlobState::Available
                            && occupied_slots(tx, &stored.task_id, now)? >= MAX_ATTACHMENTS_PER_TASK
                        {
                            return Err(AppError::Conflict(format!(
                                "a task can have at most {MAX_ATTACHMENTS_PER_TASK} available attachments"
                            )));
                        }
                        let revision = input.expected_revision + 1;
                        tx.execute(
                            "UPDATE task_attachments SET deleted_at=NULL,updated_at=?1,revision=?2
                             WHERE id=?3 AND revision=?4 AND deleted_at IS NOT NULL",
                            params![now, revision, attachment_id, input.expected_revision],
                        )?;
                        record_activity_tx(
                            tx,
                            actor,
                            ActivityInput {
                                project_id: Some(&stored.project_id),
                                entity_type: "attachment",
                                entity_id: &attachment_id,
                                task_id: Some(&stored.task_id),
                                event_type: "attachment.restored",
                                field_key: None,
                                before: None,
                                after: Some(json!({"name": stored.name})),
                                metadata: json!({"name": stored.name}),
                                entity_revision: Some(revision),
                            },
                            now,
                        )?;
                        let view = attachment_by_id(tx, &attachment_id)?.attachment;
                        let resource = Resource {
                            kind: "attachment",
                            id: Some(attachment_id.clone()),
                            project_id: Some(view.project_id.clone()),
                        };
                        Ok((view, resource))
                    },
                )
            })
            .await
    }
}

/// What a deletion's receipt keeps, so a retry rechecks access to the right
/// project.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletedAttachment {
    project_id: String,
    task_id: String,
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

/// Attachment access to `project_id`. A reader without access is told the
/// attachment doesn't exist.
fn require_file_access(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
    write: bool,
    destructive: bool,
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

/// Attachments that count against a task's limit: available files, files
/// being removed, and uploads under way.
fn occupied_slots(tx: &Transaction<'_>, task_id: &str, now: i64) -> AppResult<i64> {
    Ok(tx.query_row(
        "SELECT
           (SELECT count(*) FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
            WHERE a.task_id=?1 AND a.deleted_at IS NULL AND b.state IN ('available','deleting')) +
           (SELECT count(*) FROM upload_reservations
            WHERE task_id=?1 AND committed_at IS NULL AND expires_at>?2)",
        params![task_id, now],
        |row| row.get(0),
    )?)
}

/// The columns `stored_file_row` reads, in its order.
const ATTACHMENT_COLUMNS: &str = "a.id,a.project_id,a.task_id,a.original_name,b.size_bytes,\
     b.media_type,b.checksum_sha256,a.is_ephemeral,a.position,a.uploaded_by,a.created_at,\
     a.last_accessed_at,b.state,a.revision,b.id,b.storage_key";

fn attachment_by_id(connection: &rusqlite::Connection, id: &str) -> AppResult<StoredFile> {
    connection
        .query_row(
            &format!(
                "SELECT {ATTACHMENT_COLUMNS} FROM task_attachments a
                 JOIN file_blobs b ON b.id=a.blob_id JOIN tasks t ON t.id=a.task_id
                 WHERE a.id=?1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL"
            ),
            [id],
            stored_file_row,
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "attachment",
        })
}

/// An attachment of a task that isn't deleted, with when it was deleted, if
/// it was.
fn attachment_with_deletion(
    connection: &rusqlite::Connection,
    id: &str,
) -> AppResult<(StoredFile, Option<i64>)> {
    connection
        .query_row(
            &format!(
                "SELECT {ATTACHMENT_COLUMNS},a.deleted_at FROM task_attachments a
                 JOIN file_blobs b ON b.id=a.blob_id JOIN tasks t ON t.id=a.task_id
                 WHERE a.id=?1 AND t.deleted_at IS NULL"
            ),
            [id],
            |row| Ok((stored_file_row(row)?, row.get(16)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "attachment",
        })
}
fn attachment_views(
    connection: &rusqlite::Connection,
    task_id: &str,
) -> AppResult<Vec<AttachmentView>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {ATTACHMENT_COLUMNS} FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
         WHERE a.task_id=?1 AND a.deleted_at IS NULL ORDER BY a.position,a.id"
    ))?;
    Ok(statement
        .query_map([task_id], stored_file_row)?
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
    let thumbnail = available && thumbnail::makes_thumbnail(&media);
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
            content_url: (available && preview.is_some_and(PreviewKind::is_inline_media))
                .then(|| format!("/api/attachments/{id}/content")),
            thumbnail_url: thumbnail.then(|| format!("/api/attachments/{id}/thumbnail")),
            source_url: (available && preview.is_some_and(PreviewKind::has_source))
                .then(|| format!("/api/attachments/{id}/source")),
            html_preview_url: (available && preview == Some(PreviewKind::Html))
                .then(|| format!("/api/attachments/{id}/preview/html")),
        },
        blob_id: row.get(14)?,
        storage_key: row.get(15)?,
    })
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

impl FileService {
    async fn regular_files(&self, root: PathBuf) -> AppResult<Vec<(PathBuf, u64)>> {
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

    async fn unreferenced_files(
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
    let (image, _) =
        decode::decode_untrusted(Cursor::new(bytes), bytes.len() as u64).map_err(|_| {
            AppError::validation(
                "avatar",
                "image data is invalid, or too large to process safely",
            )
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
        // `link` also covers hints such as preconnect, which open connections
        // to other sites that the preview's policy may not govern.
        let remove = matches!(
            name,
            "iframe"
                | "frame"
                | "frameset"
                | "object"
                | "embed"
                | "base"
                | "link"
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

/// Sanitize HTML for the sandboxed preview frame, at most two files at once,
/// attachments and Knowledge files together.
pub(crate) async fn sanitized_html_preview(bytes: Vec<u8>) -> AppResult<Vec<u8>> {
    static PREVIEWS: std::sync::LazyLock<Lane> =
        std::sync::LazyLock::new(|| Lane::new("HTML preview", 2));
    PREVIEWS.run(move || sanitize_html_preview(&bytes)).await
}

/// The media type and preview kind of complete file contents, decided as for
/// uploads: by content first, with the name only choosing among text formats.
pub(crate) fn classify_bytes(name: &str, bytes: &[u8]) -> (String, Option<PreviewKind>) {
    let media = detect::detected_media_type(bytes, detect::detect_preview(name, bytes));
    let preview = preview_kind_from_metadata(name, &media)
        .filter(|kind| *kind != PreviewKind::Html || bytes.len() as u64 <= MAX_HTML_PREVIEW_BYTES);
    (media, preview)
}
/// Avatar uploads under way at once; each keeps its image in memory until it
/// is decoded. More are told to retry.
const AVATAR_UPLOADS: usize = 4;
/// How long an avatar upload waits for the decodes before it, thumbnails
/// included. The slowest decode the limits allow takes about a second on a
/// laptop, and a few seconds on a small server.
const AVATAR_DECODE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

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

#[cfg(test)]
mod tests;

// Cleanup must never hide the original write/commit failure. Recovery retries
// durable pending state if the volume is too full even for the cleanup write.
fn log_cleanup_failure(result: AppResult<()>) {
    if let Err(error) = result {
        tracing::warn!(%error, "file cleanup failed; reconciliation will retry");
    }
}
