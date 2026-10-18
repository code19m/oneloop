//! Creating, editing, moving, deleting and restoring tasks.
use super::checklist::{checklist_titles, insert_item};
use super::ordering::{placed, task_insert_position};
use super::validation::optional_date;
use super::*;

pub(super) fn create_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TaskCreate,
    now: i64,
    source_pool: Option<&str>,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Board, false)?;
    let (track_id, epic_id) = new_task_place(tx, &input.project_id, input.track_id, input.epic_id)?;
    let title = text::single_line(&input.title, "title", TASK_TITLE_MAX)?;
    let description = text::optional(&input.description, "description", TASK_DESCRIPTION_MAX)?;
    let deadline = optional_date(input.deadline, "deadline")?;
    let assignees = validate_assignees(tx, &input.project_id, input.assignee_ids)?;
    let checklist = checklist_titles(&input.checklist)?;
    let (number, prefix): (i64, String) = tx
        .query_row(
            "SELECT s.next_task_number,p.task_prefix FROM project_sequences s JOIN projects p ON \
                     p.id=s.project_id WHERE s.project_id=?1",
            [&input.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "project sequence",
        })?;
    tx.execute(
        "UPDATE project_sequences SET next_task_number=next_task_number+1 WHERE project_id=?1 AND \
                     next_task_number=?2",
        params![input.project_id, number],
    )?;
    let key = format!("{prefix}-{number:03}");
    let id = Uuid::now_v7().to_string();
    // A new task starts at the top of Planning, where every Board shows it.
    let (position, respaced) = task_insert_position(tx, &input.project_id, "planning", &id, 0)?;
    tx.execute(
        INSERT_TASK_SQL,
        params![
            id,
            input.project_id,
            track_id,
            epic_id,
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
    for (position, title) in checklist.iter().enumerate() {
        insert_item(tx, &id, position as i64, title, now)?;
    }
    let entity = task_entity(tx, &id)?;
    let event = record_activity_tx(
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
            metadata: placed(json!({"sourcePoolItemId":source_pool}), respaced),
            entity_revision: Some(1),
        },
        now,
    )?;
    snapshot_notification_tx(
        tx,
        actor,
        NotificationInput {
            project_id: &input.project_id,
            event_type: "task.assigned",
            task_id: Some(&id),
            comment_id: None,
            block_id: None,
            excerpt: None,
            broadcast: false,
        },
        assignees.clone(),
        now,
    )?;
    Ok(Mutation::one(entity, event, "task", &id))
}

pub(super) fn update_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    mut input: TaskUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    input.task_id = resolve_task_id(tx, &input.task_id)?;
    let before = task_row(tx, &input.task_id)?;
    require_project(tx, actor, &before.project_id, Need::Board, false)?;
    check_revision(expected, before.revision)?;
    let track_sent = input.track_id.is_some();
    let track_id = input.track_id.unwrap_or_else(|| before.track_id.clone());
    if track_id != before.track_id {
        roadmap::ensure_track_project(tx, &track_id, &before.project_id)?;
    }
    let epic_id = match input.epic_id {
        // An epic stays on its track, so a move to another track clears it.
        None if track_id != before.track_id => None,
        None => before.epic_id.clone(),
        Some(epic_id) => epic_id,
    };
    if let Some(epic) = epic_id.as_deref()
        && (epic_id != before.epic_id || track_id != before.track_id)
    {
        let epic_track = if epic_id == before.epic_id {
            before.track_id.clone()
        } else {
            open_epic_track(tx, epic, &before.project_id)?
        };
        if epic_track != track_id {
            return Err(AppError::validation(
                "epicId",
                if track_sent {
                    "epic is on another track than trackId"
                } else {
                    "epic is on another track than the task; send the epic's trackId to move the task"
                },
            ));
        }
    }
    let title = input
        .title
        .as_deref()
        .map(|v| text::single_line(v, "title", TASK_TITLE_MAX))
        .transpose()?
        .unwrap_or(before.title.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| text::optional(v, "description", TASK_DESCRIPTION_MAX))
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
    if track_id == before.track_id
        && epic_id == before.epic_id
        && title == before.title
        && description == before.description
        && deadline == before.deadline
        && new_set == old_set
    {
        return Err(AppError::validation("payload", "no task fields changed"));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE tasks SET track_id=?1,epic_id=?2,title=?3,description=?4,deadline=?5,updated_at=?6,\
                     revision=?7 WHERE id=?8 AND revision=?9",
        params![
            track_id,
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
        ("trackId", json!(before.track_id), json!(track_id)),
        ("epicId", json!(before.epic_id), json!(epic_id)),
        ("title", json!(before.title), json!(title)),
        ("description", json!(before.description), json!(description)),
        ("deadline", json!(before.deadline), json!(deadline)),
    ] {
        if b != a {
            events.push(record_activity_tx(
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
        events.push(record_activity_tx(
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
        events.push(record_activity_tx(
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
    snapshot_notification_tx(
        tx,
        actor,
        NotificationInput {
            project_id: &before.project_id,
            event_type: "task.assigned",
            task_id: Some(&input.task_id),
            comment_id: None,
            block_id: None,
            excerpt: None,
            broadcast: false,
        },
        newly_assigned,
        now,
    )?;
    let mut entities = vec![task_entity(tx, &input.task_id)?];
    if epic_id != before.epic_id
        && let Some(epic_id) = epic_id.as_deref()
        && matches!(before.status.as_str(), "in_progress" | "in_review")
        && let Some(event) = activate_epic_for_work(tx, actor, &before.project_id, epic_id, now)?
    {
        entities.push(activated_epic_entity(&before.project_id, &event));
        events.push(event);
    }
    Ok(Mutation {
        entities,
        events,
        resource_type: "task",
        resource_id: Some(input.task_id),
    })
}

pub(super) fn move_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    mut input: TaskMove,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    input.task_id = resolve_task_id(tx, &input.task_id)?;
    let before = task_row(tx, &input.task_id)?;
    require_project(tx, actor, &before.project_id, Need::Board, false)?;
    check_revision(expected, before.revision)?;
    let status = input.status.as_str();
    if status == "done" {
        let blocked: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_blocks WHERE task_id=?1 AND resolved_at IS NULL)",
            [&input.task_id],
            |row| row.get(0),
        )?;
        if blocked {
            return Err(AppError::PreconditionFailed(
                "the task is blocked; task.unblock-and-complete resolves the block and completes it"
                    .into(),
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
    // The task's index in the destination column, which the activity records.
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
        let not_in_column =
            || AppError::validation(field, "anchor is not in the destination column");
        // An anchor that names no task is not in the column either.
        let anchor = match resolve_task_id(tx, anchor) {
            Err(AppError::NotFound { .. }) => return Err(not_in_column()),
            anchor => anchor?,
        };
        let anchor_position: i64 = tx.query_row(
            "SELECT position FROM tasks WHERE id=?1 AND project_id=?2 AND status=?3 AND deleted_at IS NULL AND id<>?4",
            params![anchor, before.project_id, status, input.task_id], |r| r.get(0)).optional()?
            .ok_or_else(not_in_column)?;
        let index: i64 = tx.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL AND id<>?3 AND position<?4",
            params![before.project_id, status, input.task_id, anchor_position], |r| r.get(0))?;
        index + i64::from(input.after_task_id.is_some())
    } else {
        // Without a place, a task goes to the top of its new column, where
        // every Board shows it.
        input
            .position
            .map(i64::try_from)
            .transpose()
            .map_err(|_| AppError::validation("position", "is outside the status column"))?
            .unwrap_or(0)
    };
    if status == before.status && position == old_index {
        return Err(AppError::validation(
            "position",
            "task is already at that position",
        ));
    }
    let (stored_position, respaced) =
        task_insert_position(tx, &before.project_id, status, &input.task_id, position)?;
    tx.execute(
        MOVE_TASK_SQL,
        params![
            status,
            stored_position,
            if status == "done" { Some(now) } else { None },
            now,
            input.task_id,
            expected
        ],
    )?;
    let activated = match before.epic_id.as_deref() {
        Some(epic_id) if matches!(input.status, TaskStatus::InProgress | TaskStatus::InReview) => {
            activate_epic_for_work(tx, actor, &before.project_id, epic_id, now)?
        }
        _ => None,
    };
    let revision = expected + 1;
    let entity = task_entity(tx, &input.task_id)?;
    let event = record_activity_tx(
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
            metadata: placed(json!({"position":position}), respaced),
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
        resource_type: "task",
        resource_id: Some(input.task_id),
    })
}

pub(super) fn delete_task(
    tx: &Transaction<'_>,
    actor: &Actor,
    mut input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    input.id = resolve_task_id(tx, &input.id)?;
    let before = task_row(tx, &input.id)?;
    require_project(tx, actor, &before.project_id, Need::Board, true)?;
    check_revision(expected, before.revision)?;
    tx.execute("UPDATE tasks SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    let entity = deleted("task", &input.id, &before.project_id, expected + 1);
    let event = record_activity_tx(
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
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (before, deleted_at) = tx
        .query_row(
            &format!("SELECT {TASK_ROW_COLUMNS},deleted_at FROM tasks WHERE id=?1"),
            [&input.id],
            |row| Ok((TaskRow::from_row(row)?, row.get::<_, Option<i64>>(10)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "task" })?;
    require_project(tx, actor, &before.project_id, Need::Board, true)?;
    let Some(deleted_at) = deleted_at else {
        return Err(AppError::Conflict("the task is not deleted".into()));
    };
    check_revision(expected, before.revision)?;
    require_undo_window("task", deleted_at, now)?;
    // A purge that already claimed its files would remove them from the
    // restored task, as after the clock stepped back.
    let purging: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_attachments a JOIN file_deletion_jobs j ON j.blob_id=a.blob_id
                       WHERE a.task_id=?1 AND a.deleted_at IS NULL AND j.reason<>'cleanup')",
        [&input.id],
        |row| row.get(0),
    )?;
    if purging {
        return Err(AppError::Conflict(
            "the task's files are being removed, so it can no longer be restored".into(),
        ));
    }
    // A track whose only tasks are deleted counts as empty, so it may have
    // been deleted meanwhile; the task then stays deleted.
    let track: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tracks WHERE id=?1 AND deleted_at IS NULL)",
        [&before.track_id],
        |row| row.get(0),
    )?;
    if !track {
        return Err(AppError::PreconditionFailed(
            "the task's track was deleted, so the task can't be restored".into(),
        ));
    }
    // An epic deleted meanwhile leaves the task on its track without one.
    let epic_id = match before.epic_id.as_deref() {
        Some(epic_id) => tx
            .query_row(
                "SELECT id FROM epics WHERE id=?1 AND track_id=?2 AND deleted_at IS NULL",
                params![epic_id, before.track_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
        None => None,
    };
    // The task returns to its position. When another card took it, as a top
    // insert takes a deleted top card's, the task goes back to the same place
    // among the cards around it: below as many cards as were above it.
    let taken: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE project_id=?1 AND status=?2 AND position=?3 AND deleted_at IS NULL)",
        params![before.project_id, before.status, before.position],
        |row| row.get(0),
    )?;
    let (position, respaced) = if taken {
        let index: i64 = tx.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project_id=?1 AND status=?2 AND position<?3 AND deleted_at IS NULL",
            params![before.project_id, before.status, before.position],
            |row| row.get(0),
        )?;
        task_insert_position(tx, &before.project_id, &before.status, &input.id, index)?
    } else {
        (before.position, false)
    };
    let revision = expected + 1;
    tx.execute(
        "UPDATE tasks SET deleted_at=NULL,epic_id=?1,position=?2,updated_at=?3,revision=?4
         WHERE id=?5 AND revision=?6 AND deleted_at IS NOT NULL",
        params![epic_id, position, now, revision, input.id, expected],
    )?;
    // Removing a member needs their unfinished tasks reassigned first, which
    // skips deleted tasks. So people who left meanwhile come off an
    // unfinished task here; a Done task keeps them, as it does when they leave.
    let departed: Vec<String> = if before.status == "done" {
        Vec::new()
    } else {
        let mut statement = tx.prepare(
            "SELECT a.user_id FROM task_assignees a WHERE a.task_id=?1
               AND NOT EXISTS(SELECT 1 FROM project_memberships m
                              WHERE m.user_id=a.user_id AND m.project_id=?2)
             ORDER BY a.user_id",
        )?;
        statement
            .query_map(params![input.id, before.project_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?
    };
    let mut events = Vec::new();
    for user_id in &departed {
        tx.execute(
            "DELETE FROM task_assignees WHERE task_id=?1 AND user_id=?2",
            params![input.id, user_id],
        )?;
    }
    events.push(record_activity_tx(
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
            metadata: placed(json!({}), respaced),
            entity_revision: Some(revision),
        },
        now,
    )?);
    if epic_id != before.epic_id {
        events.push(record_activity_tx(
            tx,
            actor,
            ActivityInput {
                project_id: Some(&before.project_id),
                entity_type: "task",
                entity_id: &input.id,
                task_id: Some(&input.id),
                event_type: "task.updated",
                field_key: Some("epicId"),
                before: Some(json!(before.epic_id)),
                after: Some(Value::Null),
                metadata: json!({}),
                entity_revision: Some(revision),
            },
            now,
        )?);
    }
    for user_id in departed {
        let field_key = format!("assignee:{user_id}");
        events.push(record_activity_tx(
            tx,
            actor,
            ActivityInput {
                project_id: Some(&before.project_id),
                entity_type: "task",
                entity_id: &input.id,
                task_id: Some(&input.id),
                event_type: "task.assignee.removed",
                field_key: Some(&field_key),
                before: Some(json!(user_id)),
                after: Some(Value::Null),
                metadata: json!({}),
                entity_revision: Some(revision),
            },
            now,
        )?);
    }
    let mut entities = vec![task_entity(tx, &input.id)?];
    if matches!(before.status.as_str(), "in_progress" | "in_review")
        && let Some(epic_id) = epic_id.as_deref()
        && let Some(event) = activate_epic_for_work(tx, actor, &before.project_id, epic_id, now)?
    {
        entities.push(activated_epic_entity(&before.project_id, &event));
        events.push(event);
    }
    Ok(Mutation {
        entities,
        events,
        resource_type: "task",
        resource_id: Some(input.id),
    })
}
