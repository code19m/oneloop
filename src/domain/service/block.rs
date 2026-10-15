//! Blocking episodes preserve exact mention text and deliver only newly selected recipients.
use super::*;

pub(super) fn block_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TaskBlock,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let task = task_row(tx, &input.task_id)?;
    require_project(tx, actor, &task.project_id, Need::Board, false)?;
    check_revision(expected, task.revision)?;
    if task.status == "done" {
        return Err(AppError::PreconditionFailed(
            "completed tasks cannot be blocked".into(),
        ));
    }
    let open: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_blocks WHERE task_id=?1 AND resolved_at IS NULL)",
        [&input.task_id],
        |row| row.get(0),
    )?;
    if open {
        return Err(AppError::Conflict("task is already blocked".into()));
    }
    let reason = text::exact(&input.reason, "reason", BLOCK_REASON_MAX)?;
    let mentions = mentions::validate(tx, &task.project_id, &reason, input.mentions, &[])?;
    let block_id = Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO task_blocks (id,project_id,task_id,reason,created_by,created_at) VALUES (?1,\
                     ?2,?3,?4,?5,?6)",
        params![
            block_id,
            task.project_id,
            input.task_id,
            reason,
            actor.user_id,
            now
        ],
    )?;
    mentions::replace(tx, Mentioned::Block(&block_id), &mentions)?;
    tx.execute(
        "UPDATE tasks SET updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",
        params![now, input.task_id, expected],
    )?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&task.project_id),
            entity_type: "task_block",
            entity_id: &block_id,
            task_id: Some(&input.task_id),
            event_type: "task.blocked",
            field_key: None,
            before: None,
            after: Some(json!({"reason":reason,"mentions":mentions})),
            metadata: json!({"blockId":block_id}),
            entity_revision: Some(1),
        },
        now,
    )?;
    mentions::notify(
        tx,
        actor,
        MentionNotice {
            item: Mentioned::Block(&block_id),
            project_id: &task.project_id,
            task_id: &input.task_id,
            excerpt: &reason,
            mentions: &mentions,
            previous: &[],
        },
        now,
    )?;
    let block = json!({
    "entityType":"taskBlock",
    "id":block_id,
    "projectId":task.project_id,
    "taskId":input.task_id,
    "reason":reason,
    "createdBy":actor.user_id,
    "createdAt":now,
    "revision":1,
    "mentions":mentions
    });
    let task_entity = task_entity(tx, &input.task_id)?;
    Ok(Mutation {
        entities: vec![task_entity, block],
        events: vec![event],
        resource_type: "taskBlock",
        resource_id: Some(block_id),
    })
}

pub(super) fn update_block_reason(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: BlockReasonUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = tx
        .query_row(ACTIVE_BLOCK_SQL, [&input.block_id], BlockRow::from_row)
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "active task block",
        })?;
    require_project(tx, actor, &before.project_id, Need::Board, false)?;
    check_revision(expected, before.revision)?;
    let reason = text::exact(&input.reason, "reason", BLOCK_REASON_MAX)?;
    let old_mentions = mentions::load(tx, Mentioned::Block(&input.block_id))?;
    let retained: Vec<_> = old_mentions
        .iter()
        .filter_map(|m| m.user_id.clone())
        .collect();
    let mentions = mentions::validate(tx, &before.project_id, &reason, input.mentions, &retained)?;
    if reason == before.reason && mentions == old_mentions {
        return Err(AppError::validation(
            "payload",
            "no block reason fields changed",
        ));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE task_blocks SET reason=?1,revision=?2 WHERE id=?3 AND revision=?4",
        params![reason, revision, input.block_id, expected],
    )?;
    mentions::replace(tx, Mentioned::Block(&input.block_id), &mentions)?;
    let field_key = format!("block-reason:{}", input.block_id);
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "task_block",
            entity_id: &input.block_id,
            task_id: Some(&before.task_id),
            event_type: "task.block.reason.updated",
            field_key: Some(&field_key),
            before: Some(json!({"reason":before.reason,"mentions":old_mentions})),
            after: Some(json!({"reason":reason,"mentions":mentions})),
            metadata: json!({"blockId":input.block_id}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    tx.execute(
        "UPDATE notification_recipients SET excerpt_snapshot=?1 WHERE notification_id IN
         (SELECT id FROM notification_events WHERE block_id=?2)",
        params![reason, input.block_id],
    )?;
    // Earlier Inbox items about this block now show the new reason.
    for owner in previous_block_recipients(tx, &input.block_id)? {
        crate::collaboration::enqueue_inbox_change_tx(tx, &owner, now)?;
    }
    mentions::notify(
        tx,
        actor,
        MentionNotice {
            item: Mentioned::Block(&input.block_id),
            project_id: &before.project_id,
            task_id: &before.task_id,
            excerpt: &reason,
            mentions: &mentions,
            previous: &old_mentions,
        },
        now,
    )?;
    let entity = json!({
    "entityType":"taskBlock",
    "id":input.block_id,
    "projectId":before.project_id,
    "taskId":before.task_id,
    "reason":reason,
    "revision":revision,
    "mentions":mentions
    });
    Ok(Mutation::one(entity, event, "taskBlock", &input.block_id))
}

pub(super) fn unblock_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TaskUnblock,
    expected: i64,
    complete: bool,
    now: i64,
) -> AppResult<Mutation> {
    let task = task_row(tx, &input.task_id)?;
    require_project(tx, actor, &task.project_id, Need::Board, false)?;
    check_revision(expected, task.revision)?;
    let (block_id, block_revision, block_reason): (String, i64, String) = tx
        .query_row(
            "SELECT id,revision,reason FROM task_blocks WHERE task_id=?1 AND resolved_at IS NULL",
            [&input.task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "active task block",
        })?;
    let resolution = input
        .resolution
        .as_deref()
        .map(|v| text::optional(v, "resolution", BLOCK_RESOLUTION_MAX))
        .transpose()?
        .filter(|v| !v.is_empty());
    tx.execute(
        "UPDATE task_blocks SET resolved_by=?1,resolved_at=?2,resolution=?3,revision=revision+1 \
                     WHERE id=?4 AND revision=?5",
        params![actor.user_id, now, resolution, block_id, block_revision],
    )?;
    if complete {
        // A blocked task is never Done yet, so this always completes it.
        let position = task_append_position(tx, &task.project_id, "done")?;
        tx.execute(
            MOVE_TASK_SQL,
            params!["done", position, Some(now), now, input.task_id, expected],
        )?;
    } else {
        tx.execute(
            "UPDATE tasks SET updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",
            params![now, input.task_id, expected],
        )?;
    }
    let event_type = if complete {
        "task.unblocked_and_completed"
    } else {
        "task.unblocked"
    };
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&task.project_id),
            entity_type: "task_block",
            entity_id: &block_id,
            task_id: Some(&input.task_id),
            event_type,
            field_key: None,
            before: Some(json!({"blocked":true})),
            after: Some(json!({"blocked":false,"resolution":resolution,"completed":complete})),
            metadata: json!({"blockId":block_id}),
            entity_revision: Some(block_revision + 1),
        },
        now,
    )?;
    snapshot_notification_tx(
        tx,
        actor,
        NotificationInput {
            project_id: &task.project_id,
            event_type,
            task_id: Some(&input.task_id),
            comment_id: None,
            block_id: Some(&block_id),
            excerpt: Some(&block_reason),
            broadcast: false,
        },
        assignee_ids(tx, &input.task_id)?,
        now,
    )?;
    let block = json!({
    "entityType":"taskBlock",
    "id":block_id,
    "projectId":task.project_id,
    "taskId":input.task_id,
    "resolved":true,
    "resolution":resolution,
    "revision":block_revision+1
    });
    let task_entity = task_entity(tx, &input.task_id)?;
    Ok(Mutation {
        entities: vec![task_entity, block],
        events: vec![event],
        resource_type: "taskBlock",
        resource_id: Some(block_id),
    })
}

pub(super) fn previous_block_recipients(
    tx: &Transaction<'_>,
    block_id: &str,
) -> AppResult<BTreeSet<String>> {
    let mut statement = tx.prepare(
        "SELECT r.user_id FROM notification_recipients r JOIN notification_events e ON \
                     e.id=r.notification_id WHERE e.block_id=?1",
    )?;
    Ok(statement
        .query_map([block_id], |row| row.get(0))?
        .collect::<Result<BTreeSet<_>, _>>()?)
}
