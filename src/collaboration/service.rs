//! Discussion and private Inbox services. Mutations, audit and recipient snapshots commit together; reads enforce current access.

mod activity;
mod comments;
use comments::*;
mod inbox;
pub(crate) use inbox::enqueue_inbox_change_tx;
use inbox::*;

use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppError, AppResult, Db,
    access::{self, Need, require_project},
    auth::{Actor, refresh_actor_connection},
    clock::unix_now,
    idempotency::{CommandResult, Envelope, Mutation},
    input::parse_payload,
};

use super::{
    ActivityEvent, ActivityInput, ActivityPage, CollaborationCommand, CollaborationOperation,
    CommentCreate, CommentDelete, CommentEdit, CommentPage, CommentRestore, CommentView,
    InboxBulkCommand, InboxFilter, InboxItem, InboxItemCommand, InboxPage, MentionToken,
    NotificationInput,
    mentions::{self, MentionNotice, Mentioned},
    record_activity_tx, snapshot_notification_tx,
};

const ARCHIVE_RETENTION_SECONDS: i64 = 90 * 24 * 60 * 60;
const COMMENT_MAX: usize = 2_000;
const DEFAULT_PAGE_SIZE: usize = 50;
/// Deleted comments whose text the Undo window no longer needs.
const DELETED_COMMENT_TEXT_SQL: &str = "SELECT id FROM comments
    WHERE deleted_at IS NOT NULL AND content<>'' AND deleted_at<=?1 ORDER BY deleted_at LIMIT 500";
const MAX_PAGE_SIZE: usize = 100;
const INBOX_FILTER_SQL: &str = concat!(
    "
    WHERE r.user_id=?1 AND r.delivered_at IS NOT NULL
      AND ((?3=0 AND r.archived_at IS NULL)
        OR (?3=1 AND r.archived_at>?2))
      AND (?4=0 OR r.read_at IS NULL)
      AND (?6=0 OR (
        n.project_id IN (SELECT value FROM json_each(?5))
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=n.project_id AND p.deleted_at IS NULL)
        AND (r.task_key_snapshot IS NULL OR EXISTS(
          SELECT 1 FROM tasks t WHERE t.id=n.task_id AND t.deleted_at IS NULL))
        AND EXISTS(SELECT 1 FROM users me WHERE me.id=r.user_id AND ",
    access::can_read_project!("me", "n.project_id"),
    ")
      ))
      AND (?7 IS NULL OR n.project_id IN
        (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?7))"
);

#[derive(Clone)]
pub struct CollaborationService {
    db: Db,
}

impl CollaborationService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Rechecks an SSE principal without extending browser idle expiry.
    pub async fn actor_is_current(&self, actor: &Actor) -> AppResult<bool> {
        let actor = actor.clone();
        self.db
            .run(move |connection| access::allowed(refresh_actor_connection(connection, &actor)))
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
                if !access::allowed(refresh_actor_connection(connection, &actor))? {
                    return Ok(false);
                }
                match project_id {
                    Some(project_id) => access::allowed(require_project(
                        connection,
                        &actor,
                        &project_id,
                        Need::Read,
                        false,
                    )),
                    None => Ok(true),
                }
            })
            .await
    }

    pub fn supports(operation: &str) -> bool {
        CollaborationOperation::parse(operation).is_some()
    }

    pub async fn execute(
        &self,
        actor: &Actor,
        command: CollaborationCommand,
    ) -> AppResult<CommandResult> {
        actor.require_ready()?;
        let operation = CollaborationOperation::parse(&command.operation).ok_or_else(|| {
            AppError::validation("operation", "unsupported collaboration operation")
        })?;
        let envelope = Envelope::new(
            operation.as_str(),
            &command.payload,
            &command.idempotency_key,
            command.expected_revision,
            operation.revision_rule(),
        )?;
        let actor = actor.clone();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.run(
                    tx,
                    &actor,
                    now,
                    |actor, replay| {
                        authorize_replay(tx, actor, operation, &command.payload)?;
                        show_deleted_comment(tx, operation, replay)
                    },
                    |actor| dispatch(tx, actor, operation, &command, now),
                )
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
            let actor = refresh_actor_connection(connection, &actor)?;
            let project_id: String = connection.query_row(
                "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                [&task_id], |row| row.get(0),
            ).optional()?.ok_or(AppError::NotFound { resource: "task" })?;
            require_project(connection, &actor, &project_id, Need::Read, false)?;
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
            let next_cursor = next_cursor(&mut comments, limit, |item| (item.created_at, &item.id));
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
            let actor = refresh_actor_connection(connection, &actor)?;
            let project_id: String = connection.query_row(
                "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                [&task_id], |row| row.get(0),
            ).optional()?.ok_or(AppError::NotFound { resource: "task" })?;
            require_project(connection, &actor, &project_id, Need::Read, false)?;
            let comment = connection.query_row(
                "SELECT c.id,c.project_id,c.task_id,c.author_id,u.display_name,c.root_id,c.reply_to_id,
                        c.content,c.created_at,c.edited_at,c.deleted_at,c.revision
                 FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?1 AND c.task_id=?2",
                params![comment_id, task_id], comment_row,
            ).optional()?.ok_or(AppError::NotFound { resource: "comment" })?;
            comment_page_context(connection, vec![comment], None)
        }).await
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
        self.db.snapshot(move |connection| {
            let actor = refresh_actor_connection(connection, &actor)?;
            access::require_scope(connection, &actor, "inbox_private", None)?;
            validate_inbox_projects(connection, &actor, &filter.project_ids)?;
            let unread_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM notification_recipients r
                 JOIN notification_events n ON n.id=r.notification_id
                 WHERE r.user_id=?1 AND r.delivered_at IS NOT NULL AND r.read_at IS NULL AND r.archived_at IS NULL
                 AND (?2 IS NULL OR n.project_id IN
                   (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?2))",
                params![actor.user_id, actor.mcp_grant_id()], |row| row.get(0),
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
                    project_ids, !filter.project_ids.is_empty(), actor.mcp_grant_id()],
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
                        EXISTS(SELECT 1 FROM users me WHERE me.id=r.user_id AND {can_read}) AS can_read,
                        n.actor_user_id
                 FROM page
                 JOIN notification_events n ON n.id=page.id
                 JOIN notification_recipients r ON r.notification_id=page.id AND r.user_id=?1
                 LEFT JOIN projects p ON p.id=n.project_id
                 LEFT JOIN tasks t ON t.id=n.task_id
                 LEFT JOIN comments c ON c.id=n.comment_id
                 LEFT JOIN task_blocks b ON b.id=n.block_id
                 LEFT JOIN users actor ON actor.id=n.actor_user_id
                 ORDER BY page.created_at DESC,page.id DESC",
                can_read = access::can_read_project!("me", "n.project_id"),
            ))?;
            let cursor_time = cursor.as_ref().map(|cursor| cursor.time);
            let cursor_id = cursor.as_ref().map(|cursor| cursor.id.as_str());
            let rows = statement.query_map(
                params![actor.user_id, cutoff, filter.archived, filter.unread_only,
                    project_ids, !filter.project_ids.is_empty(), actor.mcp_grant_id(), cursor_time, cursor_id,
                    (limit + 1) as i64],
                inbox_row,
            )?;
            let mut items = rows.collect::<Result<Vec<_>, _>>()?;
            let next_cursor = next_cursor(&mut items, limit, |item| (item.created_at, &item.id));
            Ok(InboxPage {
                items,
                next_cursor,
                unread_count: unread_count.max(0) as u64,
                filtered_count: filtered_count.max(0) as u64,
            })
        }).await
    }

    /// Removes the text and mentions of comments deleted longer ago than the
    /// Undo window, at most 500 at a time. Returns how many it emptied.
    pub async fn purge_deleted_comments(&self, now: i64) -> AppResult<u64> {
        self.db
            .delivery_transaction(move |tx| {
                let cutoff = now.saturating_sub(crate::domain::UNDO_WINDOW_SECONDS);
                let mut statement = tx.prepare(DELETED_COMMENT_TEXT_SQL)?;
                let ids = statement
                    .query_map([cutoff], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(statement);
                for id in &ids {
                    tx.execute("DELETE FROM comment_mentions WHERE comment_id=?1", [id])?;
                    tx.execute(
                        "UPDATE comments SET content='',edited_at=NULL WHERE id=?1",
                        [id],
                    )?;
                }
                Ok(ids.len() as u64)
            })
            .await
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

fn dispatch(
    tx: &Transaction<'_>,
    actor: &Actor,
    operation: CollaborationOperation,
    command: &CollaborationCommand,
    now: i64,
) -> AppResult<Mutation> {
    use CollaborationOperation::*;
    if operation.is_inbox() {
        access::require_scope(tx, actor, "inbox_private", None)?;
    }
    let payload = &command.payload;
    // The revision rule has required one for every operation that takes it.
    let expected = command.expected_revision.unwrap_or_default();
    match operation {
        CreateComment => create_comment(tx, actor, parse_payload(payload)?, now),
        EditComment => edit_comment(tx, actor, parse_payload(payload)?, expected, now),
        DeleteComment => delete_comment(tx, actor, parse_payload(payload)?, expected, now),
        RestoreComment => restore_comment(tx, actor, parse_payload(payload)?, expected, now),
        MarkRead => inbox_item_change(tx, actor, parse_payload(payload)?, InboxChange::Read, now),
        MarkUnread => {
            inbox_item_change(tx, actor, parse_payload(payload)?, InboxChange::Unread, now)
        }
        Archive => inbox_item_change(
            tx,
            actor,
            parse_payload(payload)?,
            InboxChange::Archive,
            now,
        ),
        RestoreArchived => inbox_item_change(
            tx,
            actor,
            parse_payload(payload)?,
            InboxChange::Restore,
            now,
        ),
        BulkMarkRead => inbox_bulk_change(tx, actor, parse_payload(payload)?, false, now),
        BulkArchive => inbox_bulk_change(tx, actor, parse_payload(payload)?, true, now),
    }
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
    // A deleted comment keeps its mentions only for a restore.
    if view.deleted_at.is_none() {
        view.mentions = mentions::load(tx, Mentioned::Comment(comment_id))?;
    }
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
    for item in items
        .iter_mut()
        .chain(context.iter_mut())
        .filter(|item| item.deleted_at.is_none())
    {
        item.mentions = mentions::load(connection, Mentioned::Comment(&item.id))?;
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

fn comment_fingerprint(content: &str, mentions: &[MentionToken]) -> AppResult<String> {
    let value = json!({"content":content,"mentions":mentions});
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| AppError::internal(format!("serialize comment fingerprint: {error}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn truncate_excerpt(value: &str, max: usize) -> String {
    let mut result: String = value.chars().take(max).collect();
    if value.chars().count() > max {
        result.push('…');
    }
    result
}

/// Connected apps manage comments only as their author: moderation is an
/// account-administration power, which stays in the browser.
fn require_comment_owner_or_admin(actor: &Actor, author_id: &str) -> AppResult<()> {
    if actor.user_id == author_id {
        return Ok(());
    }
    actor.require_admin()
}

fn validate_inbox_projects(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_ids: &BTreeSet<String>,
) -> AppResult<()> {
    for project_id in project_ids {
        require_project(connection, actor, project_id, Need::Read, false)?;
    }
    Ok(())
}

fn authorize_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    operation: CollaborationOperation,
    payload: &Value,
) -> AppResult<()> {
    use CollaborationOperation::*;
    match operation {
        CreateComment => {
            let input: CommentCreate = parse_payload(payload)?;
            let project_id: String = tx
                .query_row(
                    "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                    [&input.task_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(AppError::NotFound { resource: "task" })?;
            require_project(tx, actor, &project_id, Need::Discussion, false)
        }
        EditComment | DeleteComment | RestoreComment => {
            let comment_id = payload
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
            require_project(tx, actor, &project_id, Need::Discussion, false)?;
            if operation != EditComment {
                access::require_scope(tx, actor, "destructive", Some(&project_id))?;
            }
            require_comment_owner_or_admin(actor, &author_id)
        }
        MarkRead | MarkUnread | Archive | RestoreArchived | BulkMarkRead | BulkArchive => {
            access::require_scope(tx, actor, "inbox_private", None)
        }
    }
}

/// A retry of a comment's creation or edit shows the comment as it is now
/// when it has been deleted since. Older databases may still hold a
/// live-looking result from before deletion began updating stored results.
fn show_deleted_comment(
    tx: &Transaction<'_>,
    operation: CollaborationOperation,
    replay: &mut CommandResult,
) -> AppResult<()> {
    if !matches!(
        operation,
        CollaborationOperation::CreateComment | CollaborationOperation::EditComment
    ) {
        return Ok(());
    }
    let Some(comment_id) = replay
        .entities
        .first()
        .and_then(|entity| entity.get("id"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let current = comment_view_tx(tx, comment_id)?;
    if current.deleted_at.is_some() {
        tombstone_comment_replays(tx, &current)?;
        replace_comment(replay, &current)?;
    }
    Ok(())
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

fn ensure_revision(actual: i64, expected: i64) -> AppResult<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(AppError::revision(expected, actual))
    }
}

/// Cuts a page that was read with one item too many back to `limit` items,
/// and returns the cursor of the next page when that extra item was there.
fn next_cursor<T>(
    items: &mut Vec<T>,
    limit: usize,
    key: impl Fn(&T) -> (i64, &String),
) -> Option<String> {
    let more = items.len() > limit;
    items.truncate(limit);
    items.last().filter(|_| more).map(|item| {
        let (time, id) = key(item);
        encode_cursor(time, id)
    })
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
