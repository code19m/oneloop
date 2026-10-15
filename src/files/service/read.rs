//! Authenticated file reads use leases and revalidate live parent access before serving bytes.

use rusqlite::params;
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
        BlobState, MAX_HTML_PREVIEW_BYTES, MAX_TEXT_PREVIEW_BYTES, PreviewKind,
        sanitized_html_preview,
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
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        let lease_id = Uuid::now_v7().to_string();
        let lease_id_tx = lease_id.clone();
        let stored = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let stored = attachment_by_id(tx, &attachment_id)?;
                require_file_access(tx, &actor, &stored.attachment.project_id, false, false)?;
                if stored.attachment.state != BlobState::Available || stored.storage_key.is_none() {
                    return Err(AppError::NotFound { resource: "attachment" });
                }
                match mode {
                    ReadMode::Content => {
                        if !stored.attachment.preview_kind.is_some_and(PreviewKind::is_inline_media) {
                            return Err(AppError::NotFound { resource: "preview" });
                        }
                    }
                    ReadMode::Source => {
                        if !stored.attachment.preview_kind.is_some_and(PreviewKind::has_source) {
                            return Err(AppError::NotFound { resource: "source" });
                        }
                    }
                    ReadMode::HtmlPreview => {
                        if stored.attachment.preview_kind != Some(PreviewKind::Html)
                            || stored.attachment.size > MAX_HTML_PREVIEW_BYTES
                        {
                            return Err(AppError::NotFound { resource: "preview" });
                        }
                    }
                    ReadMode::Download => {}
                }
                tx.execute(
                    "UPDATE task_attachments SET last_accessed_at=max(last_accessed_at,?1) WHERE id=?2 AND last_accessed_at<?1",
                    params![now, attachment_id],
                )?;
                let etag = file_etag(&stored.attachment.checksum, mode == ReadMode::Source);
                if etag_matches(validator.as_deref(), &etag) {
                    return Ok((stored, etag, false));
                }
                let kind = if mode == ReadMode::Download { "download" } else { "preview" };
                insert_read_lease(tx, &lease_id_tx, &stored.blob_id, kind, &actor.user_id, now)?;
                Ok((stored, etag, true))
            })
            .await?;
        let (stored, etag, modified) = stored;
        if !modified {
            return Ok(ConditionalRead::NotModified(etag));
        }
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

    pub async fn html_preview_bytes(
        &self,
        actor: &Actor,
        attachment_id: &str,
    ) -> AppResult<Vec<u8>> {
        let read = self
            .open_for_read(actor, attachment_id, ReadMode::HtmlPreview)
            .await?;
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
        sanitized_html_preview(bytes).await
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadMode {
    Download,
    Content,
    Source,
    HtmlPreview,
}
