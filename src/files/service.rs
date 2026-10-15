//! The file service: commands, reads and upkeep of attachments and avatars.
//! Each file operation checks access and metadata in SQLite first, and
//! durable jobs make the changes on disk recoverable.

mod attachments;
mod avatar;
mod capacity;
mod decode;
mod deletion;
mod maintenance;
mod read;
mod thumbnail;
mod upload;

pub use avatar::AvatarSlot;
pub use read::ReadMode;
pub(crate) use thumbnail::ThumbnailRead;
pub use upload::{AttachmentUpload, PendingAttachmentUpload, ReplayedUpload};

use std::{
    collections::HashSet,
    pin::Pin,
    task::{Context, Poll},
};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::json;
use tokio::{
    fs::File,
    io::{AsyncRead, AsyncSeek, ReadBuf},
};

use super::{
    AttachmentView, BlobState, FILE_LEASE_SECONDS, FileStore, MAX_HTML_PREVIEW_BYTES,
    MAX_TEXT_PREVIEW_BYTES, PreviewKind, StoredFile, detect::preview_kind_from_metadata,
};
use crate::{
    AppError, AppResult, Db,
    auth::Actor,
    blocking::Lane,
    collaboration::{ActivityInput, record_activity_tx, record_system_activity_tx},
    db::DataLayout,
    disk::DiskAdmission,
};

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

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRuntimeReport {
    pub expired_uploads_removed: u64,
    pub orphan_files_removed: u64,
    pub deletion_jobs_completed: u64,
    pub temporary_files_cleaned: u64,
    pub bytes_reclaimed: u64,
}

/// An open file to send, with what its response needs.
pub struct FileRead {
    pub file: LeasedFile,
    /// The name to offer when the file is saved.
    pub name: String,
    /// The size of the whole file.
    pub size: u64,
    pub media_type: String,
    /// Only this many bytes are sent, for a source view.
    pub byte_limit: Option<u64>,
    pub etag: String,
}

pub(crate) enum ConditionalRead {
    Modified(Box<FileRead>),
    NotModified(String),
}

fn file_etag(checksum: &str, source: bool) -> String {
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

/// An open file whose read lease keeps it from deletion until it is dropped.
pub struct LeasedFile {
    file: File,
    db: Db,
    lease_id: Option<String>,
}

/// Leases the blob for a read of `kind` by `owner`.
fn insert_read_lease(
    tx: &Transaction<'_>,
    id: &str,
    blob_id: &str,
    kind: &str,
    owner: &str,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO file_leases(id,blob_id,lease_kind,owner,created_at,expires_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, blob_id, kind, owner, now, now + FILE_LEASE_SECONDS],
    )?;
    Ok(())
}

fn delete_lease(connection: &rusqlite::Connection, id: &str) -> AppResult<()> {
    connection.execute("DELETE FROM file_leases WHERE id=?1", [id])?;
    Ok(())
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
                if let Err(error) = db.transaction(move |tx| delete_lease(tx, &lease_id)).await {
                    tracing::warn!(%error, "file lease release failed; expiry cleanup will retry");
                }
            });
        }
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

    /// Opens the stored file with `storage_key` under the lease `lease_id`.
    /// When the file is gone, the lease ends and the `missing` resource is not
    /// found.
    async fn open_leased(
        &self,
        storage_key: &str,
        lease_id: String,
        missing: &'static str,
    ) -> AppResult<LeasedFile> {
        match File::open(self.store.file_path(storage_key)?).await {
            Ok(file) => Ok(LeasedFile {
                file,
                db: self.db.clone(),
                lease_id: Some(lease_id),
            }),
            Err(_) => {
                self.db
                    .transaction(move |tx| delete_lease(tx, &lease_id))
                    .await?;
                Err(AppError::NotFound { resource: missing })
            }
        }
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

struct DeleteActivityContext {
    id: String,
    project_id: Option<String>,
    task_id: Option<String>,
    name: String,
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

// Cleanup must never hide the original write/commit failure. Recovery retries
// durable pending state if the volume is too full even for the cleanup write.
fn log_cleanup_failure(result: AppResult<()>) {
    if let Err(error) = result {
        tracing::warn!(%error, "file cleanup failed; reconciliation will retry");
    }
}
