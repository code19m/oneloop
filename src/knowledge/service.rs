//! Knowledge commands and reads. Administrators manage the source through the
//! shared command envelope; members read and search the synced files. Every
//! read checks current project access, and no reply contains a saved
//! credential.

use std::{
    collections::{HashMap, HashSet},
    ops::Not,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{
    AppError, AppResult, Db,
    access::{Need, require_project},
    auth::{Actor, ActorSource, refresh_actor_connection, unix_now},
    collaboration::{ActivityEvent, ActivityInput, record_activity_tx},
    files::{MAX_TEXT_PREVIEW_BYTES, PreviewKind},
};

use super::{
    MAX_DOWNLOAD_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES,
    content::FileBody,
    git::{Git, Limits},
    markdown,
    search::{Content, INDEX_BYTES_MAX, Index, Results},
    secrets::{Purpose, SecretBox, generate_deploy_key},
    source::{self, GitUrl, Transport},
};

/// Text files larger than this are found by name only.
const INDEXED_FILE_BYTES: i64 = 1024 * 1024;
/// Memory for search indexes across projects, as one project's index may
/// use. The newest always stays.
const CATALOG_BYTES: usize = INDEX_BYTES_MAX;
/// Text read to build an index. An index holds each character at least twice,
/// so more would not fit into it.
const CATALOG_TEXT_BYTES: i64 = (INDEX_BYTES_MAX / 2) as i64;
const OVERVIEW_FILES_MAX: usize = 200;
const OVERVIEW_SECTIONS_MAX: usize = 12;
const README_CHARS_MAX: usize = 20_000;
const FILE_TEXT_CHARS_MAX: usize = 100_000;
const FILE_HEADINGS_MAX: usize = 60;
const PATH_QUERY_MAX: usize = 1_024;
/// Bytes that always hold `chars` characters, whatever the script.
const fn text_bytes(chars: usize) -> u64 {
    4 * chars as u64
}
/// The part of a Markdown file that MCP reads for its title, headings and
/// sections: as much as search reads, and ten times what a reply holds.
const MARKDOWN_SOURCE_BYTES: u64 = INDEXED_FILE_BYTES as u64;
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
    pub(super) disk_min_free_bytes: u64,
    pub(super) disk: crate::files::disk::DiskAdmission,
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
    readers: Arc<tokio::sync::Semaphore>,
    /// Searches run one at a time.
    searches: Arc<tokio::sync::Semaphore>,
    /// People with a search that runs or waits. Each has one at most, so no
    /// one can fill the queue.
    searchers: Mutex<HashSet<String>>,
}

/// A person's search while it runs or waits.
struct Searching<'a> {
    inner: &'a Inner,
    user_id: &'a str,
}

impl<'a> Searching<'a> {
    /// A person who already has a search is told to try again at once.
    fn start(inner: &'a Inner, user_id: &'a str) -> AppResult<Self> {
        let mut searchers = inner.searchers.lock().expect("searchers lock");
        if !searchers.insert(user_id.to_owned()) {
            return Err(AppError::Unavailable(
                "your previous knowledge search is still running; try again shortly".into(),
            ));
        }
        Ok(Self { inner, user_id })
    }
}

impl Drop for Searching<'_> {
    // A search ends when its request does, even one that is cancelled.
    fn drop(&mut self) {
        self.inner
            .searchers
            .lock()
            .expect("searchers lock")
            .remove(self.user_id);
    }
}

/// What search and MCP need from one synced commit, built on first use.
struct Catalog {
    project_id: String,
    /// The source generation and commit it was built from.
    key: String,
    index: Index,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeCommand {
    pub operation: String,
    #[serde(default)]
    pub payload: Value,
    pub idempotency_key: String,
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCommandResult {
    pub entities: Vec<Value>,
    pub events: Vec<ActivityEvent>,
    pub replayed: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connect {
    project_id: String,
    url: String,
    branch: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    project_id: String,
    url: String,
    branch: String,
    #[serde(default)]
    folder: String,
    token_action: TokenAction,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TokenAction {
    Keep,
    Replace,
    Remove,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectOnly {
    project_id: String,
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

    /// The same service that also accepts `file://` repositories. For tests.
    #[doc(hidden)]
    pub fn allowing_local_repositories(&self) -> Self {
        Self::build(self.inner.db.clone(), self.inner.disk_min_free_bytes, true)
    }

    fn build(db: Db, disk_min_free_bytes: u64, allow_file: bool) -> Self {
        let keys = db.layout().keys();
        let disk = crate::files::disk::DiskAdmission::new(db.layout().root(), disk_min_free_bytes);
        let git = Git::new(
            db.layout().root().join("knowledge"),
            keys.join("knowledge_known_hosts"),
            allow_file,
        );
        Self {
            inner: Arc::new(Inner {
                db,
                git,
                keys,
                allow_file,
                disk_min_free_bytes,
                disk,
                limits: Limits {
                    max_files: MAX_FILES,
                    max_file_bytes: MAX_FILE_BYTES,
                    max_total_bytes: MAX_TOTAL_BYTES,
                    max_download_bytes: MAX_DOWNLOAD_BYTES,
                },
                wake: Notify::new(),
                syncing: Mutex::new(HashMap::new()),
                waiting: Mutex::new(HashMap::new()),
                catalogs: Mutex::new(Vec::new()),
                builds: tokio::sync::Mutex::new(()),
                readers: Arc::new(tokio::sync::Semaphore::new(1)),
                searches: Arc::new(tokio::sync::Semaphore::new(1)),
                searchers: Mutex::new(HashSet::new()),
            }),
        }
    }

    pub fn supports(operation: &str) -> bool {
        matches!(
            operation,
            "knowledge.connect"
                | "knowledge.update"
                | "knowledge.disconnect"
                | "knowledge.sync"
                | "knowledge.deploy-key.create"
        )
    }

    pub async fn execute(
        &self,
        actor: &Actor,
        command: KnowledgeCommand,
    ) -> AppResult<KnowledgeCommandResult> {
        actor.require_ready()?;
        if !Self::supports(&command.operation) {
            return Err(AppError::validation(
                "operation",
                "unsupported knowledge operation",
            ));
        }
        crate::idempotency::validate_key(&command.idempotency_key)?;
        let needs_revision = matches!(
            command.operation.as_str(),
            "knowledge.update" | "knowledge.disconnect"
        );
        if needs_revision != command.expected_revision.is_some() {
            return Err(AppError::validation(
                "expectedRevision",
                if needs_revision {
                    "is required for this operation"
                } else {
                    "is not accepted for this operation"
                },
            ));
        }
        let hash = crate::idempotency::request_hash(&json!({
            "operation": command.operation,
            "payload": command.payload,
            "expectedRevision": command.expected_revision,
        }))?;
        let actor = actor.clone();
        let inner = self.inner.clone();
        let (result, project_id, changed) = self
            .inner
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                // Every knowledge command is an administrator's, including replays.
                let current = refresh_actor_connection(tx, &actor)?;
                current.require_admin()?;
                if let Some(mut result) = crate::idempotency::replay::<KnowledgeCommandResult>(
                    tx,
                    &actor,
                    &command.idempotency_key,
                    &command.operation,
                    &hash,
                )? {
                    result.replayed = true;
                    return Ok((result, None, None));
                }
                let id = crate::idempotency::start(
                    tx,
                    &actor,
                    &uuid::Uuid::now_v7().to_string(),
                    &command.idempotency_key,
                    &command.operation,
                    &hash,
                    now,
                )?;
                let (project_id, entity, events) = dispatch(tx, &inner, &current, &command, now)?;
                let changed = matches!(
                    command.operation.as_str(),
                    "knowledge.update" | "knowledge.disconnect"
                )
                .then(|| project_id.clone());
                let result = KnowledgeCommandResult {
                    entities: vec![entity],
                    events,
                    replayed: false,
                };
                let response = serde_json::to_string(&result).map_err(|error| {
                    AppError::internal(format!("serialize knowledge response: {error}"))
                })?;
                crate::idempotency::succeed(
                    tx,
                    &id,
                    crate::idempotency::Receipt {
                        status: 200,
                        response: &response,
                        resource_type: Some("knowledge_source"),
                        resource_id: Some(&project_id),
                        project_id: Some(&project_id),
                    },
                    now,
                )?;
                Ok((result, Some(project_id), changed))
            })
            .await?;
        // A sync that is still running works for the old source.
        if let Some(project_id) = changed {
            self.inner.stop_sync(&project_id);
        }
        if let Some(project_id) = project_id {
            // An administrator's change or retry syncs at once.
            self.inner.stop_waiting(&project_id);
            self.inner.wake.notify_one();
        }
        Ok(result)
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
                    FileMode::Content => {
                        matches!(kind, Some(PreviewKind::Image | PreviewKind::Pdf))
                    }
                    FileMode::Text => matches!(
                        kind,
                        Some(PreviewKind::Text | PreviewKind::Markdown | PreviewKind::Html)
                    ),
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
                let current = validator.as_deref().is_some_and(|value| {
                    value
                        .split(',')
                        .any(|tag| tag.trim().trim_start_matches("W/") == etag)
                });
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

    pub async fn search(&self, actor: &Actor, project_id: &str, query: &str) -> AppResult<Results> {
        actor.require_ready()?;
        let _searching = Searching::start(&self.inner, &actor.user_id)?;
        let Some(catalog) = self.catalog(actor, project_id).await? else {
            return Ok(Results::default());
        };
        // A search reads the whole index, which takes a while for a large
        // folder. It runs off the async workers, one at a time, so searches
        // can't slow other requests down; a search that waits too long is
        // told to try again.
        let permit = tokio::time::timeout(QUEUE_WAIT, self.inner.searches.clone().acquire_owned())
            .await
            .map_err(|_| {
                AppError::Unavailable("knowledge search is busy; try again shortly".into())
            })?
            .map_err(|_| AppError::Unavailable("knowledge search is shutting down".into()))?;
        let query = query.to_owned();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            catalog.index.search(&query)
        })
        .await
        .map_err(|error| AppError::internal(format!("knowledge search failed: {error}")))
    }

    /// For MCP clients: the README of `folder` and a compact file index.
    pub async fn overview(
        &self,
        actor: &Actor,
        project_id: &str,
        folder: Option<&str>,
    ) -> AppResult<KnowledgeOverview> {
        actor.require_ready()?;
        let folder = match folder.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => source::folder(value)?,
            None => String::new(),
        };
        let view = self.view(actor, project_id).await?;
        let catalog = self.catalog(actor, project_id).await?;
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        let inside: Vec<&KnowledgeFile> = view
            .files
            .iter()
            .filter(|file| file.path.starts_with(&prefix))
            .collect();
        if !folder.is_empty() && inside.is_empty() && !view.files.is_empty() {
            return Err(AppError::NotFound { resource: "folder" });
        }
        // A binary file named README.md returns only its details, as in read_text.
        let readme_path = inside
            .iter()
            .find(|file| {
                file.path[prefix.len()..].eq_ignore_ascii_case("readme.md")
                    && matches!(file.kind, Some(PreviewKind::Markdown | PreviewKind::Text))
            })
            .map(|file| file.path.clone());
        let readme = match readme_path {
            Some(path) => {
                let (text, longer) = self
                    .text(actor, project_id, &path, text_bytes(README_CHARS_MAX))
                    .await?;
                let (content, truncated) = cut(&text, README_CHARS_MAX);
                Some(ReadmeText {
                    path,
                    content,
                    truncated: truncated || longer,
                })
            }
            None => None,
        };
        let outline = |path: &str| {
            catalog
                .as_ref()
                .and_then(|catalog| catalog.index.outline(path))
        };
        let files = inside
            .iter()
            .take(OVERVIEW_FILES_MAX)
            .map(|file| OverviewFile {
                path: file.path.clone(),
                kind: file.kind,
                size: file.size,
                updated_at: file.updated_at,
                title: outline(&file.path).and_then(|outline| outline.title.clone()),
                sections: outline(&file.path)
                    .map(|outline| {
                        outline
                            .sections
                            .iter()
                            .take(OVERVIEW_SECTIONS_MAX)
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect();
        Ok(KnowledgeOverview {
            state: view.state,
            checked_at: view.checked_at,
            readme,
            files,
            file_count: inside.len(),
            truncated: inside.len() > OVERVIEW_FILES_MAX,
        })
    }

    /// For MCP clients: one file's text, or one section of a Markdown file.
    pub async fn read_text(
        &self,
        actor: &Actor,
        project_id: &str,
        path: &str,
        section: Option<&str>,
    ) -> AppResult<TextFile> {
        actor.require_ready()?;
        let path = requested_path(path)?;
        let view = self.view(actor, project_id).await?;
        let file = view
            .files
            .into_iter()
            .find(|file| file.path == path)
            .ok_or(AppError::NotFound { resource: "file" })?;
        let mut result = TextFile {
            path: file.path.clone(),
            kind: file.kind,
            size: file.size,
            updated_at: file.updated_at,
            title: None,
            headings: Vec::new(),
            section: None,
            content: None,
            truncated: false,
            note: None,
        };
        let readable = matches!(
            file.kind,
            Some(PreviewKind::Markdown | PreviewKind::Text | PreviewKind::Html)
        );
        if !readable {
            if section.is_some() {
                return Err(AppError::validation(
                    "section",
                    "applies to Markdown files only",
                ));
            }
            result.note = Some("This file is not text. Open it in oneloop to view or download it.");
            return Ok(result);
        }
        let markdown_file = file.kind == Some(PreviewKind::Markdown);
        if section.is_some() && !markdown_file {
            return Err(AppError::validation(
                "section",
                "applies to Markdown files only",
            ));
        }
        let query = section
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        // Only the start of a file can be part of a reply, so only the start
        // is read. One file at a time is read and parsed, off the async
        // workers, so many calls at once can't use up the memory; a read
        // that waits too long is told to try again.
        let permit = tokio::time::timeout(QUEUE_WAIT, self.inner.readers.clone().acquire_owned())
            .await
            .map_err(|_| {
                AppError::Unavailable("knowledge reader is busy; try again shortly".into())
            })?
            .map_err(|_| AppError::Unavailable("knowledge reader is shutting down".into()))?;
        let limit = if markdown_file {
            MARKDOWN_SOURCE_BYTES
        } else {
            text_bytes(FILE_TEXT_CHARS_MAX)
        };
        let (text, longer) = self.text(actor, project_id, &file.path, limit).await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut content = text.as_str();
            if markdown_file {
                let sections = markdown::outline(&text);
                result.title = markdown::title(&sections);
                result.headings = sections
                    .iter()
                    .filter_map(|section| section.heading.as_ref())
                    .filter(|heading| heading.level <= 3)
                    .take(FILE_HEADINGS_MAX)
                    .map(|heading| format!("{} {}", "#".repeat(heading.level.into()), heading.text))
                    .collect();
                if let Some(query) = query {
                    content = markdown::section_source(&text, &sections, &query).ok_or(
                        AppError::NotFound {
                            resource: "section",
                        },
                    )?;
                    result.section = Some(query);
                }
            }
            // The file goes on past what was read, and so may the content.
            let unfinished = longer
                && content.as_ptr().addr() + content.len() == text.as_ptr().addr() + text.len();
            let (content, truncated) = cut(content, FILE_TEXT_CHARS_MAX);
            result.content = Some(content);
            result.truncated = truncated || unfinished;
            Ok(result)
        })
        .await
        .map_err(|error| AppError::internal(format!("knowledge reader failed: {error}")))?
    }

    /// The first `limit` bytes of a text file as text, read after the caller
    /// is authorized, and whether the file is longer.
    async fn text(
        &self,
        actor: &Actor,
        project_id: &str,
        path: &str,
        limit: u64,
    ) -> AppResult<(String, bool)> {
        let read = self
            .file(actor, project_id, path, FileMode::Download, None)
            .await?;
        let Some(body) = read.body else {
            return Ok((String::new(), false));
        };
        let longer = body.len() > limit;
        let mut bytes = body.read_start(limit).await?;
        // A character that the limit splits is left out; other bytes that
        // aren't UTF-8 become U+FFFD. Valid text is not copied.
        if longer
            && let Err(error) = std::str::from_utf8(&bytes)
            && error.error_len().is_none()
        {
            bytes.truncate(error.valid_up_to());
        }
        let text = String::from_utf8(bytes)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
        Ok((text, longer))
    }

    async fn catalog(&self, actor: &Actor, project_id: &str) -> AppResult<Option<Arc<Catalog>>> {
        match self.read_catalog(actor, project_id, false).await? {
            Loaded::Empty => return Ok(None),
            Loaded::Cached(catalog) => return Ok(Some(catalog)),
            Loaded::Missing | Loaded::Files(..) => {}
        }
        let _build = self.inner.builds.lock().await;
        let (key, files) = match self.read_catalog(actor, project_id, true).await? {
            Loaded::Empty => return Ok(None),
            Loaded::Cached(catalog) => return Ok(Some(catalog)),
            Loaded::Files(key, files) => (key, files),
            Loaded::Missing => unreachable!("files were requested"),
        };
        let project_id = project_id.to_owned();
        let catalog = tokio::task::spawn_blocking(move || {
            let texts: Vec<(String, Option<PreviewKind>, Option<String>)> = files
                .into_iter()
                .map(|(path, kind, bytes)| {
                    let text = bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
                    (path, kind, text)
                })
                .collect();
            let index = Index::build(texts.iter().map(|(path, kind, text)| {
                let content = match (kind, text) {
                    (Some(PreviewKind::Markdown), Some(text)) => Content::Markdown(text),
                    (Some(PreviewKind::Text), Some(text)) => Content::Text(text),
                    _ => Content::None,
                };
                (path.as_str(), content)
            }));
            Arc::new(Catalog {
                project_id,
                key,
                index,
            })
        })
        .await
        .map_err(|error| AppError::internal(format!("knowledge index worker failed: {error}")))?;
        self.inner.remember(catalog.clone());
        Ok(Some(catalog))
    }

    /// The cached catalog for the current source, or the files to build one.
    async fn read_catalog(
        &self,
        actor: &Actor,
        project_id: &str,
        files: bool,
    ) -> AppResult<Loaded> {
        let actor = actor.clone();
        let project = project_id.to_owned();
        let inner = self.inner.clone();
        self.inner
            .db
            .snapshot(move |connection| {
                authorize_read(connection, &actor, &project)?;
                let source: Option<(Option<String>, String)> = connection
                    .query_row(
                        "SELECT commit_id,generation FROM knowledge_sources WHERE project_id=?1",
                        [&project],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((Some(commit), generation)) = source else {
                    return Ok(Loaded::Empty);
                };
                let key = format!("{generation}:{commit}");
                if let Some(found) = inner.cached(&project, &key) {
                    return Ok(Loaded::Cached(found));
                }
                if !files {
                    return Ok(Loaded::Missing);
                }
                let mut statement = connection.prepare(
                    "SELECT rowid,path,preview_kind,media_type,size,
                            preview_kind IN ('markdown','text') AND media_type LIKE 'text/%' AND size<=?2
                     FROM knowledge_files WHERE project_id=?1 ORDER BY path",
                )?;
                let listed = statement
                    .query_map(params![project, INDEXED_FILE_BYTES], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            preview_kind(row.get::<_, Option<String>>(2)?.as_deref(), &row.get::<_, String>(3)?),
                            row.get::<_, i64>(4)?,
                            row.get::<_, bool>(5)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                // Text past what the index can hold is never read.
                let mut content = connection
                    .prepare_cached("SELECT content FROM knowledge_files WHERE rowid=?1")?;
                let mut read = 0;
                let mut files = Vec::with_capacity(listed.len());
                for (rowid, path, kind, size, indexed) in listed {
                    let text = if indexed && read + size <= CATALOG_TEXT_BYTES {
                        read += size;
                        Some(content.query_row([rowid], |row| row.get::<_, Vec<u8>>(0))?)
                    } else {
                        None
                    };
                    files.push((path, kind, text));
                }
                Ok(Loaded::Files(key, files))
            })
            .await
    }
}

enum Loaded {
    Empty,
    Cached(Arc<Catalog>),
    /// Not cached, and the files were not requested.
    Missing,
    Files(String, Vec<(String, Option<PreviewKind>, Option<Vec<u8>>)>),
}

impl Inner {
    fn cached(&self, project_id: &str, key: &str) -> Option<Arc<Catalog>> {
        let mut catalogs = self.catalogs.lock().expect("catalog cache lock");
        let position = catalogs
            .iter()
            .position(|catalog| catalog.project_id == project_id && catalog.key == key)?;
        let catalog = catalogs.remove(position);
        catalogs.push(catalog.clone());
        Some(catalog)
    }

    fn remember(&self, catalog: Arc<Catalog>) {
        let mut catalogs = self.catalogs.lock().expect("catalog cache lock");
        catalogs.retain(|cached| cached.project_id != catalog.project_id);
        catalogs.push(catalog);
        let mut total: usize = catalogs.iter().map(|cached| cached.index.bytes()).sum();
        while catalogs.len() > 1 && total > CATALOG_BYTES {
            total -= catalogs.remove(0).index.bytes();
        }
    }

    pub(super) fn forget(&self, project_id: &str) {
        self.catalogs
            .lock()
            .expect("catalog cache lock")
            .retain(|cached| cached.project_id != project_id);
    }

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

fn dispatch(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    command: &KnowledgeCommand,
    now: i64,
) -> AppResult<(String, Value, Vec<ActivityEvent>)> {
    match command.operation.as_str() {
        "knowledge.connect" => connect(tx, inner, actor, payload(command)?, now),
        "knowledge.update" => update(
            tx,
            inner,
            actor,
            payload(command)?,
            command.expected_revision.expect("checked revision"),
            now,
        ),
        "knowledge.disconnect" => disconnect(
            tx,
            inner,
            actor,
            payload(command)?,
            command.expected_revision.expect("checked revision"),
            now,
        ),
        "knowledge.sync" => request_sync(tx, actor, payload(command)?, now),
        "knowledge.deploy-key.create" => {
            create_deploy_key(tx, inner, actor, payload(command)?, now)
        }
        _ => Err(AppError::validation(
            "operation",
            "unsupported knowledge operation",
        )),
    }
}

fn payload<T: DeserializeOwned>(command: &KnowledgeCommand) -> AppResult<T> {
    crate::http::input::parse_payload(&command.payload)
}

struct Location {
    url: GitUrl,
    branch: String,
    folder: String,
}

fn location(inner: &Inner, url: &str, branch: &str, folder: &str) -> AppResult<Location> {
    Ok(Location {
        url: GitUrl::parse(url, inner.allow_file)?,
        branch: source::branch(branch)?,
        folder: source::folder(folder)?,
    })
}

fn connect(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: Connect,
    now: i64,
) -> AppResult<(String, Value, Vec<ActivityEvent>)> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    if load_source(tx, &input.project_id)?.is_some() {
        return Err(AppError::Conflict(
            "a repository is already connected to this project".into(),
        ));
    }
    let place = location(inner, &input.url, &input.branch, &input.folder)?;
    let token = input
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(source::token)
        .transpose()?;
    if token.is_some() && place.url.transport() != Transport::Https {
        return Err(AppError::validation(
            "token",
            "is used only with HTTPS URLs",
        ));
    }
    let token_ciphertext = token
        .map(|token| {
            inner
                .secrets()?
                .seal(Purpose::Token, &input.project_id, token.as_bytes())
        })
        .transpose()?;
    let mut events = Vec::new();
    if place.url.transport() == Transport::Ssh {
        events.extend(ensure_deploy_key(tx, inner, actor, &input.project_id, now)?);
    }
    // The audit history outlives a disconnected source. Continue from its
    // highest revision, so a command for an earlier source never matches.
    let revision: i64 = tx.query_row(
        "SELECT COALESCE(MAX(entity_revision),0)+1 FROM activity_events
         WHERE entity_type='knowledge_source' AND entity_id=?1",
        [&input.project_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO knowledge_sources
         (project_id,url,branch,folder,token_ciphertext,state,requested_at,created_by,created_at,updated_by,updated_at,generation,revision)
         VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?6,?7,?6,?8,?9)",
        params![
            input.project_id,
            place.url.as_str(),
            place.branch,
            place.folder,
            token_ciphertext,
            now,
            actor.user_id,
            uuid::Uuid::now_v7().to_string(),
            revision
        ],
    )?;
    events.push(record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "knowledge_source",
            entity_id: &input.project_id,
            task_id: None,
            event_type: "knowledge.connected",
            field_key: None,
            before: None,
            after: Some(described(&place.url, &place.branch, &place.folder)),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?);
    let row = load_source(tx, &input.project_id)?.expect("inserted source");
    let entity = serde_json::to_value(source_view(tx, &input.project_id, &row)?)
        .map_err(|error| AppError::internal(error.to_string()))?;
    Ok((input.project_id, entity, events))
}

fn update(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: Update,
    expected: i64,
    now: i64,
) -> AppResult<(String, Value, Vec<ActivityEvent>)> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    let before = load_source(tx, &input.project_id)?.ok_or(AppError::NotFound {
        resource: "knowledge source",
    })?;
    if before.revision != expected {
        return Err(AppError::revision(expected, before.revision));
    }
    let place = location(inner, &input.url, &input.branch, &input.folder)?;
    let https = place.url.transport() == Transport::Https;
    let previous_url = GitUrl::parse(&before.url, true)?;
    // A saved token only ever goes to the host it was entered for.
    if input.token_action == TokenAction::Keep
        && before.token_ciphertext.is_some()
        && https
        && place.url.origin() != previous_url.origin()
    {
        return Err(AppError::validation(
            "token",
            "belongs to the previous host; replace or remove it",
        ));
    }
    let token = match input.token_action {
        TokenAction::Replace => {
            let value = input.token.as_deref().unwrap_or_default();
            if value.trim().is_empty() {
                return Err(AppError::validation("token", "enter the new token"));
            }
            if !https {
                return Err(AppError::validation(
                    "token",
                    "is used only with HTTPS URLs",
                ));
            }
            Some(inner.secrets()?.seal(
                Purpose::Token,
                &input.project_id,
                source::token(value)?.as_bytes(),
            )?)
        }
        TokenAction::Keep if https => before.token_ciphertext.clone(),
        TokenAction::Keep | TokenAction::Remove => None,
    };
    let moved = place.url.as_str() != before.url
        || place.branch != before.branch
        || place.folder != before.folder;
    let credentials_changed = input.token_action == TokenAction::Replace
        || token.is_some() != before.token_ciphertext.is_some();
    if !moved && !credentials_changed {
        return Err(AppError::validation(
            "payload",
            "no knowledge base fields changed",
        ));
    }
    let mut events = Vec::new();
    if place.url.transport() == Transport::Ssh {
        events.extend(ensure_deploy_key(tx, inner, actor, &input.project_id, now)?);
    }
    tx.execute(
        "UPDATE knowledge_sources SET url=?2,branch=?3,folder=?4,token_ciphertext=?5,requested_at=?6,
         updated_by=?7,updated_at=?6,revision=revision+1,generation=?8 WHERE project_id=?1",
        params![
            input.project_id,
            place.url.as_str(),
            place.branch,
            place.folder,
            token,
            now,
            actor.user_id,
            uuid::Uuid::now_v7().to_string()
        ],
    )?;
    inner.forget(&input.project_id);
    if moved {
        // Files from the old location never show under the new one.
        tx.execute(
            "UPDATE knowledge_sources SET state='pending',commit_id=NULL,checked_at=NULL,
             attempted_at=NULL,error_code=NULL,skipped_files=0 WHERE project_id=?1",
            [&input.project_id],
        )?;
        tx.execute(
            "DELETE FROM knowledge_files WHERE project_id=?1",
            [&input.project_id],
        )?;
    }
    events.push(record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "knowledge_source",
            entity_id: &input.project_id,
            task_id: None,
            event_type: "knowledge.updated",
            field_key: None,
            before: Some(described(&previous_url, &before.branch, &before.folder)),
            after: Some(described(&place.url, &place.branch, &place.folder)),
            metadata: json!({"credentialsChanged": credentials_changed}),
            entity_revision: Some(before.revision + 1),
        },
        now,
    )?);
    let row = load_source(tx, &input.project_id)?.expect("updated source");
    let entity = serde_json::to_value(source_view(tx, &input.project_id, &row)?)
        .map_err(|error| AppError::internal(error.to_string()))?;
    Ok((input.project_id, entity, events))
}

fn disconnect(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: ProjectOnly,
    expected: i64,
    now: i64,
) -> AppResult<(String, Value, Vec<ActivityEvent>)> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    let before = load_source(tx, &input.project_id)?.ok_or(AppError::NotFound {
        resource: "knowledge source",
    })?;
    if before.revision != expected {
        return Err(AppError::revision(expected, before.revision));
    }
    let url = GitUrl::parse(&before.url, true)?;
    for table in [
        "knowledge_files",
        "knowledge_deploy_keys",
        "knowledge_sources",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE project_id=?1"),
            [&input.project_id],
        )?;
    }
    inner.forget(&input.project_id);
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "knowledge_source",
            entity_id: &input.project_id,
            task_id: None,
            event_type: "knowledge.disconnected",
            field_key: None,
            before: Some(described(&url, &before.branch, &before.folder)),
            after: None,
            metadata: json!({}),
            entity_revision: Some(before.revision + 1),
        },
        now,
    )?;
    let entity = json!({
        "entityType": "knowledgeSource",
        "id": input.project_id,
        "projectId": input.project_id,
        "deleted": true,
        "revision": before.revision + 1,
    });
    Ok((input.project_id, entity, vec![event]))
}

fn request_sync(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: ProjectOnly,
    now: i64,
) -> AppResult<(String, Value, Vec<ActivityEvent>)> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    if load_source(tx, &input.project_id)?.is_none() {
        return Err(AppError::NotFound {
            resource: "knowledge source",
        });
    }
    tx.execute(
        "UPDATE knowledge_sources SET requested_at=?2 WHERE project_id=?1",
        params![input.project_id, now],
    )?;
    let row = load_source(tx, &input.project_id)?.expect("existing source");
    let entity = serde_json::to_value(source_view(tx, &input.project_id, &row)?)
        .map_err(|error| AppError::internal(error.to_string()))?;
    Ok((input.project_id, entity, Vec::new()))
}

fn create_deploy_key(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: ProjectOnly,
    now: i64,
) -> AppResult<(String, Value, Vec<ActivityEvent>)> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    let events = ensure_deploy_key(tx, inner, actor, &input.project_id, now)?
        .into_iter()
        .collect();
    let public_key: String = tx.query_row(
        "SELECT public_key FROM knowledge_deploy_keys WHERE project_id=?1",
        [&input.project_id],
        |row| row.get(0),
    )?;
    let entity = json!({
        "entityType": "knowledgeDeployKey",
        "id": input.project_id,
        "projectId": input.project_id,
        "publicKey": public_key,
    });
    Ok((input.project_id, entity, events))
}

/// Create the project's deploy key unless it has one.
fn ensure_deploy_key(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    project_id: &str,
    now: i64,
) -> AppResult<Option<ActivityEvent>> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM knowledge_deploy_keys WHERE project_id=?1)",
        [project_id],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(None);
    }
    let key = generate_deploy_key("oneloop")?;
    let sealed = inner
        .secrets()?
        .seal(Purpose::DeployKey, project_id, key.private.as_bytes())?;
    tx.execute(
        "INSERT INTO knowledge_deploy_keys (project_id,public_key,private_key_ciphertext,created_at)
         VALUES (?1,?2,?3,?4)",
        params![project_id, key.public, sealed, now],
    )?;
    Ok(Some(record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(project_id),
            entity_type: "knowledge_source",
            entity_id: project_id,
            task_id: None,
            event_type: "knowledge.deploy_key.created",
            field_key: None,
            before: None,
            after: None,
            metadata: json!({}),
            entity_revision: None,
        },
        now,
    )?))
}

/// The repository as activity records it: never a credential.
fn described(url: &GitUrl, branch: &str, folder: &str) -> Value {
    json!({"repository": url.display_name(), "branch": branch, "folder": folder})
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
    // Older snapshots could label binary .md files as Markdown. Every read,
    // listing and catalog must reject that persisted classification.
    if matches!(value, Some("markdown" | "text" | "html")) && !media_type.starts_with("text/") {
        return None;
    }
    match value? {
        "image" => Some(PreviewKind::Image),
        "pdf" => Some(PreviewKind::Pdf),
        "html" => Some(PreviewKind::Html),
        "markdown" => Some(PreviewKind::Markdown),
        "text" => Some(PreviewKind::Text),
        _ => None,
    }
}

fn requested_path(path: &str) -> AppResult<String> {
    if path.len() > PATH_QUERY_MAX || !super::git::valid_relative_path(path) {
        return Err(AppError::NotFound { resource: "file" });
    }
    Ok(path.to_owned())
}

/// At most `limit` characters, cut at a line break when one is near.
fn cut(text: &str, limit: usize) -> (String, bool) {
    match text.char_indices().nth(limit) {
        None => (text.to_owned(), false),
        Some((end, _)) => {
            let head = &text[..end];
            let end = head
                .rfind('\n')
                .filter(|position| *position >= end / 2)
                .unwrap_or(end);
            (text[..end].to_owned(), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project with a synced folder of Markdown `files`, and a signed-in
    /// admin for each of `people`.
    async fn synced_project(
        files: Vec<(String, String)>,
        people: &[&str],
    ) -> (tempfile::TempDir, KnowledgeService, Vec<Actor>) {
        use crate::auth::{AuthService, LoginResult, NewUser, create_user};
        let root = tempfile::tempdir_in("target").unwrap();
        crate::db::migrate(root.path(), None).unwrap();
        let db = Db::open(root.path()).unwrap();
        let password = "test-only-password-012345";
        let usernames: Vec<String> = people.iter().map(|name| (*name).to_owned()).collect();
        let names = usernames.clone();
        db.transaction(move |tx| {
            for username in names {
                let user = NewUser {
                    display_name: username.clone(),
                    username,
                    password: password.into(),
                    is_admin: true,
                    must_change_password: false,
                };
                create_user(tx, user, unix_now()?)?;
            }
            tx.execute_batch(
                "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);
                 INSERT INTO knowledge_sources(project_id,url,branch,folder,state,commit_id,created_at,updated_at,generation)
                 VALUES('p','https://git.example.test/docs.git','main','','ready','c',1,1,'g');",
            )?;
            for (path, content) in files {
                tx.execute(
                    "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                     VALUES('p',?1,?2,'text/plain','markdown',?3,1,?4)",
                    params![path, content.len() as i64, format!("sum-{path}"), content.into_bytes()],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let auth = AuthService::new(db.clone());
        let mut actors = Vec::new();
        for username in &usernames {
            let login = auth
                .login(username, password, Default::default(), None)
                .await
                .unwrap();
            let LoginResult::Authenticated(session) = login else {
                panic!("the session limit can't be reached");
            };
            actors.push(session.actor);
        }
        (root, KnowledgeService::new(db, 0), actors)
    }

    #[tokio::test]
    async fn a_search_builds_its_results_off_the_worker_that_awaits_it() {
        // This test's runtime runs on this thread, so whatever a search scans
        // and builds on the async worker counts against this thread's heap.
        let section = "## Shared steps\n\nShared words for every reader.\n\n";
        let files = (0..300)
            .map(|index| {
                let content = format!("# Note {index}\n\n{}", section.repeat(6));
                (format!("shared-{index}.md"), content)
            })
            .collect();
        let (_root, service, people) = synced_project(files, &["admin"]).await;
        // The first search builds the index.
        service.search(&people[0], "p", "shared").await.unwrap();
        let watch = crate::test_memory::Watch::start();
        let results = service
            .search(&people[0], "p", "shared words")
            .await
            .unwrap();
        assert_eq!((results.file_count, results.hit_count), (0, 1800));
        assert_eq!(results.documents.len(), 50);
        assert!(watch.peak() < 16 * 1024, "{} bytes", watch.peak());
    }

    #[tokio::test]
    async fn each_person_has_one_search_and_a_search_waits_at_most_five_seconds() {
        let files = vec![("note.md".to_owned(), "# Note\n\nShared words.\n".to_owned())];
        let (_root, service, people) = synced_project(files, &["alice", "bob"]).await;
        let (alice, bob) = (&people[0], &people[1]);
        // The first search builds the index.
        service.search(alice, "p", "shared").await.unwrap();
        tokio::time::pause();
        let search = |actor: &Actor| {
            let (service, actor) = (service.clone(), actor.clone());
            tokio::spawn(async move { service.search(&actor, "p", "shared").await })
        };
        let searching = |actor: &Actor| {
            let searchers = service.inner.searchers.lock().unwrap();
            searchers.contains(&actor.user_id)
        };
        // A long search holds the one slot, and Alice's search waits for it.
        let held = service
            .inner
            .searches
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        let first = search(alice);
        while !searching(alice) {
            tokio::task::yield_now().await;
        }
        // Her next one is told at once to try again; Bob's waits its turn.
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            service.search(alice, "p", "shared"),
        )
        .await
        .expect("a second search of one person doesn't wait");
        assert!(
            matches!(second, Err(AppError::Unavailable(_))),
            "{second:?}"
        );
        let other = search(bob);
        drop(held);
        first.await.unwrap().unwrap();
        other.await.unwrap().unwrap();
        // A search whose request ends lets its person search again at once.
        let held = service
            .inner
            .searches
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        let cancelled = search(alice);
        while !searching(alice) {
            tokio::task::yield_now().await;
        }
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        assert!(!searching(alice));
        // A search that waits too long is told to try again.
        let waiting = search(bob);
        tokio::time::sleep(QUEUE_WAIT + std::time::Duration::from_secs(1)).await;
        let waited = waiting.await.unwrap();
        assert!(
            matches!(waited, Err(AppError::Unavailable(_))),
            "{waited:?}"
        );
        assert!(!searching(bob));
        drop(held);
        service.search(bob, "p", "shared").await.unwrap();
    }

    #[tokio::test]
    async fn a_file_read_waits_at_most_five_seconds_for_the_one_before_it() {
        let files = vec![("note.md".to_owned(), "# Note\n\nWords.\n".to_owned())];
        let (_root, service, people) = synced_project(files, &["alice"]).await;
        tokio::time::pause();
        // Another read holds the one reader.
        let held = service.inner.readers.clone().acquire_owned().await.unwrap();
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            service.read_text(&people[0], "p", "note.md", None),
        )
        .await
        .expect("a read doesn't wait for long");
        assert!(matches!(read, Err(AppError::Unavailable(_))), "{read:?}");
        drop(held);
        let read = service
            .read_text(&people[0], "p", "note.md", None)
            .await
            .unwrap();
        assert_eq!(read.content.as_deref(), Some("# Note\n\nWords.\n"));
    }

    #[test]
    fn long_text_is_cut_at_a_nearby_line_break() {
        assert_eq!(cut("short", 10), ("short".to_owned(), false));
        let (text, truncated) = cut("first line\nsecond line\nthird", 15);
        assert!(truncated);
        assert_eq!(text, "first line");
        let (text, truncated) = cut("ééééé", 3);
        assert_eq!((text.as_str(), truncated), ("ééé", true));
    }

    #[test]
    fn an_html_preview_reads_no_bytes_of_other_files() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CONTENT_READS: AtomicUsize = AtomicUsize::new(0);
        let root = tempfile::tempdir_in("target").unwrap();
        crate::db::migrate(root.path(), None).unwrap();
        let mut connection =
            crate::db::open_connection(&root.path().join("oneloop.sqlite3")).unwrap();
        connection.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);").unwrap();
        for (path, media_type, kind, content) in [
            (
                "data.bin",
                "application/octet-stream",
                None,
                vec![7; 4 * 1024 * 1024],
            ),
            (
                "page.html",
                "text/html",
                Some("html"),
                b"<p>hi</p>".to_vec(),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                     VALUES('p',?1,?2,?3,?4,'sum',1,?5)",
                    params![path, content.len() as i64, media_type, kind, content],
                )
                .unwrap();
        }
        connection.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(|event| {
                if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
                    && sql.contains("content")
                {
                    CONTENT_READS.fetch_add(1, Ordering::Relaxed);
                }
            }),
        );
        let transaction = connection.transaction().unwrap();
        assert!(matches!(
            html_preview_bytes(&transaction, "p", "data.bin"),
            Err(AppError::NotFound {
                resource: "preview"
            })
        ));
        assert_eq!(CONTENT_READS.load(Ordering::Relaxed), 0);
        assert_eq!(
            html_preview_bytes(&transaction, "p", "page.html").unwrap(),
            b"<p>hi</p>"
        );
        assert_eq!(CONTENT_READS.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn requested_paths_must_be_plain_relative_paths() {
        assert!(requested_path("guides/README.md").is_ok());
        for bad in ["", "/etc/passwd", "../x", "a//b", ".git/config"] {
            assert!(requested_path(bad).is_err(), "{bad:?}");
        }
    }
}
