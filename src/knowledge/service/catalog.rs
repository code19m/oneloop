//! Search indexes and Markdown outlines of the synced files, built on first
//! use and kept for the newest commits.
use super::*;

/// Text files larger than this are found by name only.
pub(super) const INDEXED_FILE_BYTES: i64 = 1024 * 1024;
/// Memory for search indexes across projects, as one project's index may
/// use. The newest always stays.
const CATALOG_BYTES: usize = INDEX_BYTES_MAX;
/// Text read to build an index. An index holds each character at least twice,
/// so more would not fit into it.
const CATALOG_TEXT_BYTES: i64 = (INDEX_BYTES_MAX / 2) as i64;

/// What search and MCP need from one synced commit, built on first use.
pub(super) struct Catalog {
    project_id: String,
    /// The source generation and commit it was built from.
    key: String,
    pub(super) index: Index,
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

impl KnowledgeService {
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
        let turn = self.inner.searches.turn_within(QUEUE_WAIT).await?;
        let query = query.to_owned();
        turn.run(move || catalog.index.search(&query)).await
    }

    pub(super) async fn catalog(
        &self,
        actor: &Actor,
        project_id: &str,
    ) -> AppResult<Option<Arc<Catalog>>> {
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
            let index = Index::build(files.iter().map(|file| {
                let content = match (&file.text, file.kind) {
                    (Text::Read(text), Some(PreviewKind::Markdown)) => Content::Markdown(text),
                    (Text::Read(text), Some(PreviewKind::Text)) => Content::Text(text),
                    (Text::LeftOut, _) => Content::LeftOut,
                    _ => Content::None,
                };
                (file.path.as_str(), content)
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
                    let text = if !indexed {
                        Text::None
                    } else if read + size <= CATALOG_TEXT_BYTES {
                        read += size;
                        let bytes = content.query_row([rowid], |row| row.get::<_, Vec<u8>>(0))?;
                        // Valid text is not copied.
                        Text::Read(String::from_utf8(bytes).unwrap_or_else(|error| {
                            String::from_utf8_lossy(error.as_bytes()).into_owned()
                        }))
                    } else {
                        Text::LeftOut
                    };
                    files.push(CatalogFile { path, kind, text });
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
    Files(String, Vec<CatalogFile>),
}

/// A file as a catalog is built from it.
struct CatalogFile {
    path: String,
    kind: Option<PreviewKind>,
    text: Text,
}

enum Text {
    Read(String),
    /// Searchable text that the index has no room for.
    LeftOut,
    /// The file is found by name only, by rule.
    None,
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
}
