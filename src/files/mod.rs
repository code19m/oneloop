//! Durable task attachments, avatars, capacity cleanup and crash recovery.
//!
//! SQLite owns file metadata while [`FileStore`] owns immutable bytes beneath
//! the configured data directory.  Callers never construct storage paths from
//! user supplied names.

mod models;
mod service;
mod storage;
mod transfer;
pub(crate) use transfer::UploadDeadline;

pub use models::*;
pub use service::{
    AttachmentUpload, AvatarSlot, FileRead, FileRuntimeReport, FileService, LeasedFile,
    PendingAttachmentUpload, ReadMode, ReplayedUpload, sanitize_html_preview,
};
pub(crate) use service::{
    ConditionalRead, ThumbnailRead, classify_bytes, etag_matches, file_etag,
    sanitized_html_preview, validate_original_name,
};
pub use storage::FileStore;
