//! The background sync. Each connected branch is checked every minute; when
//! it moved, a fresh copy of the folder replaces the stored files. A failed
//! sync keeps the last files readable and retries every five minutes, or at
//! once when an administrator asks.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    sync::watch,
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{
    AppResult,
    auth::unix_now,
    collaboration::{ActivityInput, record_system_activity_tx},
};

use super::{
    git::{Credentials, Failure, Snapshot, SyncError},
    secrets::Purpose,
    service::{Inner, KnowledgeService},
    source::{GitUrl, Transport},
};

const POLL: Duration = Duration::from_secs(15);
const CHECK_INTERVAL_SECONDS: i64 = 60;
const RETRY_INTERVAL_SECONDS: i64 = 5 * 60;
const CONCURRENT_SYNCS: usize = 4;
/// Commits searched for file dates on a first sync, and on later ones.
const FIRST_HISTORY_DEPTH: u32 = 1_000;
const HISTORY_DEPTH: u32 = 100;

struct Due {
    url: String,
    branch: String,
    folder: String,
    token_ciphertext: Option<Vec<u8>>,
    deploy_key_ciphertext: Option<Vec<u8>>,
    commit: Option<String>,
    generation: String,
}

enum Fetched {
    Unchanged,
    Changed(Snapshot),
}

/// Marks a project as syncing until its sync ends, is cancelled or is stopped
/// because an administrator changed or disconnected the source.
struct Running {
    inner: Arc<Inner>,
    project_id: String,
    stop: CancellationToken,
}

impl Running {
    fn claim(inner: &Arc<Inner>, project_id: &str) -> Option<Self> {
        let mut syncing = inner.syncing.lock().expect("sync set lock");
        if syncing.contains_key(project_id) {
            return None;
        }
        let stop = CancellationToken::new();
        syncing.insert(project_id.to_owned(), stop.clone());
        Some(Self {
            inner: inner.clone(),
            project_id: project_id.to_owned(),
            stop,
        })
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.inner
            .syncing
            .lock()
            .expect("sync set lock")
            .remove(&self.project_id);
    }
}

impl KnowledgeService {
    /// Runs until shutdown, with a few syncs at once. A free slot takes the
    /// next due source, and commands wake the worker, so a new connection or a
    /// retry never waits for unrelated syncs to finish.
    pub fn spawn_worker(&self, mut shutdown: watch::Receiver<bool>) -> JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.inner.git.clear_work_root() {
                tracing::warn!(%error, "could not remove old knowledge working copies");
            }
            // Dropping the set on shutdown cancels running syncs and stops their git.
            let mut running = JoinSet::new();
            loop {
                if *shutdown.borrow() {
                    break;
                }
                service.start_due(&mut running).await;
                tokio::select! {
                    _ = service.inner.wake.notified() => {}
                    _ = tokio::time::sleep(POLL) => {}
                    Some(result) = running.join_next(), if !running.is_empty() => {
                        if let Err(error) = result {
                            tracing::error!(%error, "knowledge sync task failed");
                        }
                    }
                    _ = shutdown.changed() => break,
                }
            }
        })
    }

    /// Start due syncs in the free slots of `running`.
    async fn start_due(&self, running: &mut JoinSet<()>) {
        let free = CONCURRENT_SYNCS.saturating_sub(running.len());
        if free == 0 {
            return;
        }
        let due = match self.due_projects().await {
            Ok(due) => due,
            Err(error) => {
                tracing::warn!(%error, "could not list knowledge sources to sync");
                return;
            }
        };
        for claim in due
            .iter()
            .filter_map(|project_id| Running::claim(&self.inner, project_id))
            .take(free)
        {
            let service = self.clone();
            running.spawn(async move { service.sync_project(claim).await });
        }
    }

    /// Syncs every source that is due and returns how many ran. Exposed for
    /// deterministic tests.
    #[doc(hidden)]
    pub async fn sync_due(&self) -> usize {
        let due = match self.due_projects().await {
            Ok(due) => due,
            Err(error) => {
                tracing::warn!(%error, "could not list knowledge sources to sync");
                return 0;
            }
        };
        let mut finished = 0;
        for project_id in due {
            if let Some(claim) = Running::claim(&self.inner, &project_id) {
                self.sync_project(claim).await;
                finished += 1;
            }
        }
        finished
    }

    async fn due_projects(&self) -> AppResult<Vec<String>> {
        let now = unix_now()?;
        self.inner
            .db
            .run(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT project_id FROM knowledge_sources
                     WHERE requested_at IS NOT NULL OR attempted_at IS NULL
                        OR (state='failed' AND attempted_at<=?1-?3)
                        OR (state<>'failed' AND attempted_at<=?1-?2)
                     ORDER BY requested_at IS NULL, attempted_at, project_id LIMIT 64",
                )?;
                let projects = statement
                    .query_map(
                        params![now, CHECK_INTERVAL_SECONDS, RETRY_INTERVAL_SECONDS],
                        |row| row.get(0),
                    )?
                    .collect::<Result<Vec<String>, _>>()?;
                Ok(projects)
            })
            .await
    }

    async fn sync_project(&self, claim: Running) {
        let project_id = claim.project_id.clone();
        let started = match unix_now() {
            Ok(now) => now,
            Err(error) => {
                tracing::warn!(%error, "clock unavailable; knowledge sync skipped");
                return;
            }
        };
        let due = match self.load_due(&project_id).await {
            Ok(Some(due)) => due,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, project_id, "could not read the knowledge source");
                return;
            }
        };
        let generation = due.generation.clone();
        // Dropping a stopped download ends git and removes its working copy.
        let result = tokio::select! {
            biased;
            () = claim.stop.cancelled() => {
                tracing::info!(project_id, "knowledge sync stopped; the source changed");
                return;
            }
            result = self.fetch(&project_id, due) => result,
        };
        if let Err(error) = &result {
            tracing::warn!(
                project_id,
                reason = error.failure.code(),
                detail = %error.detail,
                "knowledge sync failed"
            );
        }
        if let Err(error) = self
            .record(project_id.clone(), generation, started, result)
            .await
        {
            tracing::warn!(%error, project_id, "could not store the knowledge sync result");
        }
    }

    async fn load_due(&self, project_id: &str) -> AppResult<Option<Due>> {
        let project_id = project_id.to_owned();
        self.inner
            .db
            .run(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT s.url,s.branch,s.folder,s.token_ciphertext,k.private_key_ciphertext,
                                s.commit_id,s.generation
                         FROM knowledge_sources s
                         LEFT JOIN knowledge_deploy_keys k ON k.project_id=s.project_id
                         WHERE s.project_id=?1",
                        [&project_id],
                        |row| {
                            Ok(Due {
                                url: row.get(0)?,
                                branch: row.get(1)?,
                                folder: row.get(2)?,
                                token_ciphertext: row.get(3)?,
                                deploy_key_ciphertext: row.get(4)?,
                                commit: row.get(5)?,
                                generation: row.get(6)?,
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    async fn fetch(&self, project_id: &str, due: Due) -> Result<Fetched, SyncError> {
        let url = GitUrl::parse(&due.url, self.inner.allow_file)
            .map_err(|error| SyncError::new(Failure::Failed, error.to_string()))?;
        let credentials = self.credentials(project_id, &url, &due)?;
        let git = &self.inner.git;
        let head = git.remote_head(&url, &due.branch, &credentials).await?;
        if due.commit.as_deref() == Some(head.as_str()) {
            return Ok(Fetched::Unchanged);
        }
        self.require_space()?;
        let depth = if due.commit.is_none() {
            FIRST_HISTORY_DEPTH
        } else {
            HISTORY_DEPTH
        };
        let snapshot = git
            .snapshot(
                &url,
                &due.branch,
                &due.folder,
                &credentials,
                self.inner.limits,
                depth,
            )
            .await?;
        Ok(Fetched::Changed(snapshot))
    }

    fn credentials(
        &self,
        project_id: &str,
        url: &GitUrl,
        due: &Due,
    ) -> Result<Credentials, SyncError> {
        let unavailable = || {
            SyncError::new(
                Failure::CredentialsUnavailable,
                "saved credentials cannot be decrypted",
            )
        };
        let sealed = match url.transport() {
            Transport::Https => due.token_ciphertext.as_deref(),
            Transport::Ssh => Some(
                due.deploy_key_ciphertext
                    .as_deref()
                    .ok_or_else(unavailable)?,
            ),
            Transport::File => None,
        };
        let Some(sealed) = sealed else {
            return Ok(Credentials::None);
        };
        let secrets = self
            .inner
            .secrets()
            .map_err(|error| SyncError::new(Failure::CredentialsUnavailable, error.to_string()))?;
        let purpose = if url.transport() == Transport::Ssh {
            Purpose::DeployKey
        } else {
            Purpose::Token
        };
        let plain = secrets
            .open(purpose, project_id, sealed)
            .ok_or_else(unavailable)?;
        let text = Zeroizing::new(String::from_utf8(plain.to_vec()).map_err(|_| unavailable())?);
        Ok(match purpose {
            Purpose::DeployKey => Credentials::DeployKey(text),
            Purpose::Token => Credentials::Token {
                username: url.username().unwrap_or("oneloop").to_owned(),
                token: text,
            },
        })
    }

    /// A sync briefly holds the folder twice, in its working copy and in the
    /// database, on top of the configured free-space reserve.
    fn require_space(&self) -> Result<(), SyncError> {
        let available = fs4::available_space(self.inner.db.layout().root()).map_err(|error| {
            SyncError::new(Failure::Failed, format!("check free space: {error}"))
        })?;
        let limits = self.inner.limits;
        let needed = self
            .inner
            .disk_min_free_bytes
            .saturating_add(limits.max_download_bytes)
            .saturating_add(limits.max_total_bytes);
        if available < needed {
            return Err(SyncError::new(
                Failure::StorageFull,
                format!("{available} bytes free; {needed} needed"),
            ));
        }
        Ok(())
    }

    /// Store the outcome unless an administrator changed, disconnected or
    /// reconnected the source meanwhile; that change already asked for another
    /// sync.
    async fn record(
        &self,
        project_id: String,
        generation: String,
        started: i64,
        result: Result<Fetched, SyncError>,
    ) -> AppResult<()> {
        self.inner
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let current: Option<(String, i64, String, Option<String>)> = tx
                    .query_row(
                        "SELECT generation,revision,state,error_code FROM knowledge_sources
                         WHERE project_id=?1",
                        [&project_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let Some((current_generation, revision, state, error_code)) = current else {
                    return Ok(());
                };
                if current_generation != generation {
                    return Ok(());
                }
                // A request made while this sync ran gets a sync of its own.
                let finished = "attempted_at=?2,
                     requested_at=CASE WHEN requested_at<=?3 THEN NULL ELSE requested_at END";
                let (event, metadata) = match result {
                    Ok(Fetched::Unchanged) => {
                        tx.execute(
                            &format!(
                                "UPDATE knowledge_sources SET state='ready',checked_at=?2,error_code=NULL,
                                 {finished} WHERE project_id=?1"
                            ),
                            params![project_id, now, started],
                        )?;
                        if state == "ready" {
                            return Ok(());
                        }
                        ("knowledge.synced", json!({}))
                    }
                    Ok(Fetched::Changed(snapshot)) => {
                        let count = store_files(tx, &project_id, &snapshot)?;
                        tx.execute(
                            &format!(
                                "UPDATE knowledge_sources SET state='ready',checked_at=?2,error_code=NULL,
                                 commit_id=?4,skipped_files=?5,{finished} WHERE project_id=?1"
                            ),
                            params![project_id, now, started, snapshot.commit, snapshot.skipped as i64],
                        )?;
                        (
                            "knowledge.synced",
                            json!({
                                "commit": snapshot.commit.get(..12).unwrap_or(&snapshot.commit),
                                "files": count,
                                "skippedFiles": snapshot.skipped,
                            }),
                        )
                    }
                    Err(error) => {
                        let code = error.failure.code();
                        tx.execute(
                            &format!(
                                "UPDATE knowledge_sources SET state='failed',error_code=?4,{finished}
                                 WHERE project_id=?1"
                            ),
                            params![project_id, now, started, code],
                        )?;
                        if state == "failed" && error_code.as_deref() == Some(code) {
                            return Ok(());
                        }
                        ("knowledge.sync_failed", json!({"reason": code}))
                    }
                };
                record_system_activity_tx(
                    tx,
                    ActivityInput {
                        project_id: Some(&project_id),
                        entity_type: "knowledge_source",
                        entity_id: &project_id,
                        task_id: None,
                        event_type: event,
                        field_key: None,
                        before: None,
                        after: None,
                        metadata,
                        entity_revision: Some(revision),
                    },
                    now,
                )?;
                Ok(())
            })
            .await
    }
}

/// Replace the stored files with the snapshot's, rewriting only files whose
/// content changed. An unchanged file keeps its date.
fn store_files(
    tx: &rusqlite::Transaction<'_>,
    project_id: &str,
    snapshot: &Snapshot,
) -> AppResult<usize> {
    let stored: HashMap<String, String> = {
        let mut statement =
            tx.prepare("SELECT path,checksum FROM knowledge_files WHERE project_id=?1")?;
        statement
            .query_map([project_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    let mut kept = HashSet::with_capacity(snapshot.files.len());
    for file in &snapshot.files {
        kept.insert(file.path.as_str());
        let checksum = hex::encode(Sha256::digest(&file.content));
        if stored.get(&file.path) == Some(&checksum) {
            continue;
        }
        let (media_type, kind) = crate::files::classify_bytes(&file.path, &file.content);
        tx.execute(
            "INSERT OR REPLACE INTO knowledge_files
             (project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                project_id,
                file.path,
                file.content.len() as i64,
                media_type,
                kind.map(|kind| kind.as_str()),
                checksum,
                file.changed_at.unwrap_or(snapshot.committed_at),
                file.content,
            ],
        )?;
    }
    for path in stored.keys().filter(|path| !kept.contains(path.as_str())) {
        tx.execute(
            "DELETE FROM knowledge_files WHERE project_id=?1 AND path=?2",
            params![project_id, path],
        )?;
    }
    Ok(snapshot.files.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Db,
        auth::{Actor, ActorSource},
        knowledge::{KnowledgeCommand, git::SnapshotFile},
    };
    use serde_json::Value;
    use tokio::io::AsyncReadExt;

    /// A project `p1` whose source points at `url`, and an administrator.
    async fn fixture(url: &str) -> (tempfile::TempDir, Db, KnowledgeService) {
        let root = tempfile::tempdir_in("target").unwrap();
        crate::db::migrate(root.path(), None).unwrap();
        let db = Db::open(root.path()).unwrap();
        let url = url.to_owned();
        db.run(move |connection| {
            connection.execute_batch(
                "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p1','One','ONE',1,1);
                 INSERT INTO users(id,username,display_name,password_hash,is_admin,password_changed_at,created_at,updated_at)
                 VALUES('admin','admin','Admin','hash',1,1,1,1);
                 INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                 VALUES('session','admin','token',1,1,1,9999999999,9999999999);",
            )?;
            connection.execute(
                "INSERT INTO knowledge_sources(project_id,url,branch,folder,state,requested_at,created_at,updated_at,generation)
                 VALUES('p1',?1,'main','docs','pending',1,1,1,'current')",
                [url],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let service = KnowledgeService::new(db.clone(), 0);
        (root, db, service)
    }

    async fn stored(db: &Db) -> (i64, String, Option<i64>) {
        db.run(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT count(*) FROM knowledge_files),state,attempted_at FROM knowledge_sources",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .await
        .unwrap()
    }

    fn snapshot() -> Fetched {
        Fetched::Changed(Snapshot {
            commit: "a".repeat(40),
            committed_at: 100,
            files: vec![SnapshotFile {
                path: "README.md".to_owned(),
                changed_at: None,
                content: b"# Old folder".to_vec(),
            }],
            skipped: 0,
        })
    }

    fn command(operation: &str, payload: Value, revision: Option<i64>) -> KnowledgeCommand {
        KnowledgeCommand {
            operation: operation.to_owned(),
            payload,
            idempotency_key: uuid::Uuid::now_v7().to_string(),
            expected_revision: revision,
        }
    }

    #[tokio::test]
    async fn a_sync_result_for_an_earlier_connection_is_dropped() {
        let (_root, db, service) = fixture("https://git.example.test/docs.git").await;

        // Disconnect and connect again keep the revision but not the generation.
        service
            .record("p1".to_owned(), "earlier".to_owned(), 1, Ok(snapshot()))
            .await
            .unwrap();
        assert_eq!(stored(&db).await.0, 0);

        service
            .record("p1".to_owned(), "current".to_owned(), 1, Ok(snapshot()))
            .await
            .unwrap();
        assert_eq!(stored(&db).await.0, 1);
    }

    #[tokio::test]
    async fn a_stopped_sync_ends_git_records_nothing_and_frees_the_project() {
        // A host that accepts the connection and never answers.
        let host = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = host.local_addr().unwrap().port();
        let (_root, db, service) = fixture(&format!("https://127.0.0.1:{port}/docs.git")).await;
        let claim = Running::claim(&service.inner, "p1").unwrap();
        let sync = tokio::spawn({
            let service = service.clone();
            async move { service.sync_project(claim).await }
        });
        let (mut git, _) = host.accept().await.unwrap();

        service.inner.stop_sync("p1");
        sync.await.unwrap();
        // The connection closes once git is gone.
        let _ = git.read_to_end(&mut Vec::new()).await;
        assert_eq!(stored(&db).await, (0, "pending".to_owned(), None));
        assert!(Running::claim(&service.inner, "p1").is_some());
    }

    #[tokio::test]
    async fn changes_and_disconnects_stop_the_running_sync() {
        let (_root, _db, service) = fixture("https://git.example.test/docs.git").await;
        let admin = Actor {
            user_id: "admin".into(),
            username: "admin".into(),
            display_name: "Admin".into(),
            is_admin: true,
            must_change_password: false,
            authenticated_at: 1,
            source: ActorSource::BrowserSession {
                session_id: "session".into(),
            },
        };
        let project = serde_json::json!({"projectId": "p1"});
        let claim = Running::claim(&service.inner, "p1").unwrap();
        service
            .execute(&admin, command("knowledge.sync", project.clone(), None))
            .await
            .unwrap();
        assert!(!claim.stop.is_cancelled(), "a retry lets the sync finish");

        let folder = serde_json::json!({"projectId": "p1", "url": "https://git.example.test/docs.git",
            "branch": "main", "folder": "guides", "tokenAction": "keep"});
        service
            .execute(&admin, command("knowledge.update", folder, Some(1)))
            .await
            .unwrap();
        assert!(claim.stop.is_cancelled(), "a change stops it");
        drop(claim);

        let claim = Running::claim(&service.inner, "p1").unwrap();
        service
            .execute(&admin, command("knowledge.disconnect", project, Some(2)))
            .await
            .unwrap();
        assert!(claim.stop.is_cancelled(), "a disconnect stops it");
    }
}
