//! Task mutations preserve required epic ownership, assignee eligibility and block completion guards.
use super::*;

pub(super) fn create_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: TaskCreate,
    now: i64,
    source_pool: Option<&str>,
) -> AppResult<Mutation> {
    require_project(
        tx,
        actor,
        stored,
        &input.project_id,
        Permission::Board,
        false,
    )?;
    ensure_open_epic(tx, &input.epic_id, &input.project_id)?;
    let title = text(&input.title, "title", TASK_TITLE_MAX)?;
    let description = optional_text(&input.description, "description", TASK_DESCRIPTION_MAX)?;
    let deadline = optional_date(input.deadline, "deadline")?;
    let assignees = validate_assignees(tx, &input.project_id, input.assignee_ids)?;
    let (number, prefix): (i64, String) = tx
        .query_row(
            "SELECT s.next_task_number,p.task_prefix FROM project_sequences s JOIN projects p ON \
                     p.id=s.project_id WHERE s.project_id=?1",
            [&input.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("project sequence"))?;
    tx.execute(
        "UPDATE project_sequences SET next_task_number=next_task_number+1 WHERE project_id=?1 AND \
                     next_task_number=?2",
        params![input.project_id, number],
    )?;
    let key = format!("{prefix}-{number:03}");
    let position = task_append_position(tx, &input.project_id, "planning")?;
    let id = Uuid::now_v7().to_string();
    tx.execute(
        INSERT_TASKS_SQL,
        params![
            id,
            input.project_id,
            input.epic_id,
            number,
            key,
            title,
            description,
            position,
            deadline,
            actor.user_id,
            now
        ],
    )?;
    set_assignees(tx, &id, &actor.user_id, &[], &assignees, now)?;
    let entity = task_entity(tx, &id)?;
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "task",
            entity_id: &id,
            task_id: Some(&id),
            event_type: "task.created",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: json!({"sourcePoolItemId":source_pool}),
            entity_revision: Some(1),
        },
        now,
    )?;
    notify(
        tx,
        actor,
        NotificationInput {
            project_id: &input.project_id,
            event_type: "task.assigned",
            task_id: Some(&id),
            comment_id: None,
            block_id: None,
            excerpt: None,
            payload: json!({"broadcast":false}),
        },
        assignees.clone(),
        now,
    )?;
    Ok(Mutation::one(entity, event, "task", &id))
}

pub(super) fn update_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: TaskUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = task_row(tx, &input.task_id)?;
    require_project(
        tx,
        actor,
        stored,
        &before.project_id,
        Permission::Board,
        false,
    )?;
    ensure_revision(before.revision, expected)?;
    let epic_id = input.epic_id.unwrap_or(before.epic_id.clone());
    if epic_id != before.epic_id {
        ensure_open_epic(tx, &epic_id, &before.project_id)?;
    }
    let title = input
        .title
        .as_deref()
        .map(|v| text(v, "title", TASK_TITLE_MAX))
        .transpose()?
        .unwrap_or(before.title.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| optional_text(v, "description", TASK_DESCRIPTION_MAX))
        .transpose()?
        .unwrap_or(before.description.clone());
    let deadline = match input.deadline {
        Some(value) => optional_date(value, "deadline")?,
        None => before.deadline.clone(),
    };
    let old_assignees = assignee_ids(tx, &input.task_id)?;
    let assignees = match input.assignee_ids {
        Some(ids) => {
            validate_assignees(
                tx,
                &before.project_id,
                ids.iter()
                    .filter(|id| !old_assignees.contains(id))
                    .cloned()
                    .collect(),
            )?;
            ids.into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        }
        None => old_assignees.clone(),
    };
    let old_set: HashSet<_> = old_assignees.iter().cloned().collect();
    let new_set: HashSet<_> = assignees.iter().cloned().collect();
    if epic_id == before.epic_id
        && title == before.title
        && description == before.description
        && deadline == before.deadline
        && new_set == old_set
    {
        return Err(AppError::validation("payload", "no task fields changed"));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE tasks SET epic_id=?1,title=?2,description=?3,deadline=?4,updated_at=?5,\
                     revision=?6 WHERE id=?7 AND revision=?8",
        params![
            epic_id,
            title,
            description,
            deadline,
            now,
            revision,
            input.task_id,
            expected
        ],
    )?;
    set_assignees(
        tx,
        &input.task_id,
        &actor.user_id,
        &old_assignees,
        &assignees,
        now,
    )?;
    let mut events = Vec::new();
    for (field, b, a) in [
        ("epicId", json!(before.epic_id), json!(epic_id)),
        ("title", json!(before.title), json!(title)),
        ("description", json!(before.description), json!(description)),
        ("deadline", json!(before.deadline), json!(deadline)),
    ] {
        if b != a {
            events.push(activity(
                tx,
                actor,
                ActivityInput {
                    project_id: Some(&before.project_id),
                    entity_type: "task",
                    entity_id: &input.task_id,
                    task_id: Some(&input.task_id),
                    event_type: "task.updated",
                    field_key: Some(field),
                    before: Some(b),
                    after: Some(a),
                    metadata: json!({}),
                    entity_revision: Some(revision),
                },
                now,
            )?);
        }
    }
    for user_id in old_set.difference(&new_set) {
        let field_key = format!("assignee:{user_id}");
        events.push(activity(
            tx,
            actor,
            ActivityInput {
                project_id: Some(&before.project_id),
                entity_type: "task",
                entity_id: &input.task_id,
                task_id: Some(&input.task_id),
                event_type: "task.assignee.removed",
                field_key: Some(&field_key),
                before: Some(json!(user_id)),
                // Null is a real canonical value here: it means this member is
                // absent from the task. Keeping it distinct from a missing
                // audit value lets the shared activity projector consolidate
                // assign -> unassign and unassign -> assign chains.
                after: Some(Value::Null),
                metadata: json!({}),
                entity_revision: Some(revision),
            },
            now,
        )?);
    }
    let newly_assigned: Vec<_> = new_set.difference(&old_set).cloned().collect();
    for user_id in &newly_assigned {
        let field_key = format!("assignee:{user_id}");
        events.push(activity(
            tx,
            actor,
            ActivityInput {
                project_id: Some(&before.project_id),
                entity_type: "task",
                entity_id: &input.task_id,
                task_id: Some(&input.task_id),
                event_type: "task.assignee.added",
                field_key: Some(&field_key),
                before: Some(Value::Null),
                after: Some(json!(user_id)),
                metadata: json!({}),
                entity_revision: Some(revision),
            },
            now,
        )?);
    }
    notify(
        tx,
        actor,
        NotificationInput {
            project_id: &before.project_id,
            event_type: "task.assigned",
            task_id: Some(&input.task_id),
            comment_id: None,
            block_id: None,
            excerpt: None,
            payload: json!({"broadcast":false}),
        },
        newly_assigned,
        now,
    )?;
    let mut entities = vec![task_entity(tx, &input.task_id)?];
    if epic_id != before.epic_id
        && matches!(before.status.as_str(), "in_progress" | "in_review")
        && let Some(event) = activate_epic_for_work(tx, actor, &before.project_id, &epic_id, now)?
    {
        entities.push(activated_epic_entity(&before.project_id, &event));
        events.push(event);
    }
    Ok(Mutation {
        entities,
        events,
        resource_type: Some("task".into()),
        resource_id: Some(input.task_id),
    })
}

pub(super) fn move_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: TaskMove,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = task_row(tx, &input.task_id)?;
    require_project(
        tx,
        actor,
        stored,
        &before.project_id,
        Permission::Board,
        false,
    )?;
    ensure_revision(before.revision, expected)?;
    let status = input.status.as_str();
    if status == "done" {
        let blocked: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_blocks WHERE task_id=?1 AND resolved_at IS NULL)",
            [&input.task_id],
            |row| row.get(0),
        )?;
        if blocked {
            return Err(AppError::PreconditionFailed(
                "resolve the block while completing this task".into(),
            ));
        }
    }
    let old_index: i64 = tx.query_row(
        "SELECT COUNT(*) FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL AND position < ?3",
        params![before.project_id, before.status, before.position], |r| r.get(0))?;
    let selector_count = usize::from(input.position.is_some())
        + usize::from(input.before_task_id.is_some())
        + usize::from(input.after_task_id.is_some());
    if selector_count > 1 || (selector_count == 0 && status == before.status) {
        return Err(AppError::validation(
            "position",
            "provide one of position, beforeTaskId or afterTaskId when reordering a column",
        ));
    }
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL AND id<>?3",
        params![before.project_id, status, input.task_id], |r| r.get(0))?;
    let position = if let Some(anchor) = input
        .before_task_id
        .as_deref()
        .or(input.after_task_id.as_deref())
    {
        let field = if input.before_task_id.is_some() {
            "beforeTaskId"
        } else {
            "afterTaskId"
        };
        let anchor_position: i64 = tx.query_row(
            "SELECT position FROM tasks WHERE id=?1 AND project_id=?2 AND status=?3 AND deleted_at IS NULL AND id<>?4",
            params![anchor, before.project_id, status, input.task_id], |r| r.get(0)).optional()?
            .ok_or_else(|| AppError::validation(field, "anchor is not in the destination column"))?;
        let index: i64 = tx.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL AND id<>?3 AND position<?4",
            params![before.project_id, status, input.task_id, anchor_position], |r| r.get(0))?;
        index + i64::from(input.after_task_id.is_some())
    } else {
        input
            .position
            .map(i64::try_from)
            .transpose()
            .map_err(|_| AppError::validation("position", "is outside the status column"))?
            .unwrap_or(count)
    };
    if position > count {
        return Err(AppError::validation(
            "position",
            "is outside the status column",
        ));
    }
    if status == before.status && old_index == position {
        return Err(AppError::validation(
            "position",
            "task is already at that position",
        ));
    }
    let stored_position =
        task_insert_position(tx, &before.project_id, status, &input.task_id, position)?;
    tx.execute(
        UPDATE_TASKS_SQL,
        params![
            status,
            stored_position,
            if status == "done" { Some(now) } else { None },
            now,
            input.task_id,
            expected
        ],
    )?;
    let activated = if matches!(input.status, TaskStatus::InProgress | TaskStatus::InReview) {
        activate_epic_for_work(tx, actor, &before.project_id, &before.epic_id, now)?
    } else {
        None
    };
    let revision = expected + 1;
    let entity = task_entity(tx, &input.task_id)?;
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "task",
            entity_id: &input.task_id,
            task_id: Some(&input.task_id),
            event_type: "task.moved",
            field_key: if status == before.status {
                Some("position")
            } else {
                Some("status")
            },
            before: Some(if status == before.status {
                json!(old_index)
            } else {
                json!(before.status)
            }),
            after: Some(if status == before.status {
                json!(position)
            } else {
                json!(status)
            }),
            metadata: json!({"position":position}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    let mut entities = vec![entity];
    let mut events = vec![event];
    if let Some(event) = activated {
        entities.push(activated_epic_entity(&before.project_id, &event));
        events.push(event);
    }
    Ok(Mutation {
        entities,
        events,
        resource_type: Some("task".into()),
        resource_id: Some(input.task_id),
    })
}

pub(super) fn delete_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = task_row(tx, &input.id)?;
    require_project(
        tx,
        actor,
        stored,
        &before.project_id,
        Permission::Board,
        true,
    )?;
    ensure_revision(before.revision, expected)?;
    tx.execute("UPDATE tasks SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    let entity = json!({"entityType":"task","id":input.id,"projectId":before.project_id,"deleted":true,"revision":expected+1});
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "task",
            entity_id: &input.id,
            task_id: Some(&input.id),
            event_type: "task.deleted",
            field_key: None,
            before: Some(json!({"taskKey":before.task_key,"title":before.title})),
            after: None,
            metadata: json!({}),
            entity_revision: Some(expected + 1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "task", &input.id))
}

/// Undoes a deletion within the Undo window, for the people who could delete
/// the task. Its comments and files never left; the history keeps both events.
pub(super) fn restore_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (before, deleted_at) = tx
        .query_row(
            "SELECT project_id,epic_id,task_key,title,description,status,deadline,revision,position,deleted_at
             FROM tasks WHERE id=?1",
            [&input.id],
            |row| {
                Ok((
                    TaskRow {
                        project_id: row.get(0)?,
                        epic_id: row.get(1)?,
                        task_key: row.get(2)?,
                        title: row.get(3)?,
                        description: row.get(4)?,
                        status: row.get(5)?,
                        deadline: row.get(6)?,
                        revision: row.get(7)?,
                        position: row.get(8)?,
                    },
                    row.get::<_, Option<i64>>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("task"))?;
    require_project(
        tx,
        actor,
        stored,
        &before.project_id,
        Permission::Board,
        true,
    )?;
    let Some(deleted_at) = deleted_at else {
        return Err(AppError::Conflict("the task is not deleted".into()));
    };
    ensure_revision(before.revision, expected)?;
    require_undo_window("task", deleted_at, now)?;
    let epic: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM epics WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL)",
        params![before.epic_id, before.project_id],
        |row| row.get(0),
    )?;
    if !epic {
        return Err(AppError::PreconditionFailed(
            "the task's epic was deleted, so the task can't be restored".into(),
        ));
    }
    // The task returns to its place unless another card took that position.
    let taken: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE project_id=?1 AND status=?2 AND position=?3 AND deleted_at IS NULL)",
        params![before.project_id, before.status, before.position],
        |row| row.get(0),
    )?;
    let position = if taken {
        task_append_position(tx, &before.project_id, &before.status)?
    } else {
        before.position
    };
    let revision = expected + 1;
    tx.execute(
        "UPDATE tasks SET deleted_at=NULL,position=?1,updated_at=?2,revision=?3
         WHERE id=?4 AND revision=?5 AND deleted_at IS NOT NULL",
        params![position, now, revision, input.id, expected],
    )?;
    let mut events = vec![activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "task",
            entity_id: &input.id,
            task_id: Some(&input.id),
            event_type: "task.restored",
            field_key: None,
            before: None,
            after: Some(json!({"taskKey":before.task_key,"title":before.title})),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?];
    let mut entities = vec![task_entity(tx, &input.id)?];
    if matches!(before.status.as_str(), "in_progress" | "in_review")
        && let Some(event) =
            activate_epic_for_work(tx, actor, &before.project_id, &before.epic_id, now)?
    {
        entities.push(activated_epic_entity(&before.project_id, &event));
        events.push(event);
    }
    Ok(Mutation {
        entities,
        events,
        resource_type: Some("task".into()),
        resource_id: Some(input.id),
    })
}
