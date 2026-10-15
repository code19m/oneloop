//! Knowledge commands and reads. Administrators manage the source through the
//! shared command envelope; members read and search the synced files. Every
//! read checks current project access, and no reply contains a saved
//! credential.

mod catalog;
mod commands;
mod mcp;

pub use commands::KnowledgeCommand;

use std::{
    collections::HashMap,
    ops::Not,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{
    MAX_DOWNLOAD_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_FOLDERS, MAX_TOTAL_BYTES,
    content::FileBody,
    git::{Git, Limits},
    secrets::SecretBox,
    source::{GitUrl, Transport},
};
use crate::{
    AppError, AppResult, Db,
    access::{Need, require_project},
    auth::{Actor, ActorSource, refresh_actor_connection},
    blocking::{Lane, PerPerson},
    collaboration::ActivityInput,
    files::{MAX_TEXT_PREVIEW_BYTES, PreviewKind},
};
use catalog::Catalog;

/// How long a search or a file read waits for the one before it, like a
/// database request.
const QUEUE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone)]
pub struct KnowledgeService {
    pub(super) inner: Arc<Inner>,
}

pub(super) struct Inner {
    pub(super) db: Db,
    pub(super) git: Git,
    pub(super) keys: PathBuf,
    pub(super) allow_file: bool,
    pub(super) disk: crate::disk::DiskAdmission,
    pub(super) limits: Limits,
    pub(super) wake: Notify,
    /// Projects whose sync is running in this process, each with the token
    /// that stops it.
    pub(super) syncing: Mutex<HashMap<String, CancellationToken>>,
    /// Projects whose last sync could not be read or recorded, and until when
    /// they wait, so a failing database is not retried in a tight loop.
    pub(super) waiting: Mutex<HashMap<String, tokio::time::Instant>>,
    /// Search indexes and outlines, most recently used last.
    catalogs: Mutex<Vec<Arc<Catalog>>>,
    /// Indexes are built one at a time; a request that waited finds the result.
    builds: tokio::sync::Mutex<()>,
    /// MCP reads one file's text at a time, so the memory of large files
    /// never adds up.
    readers: Lane,
    /// Searches run one at a time.
    searches: Lane,
    /// People with a search that runs or waits. Each has one at most, so no
    /// one can fill the queue.
    searchers: PerPerson,
}

/// The Knowledge page: sync state and the file list. Only administrators
/// receive `source`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeView {
    /// `unconnected`, `pending` (no files yet), `ready` or `failed`.
    pub state: &'static str,
    /// A sync was requested and has not finished.
    pub syncing: bool,
    pub folder: Option<String>,
    /// When the files were last confirmed to match the branch.
    pub checked_at: Option<i64>,
    pub skipped_files: i64,
    pub files: Vec<KnowledgeFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFile {
    pub path: String,
    pub size: i64,
    pub kind: Option<PreviewKind>,
    pub updated_at: i64,
    /// Changes whenever the content does; clients key caches on it.
    pub version: String,
}

/// The connection as administrators manage it. A saved token is reported only
/// as present.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    pub entity_type: &'static str,
    pub id: String,
    pub project_id: String,
    pub url: String,
    /// Host and path, as people recognize the repository.
    pub repository: String,
    pub branch: String,
    pub folder: String,
    pub transport: &'static str,
    pub has_token: bool,
    /// Public half of the project's deploy key, for SSH.
    pub deploy_key: Option<String>,
    pub state: String,
    pub syncing: bool,
    pub checked_at: Option<i64>,
    pub attempted_at: Option<i64>,
    pub error_code: Option<String>,
    pub skipped_files: i64,
    pub revision: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileMode {
    /// Images and PDFs with their detected type.
    Content,
    /// Text, Markdown and HTML source as plain text, cut at the preview limit.
    Text,
    Download,
}

pub struct FileRead {
    pub name: String,
    pub media_type: String,
    pub etag: String,
    /// `None` when the caller's copy is current.
    pub body: Option<FileBody>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeOverview {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readme: Option<ReadmeText>,
    pub files: Vec<OverviewFile>,
    pub file_count: usize,
    #[serde(skip_serializing_if = "Not::not")]
    pub truncated: bool,
    /// Some files' text didn't fit in the search index. They have no title
    /// or sections here, and search finds them by name only.
    #[serde(skip_serializing_if = "Not::not")]
    pub partial: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadmeText {
    pub path: String,
    pub content: String,
    #[serde(skip_serializing_if = "Not::not")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<PreviewKind>,
    pub size: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<PreviewKind>,
    pub size: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Markdown headings to level three, marked with `#`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub headings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Not::not")]
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

struct SourceRow {
    url: String,
    branch: String,
    folder: String,
    token_ciphertext: Option<Vec<u8>>,
    state: String,
    requested_at: Option<i64>,
    attempted_at: Option<i64>,
    checked_at: Option<i64>,
    error_code: Option<String>,
    skipped_files: i64,
    revision: i64,
}

const SOURCE_COLUMNS: &str = "url,branch,folder,token_ciphertext,state,requested_at,attempted_at,\
     checked_at,error_code,skipped_files,revision";

fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRow> {
    Ok(SourceRow {
        url: row.get(0)?,
        branch: row.get(1)?,
        folder: row.get(2)?,
        token_ciphertext: row.get(3)?,
        state: row.get(4)?,
        requested_at: row.get(5)?,
        attempted_at: row.get(6)?,
        checked_at: row.get(7)?,
        error_code: row.get(8)?,
        skipped_files: row.get(9)?,
        revision: row.get(10)?,
    })
}

fn load_source(connection: &Connection, project_id: &str) -> AppResult<Option<SourceRow>> {
    Ok(connection
        .query_row(
            &format!("SELECT {SOURCE_COLUMNS} FROM knowledge_sources WHERE project_id=?1"),
            [project_id],
            source_row,
        )
        .optional()?)
}

impl KnowledgeService {
    pub fn new(db: Db, disk_min_free_bytes: u64) -> Self {
        Self::build(db, disk_min_free_bytes, false)
    }

    /// A service that also accepts `file://` repositories. For tests.
    #[doc(hidden)]
    pub fn with_local_repositories(db: Db, disk_min_free_bytes: u64) -> Self {
        Self::build(db, disk_min_free_bytes, true)
    }

    fn build(db: Db, disk_min_free_bytes: u64, allow_file: bool) -> Self {
        let keys = db.layout().keys();
        let disk = db.disk_admission(disk_min_free_bytes);
        let git = Git::new(
            db.layout().knowledge_work(),
            db.layout().knowledge_known_hosts(),
            allow_file,
        );
        Self {
            inner: Arc::new(Inner {
                db,
                git,
                keys,
                allow_file,
                disk,
                limits: Limits {
                    max_files: MAX_FILES,
                    max_folders: MAX_FOLDERS,
                    max_file_bytes: MAX_FILE_BYTES,
                    max_total_bytes: MAX_TOTAL_BYTES,
                    max_download_bytes: MAX_DOWNLOAD_BYTES,
                },
                wake: Notify::new(),
                syncing: Mutex::new(HashMap::new()),
                waiting: Mutex::new(HashMap::new()),
                catalogs: Mutex::new(Vec::new()),
                builds: tokio::sync::Mutex::new(()),
                readers: Lane::new("knowledge reader", 1),
                searches: Lane::new("knowledge search", 1),
                searchers: PerPerson::new(usize::MAX),
            }),
        }
    }

    pub async fn view(&self, actor: &Actor, project_id: &str) -> AppResult<KnowledgeView> {
        actor.require_ready()?;
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        self.inner
            .db
            .snapshot(move |connection| {
                let current = authorize_read(connection, &actor, &project_id)?;
                let Some(row) = load_source(connection, &project_id)? else {
                    return Ok(KnowledgeView {
                        state: "unconnected",
                        syncing: false,
                        folder: None,
                        checked_at: None,
                        skipped_files: 0,
                        files: Vec::new(),
                        source: None,
                    });
                };
                let mut statement = connection.prepare(
                    "SELECT path,size,preview_kind,updated_at,substr(checksum,1,16),media_type FROM knowledge_files
                     WHERE project_id=?1 ORDER BY path",
                )?;
                let files = statement
                    .query_map([&project_id], |row| {
                        Ok(KnowledgeFile {
                            path: row.get(0)?,
                            size: row.get(1)?,
                            kind: preview_kind(row.get::<_, Option<String>>(2)?.as_deref(), &row.get::<_, String>(5)?),
                            updated_at: row.get(3)?,
                            version: row.get(4)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let source = is_manager(&current)
                    .then(|| source_view(connection, &project_id, &row))
                    .transpose()?;
                Ok(KnowledgeView {
                    state: public_state(&row, !files.is_empty()),
                    syncing: row.requested_at.is_some(),
                    folder: Some(row.folder),
                    checked_at: row.checked_at,
                    skipped_files: row.skipped_files,
                    files,
                    source,
                })
            })
            .await
    }

    pub async fn file(
        &self,
        actor: &Actor,
        project_id: &str,
        path: &str,
        mode: FileMode,
        validator: Option<String>,
    ) -> AppResult<FileRead> {
        actor.require_ready()?;
        let path = requested_path(path)?;
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        let db = self.inner.db.clone();
        self.inner
            .db
            .snapshot(move |connection| {
                authorize_read(connection, &actor, &project_id)?;
                let (media_type, kind, checksum, rowid, size): (
                    String,
                    Option<String>,
                    String,
                    i64,
                    i64,
                ) = connection
                    .query_row(
                        "SELECT media_type,preview_kind,checksum,rowid,size FROM knowledge_files
                             WHERE project_id=?1 AND path=?2",
                        params![project_id, path],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or(AppError::NotFound { resource: "file" })?;
                let kind = preview_kind(kind.as_deref(), &media_type);
                let allowed = match mode {
                    FileMode::Content => kind.is_some_and(PreviewKind::is_inline_media),
                    FileMode::Text => kind.is_some_and(PreviewKind::has_source),
                    FileMode::Download => true,
                };
                if !allowed {
                    return Err(AppError::NotFound {
                        resource: "preview",
                    });
                }
                let (media_type, limit) = match mode {
                    FileMode::Content => (media_type, None),
                    FileMode::Text => (
                        "text/plain; charset=utf-8".to_owned(),
                        Some(MAX_TEXT_PREVIEW_BYTES),
                    ),
                    FileMode::Download => ("application/octet-stream".to_owned(), None),
                };
                let etag = match limit {
                    Some(limit) => format!("\"{checksum}-text-{limit}\""),
                    None => format!("\"{checksum}\""),
                };
                let current = crate::files::etag_matches(validator.as_deref(), &etag);
                let length = limit.map_or(size as u64, |limit| (size as u64).min(limit));
                let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
                Ok(FileRead {
                    name,
                    media_type,
                    etag,
                    body: (!current).then(|| FileBody::new(db, rowid, checksum, length)),
                })
            })
            .await
    }

    /// Sanitized HTML for the sandboxed preview frame.
    pub async fn html_preview(
        &self,
        actor: &Actor,
        project_id: &str,
        path: &str,
    ) -> AppResult<Vec<u8>> {
        actor.require_ready()?;
        let path = requested_path(path)?;
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        let bytes = self
            .inner
            .db
            .snapshot(move |connection| {
                authorize_read(connection, &actor, &project_id)?;
                html_preview_bytes(connection, &project_id, &path)
            })
            .await?;
        crate::files::sanitized_html_preview(bytes).await
    }
}

impl Inner {
    /// Stop the project's running sync, so the next one starts at once.
    pub(super) fn stop_sync(&self, project_id: &str) {
        if let Some(stop) = self.syncing.lock().expect("sync set lock").get(project_id) {
            stop.cancel();
        }
    }

    pub(super) fn secrets(&self) -> AppResult<SecretBox> {
        SecretBox::load_or_create(&self.keys)
    }
}

/// Activity on a project's Knowledge source. Callers add what changed.
pub(super) fn source_activity<'a>(project_id: &'a str, event_type: &'a str) -> ActivityInput<'a> {
    ActivityInput {
        project_id: Some(project_id),
        entity_type: "knowledge_source",
        entity_id: project_id,
        task_id: None,
        event_type,
        field_key: None,
        before: None,
        after: None,
        metadata: json!({}),
        entity_revision: None,
    }
}

fn source_view(
    connection: &Connection,
    project_id: &str,
    row: &SourceRow,
) -> AppResult<SourceView> {
    let url = GitUrl::parse(&row.url, true)?;
    let deploy_key: Option<String> = connection
        .query_row(
            "SELECT public_key FROM knowledge_deploy_keys WHERE project_id=?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(SourceView {
        entity_type: "knowledgeSource",
        id: project_id.to_owned(),
        project_id: project_id.to_owned(),
        url: row.url.clone(),
        repository: url.display_name(),
        branch: row.branch.clone(),
        folder: row.folder.clone(),
        transport: match url.transport() {
            Transport::Https => "https",
            Transport::Ssh => "ssh",
            Transport::File => "file",
        },
        has_token: row.token_ciphertext.is_some(),
        deploy_key,
        state: row.state.clone(),
        syncing: row.requested_at.is_some(),
        checked_at: row.checked_at,
        attempted_at: row.attempted_at,
        error_code: row.error_code.clone(),
        skipped_files: row.skipped_files,
        revision: row.revision,
    })
}

/// Members see `pending` only before any files exist.
fn public_state(row: &SourceRow, has_files: bool) -> &'static str {
    match row.state.as_str() {
        "failed" => "failed",
        "ready" => "ready",
        _ if has_files => "ready",
        _ => "pending",
    }
}

fn authorize_read(connection: &Connection, actor: &Actor, project_id: &str) -> AppResult<Actor> {
    let current = refresh_actor_connection(connection, actor)?;
    current.require_ready()?;
    require_project(connection, &current, project_id, Need::Read, false)?;
    Ok(current)
}

fn is_manager(actor: &Actor) -> bool {
    actor.is_admin && matches!(actor.source, ActorSource::BrowserSession { .. })
}

/// The bytes of an HTML file to preview. The file's kind is checked first, so
/// a request for another file, up to 10 MiB, never loads it.
fn html_preview_bytes(connection: &Connection, project_id: &str, path: &str) -> AppResult<Vec<u8>> {
    let (rowid, media_type, kind): (i64, String, Option<String>) = connection
        .query_row(
            "SELECT rowid,media_type,preview_kind FROM knowledge_files
             WHERE project_id=?1 AND path=?2",
            params![project_id, path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "file" })?;
    // Only files up to the HTML preview limit are classified as HTML.
    if preview_kind(kind.as_deref(), &media_type) != Some(PreviewKind::Html) {
        return Err(AppError::NotFound {
            resource: "preview",
        });
    }
    Ok(connection.query_row(
        "SELECT content FROM knowledge_files WHERE rowid=?1",
        [rowid],
        |row| row.get(0),
    )?)
}

fn preview_kind(value: Option<&str>, media_type: &str) -> Option<PreviewKind> {
    let kind = PreviewKind::from_stored(value?)?;
    // Older snapshots could label binary .md files as Markdown. Every read,
    // listing and catalog must reject that persisted classification.
    (!kind.has_source() || media_type.starts_with("text/")).then_some(kind)
}

fn requested_path(path: &str) -> AppResult<String> {
    if !super::git::valid_relative_path(path) {
        return Err(AppError::NotFound { resource: "file" });
    }
    Ok(path.to_owned())
}

#[cfg(test)]
mod tests;
