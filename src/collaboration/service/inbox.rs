//! Inbox changes are account-owned and bounded by the same filters and private grants as reads.
use super::*;

pub(super) fn inbox_item_change(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: InboxItemCommand,
    change: InboxChange,
    now: i64,
) -> AppResult<Mutation> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notification_recipients r
         JOIN notification_events n ON n.id=r.notification_id
         WHERE r.notification_id=?1 AND r.user_id=?2 AND r.delivered_at IS NOT NULL
         AND (r.archived_at IS NULL OR r.archived_at>?4)
         AND (?3 IS NULL OR n.project_id IN
           (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?3)))",
        params![
            input.notification_id,
            actor.user_id,
            inbox_grant_id(actor),
            now.saturating_sub(ARCHIVE_RETENTION_SECONDS)
        ],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound {
            resource: "notification",
        });
    }
    let changed = match change {
        InboxChange::Read => {
            tx.execute(
                "UPDATE notification_recipients SET read_at=?1 WHERE notification_id=?2 AND user_id=?3 AND read_at IS NULL",
                params![now,input.notification_id,actor.user_id],
            )?
        }
        InboxChange::Unread => {
            tx.execute(
                "UPDATE notification_recipients SET read_at=NULL WHERE notification_id=?1 AND user_id=?2 AND archived_at IS NULL AND read_at IS NOT NULL",
                params![input.notification_id,actor.user_id],
            )?
        }
        InboxChange::Archive => {
            tx.execute(
                "UPDATE notification_recipients SET read_at=COALESCE(read_at,?1),archived_at=COALESCE(archived_at,?1) WHERE notification_id=?2 AND user_id=?3 AND (read_at IS NULL OR archived_at IS NULL)",
                params![now,input.notification_id,actor.user_id],
            )?
        }
        InboxChange::Restore => {
            tx.execute(
                "UPDATE notification_recipients SET archived_at=NULL WHERE notification_id=?1 AND user_id=?2 AND archived_at IS NOT NULL",
                params![input.notification_id,actor.user_id],
            )?
        }
    };
    if changed > 0 {
        enqueue_inbox_change_tx(tx, &actor.user_id, now)?;
    }
    let entity = json!({"entityType":"notification","id":input.notification_id});
    Ok(Mutation::new(
        entity,
        Vec::new(),
        "notification",
        &input.notification_id,
    ))
}

pub(super) fn inbox_bulk_change(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: InboxBulkCommand,
    archive: bool,
    now: i64,
) -> AppResult<Mutation> {
    validate_inbox_projects(tx, actor, &input.filter.project_ids)?;
    let filter = &input.filter;
    let project_ids = serde_json::to_string(&filter.project_ids)
        .map_err(|error| AppError::internal(format!("serialize Inbox filter: {error}")))?;
    let (assignment, changed_filter) = if archive {
        (
            "read_at=COALESCE(read_at,?8),archived_at=COALESCE(archived_at,?8)",
            "(read_at IS NULL OR archived_at IS NULL)",
        )
    } else {
        ("read_at=?8", "read_at IS NULL")
    };
    let changed = tx.execute(
        &format!(
            "UPDATE notification_recipients SET {assignment}
         WHERE user_id=?1 AND {changed_filter} AND notification_id IN (
           SELECT n.id FROM notification_recipients r
           JOIN notification_events n ON n.id=r.notification_id {INBOX_FILTER_SQL})"
        ),
        params![
            actor.user_id,
            now.saturating_sub(ARCHIVE_RETENTION_SECONDS),
            filter.archived,
            filter.unread_only,
            project_ids,
            !filter.project_ids.is_empty(),
            inbox_grant_id(actor),
            now
        ],
    )?;
    if changed > 0 {
        enqueue_inbox_change_tx(tx, &actor.user_id, now)?;
    }
    let entity = json!({"entityType":"inboxBulkResult","changed":changed});
    Ok(Mutation {
        entities: vec![entity],
        events: Vec::new(),
        resource_type: Some("inbox".into()),
        resource_id: None,
    })
}

pub(crate) fn enqueue_inbox_change_tx(
    tx: &Transaction<'_>,
    owner_id: &str,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO outbox_messages
         (id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
         VALUES (?1,'inbox.state_changed','inbox',?2,'{}',?3,?3)",
        params![Uuid::now_v7().to_string(), owner_id, now],
    )?;
    Ok(())
}

pub(super) fn inbox_grant_id(actor: &Actor) -> Option<&str> {
    match &actor.source {
        ActorSource::McpGrant { grant_id } => Some(grant_id),
        ActorSource::BrowserSession { .. } => None,
    }
}
#[derive(Clone, Copy)]
pub(super) enum InboxChange {
    Read,
    Unread,
    Archive,
    Restore,
}
