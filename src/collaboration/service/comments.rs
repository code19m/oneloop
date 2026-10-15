//! Comments: their pages, their changes and the purge of deleted comments'
//! text. Changes keep ownership, audit and recipient snapshots together.
use super::*;

const COMMENT_MAX: usize = 2_000;
/// Deleted comments whose text the Undo window no longer needs.
const DELETED_COMMENT_TEXT_SQL: &str = "SELECT id FROM comments
    WHERE deleted_at IS NOT NULL AND content<>'' AND deleted_at<=?1 ORDER BY deleted_at LIMIT ?2";
/// Deleted comments emptied in one pass.
const DELETED_COMMENT_BATCH: usize = 500;

impl CollaborationService {
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

    /// Removes the text and mentions of comments deleted longer ago than the
    /// Undo window, a batch at a time. Returns whether the batch was full,
    /// so more may be waiting.
    pub async fn purge_deleted_comments(&self, now: i64) -> AppResult<bool> {
        self.db
            .delivery_transaction(move |tx| {
                let cutoff = now.saturating_sub(crate::domain::UNDO_WINDOW_SECONDS);
                let mut statement = tx.prepare(DELETED_COMMENT_TEXT_SQL)?;
                let ids = statement
                    .query_map(params![cutoff, DELETED_COMMENT_BATCH as i64], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(statement);
                for id in &ids {
                    tx.execute("DELETE FROM comment_mentions WHERE comment_id=?1", [id])?;
                    tx.execute(
                        "UPDATE comments SET content='',edited_at=NULL WHERE id=?1",
                        [id],
                    )?;
                }
                Ok(ids.len() == DELETED_COMMENT_BATCH)
            })
            .await
    }
}

pub(super) fn create_comment(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: CommentCreate,
    now: i64,
) -> AppResult<Mutation> {
    let content = crate::text::exact(&input.content, "content", COMMENT_MAX)?;
    let project_id: String = tx
        .query_row(
            "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
            [&input.task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "task" })?;
    require_project(tx, actor, &project_id, Need::Discussion, false)?;
    let mentions = access::validate_mentions(tx, &project_id, &content, input.mentions, &[])?;
    let id = Uuid::now_v7().to_string();
    let (root_id, reply_author) = match input.reply_to_id.as_deref() {
        Some(reply_to_id) => {
            let (root_id, author_id): (String, String) = tx
                .query_row(
                    "SELECT root_id,author_id FROM comments
                 WHERE id=?1 AND task_id=?2 AND deleted_at IS NULL",
                    params![reply_to_id, input.task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or(AppError::NotFound {
                    resource: "reply target",
                })?;
            (root_id, Some(author_id))
        }
        None => (id.clone(), None),
    };
    tx.execute(
        "INSERT INTO comments
         (id,project_id,task_id,author_id,root_id,reply_to_id,content,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            id,
            project_id,
            input.task_id,
            actor.user_id,
            root_id,
            input.reply_to_id,
            content,
            now
        ],
    )?;
    mentions::replace(tx, Mentioned::Comment(&id), &mentions)?;
    let excerpt = truncate_excerpt(&content, 240);
    let notified = mentions::notify(
        tx,
        actor,
        MentionNotice {
            item: Mentioned::Comment(&id),
            project_id: &project_id,
            task_id: &input.task_id,
            excerpt: &excerpt,
            mentions: &mentions,
            previous: &[],
        },
        now,
    )?;
    // The author of the comment replied to hears about it, once.
    let reply_author = reply_author.filter(|author| !notified.contains(author));
    snapshot_notification_tx(
        tx,
        actor,
        NotificationInput {
            project_id: &project_id,
            event_type: "discussion.reply",
            task_id: Some(&input.task_id),
            comment_id: Some(&id),
            block_id: None,
            excerpt: Some(&excerpt),
            broadcast: false,
        },
        reply_author,
        now,
    )?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "comment",
            entity_id: &id,
            task_id: Some(&input.task_id),
            event_type: if input.reply_to_id.is_some() {
                "comment.replied"
            } else {
                "comment.created"
            },
            field_key: None,
            before: None,
            after: None,
            metadata: json!({"rootId": root_id, "replyToId": input.reply_to_id}),
            entity_revision: Some(1),
        },
        now,
    )?;
    let view = comment_view_tx(tx, &id)?;
    Ok(Mutation::new(
        serde_json::to_value(view).unwrap_or(Value::Null),
        vec![event],
        "comment",
        &id,
    ))
}

pub(super) fn edit_comment(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: CommentEdit,
    expected_revision: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = changeable_comment_tx(tx, &input.comment_id)?;
    require_project(tx, actor, &before.project_id, Need::Discussion, false)?;
    require_comment_owner_or_admin(actor, &before.author_id)?;
    if before.deleted_at.is_some() {
        return Err(AppError::Conflict(
            "deleted comments cannot be edited".into(),
        ));
    }
    ensure_revision(before.revision, expected_revision)?;
    let content = crate::text::exact(&input.content, "content", COMMENT_MAX)?;
    let retained: Vec<_> = before
        .mentions
        .iter()
        .filter_map(|token| token.user_id.clone())
        .collect();
    let mentions =
        access::validate_mentions(tx, &before.project_id, &content, input.mentions, &retained)?;
    let before_fingerprint = comment_fingerprint(
        before.content.as_deref().unwrap_or_default(),
        &before.mentions,
    )?;
    let after_fingerprint = comment_fingerprint(&content, &mentions)?;
    if before_fingerprint == after_fingerprint {
        return Ok(Mutation::new(
            serde_json::to_value(before).unwrap_or(Value::Null),
            Vec::new(),
            "comment",
            &input.comment_id,
        ));
    }
    tx.execute(
        "UPDATE comments SET content=?1,edited_at=?2,revision=revision+1
         WHERE id=?3 AND revision=?4 AND deleted_at IS NULL",
        params![content, now, input.comment_id, expected_revision],
    )?;
    mentions::replace(tx, Mentioned::Comment(&input.comment_id), &mentions)?;
    invalidate_comment_inboxes_tx(tx, &input.comment_id, now)?;
    let excerpt = truncate_excerpt(&content, 240);
    tx.execute(
        "UPDATE notification_recipients SET excerpt_snapshot=?1
         WHERE notification_id IN (SELECT id FROM notification_events WHERE comment_id=?2)",
        params![excerpt, input.comment_id],
    )?;
    mentions::notify(
        tx,
        actor,
        MentionNotice {
            item: Mentioned::Comment(&input.comment_id),
            project_id: &before.project_id,
            task_id: &before.task_id,
            excerpt: &excerpt,
            mentions: &mentions,
            previous: &before.mentions,
        },
        now,
    )?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "comment",
            entity_id: &input.comment_id,
            task_id: Some(&before.task_id),
            event_type: "comment.edited",
            field_key: Some("content"),
            before: Some(json!(before_fingerprint)),
            after: Some(json!(after_fingerprint)),
            metadata: json!({}),
            entity_revision: Some(expected_revision + 1),
        },
        now,
    )?;
    let view = comment_view_tx(tx, &input.comment_id)?;
    Ok(Mutation::new(
        serde_json::to_value(view).unwrap_or(Value::Null),
        vec![event],
        "comment",
        &input.comment_id,
    ))
}

pub(super) fn delete_comment(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: CommentDelete,
    expected_revision: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = changeable_comment_tx(tx, &input.comment_id)?;
    require_project(tx, actor, &before.project_id, Need::Discussion, false)?;
    access::require_scope(tx, actor, "destructive", Some(&before.project_id))?;
    require_comment_owner_or_admin(actor, &before.author_id)?;
    if before.deleted_at.is_some() {
        return Err(AppError::Conflict("comment is already deleted".into()));
    }
    ensure_revision(before.revision, expected_revision)?;
    // The text and mentions stay hidden for the Undo window; the purge in
    // `purge_deleted_comments` removes them after it.
    tx.execute(
        "UPDATE comments SET deleted_at=?1,revision=revision+1
         WHERE id=?2 AND revision=?3 AND deleted_at IS NULL",
        params![now, input.comment_id, expected_revision],
    )?;
    tx.execute(
        "UPDATE notification_recipients SET excerpt_snapshot=NULL
         WHERE notification_id IN (SELECT id FROM notification_events WHERE comment_id=?1)",
        [&input.comment_id],
    )?;
    let view = comment_view_tx(tx, &input.comment_id)?;
    tombstone_comment_replays(tx, &view)?;
    invalidate_comment_inboxes_tx(tx, &input.comment_id, now)?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "comment",
            entity_id: &input.comment_id,
            task_id: Some(&before.task_id),
            event_type: "comment.deleted",
            field_key: None,
            before: None,
            after: None,
            metadata: json!({}),
            entity_revision: Some(expected_revision + 1),
        },
        now,
    )?;
    Ok(Mutation::new(
        serde_json::to_value(view).unwrap_or(Value::Null),
        vec![event],
        "comment",
        &input.comment_id,
    ))
}

/// Undoes a deletion within the Undo window, for the people who could delete
/// the comment. Its text, mentions and Inbox excerpts come back; nobody is
/// notified again.
pub(super) fn restore_comment(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: CommentRestore,
    expected_revision: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = changeable_comment_tx(tx, &input.comment_id)?;
    require_project(tx, actor, &before.project_id, Need::Discussion, false)?;
    access::require_scope(tx, actor, "destructive", Some(&before.project_id))?;
    require_comment_owner_or_admin(actor, &before.author_id)?;
    let Some(deleted_at) = before.deleted_at else {
        return Err(AppError::Conflict("the comment is not deleted".into()));
    };
    ensure_revision(before.revision, expected_revision)?;
    crate::domain::require_undo_window("comment", deleted_at, now)?;
    let content: String = tx.query_row(
        "SELECT content FROM comments WHERE id=?1",
        [&input.comment_id],
        |row| row.get(0),
    )?;
    if content.is_empty() {
        // Deleted before Undo existed, when deletion emptied the text at once.
        return Err(AppError::PreconditionFailed(
            "the comment's text is gone, so it can't be restored".into(),
        ));
    }
    tx.execute(
        "UPDATE comments SET deleted_at=NULL,revision=revision+1
         WHERE id=?1 AND revision=?2 AND deleted_at IS NOT NULL",
        params![input.comment_id, expected_revision],
    )?;
    tx.execute(
        "UPDATE notification_recipients SET excerpt_snapshot=?1
         WHERE notification_id IN (SELECT id FROM notification_events WHERE comment_id=?2)",
        params![truncate_excerpt(&content, 240), input.comment_id],
    )?;
    let view = comment_view_tx(tx, &input.comment_id)?;
    // Retries of the comment's creation and edits show it again.
    tombstone_comment_replays(tx, &view)?;
    invalidate_comment_inboxes_tx(tx, &input.comment_id, now)?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "comment",
            entity_id: &input.comment_id,
            task_id: Some(&before.task_id),
            event_type: "comment.restored",
            field_key: None,
            before: None,
            after: None,
            metadata: json!({}),
            entity_revision: Some(expected_revision + 1),
        },
        now,
    )?;
    Ok(Mutation::new(
        serde_json::to_value(view).unwrap_or(Value::Null),
        vec![event],
        "comment",
        &input.comment_id,
    ))
}

/// Replaces the comment in cached retry responses with `comment`: the
/// tombstone after a deletion, or the comment again after a restore.
pub(super) fn tombstone_comment_replays(
    tx: &Transaction<'_>,
    comment: &CommentView,
) -> AppResult<()> {
    let mut statement = tx.prepare(
        "SELECT id,response_json FROM idempotency_keys
         WHERE resource_type='comment' AND resource_id=?1 AND response_json IS NOT NULL",
    )?;
    let rows = statement
        .query_map([&comment.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, response) in rows {
        let mut result: CommandResult = serde_json::from_str(&response)
            .map_err(|error| AppError::internal(format!("read comment retry response: {error}")))?;
        replace_comment(&mut result, comment)?;
        tx.execute(
            "UPDATE idempotency_keys SET response_json=?1 WHERE id=?2",
            params![
                serde_json::to_string(&result).map_err(|error| AppError::internal(format!(
                    "serialize comment retry response: {error}"
                )))?,
                id
            ],
        )?;
    }
    Ok(())
}

/// Puts `comment` in place of the same comment among a result's entities.
pub(super) fn replace_comment(result: &mut CommandResult, comment: &CommentView) -> AppResult<()> {
    let value = serde_json::to_value(comment)
        .map_err(|error| AppError::internal(format!("serialize comment: {error}")))?;
    for entity in &mut result.entities {
        if entity.get("id").and_then(Value::as_str) == Some(comment.id.as_str()) {
            *entity = value.clone();
        }
    }
    Ok(())
}

// Excerpts can belong to recipients no longer mentioned by the edited comment.
// Invalidate the original private inboxes in the same transaction as the edit.
fn invalidate_comment_inboxes_tx(
    tx: &Transaction<'_>,
    comment_id: &str,
    now: i64,
) -> AppResult<()> {
    let mut statement = tx.prepare(
        "SELECT DISTINCT r.user_id FROM notification_recipients r
         JOIN notification_events e ON e.id=r.notification_id WHERE e.comment_id=?1",
    )?;
    let owners = statement
        .query_map([comment_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for owner in owners {
        enqueue_inbox_change_tx(tx, &owner, now)?;
    }
    Ok(())
}

/// A deleted task takes its comments with it: changing one is refused as not
/// found, like a new comment on that task.
fn changeable_comment_tx(tx: &Transaction<'_>, comment_id: &str) -> AppResult<CommentView> {
    let comment = comment_view_tx(tx, comment_id)?;
    let task_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND deleted_at IS NULL)",
        [&comment.task_id],
        |row| row.get(0),
    )?;
    if !task_exists {
        return Err(AppError::NotFound {
            resource: "comment",
        });
    }
    Ok(comment)
}

pub(super) fn comment_view_tx(tx: &Transaction<'_>, comment_id: &str) -> AppResult<CommentView> {
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
pub(super) fn require_comment_owner_or_admin(actor: &Actor, author_id: &str) -> AppResult<()> {
    if actor.user_id == author_id {
        return Ok(());
    }
    actor.require_admin()
}

/// A retry of a comment's creation or edit shows the comment as it is now
/// when it has been deleted since. Older databases may still hold a
/// live-looking result from before deletion began updating stored results.
pub(super) fn show_deleted_comment(
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

fn ensure_revision(actual: i64, expected: i64) -> AppResult<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(AppError::revision(expected, actual))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrated_connection, query_plan};

    #[test]
    fn the_comment_purge_reads_only_deleted_comments_with_text() {
        let (_root, connection) = migrated_connection();
        let plan = query_plan(&connection, DELETED_COMMENT_TEXT_SQL);
        assert!(plan.contains("comments_deleted_text_idx"), "{plan}");
    }
}
