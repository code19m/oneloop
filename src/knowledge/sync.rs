//! The background sync. Each connected branch is checked every minute; when
//! it moved, a fresh copy of the folder replaces the stored files. A failed
//! sync keeps the last files readable and retries every five minutes, or at
//! once when an administrator asks.

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    sync::watch,
    task::{JoinHandle, JoinSet},
};
use zeroize::Zeroizing;

use crate::{
    AppResult,
    auth::unix_now,
    collaboration::{ActivityInput, record_system_activity_tx},
};

use super::{
    git::{Credentials, Failure, Snapshot, SyncError},
    secrets::Purpose,
    service::KnowledgeService,
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
    revision: i64,
}

enum Fetched {
    Unchanged,
    Changed(Snapshot),
}

/// Removes the project from the running set when its sync ends or is cancelled.
struct Running<'a> {
    service: &'a KnowledgeService,
    project_id: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.service
            .inner
            .syncing
            .lock()
            .expect("sync set lock")
            .remove(&self.project_id);
    }
}

impl KnowledgeService {
    /// Runs until shutdown. Commands wake the worker so a new connection or a
    /// retry starts at once.
    pub fn spawn_worker(&self, mut shutdown: watch::Receiver<bool>) -> JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.inner.git.clear_work_root() {
                tracing::warn!(%error, "could not remove old knowledge working copies");
            }
            loop {
                if *shutdown.borrow() {
                    break;
                }
                tokio::select! {
                    _ = service.sync_due() => {}
                    _ = shutdown.changed() => break,
                }
                tokio::select! {
                    _ = service.inner.wake.notified() => {}
                    _ = tokio::time::sleep(POLL) => {}
                    _ = shutdown.changed() => break,
                }
            }
        })
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
        let mut queue = due.into_iter();
        let mut running = JoinSet::new();
        let mut finished = 0;
        loop {
            while running.len() < CONCURRENT_SYNCS {
                let Some(project_id) = queue.next() else {
                    break;
                };
                let service = self.clone();
                running.spawn(async move { service.sync_project(project_id).await });
            }
            match running.join_next().await {
                Some(Ok(())) => finished += 1,
                Some(Err(error)) => tracing::error!(%error, "knowledge sync task failed"),
                None => break,
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

    async fn sync_project(&self, project_id: String) {
        if !self
            .inner
            .syncing
            .lock()
            .expect("sync set lock")
            .insert(project_id.clone())
        {
            return;
        }
        let _running = Running {
            service: self,
            project_id: project_id.clone(),
        };
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
        let revision = due.revision;
        let result = self.fetch(&project_id, due).await;
        if let Err(error) = &result {
            tracing::warn!(
                project_id,
                reason = error.failure.code(),
                detail = %error.detail,
                "knowledge sync failed"
            );
        }
        if let Err(error) = self
            .record(project_id.clone(), revision, started, result)
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
                                s.commit_id,s.revision
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
                                revision: row.get(6)?,
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
        let needed = self
            .inner
            .disk_min_free_bytes
            .saturating_add(self.inner.limits.max_total_bytes.saturating_mul(3));
        if available < needed {
            return Err(SyncError::new(
                Failure::StorageFull,
                format!("{available} bytes free; {needed} needed"),
            ));
        }
        Ok(())
    }

    /// Store the outcome unless an administrator changed the source meanwhile;
    /// that change already asked for another sync.
    async fn record(
        &self,
        project_id: String,
        revision: i64,
        started: i64,
        result: Result<Fetched, SyncError>,
    ) -> AppResult<()> {
        self.inner
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let current: Option<(i64, String, Option<String>)> = tx
                    .query_row(
                        "SELECT revision,state,error_code FROM knowledge_sources WHERE project_id=?1",
                        [&project_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((current_revision, state, error_code)) = current else {
                    return Ok(());
                };
                if current_revision != revision {
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
