//! Blocking episodes preserve exact mention text and deliver only newly selected recipients.
use super::*;

pub(super) fn block_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: TaskBlock,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let task = task_row(tx, &input.task_id)?;
    require_project(
        tx,
        actor,
        stored,
        &task.project_id,
        Permission::Board,
        false,
    )?;
    ensure_revision(task.revision, expected)?;
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
    let reason = mention_text(&input.reason)?;
    let mentions = validate_mentions(tx, &task.project_id, &reason, input.mentions, &[])?;
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
    replace_block_mentions(tx, &block_id, &mentions)?;
    tx.execute(
        "UPDATE tasks SET updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",
        params![now, input.task_id, expected],
    )?;
    let event = activity(
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
    let direct: Vec<String> = mentions.iter().filter_map(|m| m.user_id.clone()).collect();
    notify(
        tx,
        actor,
        NotificationInput {
            project_id: &task.project_id,
            event_type: "task.block.mentioned",
            task_id: Some(&input.task_id),
            comment_id: None,
            block_id: Some(&block_id),
            excerpt: Some(&reason),
            payload: json!({"broadcast":false}),
        },
        direct.clone(),
        now,
    )?;
    if mentions.iter().any(|m| m.kind == MentionKind::Everyone) {
        let recipients: Vec<_> = active_project_members(tx, &task.project_id)?
            .into_iter()
            .filter(|id| id != &actor.user_id && !direct.contains(id))
            .collect();
        notify(
            tx,
            actor,
            NotificationInput {
                project_id: &task.project_id,
                event_type: "task.block.everyone",
                task_id: Some(&input.task_id),
                comment_id: None,
                block_id: Some(&block_id),
                excerpt: Some(&reason),
                payload: json!({"broadcast":true}),
            },
            recipients,
            now,
        )?;
    }
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
        resource_type: Some("taskBlock".into()),
        resource_id: Some(block_id),
    })
}

pub(super) fn update_block_reason(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: BlockReasonUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = tx
        .query_row(
            SELECT_TASK_BLOCKS_SQL,
            [&input.block_id],
            BlockRow::from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("active task block"))?;
    require_project(
        tx,
        actor,
        stored,
        &before.project_id,
        Permission::Board,
        false,
    )?;
    ensure_revision(before.revision, expected)?;
    let reason = mention_text(&input.reason)?;
    let old_mentions = load_block_mentions(tx, &input.block_id)?;
    let retained: Vec<_> = old_mentions
        .iter()
        .filter_map(|m| m.user_id.clone())
        .collect();
    let mentions = validate_mentions(tx, &before.project_id, &reason, input.mentions, &retained)?;
    if reason == before.reason && mentions_equal(&mentions, &old_mentions) {
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
    replace_block_mentions(tx, &input.block_id, &mentions)?;
    let field_key = format!("block-reason:{}", input.block_id);
    let event = activity(
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
    let notified = previous_block_recipients(tx, &input.block_id)?;
    for owner in &notified {
        crate::collaboration::enqueue_inbox_change_tx(tx, owner, now)?;
    }
    let direct: Vec<String> = mentions
        .iter()
        .filter(|mention| mention.kind == MentionKind::User)
        .filter_map(|mention| mention.user_id.clone())
        .filter(|id| !notified.contains(id) && !retained.contains(id) && id != &actor.user_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !direct.is_empty() {
        notify(
            tx,
            actor,
            NotificationInput {
                project_id: &before.project_id,
                event_type: "task.block.mentioned",
                task_id: Some(&before.task_id),
                comment_id: None,
                block_id: Some(&input.block_id),
                excerpt: Some(&reason),
                payload: json!({"broadcast":false}),
            },
            direct.clone(),
            now,
        )?;
    }
    let has_everyone = mentions
        .iter()
        .any(|mention| mention.kind == MentionKind::Everyone);
    let had_everyone: bool = old_mentions
        .iter()
        .any(|mention| mention.kind == MentionKind::Everyone)
        || tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM notification_events WHERE block_id=?1
         AND json_extract(payload_json,'$.broadcast')=1)",
            [&input.block_id],
            |row| row.get(0),
        )?;
    if has_everyone && !had_everyone {
        let mut everyone = active_project_members(tx, &before.project_id)?;
        everyone.retain(|id| {
            id != &actor.user_id
                && !notified.contains(id)
                && !retained.contains(id)
                && !direct.contains(id)
        });
        notify(
            tx,
            actor,
            NotificationInput {
                project_id: &before.project_id,
                event_type: "task.block.everyone",
                task_id: Some(&before.task_id),
                comment_id: None,
                block_id: Some(&input.block_id),
                excerpt: Some(&reason),
                payload: json!({"broadcast":true}),
            },
            everyone,
            now,
        )?;
    }
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
    stored: &StoredActor,
    input: TaskUnblock,
    expected: i64,
    complete: bool,
    now: i64,
) -> AppResult<Mutation> {
    let task = task_row(tx, &input.task_id)?;
    require_project(
        tx,
        actor,
        stored,
        &task.project_id,
        Permission::Board,
        false,
    )?;
    ensure_revision(task.revision, expected)?;
    let (block_id, block_revision, block_reason): (String, i64, String) = tx
        .query_row(
            "SELECT id,revision,reason FROM task_blocks WHERE task_id=?1 AND resolved_at IS NULL",
            [&input.task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("active task block"))?;
    let resolution = input
        .resolution
        .as_deref()
        .map(|v| optional_text(v, "resolution", BLOCK_RESOLUTION_MAX))
        .transpose()?
        .filter(|v| !v.is_empty());
    tx.execute(
        "UPDATE task_blocks SET resolved_by=?1,resolved_at=?2,resolution=?3,revision=revision+1 \
                     WHERE id=?4 AND revision=?5",
        params![actor.user_id, now, resolution, block_id, block_revision],
    )?;
    if complete {
        let position = task_append_position(tx, &task.project_id, "done")?;
        tx.execute(
            "UPDATE tasks SET status='done',position=?1,completed_at=?2,completion_order=(SELECT COALESCE(MAX(completion_order),0)+1
             FROM tasks WHERE completion_order>0),updated_at=?2,revision=revision+1 WHERE id=?3 AND revision=?4",
            params![position, now, input.task_id, expected],
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
    let event = activity(
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
    notify(
        tx,
        actor,
        NotificationInput {
            project_id: &task.project_id,
            event_type,
            task_id: Some(&input.task_id),
            comment_id: None,
            block_id: Some(&block_id),
            excerpt: Some(&block_reason),
            payload: json!({"broadcast":false}),
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
        resource_type: Some("taskBlock".into()),
        resource_id: Some(block_id),
    })
}

type ValidMention = MentionInput;

pub(super) fn replace_block_mentions(
    tx: &Transaction<'_>,
    block_id: &str,
    mentions: &[ValidMention],
) -> AppResult<()> {
    tx.execute("DELETE FROM block_mentions WHERE block_id=?1", [block_id])?;
    for mention in mentions {
        tx.execute(
            "INSERT INTO block_mentions (id,block_id,kind,user_id,start_offset,end_offset,label) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                Uuid::now_v7().to_string(),
                block_id,
                match mention.kind {
                    MentionKind::User => "user",
                    MentionKind::Everyone => "everyone",
                },
                mention.user_id,
                mention.start_offset as i64,
                mention.end_offset as i64,
                mention.label
            ],
        )?;
    }
    Ok(())
}

pub(super) fn load_block_mentions(
    tx: &Transaction<'_>,
    block_id: &str,
) -> AppResult<Vec<ValidMention>> {
    let mut statement = tx.prepare(
        "SELECT kind,user_id,start_offset,end_offset,label FROM block_mentions WHERE block_id=?1 \
                     ORDER BY start_offset,id",
    )?;
    Ok(statement
        .query_map([block_id], |row| {
            Ok(ValidMention {
                kind: if row.get::<_, String>(0)? == "everyone" {
                    MentionKind::Everyone
                } else {
                    MentionKind::User
                },
                user_id: row.get(1)?,
                start_offset: row.get::<_, i64>(2)? as usize,
                end_offset: row.get::<_, i64>(3)? as usize,
                label: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn mentions_equal(a: &[ValidMention], b: &[ValidMention]) -> bool {
    a == b
}

pub(super) fn active_project_members(
    tx: &Transaction<'_>,
    project_id: &str,
) -> AppResult<Vec<String>> {
    let mut statement = tx.prepare(
        "SELECT u.id FROM users u JOIN project_memberships m ON m.user_id=u.id WHERE \
                     m.project_id=?1 AND u.is_active=1",
    )?;
    Ok(statement
        .query_map([project_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn previous_block_recipients(
    tx: &Transaction<'_>,
    block_id: &str,
) -> AppResult<HashSet<String>> {
    let mut statement = tx.prepare(
        "SELECT r.user_id FROM notification_recipients r JOIN notification_events e ON \
                     e.id=r.notification_id WHERE e.block_id=?1",
    )?;
    Ok(statement
        .query_map([block_id], |row| row.get(0))?
        .collect::<Result<HashSet<_>, _>>()?)
}
