//! Upload admission and durable reservations; streaming never holds a database write transaction.

use std::{future::Future, path::PathBuf, time::Duration};

use rusqlite::{Transaction, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, File, OpenOptions},
    io::AsyncWriteExt,
    time::{Instant, timeout_at},
};
use uuid::Uuid;

use super::{
    FileService, attachment_by_id, capacity::require_capacity, delete_for_undo,
    log_cleanup_failure, require_file_access, require_free_slot, task_project,
};
use crate::{
    AppError, AppResult, Db,
    auth::Actor,
    clock::unix_now,
    collaboration::{ActivityInput, record_activity_tx},
    db::DataLease,
    disk::DiskReservation,
    domain::resolve_task_id,
    files::{
        AttachmentView, BlobState, FileStore, MAX_ATTACHMENT_BYTES, MAX_HTML_PREVIEW_BYTES,
        NewAttachment, UPLOAD_RESERVATION_SECONDS,
        detect::{self, validate_original_name},
    },
    idempotency::{Resource, validate_key as validate_idempotency_key},
};

const PREFIX_INSPECTION_BYTES: usize = MAX_HTML_PREVIEW_BYTES as usize;

/// The rules an upload meets before its bytes arrive. The fields are named as
/// MCP upload tickets name them.
fn check_upload(actor: &Actor, name: &str, size: u64, key: &str) -> AppResult<()> {
    actor.require_ready()?;
    validate_original_name(name)?;
    validate_idempotency_key(key)?;
    check_attachment_size(size, "sizeBytes")
}

/// Refuses an attachment of `size` bytes outside the limits, naming `field`.
/// The browser checks a declared size before it reads the body.
pub(crate) fn check_attachment_size(size: u64, field: &'static str) -> AppResult<()> {
    if size == 0 || size > MAX_ATTACHMENT_BYTES {
        return Err(AppError::validation(
            field,
            format!(
                "must contain 1 byte to {} MiB",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(())
}

/// The time limits on the bytes of an upload, for browser and MCP uploads
/// alike: a minute for each read, and the life of the reservation in all.
pub(crate) struct UploadDeadline {
    overall: Instant,
}

impl UploadDeadline {
    pub(crate) fn new() -> Self {
        Self {
            overall: Instant::now() + Duration::from_secs(UPLOAD_RESERVATION_SECONDS as u64),
        }
    }

    pub(crate) async fn read<T>(&self, read: impl Future<Output = T>) -> AppResult<T> {
        let now = Instant::now();
        // timeout_at polls the read first. Reject an expired overall deadline
        // even when the next buffered chunk is immediately ready.
        if now >= self.overall {
            return Err(AppError::validation(
                "file",
                "upload timed out; retry the upload",
            ));
        }
        timeout_at(self.overall.min(now + Duration::from_secs(60)), read)
            .await
            .map_err(|_| AppError::validation("file", "upload timed out; retry the upload"))
    }
}

impl FileService {
    /// Checks an upload as `begin_attachment_upload` will, before anything
    /// is reserved for it. `task` is the task's ID or key; the result is its
    /// ID. A connection without the attachments permission is refused before
    /// the task is looked up.
    pub(crate) async fn check_attachment_upload(
        &self,
        actor: &Actor,
        task: &str,
        name: &str,
        size: u64,
        key: &str,
    ) -> AppResult<String> {
        check_upload(actor, name, size, key)?;
        let actor = actor.clone();
        let task = task.to_owned();
        self.db
            .run(move |connection| {
                crate::access::require_scope(
                    connection,
                    &actor,
                    crate::access::McpScope::Attachments,
                    None,
                )?;
                let task_id = resolve_task_id(connection, &task)?;
                let project_id = task_project(connection, &task_id)?;
                require_file_access(connection, &actor, &project_id, true, false)?;
                Ok(task_id)
            })
            .await
    }

    /// Starts an upload of a file to the task, which replaces a file of the
    /// task once its bytes arrive when it names one. A retry of a finished
    /// upload replays it even when that file is gone, so the file is checked
    /// here, after the replay, as free slots are.
    pub async fn begin_attachment_upload(
        &self,
        actor: &Actor,
        task_id: &str,
        file: NewAttachment<'_>,
    ) -> AppResult<AttachmentUpload> {
        let NewAttachment {
            name: original_name,
            size: claimed_size,
            temporary: is_ephemeral,
            idempotency_key,
            replaces,
        } = file;
        check_upload(actor, original_name, claimed_size, idempotency_key)?;
        let mut request = json!({
            "taskId": task_id,
            "name": original_name,
            "size": claimed_size,
            "ephemeral": is_ephemeral,
        });
        // The retry key covers the file it replaces, so a retry replaces once.
        if let Some(replaces) = replaces {
            request["replacesAttachmentId"] = json!(replaces);
        }
        let request_hash = crate::idempotency::request_hash(&request)?;
        let replay_task = task_id.to_owned();
        let replay_key = idempotency_key.to_owned();
        let replay_actor = actor.clone();
        let replay_hash = request_hash.clone();
        if let Some(existing) = self
            .db
            .transaction(move |tx| {
                let project_id = task_project(tx, &replay_task)?;
                require_file_access(tx, &replay_actor, &project_id, true, false)?;
                crate::idempotency::replay(
                    tx,
                    &replay_actor,
                    &replay_key,
                    "attachment.upload",
                    &replay_hash,
                    unix_now()?,
                )
            })
            .await?
        {
            return Ok(AttachmentUpload::replayed(existing, claimed_size));
        }

        let non_database_bytes = self.admit(claimed_size).await?;
        let reservation_id = Uuid::now_v7().to_string();
        let idempotency_id = Uuid::now_v7().to_string();
        let staging_key = self.store.new_staging_key()?;
        let storage_key = self.store.new_storage_key()?;
        let staging_path = self.store.staging_path(&staging_key)?;
        let task_id_owned = task_id.to_owned();
        let pending_task_id = task_id.to_owned();
        let pending_original_name = original_name.to_owned();
        let key_owned = idempotency_key.to_owned();
        let actor_owned = actor.clone();
        let reservation_id_tx = reservation_id.clone();
        let idempotency_id_tx = idempotency_id.clone();
        let staging_key_tx = staging_key.clone();
        let replaces_tx = replaces.map(str::to_owned);
        let pending_replaces = replaces_tx.clone();
        let limit = self.storage_limit_bytes;

        let service = self.clone();
        let pending_actor = actor.clone();
        let reservation_task = tokio::spawn(async move {
            let _maintenance_gate = service.acquire_file_maintenance_gate().await?;
            let disk = service.disk.reserve(claimed_size)?;
            disk.keep_until_removed(staging_path.clone());
            disk.keep_until_removed(service.store.file_path(&storage_key)?);
            let outcome = service
                .db
                .transaction(move |tx| {
                    let now = unix_now()?;
                    let project_id = task_project(tx, &task_id_owned)?;
                    require_file_access(tx, &actor_owned, &project_id, true, false)?;

                    if let Some(existing) = crate::idempotency::replay(
                        tx,
                        &actor_owned,
                        &key_owned,
                        "attachment.upload",
                        &request_hash,
                        now,
                    )? {
                        return Ok(ReserveOutcome::Replay(Box::new(existing)));
                    }

                    if let Some(replaces) = &replaces_tx {
                        replaced_attachment(tx, &actor_owned, &task_id_owned, replaces)?;
                    }
                    require_free_slot(tx, &task_id_owned, now, replaces_tx.as_deref())?;

                    require_capacity(tx, now, non_database_bytes, claimed_size, limit)?;

                    let actual_idempotency_id = crate::idempotency::start(
                        tx,
                        &actor_owned,
                        &idempotency_id_tx,
                        &key_owned,
                        "attachment.upload",
                        &request_hash,
                        now,
                    )?;
                    tx.execute(
                        "INSERT INTO upload_reservations
                     (id,project_id,task_id,user_id,size_bytes,staging_key,created_at,expires_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![
                            reservation_id_tx,
                            project_id,
                            task_id_owned,
                            actor_owned.user_id,
                            claimed_size as i64,
                            staging_key_tx,
                            now,
                            now + UPLOAD_RESERVATION_SECONDS
                        ],
                    )?;
                    tx.execute(
                        "UPDATE idempotency_keys SET resource_type='upload_reservation',resource_id=?1
                     WHERE id=?2",
                        params![reservation_id_tx, actual_idempotency_id],
                    )?;
                    Ok(ReserveOutcome::Reserved(project_id, actual_idempotency_id))
                })
                .await?;

            match outcome {
                ReserveOutcome::Replay(view) => Ok(AttachmentUpload::replayed(*view, claimed_size)),
                ReserveOutcome::Reserved(project_id, idempotency_id) => {
                    let mut pending = PendingAttachmentUpload {
                        attempt: Some(UploadAttempt {
                            service: service.clone(),
                            actor: pending_actor,
                            reservation_id,
                            idempotency_id,
                            task_id: pending_task_id,
                            project_id,
                            original_name: pending_original_name,
                            is_ephemeral,
                            replaces: pending_replaces,
                            staging_path: staging_path.clone(),
                            storage_key,
                            disk,
                        }),
                        received: Received::new(claimed_size),
                        file: None,
                        inspection: Vec::with_capacity(
                            PREFIX_INSPECTION_BYTES.min(claimed_size as usize),
                        ),
                    };
                    match OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&staging_path)
                        .await
                    {
                        Ok(file) => {
                            pending.file = Some(file);
                            Ok(AttachmentUpload::Pending(Box::new(pending)))
                        }
                        Err(error) => {
                            pending.abort().await?;
                            Err(error.into())
                        }
                    }
                }
            }
        });
        reservation_task.await.map_err(|error| {
            AppError::internal(format!("upload reservation worker failed: {error}"))
        })?
    }
}

enum ReserveOutcome {
    Replay(Box<AttachmentView>),
    Reserved(String, String),
}

/// An attachment upload whose bytes are arriving. A retry of an upload that
/// finished sends its bytes again, and they must match the stored file.
pub enum AttachmentUpload {
    Pending(Box<PendingAttachmentUpload>),
    Replayed(ReplayedUpload),
}

impl AttachmentUpload {
    fn replayed(view: AttachmentView, claimed_size: u64) -> Self {
        Self::Replayed(ReplayedUpload {
            view: Box::new(view),
            received: Received::new(claimed_size),
        })
    }

    pub async fn write_chunk(&mut self, chunk: &[u8]) -> AppResult<()> {
        match self {
            Self::Pending(upload) => upload.write_chunk(chunk).await,
            Self::Replayed(upload) => upload.received.add(chunk),
        }
    }

    /// The attachment, and whether this upload created it.
    pub async fn finish(self) -> AppResult<(AttachmentView, bool)> {
        match self {
            Self::Pending(upload) => Ok((upload.finish().await?, true)),
            Self::Replayed(upload) => Ok((upload.finish()?, false)),
        }
    }

    pub async fn abort(self) -> AppResult<()> {
        match self {
            Self::Pending(upload) => upload.abort().await,
            Self::Replayed(_) => Ok(()),
        }
    }

    /// Aborts an upload whose bytes failed with `error`, and returns the
    /// error. A retry then finds the task slot and the key free.
    pub async fn fail(self, error: AppError) -> AppError {
        if let Err(cleanup) = self.abort().await {
            tracing::warn!(error=%cleanup, "upload abort failed; reconciliation will retry");
        }
        error
    }
}

/// A retry of an upload that finished. Its bytes are only counted and hashed.
pub struct ReplayedUpload {
    view: Box<AttachmentView>,
    received: Received,
}

impl ReplayedUpload {
    fn finish(self) -> AppResult<AttachmentView> {
        if self.received.checksum()? != self.view.checksum {
            return Err(AppError::rule(
                crate::error::RuleKind::IdempotencyKeyReused,
                "idempotency key was already used for different file bytes",
            ));
        }
        Ok(*self.view)
    }
}

/// The bytes of an upload so far, held to its declared size.
#[derive(Default)]
struct Received {
    claimed: u64,
    written: u64,
    hasher: Sha256,
}

impl Received {
    fn new(claimed: u64) -> Self {
        Self {
            claimed,
            ..Self::default()
        }
    }

    fn add(&mut self, chunk: &[u8]) -> AppResult<()> {
        let next = self.written.saturating_add(chunk.len() as u64);
        if next > self.claimed {
            return Err(AppError::validation(
                "file",
                "received more bytes than declared",
            ));
        }
        self.hasher.update(chunk);
        self.written = next;
        Ok(())
    }

    /// The checksum of the bytes, once all declared bytes arrived.
    fn checksum(self) -> AppResult<String> {
        if self.written != self.claimed {
            return Err(AppError::validation(
                "file",
                format!(
                    "declared {} bytes but received {}",
                    self.claimed, self.written
                ),
            ));
        }
        Ok(hex::encode(self.hasher.finalize()))
    }
}

/// What an upload attempt owns until its file is published or cleaned up.
struct UploadAttempt {
    service: FileService,
    actor: Actor,
    reservation_id: String,
    idempotency_id: String,
    task_id: String,
    project_id: String,
    original_name: String,
    is_ephemeral: bool,
    /// The file of the task that the new one replaces.
    replaces: Option<String>,
    staging_path: PathBuf,
    storage_key: String,
    disk: DiskReservation,
}

/// An attachment upload whose bytes are arriving. Dropped unfinished, it
/// cleans up after itself.
pub struct PendingAttachmentUpload {
    /// Taken by `finish` and `abort`; still here on drop, it needs cleanup.
    attempt: Option<UploadAttempt>,
    received: Received,
    file: Option<File>,
    inspection: Vec<u8>,
}

impl UploadAttempt {
    /// Frees the attempt's task slot and retry key and removes its bytes,
    /// unless its file was published. Without the data lease, for example
    /// during a backup, the bytes stay for reconciliation to remove, as no
    /// reservation owns them any more.
    async fn cleanup(&self, lease: Option<&DataLease>) -> AppResult<()> {
        let reservation_id = self.reservation_id.clone();
        let idempotency_id = self.idempotency_id.clone();
        if lease.is_none() {
            return self
                .service
                .db
                .transaction(move |tx| release_upload_rows(tx, &reservation_id, &idempotency_id))
                .await;
        }
        let storage_key = self.storage_key.clone();
        let destination = self.service.store.file_path(&storage_key);
        let published = self
            .service
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
                    return Ok(true);
                }
                release_upload_rows(tx, &reservation_id, &idempotency_id)?;
                Ok(false)
            })
            .await?;
        if published {
            return Ok(());
        }
        let store = &self.service.store;
        store.remove_file_if_present(&self.staging_path).await?;
        let destination = destination?;
        let destination_existed = fs::metadata(&destination).await.is_ok();
        store.remove_file_if_present(&destination).await?;
        if destination_existed {
            FileStore::sync_parent(destination).await?;
        }
        Ok(())
    }

    /// Publishes the staged file as an attachment, or cleans up.
    async fn finalize(
        self,
        lease: DataLease,
        mut file: File,
        size: u64,
        checksum: String,
        inspection: Vec<u8>,
    ) -> AppResult<AttachmentView> {
        let result: AppResult<AttachmentView> = async {
            file.flush().await?;
            file.sync_all().await?;
            drop(file);
            let (name, path) = (self.original_name.clone(), self.staging_path.clone());
            let media = self
                .service
                .inspections
                .run(move || detect::inspect_file_media(&name, &path, &inspection))
                .await??;
            let _gate = self.service.acquire_file_maintenance_gate().await?;
            let destination = self
                .service
                .store
                .prepare_file_parent(&self.storage_key)
                .await?;
            fs::rename(&self.staging_path, &destination).await?;
            FileStore::sync_parent(destination).await?;

            let actor = self.actor.clone();
            let attachment_id = Uuid::now_v7().to_string();
            let blob_id = Uuid::now_v7().to_string();
            let reservation_id = self.reservation_id.clone();
            let idempotency_id = self.idempotency_id.clone();
            let task_id = self.task_id.clone();
            let project_id = self.project_id.clone();
            let name = self.original_name.clone();
            let storage_key = self.storage_key.clone();
            let is_ephemeral = self.is_ephemeral;
            let replaces = self.replaces.clone();
            self.service
                .db
                .transaction(move |tx| {
                    let now = unix_now()?;
                    require_file_access(tx, &actor, &project_id, true, false)?;
                    // Someone may have deleted the task while the bytes arrived.
                    if task_project(tx, &task_id)? != project_id {
                        return Err(AppError::NotFound { resource: "task" });
                    }
                    let active: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM upload_reservations
                         WHERE id=?1 AND committed_at IS NULL AND expires_at>?2)",
                        params![reservation_id, now],
                        |r| r.get(0),
                    )?;
                    if !active {
                        return Err(AppError::Conflict("upload reservation expired".into()));
                    }
                    let position: i64 = match &replaces {
                        // The new file takes the place of the one it replaces.
                        // That one is deleted, and waits after the other files,
                        // as deleted files do.
                        Some(replaces) => {
                            let old = replaced_attachment(tx, &actor, &task_id, replaces)?;
                            tx.execute(
                                "UPDATE task_attachments SET position=(SELECT max(position)+1
                                   FROM task_attachments WHERE task_id=?1) WHERE id=?2",
                                params![task_id, old.id],
                            )?;
                            delete_for_undo(tx, &actor, &old, now)?;
                            old.position
                        }
                        None => tx.query_row(
                            "SELECT coalesce(max(position)+1,0) FROM task_attachments WHERE task_id=?1",
                            [&task_id],
                            |r| r.get(0),
                        )?,
                    };
                    tx.execute(
                        "INSERT INTO file_blobs
                         (id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                         VALUES(?1,?2,?3,?4,?5,'available',?6)",
                        params![blob_id, storage_key, checksum, size as i64, media, now],
                    )?;
                    tx.execute(
                        "INSERT INTO task_attachments
                         (id,project_id,task_id,blob_id,original_name,uploaded_by,is_ephemeral,
                          position,created_at,last_accessed_at,updated_at)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?9)",
                        params![
                            attachment_id,
                            project_id,
                            task_id,
                            blob_id,
                            name,
                            actor.user_id,
                            is_ephemeral,
                            position,
                            now
                        ],
                    )?;
                    tx.execute(
                        "DELETE FROM upload_reservations WHERE id=?1",
                        [reservation_id],
                    )?;
                    let view = attachment_by_id(tx, &attachment_id)?.attachment;
                    crate::idempotency::succeed(
                        tx,
                        &idempotency_id,
                        &serde_json::to_string(&view)
                            .map_err(|e| AppError::internal(e.to_string()))?,
                        &Resource {
                            kind: "attachment",
                            id: Some(attachment_id.clone()),
                            project_id: Some(project_id.clone()),
                        },
                        now,
                    )?;
                    record_activity_tx(
                        tx,
                        &actor,
                        ActivityInput {
                            project_id: Some(&project_id),
                            entity_type: "attachment",
                            entity_id: &attachment_id,
                            task_id: Some(&task_id),
                            event_type: "attachment.created",
                            field_key: None,
                            before: None,
                            after: Some(json!({"name":name,"size":size,"temporary":is_ephemeral})),
                            metadata: json!({"name":name,"size":size,"temporary":is_ephemeral}),
                            entity_revision: Some(1),
                        },
                        now,
                    )?;
                    Ok(view)
                })
                .await
        }
        .await;
        // The maintenance gate ended with the block, before any cleanup.
        match result {
            Ok(view) => {
                self.disk.published();
                if view.thumbnail_url.is_some() {
                    self.service.queue_thumbnail(&self.storage_key);
                }
                Ok(view)
            }
            Err(error) => {
                log_cleanup_failure(self.cleanup(Some(&lease)).await);
                Err(error)
            }
        }
    }
}

impl PendingAttachmentUpload {
    pub async fn write_chunk(&mut self, chunk: &[u8]) -> AppResult<()> {
        self.received.add(chunk)?;
        if self.inspection.len() < PREFIX_INSPECTION_BYTES {
            let remaining = PREFIX_INSPECTION_BYTES - self.inspection.len();
            self.inspection
                .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        self.file
            .as_mut()
            .ok_or_else(|| AppError::internal("upload staging file is unavailable"))?
            .write_all(chunk)
            .await?;
        Ok(())
    }

    pub async fn finish(mut self) -> AppResult<AttachmentView> {
        let size = self.received.claimed;
        let checksum = match std::mem::take(&mut self.received).checksum() {
            Ok(checksum) => checksum,
            Err(error) => {
                log_cleanup_failure(self.abort().await);
                return Err(error);
            }
        };
        let file = self
            .file
            .take()
            .ok_or_else(|| AppError::internal("upload staging file is unavailable"))?;
        // Until the attempt is taken, a cancelled request still cleans up.
        let lease = self.db().acquire_data_lease().await;
        let attempt = self.attempt.take().expect("an unfinished upload");
        let lease = match lease {
            Ok(lease) => lease,
            Err(error) => {
                drop(file);
                log_cleanup_failure(attempt.cleanup(None).await);
                return Err(error);
            }
        };
        let inspection = std::mem::take(&mut self.inspection);
        // A finalizer runs to its end even when the request is cancelled, so
        // it either records the file or cleans it up.
        tokio::spawn(attempt.finalize(lease, file, size, checksum, inspection))
            .await
            .map_err(|error| AppError::internal(format!("upload finalizer failed: {error}")))?
    }

    pub async fn abort(mut self) -> AppResult<()> {
        let lease = self.db().acquire_data_lease().await;
        let attempt = self.attempt.take().expect("an unfinished upload");
        let lease = match lease {
            Ok(lease) => lease,
            Err(error) => {
                log_cleanup_failure(attempt.cleanup(None).await);
                return Err(error);
            }
        };
        let file = self.file.take();
        tokio::spawn(async move {
            if let Some(mut file) = file {
                // Tokio may still be writing on a blocking worker. Finish that
                // write before unlinking and releasing its disk reservation.
                let _ = file.flush().await;
            }
            attempt.cleanup(Some(&lease)).await
        })
        .await
        .map_err(|error| AppError::internal(format!("upload cleanup failed: {error}")))?
    }

    fn db(&self) -> Db {
        let attempt = self.attempt.as_ref().expect("an unfinished upload");
        attempt.service.db.clone()
    }
}

impl Drop for PendingAttachmentUpload {
    fn drop(&mut self) {
        let Some(attempt) = self.attempt.take() else {
            return;
        };
        let file = self.file.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Some(mut file) = file {
                    let _ = file.flush().await;
                }
                let lease = attempt.service.db.acquire_data_lease().await.ok();
                log_cleanup_failure(attempt.cleanup(lease.as_ref()).await);
            });
        }
    }
}

/// The file that an upload replaces: one that the person uploaded to the same
/// task, and that is not being removed. Another person's file goes only
/// through a deletion, which needs destructive access.
fn replaced_attachment(
    connection: &rusqlite::Connection,
    actor: &Actor,
    task_id: &str,
    id: &str,
) -> AppResult<AttachmentView> {
    // A file of any other task is not found, as an ID that names no file is,
    // so the answer never tells whether an ID exists.
    let attachment = attachment_by_id(connection, id)?.attachment;
    if attachment.task_id != task_id {
        return Err(AppError::NotFound {
            resource: "attachment",
        });
    }
    if attachment.uploaded_by != actor.user_id {
        return Err(AppError::validation(
            "replacesAttachmentId",
            "must name a file you uploaded; another person's file can only be deleted",
        ));
    }
    if attachment.state == BlobState::Deleting {
        return Err(AppError::Conflict(
            "the attachment is being removed, so it can't be replaced".into(),
        ));
    }
    Ok(attachment)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn overall_deadline_ends_even_a_trickling_upload() {
        let deadline = UploadDeadline {
            overall: Instant::now() + Duration::from_millis(20),
        };
        assert_eq!(deadline.read(async { 7 }).await.unwrap(), 7);
        tokio::time::advance(Duration::from_millis(25)).await;
        assert!(deadline.read(async { 8 }).await.is_err());
        assert!(deadline.read(std::future::pending::<()>()).await.is_err());
    }
}
