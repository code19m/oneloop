//! Authenticated file reads. Access and validators are checked in a read
//! snapshot, so a revalidation doesn't wait for the writer; sending the bytes
//! takes a read lease, in a write that checks the file again.

use rusqlite::{Connection, Transaction, params};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use super::{
    ConditionalRead, FileRead, FileService, attachment_by_id, etag_matches, file_etag,
    insert_read_lease, require_file_access,
};
use crate::{
    AppError, AppResult,
    auth::Actor,
    clock::unix_now,
    files::{
        AttachmentView, BlobState, HtmlPreview, MAX_HTML_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES,
        PreviewKind, StoredFile, html_preview_etag, sanitized_html_preview,
    },
};

impl FileService {
    pub async fn open_for_read(
        &self,
        actor: &Actor,
        attachment_id: &str,
        mode: ReadMode,
    ) -> AppResult<FileRead> {
        match self
            .open_for_read_conditional(actor, attachment_id, mode, None)
            .await?
        {
            ConditionalRead::Modified(read) => Ok(*read),
            ConditionalRead::NotModified(_) => unreachable!("unconditional read"),
        }
    }

    pub(crate) async fn open_for_read_conditional(
        &self,
        actor: &Actor,
        attachment_id: &str,
        mode: ReadMode,
        validator: Option<String>,
    ) -> AppResult<ConditionalRead> {
        let _lease = self.db.acquire_data_lease().await?;
        let (actor_tx, id) = (actor.clone(), attachment_id.to_owned());
        let stored = self
            .db
            .snapshot(move |connection| readable(connection, &actor_tx, &id, mode))
            .await?;
        let etag = match mode {
            ReadMode::HtmlPreview => html_preview_etag(&stored.attachment.checksum),
            _ => file_etag(&stored.attachment.checksum, mode == ReadMode::Source),
        };
        if etag_matches(validator.as_deref(), &etag) {
            self.keep_temporary(&stored.attachment).await?;
            return Ok(ConditionalRead::NotModified(etag));
        }
        let (actor, id) = (actor.clone(), attachment_id.to_owned());
        let lease_id = Uuid::now_v7().to_string();
        let lease_id_tx = lease_id.clone();
        // A deletion that claimed the file meanwhile wins here, and a later
        // one sees the lease.
        let stored = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let stored = readable(tx, &actor, &id, mode)?;
                touch_temporary(tx, &id, now)?;
                let kind = if mode == ReadMode::Download {
                    "download"
                } else {
                    "preview"
                };
                insert_read_lease(tx, &lease_id_tx, &stored.blob_id, kind, &actor.user_id, now)?;
                Ok(stored)
            })
            .await?;
        let key = stored.storage_key.as_deref().expect("checked storage key");
        let file = self.open_leased(key, lease_id, "attachment").await?;
        let byte_limit = match mode {
            ReadMode::Source => Some(MAX_TEXT_PREVIEW_BYTES),
            ReadMode::HtmlPreview => Some(MAX_HTML_PREVIEW_BYTES),
            _ => None,
        };
        let media_type = match mode {
            ReadMode::Download => "application/octet-stream".into(),
            ReadMode::Source => "text/plain; charset=utf-8".into(),
            ReadMode::HtmlPreview => "text/html; charset=utf-8".into(),
            ReadMode::Content => stored.attachment.media_type.clone(),
        };
        Ok(ConditionalRead::Modified(Box::new(FileRead {
            file,
            name: stored.attachment.name,
            size: stored.attachment.size,
            media_type,
            byte_limit,
            etag,
        })))
    }

    /// Starts the 24 hours of a temporary file again when a read checked in a
    /// snapshot answers without the bytes.
    pub(super) async fn keep_temporary(&self, attachment: &AttachmentView) -> AppResult<()> {
        let now = unix_now()?;
        if !attachment.is_ephemeral || attachment.last_accessed_at >= now {
            return Ok(());
        }
        let id = attachment.id.clone();
        self.db
            .transaction(move |tx| touch_temporary(tx, &id, now))
            .await
    }

    /// The cleaned page of an HTML attachment. A `validator` that matches
    /// answers without reading or cleaning the file again.
    pub async fn html_preview(
        &self,
        actor: &Actor,
        attachment_id: &str,
        validator: Option<String>,
    ) -> AppResult<HtmlPreview> {
        let read = match self
            .open_for_read_conditional(actor, attachment_id, ReadMode::HtmlPreview, validator)
            .await?
        {
            ConditionalRead::Modified(read) => *read,
            ConditionalRead::NotModified(etag) => return Ok(HtmlPreview::NotModified(etag)),
        };
        let mut bytes = Vec::with_capacity(read.size as usize);
        read.file
            .take(MAX_HTML_PREVIEW_BYTES + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > MAX_HTML_PREVIEW_BYTES {
            return Err(AppError::NotFound {
                resource: "preview",
            });
        }
        Ok(HtmlPreview::Page {
            bytes: sanitized_html_preview(bytes).await?,
            etag: read.etag,
        })
    }
}

/// The attachment `id`, when `actor` may read it in `mode`.
fn readable(
    connection: &Connection,
    actor: &Actor,
    id: &str,
    mode: ReadMode,
) -> AppResult<StoredFile> {
    let stored = attachment_by_id(connection, id)?;
    require_file_access(
        connection,
        actor,
        &stored.attachment.project_id,
        false,
        false,
    )?;
    if stored.attachment.state != BlobState::Available || stored.storage_key.is_none() {
        return Err(AppError::NotFound {
            resource: "attachment",
        });
    }
    let kind = stored.attachment.preview_kind;
    let (allowed, resource) = match mode {
        ReadMode::Content => (kind.is_some_and(PreviewKind::is_inline_media), "preview"),
        ReadMode::Source => (kind.is_some_and(PreviewKind::has_source), "source"),
        ReadMode::HtmlPreview => (kind == Some(PreviewKind::Html), "preview"),
        ReadMode::Download => (true, "attachment"),
    };
    if !allowed {
        return Err(AppError::NotFound { resource });
    }
    Ok(stored)
}

/// Opening a temporary file starts its 24 hours again. Permanent files need
/// no access time, so reading them doesn't write.
fn touch_temporary(tx: &Transaction<'_>, id: &str, now: i64) -> AppResult<()> {
    tx.execute(
        "UPDATE task_attachments SET last_accessed_at=?1
         WHERE id=?2 AND is_ephemeral=1 AND last_accessed_at<?1",
        params![now, id],
    )?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadMode {
    Download,
    Content,
    Source,
    HtmlPreview,
}
