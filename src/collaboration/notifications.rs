use std::collections::BTreeSet;

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppError, AppResult,
    auth::{Actor, ActorSource},
};

#[derive(Clone, Debug)]
pub struct NotificationInput<'a> {
    pub project_id: &'a str,
    pub event_type: &'a str,
    pub task_id: Option<&'a str>,
    pub comment_id: Option<&'a str>,
    pub block_id: Option<&'a str>,
    pub excerpt: Option<&'a str>,
    pub payload: Value,
}

pub fn snapshot_notification_tx(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: NotificationInput<'_>,
    recipient_ids: impl IntoIterator<Item = String>,
    now: i64,
) -> AppResult<Option<String>> {
    let requested: BTreeSet<_> = recipient_ids
        .into_iter()
        .filter(|user_id| user_id != &actor.user_id)
        .collect();
    let is_broadcast = input
        .payload
        .get("broadcast")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if requested.is_empty() && !is_broadcast {
        return Ok(None);
    }
    let project_name: String = tx
        .query_row(
            "SELECT name FROM projects WHERE id=?1 AND deleted_at IS NULL",
            [input.project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "project",
        })?;
    let (task_key, task_title) = match input.task_id {
        Some(task_id) => tx
            .query_row(
                "SELECT task_key,title FROM tasks
                 WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL",
                params![task_id, input.project_id],
                |row| {
                    Ok((
                        Some(row.get::<_, String>(0)?),
                        Some(row.get::<_, String>(1)?),
                    ))
                },
            )
            .optional()?
            .ok_or(AppError::NotFound { resource: "task" })?,
        None => (None, None),
    };
    let eligible = eligible_recipients(tx, input.project_id, requested)?;
    if eligible.is_empty() && !is_broadcast {
        return Ok(None);
    }
    let notification_id = Uuid::now_v7().to_string();
    let grant_id = match &actor.source {
        ActorSource::McpGrant { grant_id } => Some(grant_id.as_str()),
        ActorSource::BrowserSession { .. } => None,
    };
    tx.execute(
        "INSERT INTO notification_events
         (id,project_id,actor_user_id,actor_mcp_grant_id,event_type,task_id,comment_id,block_id,payload_json,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            notification_id,
            input.project_id,
            actor.user_id,
            grant_id,
            input.event_type,
            input.task_id,
            input.comment_id,
            input.block_id,
            input.payload.to_string(),
            now,
        ],
    )?;
    for user_id in &eligible {
        tx.execute(
            "INSERT INTO notification_recipients
             (notification_id,user_id,project_name_snapshot,task_key_snapshot,task_title_snapshot,
              actor_name_snapshot,excerpt_snapshot)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                notification_id,
                user_id,
                project_name,
                task_key,
                task_title,
                actor.display_name,
                input.excerpt,
            ],
        )?;
    }
    if !eligible.is_empty() {
        let outbox_id = Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO outbox_messages
             (id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
             VALUES (?1,'notification.created','notification',?2,?3,?4,?4)",
            params![
                outbox_id,
                notification_id,
                json!({"notificationId": notification_id}).to_string(),
                now
            ],
        )?;
    }
    Ok(Some(notification_id))
}

fn eligible_recipients(
    tx: &Transaction<'_>,
    project_id: &str,
    requested: BTreeSet<String>,
) -> AppResult<Vec<String>> {
    let mut eligible = Vec::with_capacity(requested.len());
    for user_id in requested {
        let allowed: bool = tx.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM users u
               WHERE u.id=?1 AND u.is_active=1 AND
                 (u.is_admin=1 OR EXISTS(
                    SELECT 1 FROM project_memberships m
                    WHERE m.user_id=u.id AND m.project_id=?2
                 ))
             )",
            params![user_id, project_id],
            |row| row.get(0),
        )?;
        if allowed {
            eligible.push(user_id);
        }
    }
    Ok(eligible)
}
