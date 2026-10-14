//! Comment mutations preserve ownership, immutable audit and notification recipient snapshots.
use super::*;

pub(super) fn create_comment(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: CommentCreate,
    now: i64,
) -> AppResult<Mutation> {
    let content = canonical_comment(&input.content)?;
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
    let content = canonical_comment(&input.content)?;
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
