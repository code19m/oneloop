use serde::{Deserialize, Serialize};

pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_ATTACHMENTS_PER_TASK: i64 = 25;
pub const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_TEXT_PREVIEW_BYTES: u64 = 200 * 1024;
pub const MAX_HTML_PREVIEW_BYTES: u64 = 1024 * 1024;
pub const ACCESS_GRACE_SECONDS: i64 = 24 * 60 * 60;
pub const UPLOAD_RESERVATION_SECONDS: i64 = 60 * 60;
pub const FILE_LEASE_SECONDS: i64 = 10 * 60;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PreviewKind {
    Image,
    Pdf,
    Html,
    Markdown,
    Text,
}

impl PreviewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Html => "html",
            Self::Markdown => "markdown",
            Self::Text => "text",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentView {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub name: String,
    pub size: u64,
    pub media_type: String,
    pub checksum: String,
    #[serde(alias = "temporary")]
    pub is_ephemeral: bool,
    pub position: i64,
    pub uploaded_by: String,
    pub uploaded_at: i64,
    pub last_accessed_at: i64,
    pub state: BlobState,
    pub revision: i64,
    pub preview_kind: Option<PreviewKind>,
    pub download_url: Option<String>,
    pub content_url: Option<String>,
    /// A small preview of a PNG, JPEG or WebP image. It serves the original
    /// until the thumbnail is ready, or when one can't be made.
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    pub source_url: Option<String>,
    pub html_preview_url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StoredFile {
    pub attachment: AttachmentView,
    pub blob_id: String,
    pub storage_key: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentPatch {
    #[serde(alias = "temporary")]
    pub is_ephemeral: bool,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentReorder {
    pub attachment_id: String,
    pub target_id: String,
    #[serde(default)]
    pub after: bool,
    pub expected_revision: i64,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentList {
    pub items: Vec<AttachmentView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub budget_bytes: u64,
    pub used_bytes: u64,
    pub reserved_bytes: u64,
    pub staging_bytes: u64,
    pub preview_bytes: u64,
    pub permanent_bytes: u64,
    pub temporary_bytes: u64,
    pub pending_deletion_bytes: u64,
    pub cleaned_records: u64,
    pub high_watermark_bytes: u64,
    pub low_watermark_bytes: u64,
    pub projects: Vec<StorageProjectUsage>,
    pub recent_cleanup: Vec<StorageCleanupRun>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageProjectUsage {
    pub project_id: String,
    pub project_name: String,
    pub file_count: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupRun {
    pub at: i64,
    pub file_count: u64,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BlobState {
    Pending,
    Available,
    Cleaned,
    Deleting,
}
impl BlobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Available => "available",
            Self::Cleaned => "cleaned",
            Self::Deleting => "deleting",
        }
    }
}
impl rusqlite::types::ToSql for BlobState {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}
impl rusqlite::types::FromSql for BlobState {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        match value.as_str()? {
            "pending" => Ok(Self::Pending),
            "available" => Ok(Self::Available),
            "cleaned" => Ok(Self::Cleaned),
            "deleting" => Ok(Self::Deleting),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}

/// Public upload bounds shared by browser clients and the file service.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLimits {
    pub max_attachment_bytes: u64,
    pub max_attachments_per_task: i64,
    pub max_avatar_bytes: u64,
}

impl Default for FileLimits {
    fn default() -> Self {
        Self {
            max_attachment_bytes: MAX_ATTACHMENT_BYTES,
            max_attachments_per_task: MAX_ATTACHMENTS_PER_TASK,
            max_avatar_bytes: MAX_AVATAR_BYTES,
        }
    }
}
