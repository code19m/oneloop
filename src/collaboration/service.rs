//! Discussion and private Inbox services. Mutations, audit and recipient snapshots commit together; reads enforce current access.

mod comments;
use comments::*;
mod inbox;
pub(crate) use inbox::enqueue_inbox_change_tx;
use inbox::*;

use crate::{auth::unix_now, idempotency::validate_key as validate_idempotency_key};
use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppError, AppResult, Db,
    auth::{Actor, ActorSource},
};

use super::{
    ActivityEvent, ActivityInput, ActivityPage, CollaborationCommand, CollaborationCommandResult,
    CommentCreate, CommentDelete, CommentEdit, CommentPage, CommentView, InboxBulkCommand,
    InboxFilter, InboxItem, InboxItemCommand, InboxPage, MentionKind, MentionToken,
    NotificationInput, record_activity_tx, snapshot_notification_tx,
};

use crate::access::enforce_broadcast_cooldown;
const ARCHIVE_RETENTION_SECONDS: i64 = 90 * 24 * 60 * 60;
const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 100;
const INBOX_FILTER_SQL: &str = "
    WHERE r.user_id=?1 AND r.delivered_at IS NOT NULL
      AND ((?3=0 AND r.archived_at IS NULL)
        OR (?3=1 AND r.archived_at>?2))
      AND (?4=0 OR r.read_at IS NULL)
      AND (?6=0 OR (
        n.project_id IN (SELECT value FROM json_each(?5))
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=n.project_id AND p.deleted_at IS NULL)
        AND (r.task_key_snapshot IS NULL OR EXISTS(
          SELECT 1 FROM tasks t WHERE t.id=n.task_id AND t.deleted_at IS NULL))
        AND EXISTS(SELECT 1 FROM users me WHERE me.id=r.user_id AND me.is_active=1 AND
          (me.is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships pm
           WHERE pm.user_id=me.id AND pm.project_id=n.project_id)))
      ))
      AND (?7 IS NULL OR n.project_id IN
        (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?7))";

struct CommentNotificationContext<'a> {
    project_id: &'a str,
    task_id: &'a str,
    comment_id: &'a str,
    content: &'a str,
    mentions: &'a [MentionToken],
    previous_mentions: &'a [MentionToken],
    reply_author: Option<&'a str>,
    editing: bool,
    now: i64,
}

#[derive(Clone)]
pub struct CollaborationService {
    db: Db,
}

impl CollaborationService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    /// Rechecks an SSE principal without extending browser idle expiry.
    pub async fn actor_is_current(&self, actor: &Actor) -> AppResult<bool> {
        let actor = actor.clone();
        self.db
            .run(move |connection| {
                authorization_decision(authorize_actor_connection(connection, &actor, unix_now()?))
            })
            .await
    }

    /// Passive authorization used before an SSE hint is emitted. It does not
    /// update session activity and therefore cannot keep an idle session alive.
    pub async fn actor_can_receive(
        &self,
        actor: &Actor,
        project_id: Option<&str>,
    ) -> AppResult<bool> {
        let actor = actor.clone();
        let project_id = project_id.map(str::to_owned);
        self.db
            .run(move |connection| {
                if !authorization_decision(authorize_actor_connection(
                    connection,
                    &actor,
                    unix_now()?,
                ))? {
                    return Ok(false);
                }
                match project_id {
                    Some(project_id) => authorization_decision(require_project_read_connection(
                        connection,
                        &actor,
                        &project_id,
                    )),
                    None => Ok(true),
                }
            })
            .await
    }

    pub fn supports(operation: &str) -> bool {
        matches!(
            operation,
            "discussion.comment.create"
                | "discussion.comment.edit"
                | "discussion.comment.delete"
                | "inbox.markRead"
                | "inbox.markUnread"
                | "inbox.archive"
                | "inbox.restore"
                | "inbox.bulkMarkRead"
                | "inbox.bulkArchive"
        )
    }

    pub async fn execute(
        &self,
        actor: &Actor,
        command: CollaborationCommand,
    ) -> AppResult<CollaborationCommandResult> {
        actor.require_ready()?;
        if !Self::supports(&command.operation) {
            return Err(AppError::validation(
                "operation",
                "unsupported collaboration operation",
            ));
        }
        validate_idempotency_key(&command.idempotency_key)?;
        validate_revision_contract(&command)?;
        let request_hash = request_hash(&command)?;
        let actor = actor.clone();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                authorize_actor_connection(tx, &actor, now)?;
                if let Some(mut result) = replay(tx, &actor, &command, &request_hash)? {
                    authorize_replay(tx, &actor, &command)?;
                    if matches!(
                        command.operation.as_str(),
                        "discussion.comment.create" | "discussion.comment.edit"
                    ) && let Some(comment_id) = result
                        .entities
                        .first()
                        .and_then(|entity| entity.get("id"))
                        .and_then(Value::as_str)
                    {
                        let canonical = comment_view_tx(tx, comment_id)?;
                        if canonical.deleted_at.is_some() {
                            // Older databases may still hold a live-looking response from
                            // before deletion began scrubbing cached receipts.
                            tombstone_comment_replays(tx, &canonical)?;
                            result =
                                replay(tx, &actor, &command, &request_hash)?.ok_or_else(|| {
                                    AppError::internal("comment retry receipt disappeared")
                                })?;
                        }
                    }
                    result.replayed = true;
                    return Ok(result);
                }
                let idempotency_id = crate::idempotency::start(
                    tx,
                    &actor,
                    &Uuid::now_v7().to_string(),
                    &command.idempotency_key,
                    &command.operation,
                    &request_hash,
                    now,
                )?;
                let mutation = dispatch(tx, &actor, &command, now)?;
                let result = CollaborationCommandResult {
                    entities: mutation.entities,
                    events: mutation.events,
                    replayed: false,
                };
                let response = serde_json::to_string(&result).map_err(|error| {
                    AppError::internal(format!("serialize collaboration response: {error}"))
                })?;
                crate::idempotency::succeed(
                    tx,
                    &idempotency_id,
                    crate::idempotency::Receipt {
                        status: 200,
                        response: &response,
                        resource_type: mutation.resource_type.as_deref(),
                        resource_id: mutation.resource_id.as_deref(),
                        project_id: result
                            .events
                            .iter()
                            .find_map(|event| event.project_id.as_deref()),
                    },
                    now,
                )?;
                Ok(result)
            })
            .await
    }

    pub async fn comments(
        &self,
        actor: &Actor,
        task_id: &str,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<CommentPage> {
        actor.require_ready()?;
        let actor = actor.clone();
        let task_id = task_id.to_owned();
        let cursor = cursor.map(decode_cursor).transpose()?;
        let limit = page_limit(limit);
        self.db.snapshot(move |connection| {
            authorize_actor_connection(connection, &actor, unix_now()?)?;
            let project_id: String = connection.query_row(
                "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                [&task_id], |row| row.get(0),
            ).optional()?.ok_or(AppError::NotFound { resource: "task" })?;
            require_project_read_connection(connection, &actor, &project_id)?;
            let mut statement = connection.prepare(
                "SELECT c.id,c.project_id,c.task_id,c.author_id,u.display_name,c.root_id,c.reply_to_id,
                        c.content,c.created_at,c.edited_at,c.deleted_at,c.revision
                 FROM comments c JOIN users u ON u.id=c.author_id
                 WHERE c.task_id=?1 AND (?2 IS NULL OR c.created_at<?2 OR (c.created_at=?2 AND c.id<?3))
                 ORDER BY c.created_at DESC,c.id DESC LIMIT ?4",
            )?;
            let (cursor_time, cursor_id) = cursor.map(|value| (Some(value.time), value.id)).unwrap_or((None, String::new()));
            let rows = statement.query_map(params![task_id, cursor_time, cursor_id, (limit + 1) as i64], comment_row)?;
            let mut comments = rows.collect::<Result<Vec<_>, _>>()?;
            let has_more = comments.len() > limit;
            comments.truncate(limit);
            let next_cursor = has_more.then(|| comments.last()).flatten()
                .map(|item| encode_cursor(item.created_at, &item.id));
            comment_page_context(connection, comments, next_cursor)
        }).await
    }

    /// Bounded context for an exact notification destination, independent of feed pagination.
    pub async fn comment_context(
        &self,
        actor: &Actor,
        task_id: &str,
        comment_id: &str,
    ) -> AppResult<CommentPage> {
        actor.require_ready()?;
        let actor = actor.clone();
        let task_id = task_id.to_owned();
        let comment_id = comment_id.to_owned();
        self.db.snapshot(move |connection| {
            authorize_actor_connection(connection, &actor, unix_now()?)?;
            let project_id: String = connection.query_row(
                "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                [&task_id], |row| row.get(0),
            ).optional()?.ok_or(AppError::NotFound { resource: "task" })?;
            require_project_read_connection(connection, &actor, &project_id)?;
            let comment = connection.query_row(
                "SELECT c.id,c.project_id,c.task_id,c.author_id,u.display_name,c.root_id,c.reply_to_id,
                        c.content,c.created_at,c.edited_at,c.deleted_at,c.revision
                 FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?1 AND c.task_id=?2",
                params![comment_id, task_id], comment_row,
            ).optional()?.ok_or(AppError::NotFound { resource: "comment" })?;
            comment_page_context(connection, vec![comment], None)
        }).await
    }

    pub async fn block_context(
        &self,
        actor: &Actor,
        task_id: &str,
        block_id: &str,
    ) -> AppResult<ActivityPage> {
        actor.require_ready()?;
        let actor = actor.clone();
        let task_id = task_id.to_owned();
        let block_id = block_id.to_owned();
        self.db.run(move |connection| {
            authorize_actor_connection(connection, &actor, unix_now()?)?;
            let project_id: String = connection.query_row(
                "SELECT b.project_id FROM task_blocks b JOIN tasks t ON t.id=b.task_id
                 WHERE b.id=?1 AND b.task_id=?2 AND t.deleted_at IS NULL",
                params![block_id, task_id], |row| row.get(0),
            ).optional()?.ok_or(AppError::NotFound { resource: "task block" })?;
            require_project_read_connection(connection, &actor, &project_id)?;
            let columns = "id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_name_snapshot,
                event_type,field_key,before_json,after_json,metadata_json,entity_revision,latest_at";
            let mut statement = connection.prepare(&format!(
                "SELECT {columns} FROM activity_projection WHERE entity_type='task_block'
                 AND entity_id=?1 AND task_id=?2 AND visibility='public' AND is_hidden=0
                 ORDER BY latest_at DESC,id DESC LIMIT 50"))?;
            let mut items = statement.query_map(params![block_id, task_id], activity_row)?.collect::<Result<Vec<_>, _>>()?;
            if !items.iter().any(|item| item.event_type == "task.blocked") {
                let original = connection.query_row(&format!(
                    "SELECT {columns} FROM activity_projection WHERE entity_type='task_block'
                     AND entity_id=?1 AND task_id=?2 AND event_type='task.blocked'
                     AND visibility='public' AND is_hidden=0 ORDER BY latest_at,id LIMIT 1"),
                    params![block_id, task_id], activity_row).optional()?;
                if let Some(original) = original { items.push(original); }
            }
            Ok(ActivityPage { items, next_cursor: None })
        }).await
    }

    pub async fn activity(
        &self,
        actor: &Actor,
        project_id: &str,
        task_id: Option<&str>,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<ActivityPage> {
        actor.require_ready()?;
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        let task_id = task_id.map(str::to_owned);
        let cursor = cursor.map(decode_cursor).transpose()?;
        let limit = page_limit(limit);
        self.db
            .run(move |connection| {
                authorize_actor_connection(connection, &actor, unix_now()?)?;
                require_project_read_connection(connection, &actor, &project_id)?;
                let mut visible = activity_projection_stream(
                    connection,
                    &project_id,
                    task_id.as_deref(),
                    None,
                    cursor.as_ref(),
                    limit + 1,
                )?;
                if crate::auth::can_read_private_pool(connection, &actor)? {
                    visible.extend(activity_projection_stream(
                        connection,
                        &project_id,
                        task_id.as_deref(),
                        Some(&actor.user_id),
                        cursor.as_ref(),
                        limit + 1,
                    )?);
                }
                visible.sort_by(|left, right| {
                    right
                        .created_at
                        .cmp(&left.created_at)
                        .then_with(|| right.id.cmp(&left.id))
                });
                let has_more = visible.len() > limit;
                visible.truncate(limit);
                let next_cursor = has_more
                    .then(|| visible.last())
                    .flatten()
                    .map(|item| encode_cursor(item.created_at, &item.id));
                Ok(ActivityPage {
                    items: visible,
                    next_cursor,
                })
            })
            .await
    }

    pub async fn inbox(
        &self,
        actor: &Actor,
        filter: InboxFilter,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<InboxPage> {
        actor.require_ready()?;
        let actor = actor.clone();
        let cursor = cursor.map(decode_cursor).transpose()?;
        let limit = page_limit(limit);
        self.db.run(move |connection| {
            authorize_actor_connection(connection, &actor, unix_now()?)?;
            require_mcp_scope_connection(connection, &actor, "inbox_private", None)?;
            validate_inbox_projects(connection, &actor, &filter.project_ids)?;
            let unread_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM notification_recipients r
                 JOIN notification_events n ON n.id=r.notification_id
                 WHERE r.user_id=?1 AND r.delivered_at IS NOT NULL AND r.read_at IS NULL AND r.archived_at IS NULL
                 AND (?2 IS NULL OR n.project_id IN
                   (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?2))",
                params![actor.user_id, inbox_grant_id(&actor)], |row| row.get(0),
            )?;
            let cutoff = unix_now()?.saturating_sub(ARCHIVE_RETENTION_SECONDS);
            let project_ids = serde_json::to_string(&filter.project_ids)
                .map_err(|error| AppError::internal(format!("serialize Inbox filter: {error}")))?;
            let filtered_count: i64 = connection.query_row(
                &format!("SELECT COUNT(*)
                    FROM notification_recipients r
                    JOIN notification_events n ON n.id=r.notification_id
                    {INBOX_FILTER_SQL}"),
                params![actor.user_id, cutoff, filter.archived, filter.unread_only,
                    project_ids, !filter.project_ids.is_empty(), inbox_grant_id(&actor)],
                |row| row.get(0),
            )?;
            let mut statement = connection.prepare(&format!(
                "WITH page AS (
                    SELECT n.id,n.created_at
                    FROM notification_recipients r
                    JOIN notification_events n ON n.id=r.notification_id
                    {INBOX_FILTER_SQL}
                    AND (?8 IS NULL OR n.created_at<?8 OR (n.created_at=?8 AND n.id<?9))
                    ORDER BY n.created_at DESC,n.id DESC LIMIT ?10
                 )
                 SELECT n.id,n.event_type,n.project_id,n.task_id,n.comment_id,n.block_id,n.created_at,
                        COALESCE(p.name,r.project_name_snapshot),
                        COALESCE(t.task_key,r.task_key_snapshot),COALESCE(t.title,r.task_title_snapshot),
                        COALESCE(actor.display_name,r.actor_name_snapshot),
                        CASE WHEN n.comment_id IS NOT NULL THEN r.excerpt_snapshot
                             ELSE COALESCE(b.reason,r.excerpt_snapshot) END,r.read_at,r.archived_at,
                        p.deleted_at,t.deleted_at,c.deleted_at,
                        EXISTS(SELECT 1 FROM users me WHERE me.id=r.user_id AND me.is_active=1 AND
                          (me.is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships pm
                           WHERE pm.user_id=me.id AND pm.project_id=n.project_id))) AS can_read, n.actor_user_id
                 FROM page
                 JOIN notification_events n ON n.id=page.id
                 JOIN notification_recipients r ON r.notification_id=page.id AND r.user_id=?1
                 LEFT JOIN projects p ON p.id=n.project_id
                 LEFT JOIN tasks t ON t.id=n.task_id
                 LEFT JOIN comments c ON c.id=n.comment_id
                 LEFT JOIN task_blocks b ON b.id=n.block_id
                 LEFT JOIN users actor ON actor.id=n.actor_user_id
                 ORDER BY page.created_at DESC,page.id DESC"
            ))?;
            let cursor_time = cursor.as_ref().map(|cursor| cursor.time);
            let cursor_id = cursor.as_ref().map(|cursor| cursor.id.as_str());
            let rows = statement.query_map(
                params![actor.user_id, cutoff, filter.archived, filter.unread_only,
                    project_ids, !filter.project_ids.is_empty(), inbox_grant_id(&actor), cursor_time, cursor_id,
                    (limit + 1) as i64],
                inbox_row,
            )?;
            let mut items = rows.collect::<Result<Vec<_>, _>>()?;
            let has_more = items.len() > limit;
            items.truncate(limit);
            let next_cursor = has_more
                .then(|| items.last())
                .flatten()
                .map(|item| encode_cursor(item.created_at, &item.id));
            Ok(InboxPage {
                items,
                next_cursor,
                unread_count: unread_count.max(0) as u64,
                filtered_count: filtered_count.max(0) as u64,
            })
        }).await
    }

    pub async fn purge_archived(&self, now: i64) -> AppResult<u64> {
        self.db.delivery_transaction(move |connection| {
            let cutoff = now.saturating_sub(ARCHIVE_RETENTION_SECONDS);
            let changed = connection.execute(
                "UPDATE notification_recipients
                 SET project_name_snapshot='',task_key_snapshot=NULL,task_title_snapshot=NULL,
                     actor_name_snapshot='',excerpt_snapshot=NULL
                 WHERE archived_at IS NOT NULL AND archived_at<=?1 AND
                   (project_name_snapshot<>'' OR actor_name_snapshot<>'' OR task_key_snapshot IS NOT NULL
                    OR task_title_snapshot IS NOT NULL OR excerpt_snapshot IS NOT NULL)",
                [cutoff],
            )?;
            Ok(changed as u64)
        }).await
    }
}

struct Mutation {
    entities: Vec<Value>,
    events: Vec<ActivityEvent>,
    resource_type: Option<String>,
    resource_id: Option<String>,
}

impl Mutation {
    fn new(
        entity: Value,
        events: Vec<ActivityEvent>,
        resource_type: &str,
        resource_id: &str,
    ) -> Self {
        Self {
            entities: vec![entity],
            events,
            resource_type: Some(resource_type.to_owned()),
            resource_id: Some(resource_id.to_owned()),
        }
    }
}

fn dispatch(
    tx: &Transaction<'_>,
    actor: &Actor,
    command: &CollaborationCommand,
    now: i64,
) -> AppResult<Mutation> {
    if command.operation.starts_with("inbox.") {
        require_mcp_scope_connection(tx, actor, "inbox_private", None)?;
    }
    match command.operation.as_str() {
        "discussion.comment.create" => {
            create_comment(tx, actor, parse_payload(&command.payload)?, now)
        }
        "discussion.comment.edit" => edit_comment(
            tx,
            actor,
            parse_payload(&command.payload)?,
            required_revision(command)?,
            now,
        ),
        "discussion.comment.delete" => delete_comment(
            tx,
            actor,
            parse_payload(&command.payload)?,
            required_revision(command)?,
            now,
        ),
        "inbox.markRead" => inbox_item_change(
            tx,
            actor,
            parse_payload(&command.payload)?,
            InboxChange::Read,
            now,
        ),
        "inbox.markUnread" => inbox_item_change(
            tx,
            actor,
            parse_payload(&command.payload)?,
            InboxChange::Unread,
            now,
        ),
        "inbox.archive" => inbox_item_change(
            tx,
            actor,
            parse_payload(&command.payload)?,
            InboxChange::Archive,
            now,
        ),
        "inbox.restore" => inbox_item_change(
            tx,
            actor,
            parse_payload(&command.payload)?,
            InboxChange::Restore,
            now,
        ),
        "inbox.bulkMarkRead" => {
            inbox_bulk_change(tx, actor, parse_payload(&command.payload)?, false, now)
        }
        "inbox.bulkArchive" => {
            inbox_bulk_change(tx, actor, parse_payload(&command.payload)?, true, now)
        }
        _ => Err(AppError::validation(
            "operation",
            "unsupported collaboration operation",
        )),
    }
}

fn validate_mentions(
    tx: &Transaction<'_>,
    project_id: &str,
    content: &str,
    mut mentions: Vec<MentionToken>,
) -> AppResult<Vec<MentionToken>> {
    mentions.sort_by_key(|token| (token.start_offset, token.end_offset));
    crate::access::validate_mentions(tx, project_id, content, mentions)
}

fn insert_mentions(
    tx: &Transaction<'_>,
    comment_id: &str,
    mentions: &[MentionToken],
) -> AppResult<()> {
    for mention in mentions {
        tx.execute(
            "INSERT INTO comment_mentions
             (id,comment_id,kind,user_id,start_offset,end_offset,label)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                Uuid::now_v7().to_string(),
                comment_id,
                match mention.kind {
                    MentionKind::User => "user",
                    MentionKind::Everyone => "everyone",
                },
                mention.user_id,
                mention.start_offset as i64,
                mention.end_offset as i64,
                mention.label,
            ],
        )?;
    }
    Ok(())
}

fn comment_view_tx(tx: &Transaction<'_>, comment_id: &str) -> AppResult<CommentView> {
    let mut view = tx
        .query_row(
            "SELECT c.id,c.project_id,c.task_id,c.author_id,u.display_name,c.root_id,c.reply_to_id,
                c.content,c.created_at,c.edited_at,c.deleted_at,c.revision
         FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?1",
            [comment_id],
            comment_row,
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "comment",
        })?;
    view.mentions = load_mentions_tx(tx, comment_id)?;
    Ok(view)
}

fn comment_page_context(
    connection: &rusqlite::Connection,
    mut items: Vec<CommentView>,
    next_cursor: Option<String>,
) -> AppResult<CommentPage> {
    let task_id = items
        .first()
        .map(|item| item.task_id.clone())
        .unwrap_or_default();
    let included = items
        .iter()
        .map(|item| item.id.clone())
        .collect::<BTreeSet<_>>();
    let roots = items
        .iter()
        .map(|item| item.root_id.clone())
        .collect::<BTreeSet<_>>();
    let mut missing = roots.clone();
    missing.extend(items.iter().filter_map(|item| item.reply_to_id.clone()));
    let mut context = Vec::new();
    for id in missing.difference(&included) {
        if let Some(view) = connection.query_row(
            "SELECT c.id,c.project_id,c.task_id,c.author_id,u.display_name,c.root_id,c.reply_to_id,
                    c.content,c.created_at,c.edited_at,c.deleted_at,c.revision
             FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?1 AND c.task_id=?2",
            params![id, task_id], comment_row,
        ).optional()? {
            context.push(view);
        }
    }
    for item in items.iter_mut().chain(context.iter_mut()) {
        item.mentions = load_mentions_connection(connection, &item.id)?;
    }
    let mut reply_counts = std::collections::BTreeMap::new();
    for root in roots {
        let count = connection.query_row(
            "SELECT COUNT(*) FROM comments WHERE root_id=?1 AND id<>?1",
            [&root],
            |row| row.get(0),
        )?;
        reply_counts.insert(root, count);
    }
    Ok(CommentPage {
        items,
        context,
        reply_counts,
        next_cursor,
    })
}

fn comment_row(row: &Row<'_>) -> rusqlite::Result<CommentView> {
    let deleted_at: Option<i64> = row.get(10)?;
    let content: String = row.get(7)?;
    Ok(CommentView {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_id: row.get(2)?,
        author_id: row.get(3)?,
        author_name: row.get(4)?,
        root_id: row.get(5)?,
        reply_to_id: row.get(6)?,
        content: deleted_at.is_none().then_some(content),
        mentions: Vec::new(),
        created_at: row.get(8)?,
        edited_at: row.get(9)?,
        deleted_at,
        revision: row.get(11)?,
    })
}

fn load_mentions_tx(tx: &Transaction<'_>, comment_id: &str) -> AppResult<Vec<MentionToken>> {
    let mut statement = tx.prepare(
        "SELECT kind,user_id,start_offset,end_offset,label FROM comment_mentions
         WHERE comment_id=?1 ORDER BY start_offset,id",
    )?;
    Ok(statement
        .query_map([comment_id], mention_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

fn load_mentions_connection(
    connection: &rusqlite::Connection,
    comment_id: &str,
) -> AppResult<Vec<MentionToken>> {
    let mut statement = connection.prepare(
        "SELECT kind,user_id,start_offset,end_offset,label FROM comment_mentions
         WHERE comment_id=?1 ORDER BY start_offset,id",
    )?;
    Ok(statement
        .query_map([comment_id], mention_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

fn mention_row(row: &Row<'_>) -> rusqlite::Result<MentionToken> {
    let kind: String = row.get(0)?;
    Ok(MentionToken {
        kind: if kind == "user" {
            MentionKind::User
        } else {
            MentionKind::Everyone
        },
        user_id: row.get(1)?,
        start_offset: row.get::<_, i64>(2)? as usize,
        end_offset: row.get::<_, i64>(3)? as usize,
        label: row.get(4)?,
    })
}

fn comment_fingerprint(content: &str, mentions: &[MentionToken]) -> AppResult<String> {
    let value = json!({"content":content,"mentions":mentions});
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| AppError::internal(format!("serialize comment fingerprint: {error}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn canonical_comment(value: &str) -> AppResult<String> {
    crate::text::validate(value, "content", crate::text::Lines::Multi, true)?;
    // Selected mention offsets address this exact UTF-16 content. Trimming or
    // rewriting line endings would shift a valid selection to another range.
    let count = value.encode_utf16().count();
    if value.trim().is_empty() || !(1..=2_000).contains(&count) {
        return Err(AppError::validation(
            "content",
            "must contain 1–2000 characters",
        ));
    }
    Ok(value.to_owned())
}

fn truncate_excerpt(value: &str, max: usize) -> String {
    let mut result: String = value.chars().take(max).collect();
    if value.chars().count() > max {
        result.push('…');
    }
    result
}

fn require_participation(tx: &Transaction<'_>, actor: &Actor, project_id: &str) -> AppResult<()> {
    crate::access::require_project(
        tx,
        actor,
        project_id,
        crate::access::Need::Discussion,
        false,
    )
}

fn require_comment_owner_or_admin(
    tx: &Transaction<'_>,
    actor: &Actor,
    author_id: &str,
) -> AppResult<()> {
    if actor.user_id == author_id {
        return Ok(());
    }
    // Connected apps may manage comments only as their author. Moderation is
    // an account-administration power and remains browser-only.
    if matches!(actor.source, ActorSource::McpGrant { .. }) {
        return Err(AppError::Forbidden);
    }
    let is_admin: bool = tx
        .query_row(
            "SELECT is_admin FROM users WHERE id=?1 AND is_active=1",
            [&actor.user_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if is_admin {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

fn authorize_actor_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    _now: i64,
) -> AppResult<()> {
    crate::auth::refresh_actor_connection(connection, actor).map(|_| ())
}

fn require_project_read_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
) -> AppResult<()> {
    crate::access::require_project(
        connection,
        actor,
        project_id,
        crate::access::Need::Read,
        false,
    )
}

fn require_mcp_scope_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    scope: &str,
    project_id: Option<&str>,
) -> AppResult<()> {
    crate::access::require_scope(connection, actor, scope, project_id)
}

fn validate_inbox_projects(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_ids: &BTreeSet<String>,
) -> AppResult<()> {
    for project_id in project_ids {
        require_project_read_connection(connection, actor, project_id)?;
    }
    Ok(())
}

fn authorize_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    command: &CollaborationCommand,
) -> AppResult<()> {
    match command.operation.as_str() {
        "discussion.comment.create" => {
            let input: CommentCreate = parse_payload(&command.payload)?;
            let project_id: String = tx
                .query_row(
                    "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                    [&input.task_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(AppError::NotFound { resource: "task" })?;
            require_participation(tx, actor, &project_id)
        }
        "discussion.comment.edit" | "discussion.comment.delete" => {
            let comment_id = command
                .payload
                .get("commentId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::validation("payload", "commentId is required"))?;
            let (project_id, author_id): (String, String) = tx
                .query_row(
                    "SELECT project_id,author_id FROM comments WHERE id=?1",
                    [comment_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or(AppError::NotFound {
                    resource: "comment",
                })?;
            require_participation(tx, actor, &project_id)?;
            if command.operation == "discussion.comment.delete" {
                require_mcp_scope_connection(tx, actor, "destructive", Some(&project_id))?;
            }
            require_comment_owner_or_admin(tx, actor, &author_id)
        }
        operation if operation.starts_with("inbox.") => {
            require_mcp_scope_connection(tx, actor, "inbox_private", None)
        }
        _ => Err(AppError::Forbidden),
    }
}

fn inbox_row(row: &Row<'_>) -> rusqlite::Result<InboxItem> {
    let event_type: String = row.get(1)?;
    let project_id: Option<String> = row.get(2)?;
    let task_id: Option<String> = row.get(3)?;
    let task_key_snapshot: Option<String> = row.get(8)?;
    let project_deleted: Option<i64> = row.get(14)?;
    let task_deleted: Option<i64> = row.get(15)?;
    let comment_deleted: Option<i64> = row.get(16)?;
    let can_read: bool = row.get(17)?;
    let had_task = task_key_snapshot.is_some();
    let available = can_read
        && project_id.is_some()
        && project_deleted.is_none()
        && (!had_task || (task_id.is_some() && task_deleted.is_none()));
    let comment_id: Option<String> = row.get(4)?;
    let comment_unavailable = event_type.starts_with("discussion.")
        && (comment_id.is_none() || comment_deleted.is_some());
    Ok(InboxItem {
        id: row.get(0)?,
        event_type,
        project_id: available.then_some(project_id).flatten(),
        project_name: available.then(|| row.get(7)).transpose()?,
        task_id: if available { task_id } else { None },
        task_key: if available { task_key_snapshot } else { None },
        task_title: if available { row.get(9)? } else { None },
        comment_id: if available { comment_id } else { None },
        block_id: if available { row.get(5)? } else { None },
        actor_name: if available { row.get(10)? } else { None },
        actor_user_id: if available { row.get(18)? } else { None },
        excerpt: if available && !comment_unavailable {
            row.get(11)?
        } else {
            None
        },
        destination_available: available,
        read_at: row.get(12)?,
        archived_at: row.get(13)?,
        created_at: row.get(6)?,
    })
}

fn activity_row(row: &Row<'_>) -> rusqlite::Result<ActivityEvent> {
    fn parse(value: Option<String>) -> Option<Value> {
        value.and_then(|value| serde_json::from_str(&value).ok())
    }
    let field: Option<String> = row.get(8)?;
    let metadata = crate::legacy_values::payload(parse(row.get(11)?).unwrap_or_else(|| json!({})));
    let event_type: String = row.get(7)?;
    let private_comparison = event_type == "comment.edited";
    Ok(ActivityEvent {
        id: row.get(0)?,
        project_id: row.get(1)?,
        entity_type: row.get(2)?,
        entity_id: row.get(3)?,
        task_id: row.get(4)?,
        actor_user_id: row.get(5)?,
        actor_name: row.get(6)?,
        actor_mcp_grant_id: metadata
            .get("actorMcpGrantId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        actor_app_name: metadata
            .get("actorAppName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        event_type,
        field_key: row.get(8)?,
        before: if private_comparison {
            None
        } else {
            crate::legacy_values::activity(parse(row.get(9)?), field.as_deref())
        },
        after: if private_comparison {
            None
        } else {
            crate::legacy_values::activity(parse(row.get(10)?), field.as_deref())
        },
        metadata,
        entity_revision: row.get(12)?,
        created_at: row.get(13)?,
    })
}

fn activity_projection_stream(
    connection: &rusqlite::Connection,
    project_id: &str,
    task_id: Option<&str>,
    private_owner_user_id: Option<&str>,
    cursor: Option<&Cursor>,
    limit: usize,
) -> AppResult<Vec<ActivityEvent>> {
    const COLUMNS: &str = "p.id,p.project_id,p.entity_type,p.entity_id,p.task_id,p.actor_user_id,
         p.actor_name_snapshot,p.event_type,p.field_key,p.before_json,p.after_json,
         p.metadata_json,p.entity_revision,p.latest_at";
    let (cursor_time, cursor_id) = cursor
        .map(|value| (value.time, value.id.as_str()))
        .unwrap_or((i64::MAX, "\u{10ffff}"));
    let result = match (task_id, private_owner_user_id) {
        (Some(task_id), Some(owner_id)) => {
            let sql = format!(
                "SELECT {COLUMNS} FROM activity_projection p
                WHERE p.project_id=?1 AND p.task_id=?2 AND p.is_hidden=0
                  AND p.visibility='owner' AND p.private_owner_user_id=?3
                  AND (p.latest_at,p.id)<(?4,?5)
                ORDER BY p.latest_at DESC,p.id DESC LIMIT ?6"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                params![
                    project_id,
                    task_id,
                    owner_id,
                    cursor_time,
                    cursor_id,
                    limit as i64
                ],
                activity_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        (Some(task_id), None) => {
            let sql = format!(
                "SELECT {COLUMNS} FROM activity_projection p
                WHERE p.project_id=?1 AND p.task_id=?2 AND p.is_hidden=0 AND p.visibility='public'
                  AND (p.latest_at,p.id)<(?3,?4)
                ORDER BY p.latest_at DESC,p.id DESC LIMIT ?5"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                params![project_id, task_id, cursor_time, cursor_id, limit as i64],
                activity_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        (None, Some(owner_id)) => {
            let sql = format!(
                "SELECT {COLUMNS} FROM activity_projection p
                WHERE p.project_id=?1 AND p.is_hidden=0
                  AND p.visibility='owner' AND p.private_owner_user_id=?2
                  AND (p.latest_at,p.id)<(?3,?4)
                ORDER BY p.latest_at DESC,p.id DESC LIMIT ?5"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                params![project_id, owner_id, cursor_time, cursor_id, limit as i64],
                activity_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
        (None, None) => {
            let sql = format!(
                "SELECT {COLUMNS} FROM activity_projection p
                WHERE p.project_id=?1 AND p.is_hidden=0 AND p.visibility='public'
                  AND (p.latest_at,p.id)<(?2,?3)
                ORDER BY p.latest_at DESC,p.id DESC LIMIT ?4"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                params![project_id, cursor_time, cursor_id, limit as i64],
                activity_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(result)
}

fn parse_payload<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    crate::http::input::parse_payload(value)
}

fn required_revision(command: &CollaborationCommand) -> AppResult<i64> {
    command
        .expected_revision
        .ok_or_else(|| AppError::validation("expectedRevision", "is required"))
}

fn validate_revision_contract(command: &CollaborationCommand) -> AppResult<()> {
    let needs_revision = matches!(
        command.operation.as_str(),
        "discussion.comment.edit" | "discussion.comment.delete"
    );
    if needs_revision && command.expected_revision.is_none() {
        return Err(AppError::validation("expectedRevision", "is required"));
    }
    if command.expected_revision.is_some_and(|value| value < 1) {
        return Err(AppError::validation(
            "expectedRevision",
            "must be a positive integer",
        ));
    }
    Ok(())
}

fn ensure_revision(actual: i64, expected: i64) -> AppResult<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(AppError::revision(expected, actual))
    }
}

fn request_hash(command: &CollaborationCommand) -> AppResult<String> {
    crate::idempotency::request_hash(
        &json!({"operation":command.operation,"payload":command.payload,"expectedRevision":command.expected_revision}),
    )
}

fn replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    command: &CollaborationCommand,
    hash: &str,
) -> AppResult<Option<CollaborationCommandResult>> {
    crate::idempotency::replay(
        tx,
        actor,
        &command.idempotency_key,
        &command.operation,
        hash,
    )
}

fn page_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE)
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    time: i64,
    id: String,
}

fn encode_cursor(time: i64, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Cursor {
            time,
            id: id.to_owned(),
        })
        .unwrap_or_default(),
    )
}

fn decode_cursor(value: &str) -> AppResult<Cursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::validation("cursor", "is invalid"))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor", "is invalid"))
}

fn authorization_decision(result: AppResult<()>) -> AppResult<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(AppError::Unauthorized | AppError::Forbidden | AppError::NotFound { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod generated_tests {
    proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config { failure_persistence: None, ..proptest::test_runner::Config::default() })]
        #[test]
        fn unicode_mention_offsets_land_only_on_codepoint_boundaries(value in ".{0,256}") {
            let boundaries = crate::access::utf16_boundaries(&value);
            let mut units = 0;
            for (offset, ch) in value.char_indices() {
                proptest::prop_assert_eq!(boundaries.get(&units), Some(&offset));
                if ch.len_utf16() == 2 { proptest::prop_assert!(!boundaries.contains_key(&(units + 1))); }
                units += ch.len_utf16();
            }
            proptest::prop_assert_eq!(boundaries.get(&units), Some(&value.len()));
        }
    }
}
