//! Durable task attachments, avatars, capacity cleanup and crash recovery.
//!
//! SQLite owns file metadata while [`FileStore`] owns immutable bytes beneath
//! the configured data directory.  Callers never construct storage paths from
//! user supplied names.

mod detect;
mod models;
mod preview;
pub use preview::{CleanedPage, HtmlPreview};
pub(crate) use preview::{
    Previewers, cleaned_html_preview, html_preview_etag, html_preview_problem, html_preview_turn,
};
mod service;
mod storage;

pub(crate) use detect::{classify_bytes, preview_kind_from_metadata};
pub use models::*;
pub use service::{
    AttachmentUpload, AvatarSlot, FileRead, FileRuntimeReport, FileService, LeasedFile,
    PendingAttachmentUpload, ReadMode, ReplayedUpload,
};
pub(crate) use service::{
    ConditionalRead, ThumbnailRead, UploadDeadline, check_attachment_size, etag_matches,
};
pub use storage::FileStore;
