const INBOX_PURGE_INTERVAL_SECONDS: i64 = 60 * 60;

use crate::clock::unix_now;
use std::{collections::BTreeSet, sync::Arc};

use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use tokio::{
    sync::{Semaphore, SemaphorePermit, broadcast, watch},
    task::JoinHandle,
    time::{Duration, sleep},
};
use uuid::Uuid;

use crate::{AppError, AppResult, Db};

use super::{CollaborationService, SseHint};

const CLAIM_SECONDS: i64 = 30;
const IDLE_POLL: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct CollaborationRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    db: Db,
    hints: broadcast::Sender<Arc<SseHint>>,
    authorization: Semaphore,
    shutdown: watch::Sender<bool>,
}

impl CollaborationRuntime {
    pub fn new(db: Db) -> Self {
        let (hints, _) = broadcast::channel(512);
        let (shutdown, _) = watch::channel(false);
        Self {
            inner: Arc::new(RuntimeInner {
                db,
                hints,
                authorization: Semaphore::new(2),
                shutdown,
            }),
        }
    }

    pub fn db(&self) -> &Db {
        &self.inner.db
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<SseHint>> {
        self.inner.hints.subscribe()
    }

    /// SSE checks queue here before entering the shared database admission pool.
    /// No authorization result is cached between deliveries.
    pub async fn authorization_permit(&self) -> SemaphorePermit<'_> {
        self.inner
            .authorization
            .acquire()
            .await
            .expect("SSE authorization lane stays open")
    }

    #[doc(hidden)]
    pub fn receiver_count(&self) -> usize {
        self.inner.hints.receiver_count()
    }

    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.inner.shutdown.subscribe()
    }

    /// Stops live streams and background work. Safe to call more than once.
    pub fn shutdown(&self) {
        let _ = self.inner.shutdown.send_replace(true);
    }

    pub fn worker(&self) -> OutboxWorker {
        OutboxWorker {
            runtime: self.clone(),
            worker_id: Uuid::now_v7().to_string(),
        }
    }

    pub fn spawn_worker(&self, shutdown: watch::Receiver<bool>) -> JoinHandle<AppResult<()>> {
        let worker = self.worker();
        tokio::spawn(async move { worker.run(shutdown).await })
    }
}

#[derive(Clone)]
pub struct OutboxWorker {
    runtime: CollaborationRuntime,
    worker_id: String,
}

impl OutboxWorker {
    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) -> AppResult<()> {
        let mut runtime_shutdown = self.runtime.shutdown_receiver();
        let mut next_purge = 0_i64;
        let mut next_optimize = 0_i64;
        let mut next_retention = 0_i64;
        let mut next_throttle_prune = 0_i64;
        loop {
            if *shutdown.borrow() || *runtime_shutdown.borrow() {
                return Ok(());
            }
            let now = match unix_now() {
                Ok(now) => now,
                Err(error) => {
                    tracing::warn!(%error, "clock unavailable; retrying in one minute");
                    tokio::select! {
                        _ = sleep(Duration::from_secs(60)) => {},
                        _ = shutdown.changed() => {},
                        _ = runtime_shutdown.changed() => {},
                    }
                    continue;
                }
            };
            if now >= next_throttle_prune {
                if let Err(error) =
                    crate::retention::prune_login_throttles(self.runtime.db(), now).await
                {
                    tracing::warn!(%error, "login throttle cleanup failed; retrying in one minute");
                }
                next_throttle_prune = now.saturating_add(60);
            }
            if now >= next_retention {
                next_retention = match crate::retention::prune_transient_state(
                    self.runtime.db(),
                    now,
                )
                .await
                {
                    Ok(false) => now.saturating_add(3600),
                    Ok(true) => now.saturating_add(60),
                    Err(error) => {
                        tracing::warn!(%error, "transient state cleanup failed; retrying in one minute");
                        now.saturating_add(60)
                    }
                };
            }
            if now >= next_optimize {
                match self
                    .runtime
                    .db()
                    .run(|connection| {
                        connection.execute_batch("PRAGMA optimize;")?;
                        Ok(())
                    })
                    .await
                {
                    Ok(()) => next_optimize = now.saturating_add(60 * 60),
                    Err(error) => {
                        tracing::warn!(error = %error, "query planner maintenance failed; retrying in one minute");
                        next_optimize = now.saturating_add(60);
                    }
                }
            }
            if now >= next_purge {
                match CollaborationService::new(self.runtime.db().clone())
                    .purge_archived(now)
                    .await
                {
                    Ok(_) => next_purge = now.saturating_add(INBOX_PURGE_INTERVAL_SECONDS),
                    Err(error) => {
                        tracing::warn!(error = %error, "archive purge failed; retrying in one minute");
                        next_purge = now.saturating_add(60);
                    }
                }
            }
            match self.run_once().await {
                Ok(true) => continue,
                Ok(false) => tokio::select! {
                    _ = self.runtime.db().wait_for_changes() => {},
                    _ = sleep(IDLE_POLL) => {},
                    result = shutdown.changed() => {
                        if result.is_err() || *shutdown.borrow() { return Ok(()); }
                    },
                    result = runtime_shutdown.changed() => {
                        if result.is_err() || *runtime_shutdown.borrow() { return Ok(()); }
                    }
                },
                Err(error) => {
                    tracing::error!(error = %error, "collaboration outbox delivery failed");
                    sleep(IDLE_POLL).await;
                }
            }
        }
    }

    /// Delivers at most one outbox record. Exposed for deterministic tests and
    /// service supervisors that prefer their own scheduling loop.
    pub async fn run_once(&self) -> AppResult<bool> {
        let now = unix_now()?;
        // A WAL read does not compete for the serialized writer while idle.
        // The claim transaction rechecks readiness to handle competing workers.
        let ready = self.runtime.db().run(move |connection| {
            Ok(connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM outbox_messages
                 WHERE delivered_at IS NULL AND available_at<=?1
                   AND topic IN ('notification.created','domain.activity','inbox.state_changed','access.changed')
                   AND (locked_at IS NULL OR locked_at<=?2))")?.query_row(
                params![now, now - CLAIM_SECONDS], |row| row.get::<_, bool>(0),
            )?)
        }).await?;
        if !ready {
            return Ok(false);
        }
        let worker_id = self.worker_id.clone();
        let claimed = self
            .runtime
            .db()
            .delivery_transaction(move |tx| {
                let candidate: Option<ClaimedMessage> = tx.prepare_cached("SELECT id,topic,aggregate_type,aggregate_id,payload_json,attempt_count
                 FROM outbox_messages
                 WHERE delivered_at IS NULL AND available_at<=?1
                   AND topic IN ('notification.created','domain.activity','inbox.state_changed','access.changed')
                   AND (locked_at IS NULL OR locked_at<=?2)
                 ORDER BY available_at,id LIMIT 1")?.query_row(
                        params![now, now - CLAIM_SECONDS],
                        |row| {
                            Ok(ClaimedMessage {
                                id: row.get(0)?,
                                topic: row.get(1)?,
                                aggregate_type: row.get(2)?,
                                aggregate_id: row.get(3)?,
                                payload_json: row.get(4)?,
                                attempt_count: row.get(5)?,
                            })
                        },
                    )
                    .optional()?;
                let Some(message) = candidate else {
                    return Ok(None);
                };
                let changed = tx.prepare_cached("UPDATE outbox_messages SET locked_at=?1,locked_by=?2
                 WHERE id=?3 AND delivered_at IS NULL AND (locked_at IS NULL OR locked_at<=?4)")?.execute(
                    params![now, worker_id, message.id, now - CLAIM_SECONDS],
                )?;
                Ok((changed == 1).then_some(message))
            })
            .await?;
        let Some(message) = claimed else {
            return Ok(false);
        };

        let delivery = self.deliver(&message, now).await;
        match delivery {
            Ok(hint) => {
                if let Some(hint) = hint {
                    let _ = self.runtime.inner.hints.send(Arc::new(hint));
                }
                Ok(true)
            }
            Err(error) => {
                let id = message.id.clone();
                let worker_id = self.worker_id.clone();
                let detail = safe_error(&error);
                let attempt = message.attempt_count.saturating_add(1);
                let backoff = 2_i64.saturating_pow(attempt.min(8) as u32).min(300);
                self.runtime.db().transaction(move |connection| {
                    connection.execute(
                        "UPDATE outbox_messages
                         SET attempt_count=?1,available_at=?2,locked_at=NULL,locked_by=NULL,last_error=?3
                         WHERE id=?4 AND locked_by=?5 AND delivered_at IS NULL",
                        params![attempt, now + backoff, detail, id, worker_id],
                    )?;
                    Ok(())
                }).await?;
                Err(error)
            }
        }
    }

    async fn deliver(&self, message: &ClaimedMessage, now: i64) -> AppResult<Option<SseHint>> {
        let message = message.clone();
        let worker_id = self.worker_id.clone();
        self.runtime.db().delivery_transaction(move |tx| {
            let owns_claim: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox_messages
                 WHERE id=?1 AND locked_by=?2 AND delivered_at IS NULL)",
                params![message.id, worker_id], |row| row.get(0),
            )?;
            if !owns_claim { return Ok(None); }
            let hint = match message.topic.as_str() {
                "notification.created" => deliver_notification(tx, &message, now)?,
                "domain.activity" => deliver_activity(tx, &message)?,
                "inbox.state_changed" => deliver_inbox_change(tx, &message)?,
                "access.changed" => Some(SseHint {
                    id: message.id.clone(), kind: "access.changed".into(),
                    project_id: None, task_id: None, entity_type: None, entity_id: None,
                    entity_revision: None, notification_id: None,
                    recipient_ids: BTreeSet::from([message.aggregate_id.clone()]),
                }),
                _ => None,
            };
            tx.execute(
                "UPDATE outbox_messages SET delivered_at=?1,locked_at=NULL,locked_by=NULL,last_error=NULL
                 WHERE id=?2 AND locked_by=?3 AND delivered_at IS NULL",
                params![now, message.id, worker_id],
            )?;
            Ok(hint)
        }).await
    }
}

fn deliver_inbox_change(
    tx: &rusqlite::Transaction<'_>,
    message: &ClaimedMessage,
) -> AppResult<Option<SseHint>> {
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND is_active=1)",
        [&message.aggregate_id],
        |row| row.get(0),
    )?;
    Ok(active.then(|| SseHint {
        id: message.id.clone(),
        kind: "inbox.changed".into(),
        project_id: None,
        task_id: None,
        entity_type: Some("inbox".into()),
        entity_id: None,
        entity_revision: None,
        notification_id: None,
        recipient_ids: BTreeSet::from([message.aggregate_id.clone()]),
    }))
}

#[derive(Clone)]
struct ClaimedMessage {
    id: String,
    topic: String,
    aggregate_type: String,
    aggregate_id: String,
    payload_json: String,
    attempt_count: i64,
}

fn deliver_notification(
    tx: &rusqlite::Transaction<'_>,
    message: &ClaimedMessage,
    now: i64,
) -> AppResult<Option<SseHint>> {
    let project_id: Option<String> = tx
        .query_row(
            "SELECT project_id FROM notification_events WHERE id=?1",
            [&message.aggregate_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let mut statement = tx.prepare(
        "SELECT r.user_id FROM notification_recipients r JOIN users u ON u.id=r.user_id
         WHERE r.notification_id=?1 AND r.delivered_at IS NULL AND u.is_active=1
           AND (u.is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships m
                WHERE m.user_id=u.id AND m.project_id=?2))",
    )?;
    let recipients: BTreeSet<String> = statement
        .query_map(params![message.aggregate_id, project_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    drop(statement);
    for user_id in &recipients {
        tx.execute(
            "UPDATE notification_recipients SET delivered_at=?1
             WHERE notification_id=?2 AND user_id=?3 AND delivered_at IS NULL",
            params![now, message.aggregate_id, user_id],
        )?;
    }
    Ok((!recipients.is_empty()).then(|| SseHint {
        id: message.id.clone(),
        kind: "inbox.changed".into(),
        project_id: Some(project_id),
        task_id: None,
        entity_type: Some(message.aggregate_type.clone()),
        entity_id: Some(message.aggregate_id.clone()),
        entity_revision: None,
        notification_id: Some(message.aggregate_id.clone()),
        recipient_ids: recipients,
    }))
}

fn deliver_activity(
    tx: &rusqlite::Transaction<'_>,
    message: &ClaimedMessage,
) -> AppResult<Option<SseHint>> {
    let payload: Value = serde_json::from_str(&message.payload_json)
        .map(crate::legacy_values::payload)
        .map_err(|error| AppError::internal(format!("invalid activity outbox payload: {error}")))?;
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let private_owner = (payload.get("visibility").and_then(Value::as_str) == Some("owner"))
        .then(|| payload.get("ownerUserId").and_then(Value::as_str))
        .flatten();
    let recipients = if let Some(owner_id) = private_owner {
        let Some(project_id) = project_id.as_deref() else {
            return Err(AppError::internal(
                "private activity has no project context",
            ));
        };
        let allowed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=?1 AND u.is_active=1 AND
              (u.is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships m
               WHERE m.user_id=u.id AND m.project_id=?2)))",
            params![owner_id, project_id],
            |row| row.get(0),
        )?;
        if allowed {
            BTreeSet::from([owner_id.to_owned()])
        } else {
            BTreeSet::new()
        }
    } else if payload.get("visibility").and_then(Value::as_str) == Some("owner") {
        BTreeSet::new()
    } else if let Some(project_id) = project_id.as_deref() {
        let mut statement = tx.prepare(
            "SELECT u.id FROM users u WHERE u.is_active=1 AND
              (u.is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships m
               WHERE m.user_id=u.id AND m.project_id=?1))",
        )?;
        statement
            .query_map([project_id], |row| row.get(0))?
            .collect::<Result<BTreeSet<String>, _>>()?
    } else {
        let actor_id = payload
            .get("actorUserId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::internal("activity outbox payload has no recipient context")
            })?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND is_active=1)",
            [actor_id],
            |row| row.get(0),
        )?;
        if active {
            BTreeSet::from([actor_id.to_owned()])
        } else {
            BTreeSet::new()
        }
    };
    Ok((!recipients.is_empty()).then(|| SseHint {
        id: message.id.clone(),
        kind: "activity.changed".into(),
        project_id,
        task_id: payload
            .get("taskId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        entity_type: payload
            .get("entityType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        entity_id: payload
            .get("entityId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        entity_revision: payload.get("entityRevision").and_then(Value::as_i64),
        notification_id: None,
        recipient_ids: recipients,
    }))
}

fn safe_error(error: &AppError) -> String {
    let text = error.to_string();
    text.chars().take(500).collect()
}

/// Durable, content-free invalidation addressed to the affected account, even
/// after it loses project access or becomes inactive. Never includes snapshots.
pub(crate) fn enqueue_access_change_tx(
    tx: &rusqlite::Transaction<'_>,
    user_id: &str,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO outbox_messages
        (id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
        VALUES (?1,'access.changed','user',?2,'{}',?3,?3)",
        params![Uuid::now_v7().to_string(), user_id, now],
    )?;
    Ok(())
}
