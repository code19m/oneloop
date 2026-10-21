//! Search indexes and Markdown outlines of the synced files, built on first
//! use and kept for the newest commits.

use std::sync::Arc;

use rusqlite::{OptionalExtension, params};

use super::{Inner, KnowledgeService, QUEUE_WAIT, authorize_read, preview_kind};
use crate::{
    AppError, AppResult,
    auth::Actor,
    files::PreviewKind,
    knowledge::search::{Content, INDEX_BYTES_MAX, Index, Results},
};

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

impl KnowledgeService {
    pub async fn search(&self, actor: &Actor, project_id: &str, query: &str) -> AppResult<Results> {
        actor.require_ready()?;
        // A search ends when its request does, even one that is cancelled.
        let _searching = self.inner.searchers.claim(&actor.user_id).map_err(|_| {
            AppError::Unavailable(
                "your previous knowledge search is still running; try again shortly".into(),
            )
        })?;
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
                        let path = row.get::<_, String>(1)?;
                        let kind = preview_kind(&path, row.get::<_, Option<String>>(2)?.as_deref(), &row.get::<_, String>(3)?, row.get(4)?);
                        Ok((
                            row.get::<_, i64>(0)?,
                            path,
                            kind,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{blocking::Taken, knowledge::service::tests::synced_project};

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
        // Probes whether a person's search runs or waits; a free place is
        // given back at once.
        let searching = |actor: &Actor| {
            matches!(
                service.inner.searchers.claim(&actor.user_id),
                Err(Taken::Mine)
            )
        };
        // A long search holds the one slot, and Alice's search waits for it.
        let held = service.inner.searches.turn().await;
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
        let held = service.inner.searches.turn().await;
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
}
