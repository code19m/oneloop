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
pub(crate) use service::{ConditionalRead, file_etag, validate_original_name};
pub use service::{
    FileRead, FileRuntimeReport, FileService, LeasedFile, PendingAttachmentUpload, ReadMode,
    UploadStart, sanitize_html_preview,
};
pub use storage::FileStore;
