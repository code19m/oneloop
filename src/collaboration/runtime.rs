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

/// Leases from versions that claimed messages before delivering them.
const CLAIM_SECONDS: i64 = 30;
/// One delivery transaction takes at most this many messages, and stops
/// taking more after `BATCH_TIME`, so it holds the writer only briefly.
const BATCH_MESSAGES: usize = 64;
const BATCH_TIME: std::time::Duration = std::time::Duration::from_millis(10);
/// Writes in this process wake the worker at once. This interval only finds
/// messages from other processes, such as `oneloop user passwd`, and retries.
const LONGEST_IDLE: Duration = Duration::from_secs(5);
const SHORTEST_IDLE: Duration = Duration::from_secs(1);
const FIRST_ERROR_PAUSE: Duration = Duration::from_millis(500);
const DELIVERABLE_TOPICS: &str =
    "'notification.created','domain.activity','inbox.state_changed','access.changed'";

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
}

impl OutboxWorker {
    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) -> AppResult<()> {
        let mut runtime_shutdown = self.runtime.shutdown_receiver();
        let mut next_purge = 0_i64;
        let mut next_optimize = 0_i64;
        let mut next_retention = 0_i64;
        let mut next_throttle_prune = 0_i64;
        let mut error_pause = FIRST_ERROR_PAUSE;
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
                Ok(true) => {
                    error_pause = FIRST_ERROR_PAUSE;
                    continue;
                }
                Ok(false) => {
                    error_pause = FIRST_ERROR_PAUSE;
                    let wait = match self.next_available().await {
                        Ok(earliest) => idle_wait(earliest, unix_now().unwrap_or(now)),
                        Err(_) => LONGEST_IDLE,
                    };
                    tokio::select! {
                        _ = self.runtime.db().wait_for_changes() => {},
                        _ = sleep(wait) => {},
                        result = shutdown.changed() => {
                            if result.is_err() || *shutdown.borrow() { return Ok(()); }
                        },
                        result = runtime_shutdown.changed() => {
                            if result.is_err() || *runtime_shutdown.borrow() { return Ok(()); }
                        }
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "collaboration outbox delivery failed");
                    sleep(error_pause).await;
                    error_pause = (error_pause * 2).min(LONGEST_IDLE);
                }
            }
        }
    }

    /// Delivers the outbox messages that are ready, oldest first, in one
    /// transaction (see `BATCH_MESSAGES`), then sends one hint for each, in
    /// the same order. A message that fails rolls back alone and is retried
    /// later with a backoff. Returns whether anything was delivered; when
    /// nothing was and a message failed, returns that failure. Exposed for
    /// deterministic tests and service supervisors that prefer their own
    /// scheduling loop.
    pub async fn run_once(&self) -> AppResult<bool> {
        let now = unix_now()?;
        // A WAL read does not compete for the serialized writer while idle.
        let ready = self
            .runtime
            .db()
            .run(move |connection| {
                Ok(connection
                    .prepare_cached(&format!(
                        "SELECT EXISTS(SELECT 1 FROM outbox_messages
                 WHERE delivered_at IS NULL AND available_at<=?1
                   AND topic IN ({DELIVERABLE_TOPICS})
                   AND (locked_at IS NULL OR locked_at<=?2))"
                    ))?
                    .query_row(params![now, now - CLAIM_SECONDS], |row| {
                        row.get::<_, bool>(0)
                    })?)
            })
            .await?;
        if !ready {
            return Ok(false);
        }
        // One writer transaction selects, delivers and marks the messages, so
        // concurrent workers can't deliver one twice.
        let batch = self
            .runtime
            .db()
            .delivery_transaction(move |tx| deliver_batch(tx, now))
            .await?;
        for hint in batch.hints {
            let _ = self.runtime.inner.hints.send(Arc::new(hint));
        }
        let mut failures = batch.failures.into_iter();
        if batch.delivered == 0
            && let Some(failure) = failures.next()
        {
            return Err(failure);
        }
        for failure in failures {
            tracing::error!(error = %failure, "collaboration outbox delivery failed");
        }
        Ok(batch.delivered > 0)
    }

    /// When the earliest undelivered message becomes ready, as a Unix time.
    async fn next_available(&self) -> AppResult<Option<i64>> {
        self.runtime
            .db()
            .run(move |connection| {
                Ok(connection
                    .prepare_cached(&format!(
                        "SELECT MIN(MAX(available_at,COALESCE(locked_at+{CLAIM_SECONDS},0)))
                         FROM outbox_messages
                         WHERE delivered_at IS NULL AND topic IN ({DELIVERABLE_TOPICS})"
                    ))?
                    .query_row([], |row| row.get(0))?)
            })
            .await
    }
}

/// How long an idle worker sleeps before it looks again: until the earliest
/// message is ready, from one to five seconds.
fn idle_wait(earliest: Option<i64>, now: i64) -> Duration {
    earliest.map_or(LONGEST_IDLE, |at| {
        Duration::from_secs(at.saturating_sub(now).max(0).unsigned_abs())
            .clamp(SHORTEST_IDLE, LONGEST_IDLE)
    })
}

struct Batch {
    delivered: usize,
    hints: Vec<SseHint>,
    failures: Vec<AppError>,
}

fn deliver_batch(tx: &rusqlite::Transaction<'_>, now: i64) -> AppResult<Batch> {
    let started = std::time::Instant::now();
    let messages = tx
        .prepare_cached(&format!(
            "SELECT id,topic,aggregate_type,aggregate_id,payload_json,attempt_count
             FROM outbox_messages
             WHERE delivered_at IS NULL AND available_at<=?1
               AND topic IN ({DELIVERABLE_TOPICS})
               AND (locked_at IS NULL OR locked_at<=?2)
             ORDER BY available_at,id LIMIT ?3"
        ))?
        .query_map(
            params![now, now - CLAIM_SECONDS, BATCH_MESSAGES as i64],
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
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut batch = Batch {
        delivered: 0,
        hints: Vec::new(),
        failures: Vec::new(),
    };
    for message in messages {
        if batch.delivered + batch.failures.len() > 0 && started.elapsed() >= BATCH_TIME {
            break;
        }
        tx.execute_batch("SAVEPOINT outbox_message")?;
        match deliver_message(tx, &message, now) {
            Ok(hint) => {
                tx.execute_batch("RELEASE outbox_message")?;
                batch.delivered += 1;
                batch.hints.extend(hint);
            }
            Err(error) => {
                tx.execute_batch("ROLLBACK TO outbox_message; RELEASE outbox_message")?;
                let attempt = message.attempt_count.saturating_add(1);
                let backoff = 2_i64.saturating_pow(attempt.min(8) as u32).min(300);
                tx.execute(
                    "UPDATE outbox_messages
                     SET attempt_count=?1,available_at=?2,locked_at=NULL,locked_by=NULL,last_error=?3
                     WHERE id=?4 AND delivered_at IS NULL",
                    params![attempt, now + backoff, safe_error(&error), message.id],
                )?;
                batch.failures.push(error);
            }
        }
    }
    Ok(batch)
}

fn deliver_message(
    tx: &rusqlite::Transaction<'_>,
    message: &ClaimedMessage,
    now: i64,
) -> AppResult<Option<SseHint>> {
    let hint = match message.topic.as_str() {
        "notification.created" => deliver_notification(tx, message, now)?,
        "domain.activity" => deliver_activity(tx, message)?,
        "inbox.state_changed" => deliver_inbox_change(tx, message)?,
        "access.changed" => Some(SseHint {
            id: message.id.clone(),
            kind: "access.changed".into(),
            project_id: None,
            task_id: None,
            entity_type: None,
            entity_id: None,
            entity_revision: None,
            notification_id: None,
            recipient_ids: BTreeSet::from([message.aggregate_id.clone()]),
        }),
        _ => None,
    };
    tx.execute(
        "UPDATE outbox_messages SET delivered_at=?1,locked_at=NULL,locked_by=NULL,last_error=NULL
         WHERE id=?2 AND delivered_at IS NULL",
        params![now, message.id],
    )?;
    Ok(hint)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_idle_worker_looks_again_when_the_next_message_is_due() {
        assert_eq!(idle_wait(None, 100), LONGEST_IDLE);
        assert_eq!(idle_wait(Some(103), 100), Duration::from_secs(3));
        assert_eq!(idle_wait(Some(400), 100), LONGEST_IDLE);
        for due in [99, 100] {
            assert_eq!(idle_wait(Some(due), 100), SHORTEST_IDLE);
        }
    }
}
