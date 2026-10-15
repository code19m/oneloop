//! Durable task attachments, avatars, capacity cleanup and crash recovery.
//!
//! SQLite owns file metadata while [`FileStore`] owns immutable bytes beneath
//! the configured data directory.  Callers never construct storage paths from
//! user supplied names.

mod detect;
mod models;
mod preview;
pub(crate) use preview::sanitized_html_preview;
mod service;
mod storage;
mod transfer;
pub(crate) use transfer::UploadDeadline;

pub(crate) use detect::classify_bytes;
pub use models::*;
pub use service::{
    AttachmentUpload, AvatarSlot, FileRead, FileRuntimeReport, FileService, LeasedFile,
    PendingAttachmentUpload, ReadMode, ReplayedUpload,
};
pub(crate) use service::{ConditionalRead, ThumbnailRead, etag_matches};
pub use storage::FileStore;
