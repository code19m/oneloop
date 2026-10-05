//! Knowledge: a read-only copy of one folder of a Git repository per project.
//!
//! Administrators connect a repository in project Settings. A background
//! worker keeps the folder's files in SQLite, checking the branch every
//! minute, and members read and search them in the browser or through MCP.
//! Nothing in oneloop writes to the repository, and knowledge files never link
//! to tasks or other project work.

mod content;
mod git;
mod markdown;
mod search;
mod secrets;
mod service;
mod source;
mod sync;

pub use content::{Chunks, FileBody};
pub use search::{DocumentHits, FileHit, Hit, Results as SearchResults};
pub use service::{
    FileMode, FileRead, KnowledgeCommand, KnowledgeCommandResult, KnowledgeFile, KnowledgeOverview,
    KnowledgeService, KnowledgeView, OverviewFile, ReadmeText, SourceView, TextFile,
};

/// Folder limits. A sync fails when a limit is exceeded, except that single
/// files over the size limit are left out and counted.
pub const MAX_FILES: usize = 5_000;
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
/// Disk one sync may use for its working copy. It holds the folder twice, as
/// Git's packed copy and as files, including files it then leaves out.
pub const MAX_DOWNLOAD_BYTES: u64 = 300 * 1024 * 1024;
