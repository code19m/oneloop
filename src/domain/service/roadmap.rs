//! Tracks, epics and milestones.
use super::ordering::{active_ids, compact_positions, resequence};
use super::validation::{date, optional_date};
use super::*;
use crate::collaboration::record_follow_up_activity_tx;

pub(super) fn create_track(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TrackCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Roadmap, false)?;
    let name = text::single_line(&input.name, "name", NAME_MAX)?;
    let position: i64 = tx.query_row(NEXT_TRACK_POSITION_SQL, [&input.project_id], |row| {
        row.get(0)
    })?;
    let id = Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO tracks (id,project_id,name,position,created_by,created_at,updated_at) \
                     VALUES (?1,?2,?3,?4,?5,?6,?6)",
        params![id, input.project_id, name, position, actor.user_id, now],
    )?;
    let entity = Entity::Track(TrackView {
        id: id.clone(),
        project_id: input.project_id.clone(),
        name,
        position,
        revision: 1,
    })
    .value()?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "track",
            entity_id: &id,
            task_id: None,
            event_type: "track.created",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: json!({}),
            entity_revision: Some(1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "track", &id))
}

pub(super) fn update_track(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TrackUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = tx
        .query_row(
            "SELECT project_id,name,position,revision FROM tracks WHERE id=?1 AND deleted_at IS NULL",
            [&input.track_id],
            TrackRow::from_row,
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "track" })?;
    require_project(tx, actor, &before.project_id, Need::Roadmap, false)?;
    check_revision(expected, before.revision)?;
    let name = text::single_line(&input.name, "name", NAME_MAX)?;
    if name == before.name {
        return Err(AppError::validation("payload", "no track fields changed"));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE tracks SET name=?1,updated_at=?2,revision=?3 WHERE id=?4 AND revision=?5",
        params![name, now, revision, input.track_id, expected],
    )?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "track",
            entity_id: &input.track_id,
            task_id: None,
            event_type: "track.updated",
            field_key: None,
            before: Some(json!({"name":before.name})),
            after: Some(json!({"name":name})),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    let entity = Entity::Track(TrackView {
        id: input.track_id.clone(),
        project_id: before.project_id,
        name,
        position: before.position,
        revision,
    })
    .value()?;
    Ok(Mutation::one(entity, event, "track", &input.track_id))
}

pub(super) fn reorder_track(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TrackReorder,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (project_id, revision): (String, i64) = tx
        .query_row(
            "SELECT project_id,revision FROM tracks WHERE id=?1 AND deleted_at IS NULL",
            [&input.track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "track" })?;
    require_project(tx, actor, &project_id, Need::Roadmap, false)?;
    check_revision(expected, revision)?;
    let mut ids = active_ids(tx, "tracks", "project_id", &project_id, None)?;
    let old = ids
        .iter()
        .position(|id| id == &input.track_id)
        .ok_or(AppError::NotFound { resource: "track" })?;
    if input.position >= ids.len() {
        return Err(AppError::validation(
            "position",
            "is outside the track list",
        ));
    }
    if input.position == old {
        return Err(AppError::validation(
            "position",
            "track is already at that position",
        ));
    }
    let id = ids.remove(old);
    ids.insert(input.position, id);
    resequence(tx, "tracks", &ids, now, Some((&input.track_id, expected)))?;
    let updated_revision = expected + 1;
    let entity = json!({
    "entityType":"track",
    "id":input.track_id,
    "projectId":project_id,
    "position":input.position,
    "revision":updated_revision
    });
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "track",
            entity_id: &input.track_id,
            task_id: None,
            event_type: "track.reordered",
            field_key: Some("position"),
            before: Some(json!(old)),
            after: Some(json!(input.position)),
            metadata: json!({}),
            entity_revision: Some(updated_revision),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "track", &input.track_id))
}

pub(super) fn delete_track(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (project_id, revision): (String, i64) = tx
        .query_row(
            "SELECT project_id,revision FROM tracks WHERE id=?1 AND deleted_at IS NULL",
            [&input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "track" })?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    check_revision(expected, revision)?;
    // Only an empty track goes, so no task or epic is ever left without one.
    // Deleted tasks don't count: restoring one of them is refused instead.
    let (tasks, epics): (i64, i64) = tx.query_row(
        super::super::reads::TRACK_CONTENTS_SQL,
        params![project_id, input.id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if tasks + epics > 0 {
        let count = |count: i64, one: &str| match count {
            0 => None,
            1 => Some(format!("1 {one}")),
            _ => Some(format!("{count} {one}s")),
        };
        let contents = [count(tasks, "task"), count(epics, "epic")]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" and ");
        return Err(AppError::PreconditionFailed(format!(
            "Move or delete its {contents} first"
        )));
    }
    tx.execute("UPDATE tracks SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    compact_positions(tx, "tracks", "project_id", &project_id, None, now)?;
    let entity = deleted("track", &input.id, &project_id, revision + 1);
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "track",
            entity_id: &input.id,
            task_id: None,
            event_type: "track.deleted",
            field_key: None,
            before: Some(json!({"id":input.id})),
            after: None,
            metadata: json!({}),
            entity_revision: Some(revision + 1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "track", &input.id))
}

pub(super) fn create_epic(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EpicCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Roadmap, false)?;
    ensure_track_project(tx, &input.track_id, &input.project_id)?;
    let title = text::single_line(&input.title, "title", EPIC_TITLE_MAX)?;
    let description = text::optional(&input.description, "description", EPIC_DESCRIPTION_MAX)?;
    let start = date(&input.start_date, "startDate")?;
    let end = optional_date(input.end_date, "endDate")?;
    if end.as_deref().is_some_and(|value| value < start.as_str()) {
        return Err(AppError::validation(
            "endDate",
            "cannot be before startDate",
        ));
    }
    let position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position),-1)+1 FROM epics WHERE track_id=?1 AND deleted_at IS NULL",
        [&input.track_id],
        |row| row.get(0),
    )?;
    let id = Uuid::now_v7().to_string();
    tx.execute(
        INSERT_EPIC_SQL,
        params![
            id,
            input.project_id,
            input.track_id,
            title,
            description,
            start,
            end,
            position,
            actor.user_id,
            now
        ],
    )?;
    let mut epic = EpicView {
        id: id.clone(),
        project_id: input.project_id.clone(),
        track_id: input.track_id,
        title,
        description,
        start_date: start,
        end_date: end,
        state: "planning".into(),
        position,
        summary: None,
        revision: 1,
    };
    let entity = Entity::Epic(epic.clone()).value()?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "epic",
            entity_id: &id,
            task_id: None,
            event_type: "epic.created",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: json!({}),
            entity_revision: Some(1),
        },
        now,
    )?;
    // A new epic has no tasks. With its counts, the Roadmap that created it
    // shows 0/0 at once instead of waiting for a read; the activity above
    // records only the epic.
    epic.summary = Some(EpicSummary {
        task_total: 0,
        task_done: 0,
        task_open: 0,
        completed_this_week: 0,
        completed_since_start: 0,
        weekly_completions: vec![0; 7],
    });
    Ok(Mutation::one(
        Entity::Epic(epic).value()?,
        event,
        "epic",
        &id,
    ))
}

pub(super) fn update_epic(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EpicUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = tx
        .query_row(EPIC_ROW_SQL, [&input.epic_id], EpicRow::from_row)
        .optional()?
        .ok_or(AppError::NotFound { resource: "epic" })?;
    require_project(tx, actor, &before.project_id, Need::Roadmap, false)?;
    check_revision(expected, before.revision)?;
    let track_id = input.track_id.unwrap_or(before.track_id.clone());
    ensure_track_project(tx, &track_id, &before.project_id)?;
    let title = input
        .title
        .as_deref()
        .map(|v| text::single_line(v, "title", EPIC_TITLE_MAX))
        .transpose()?
        .unwrap_or(before.title.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| text::optional(v, "description", EPIC_DESCRIPTION_MAX))
        .transpose()?
        .unwrap_or(before.description.clone());
    let start = input
        .start_date
        .as_deref()
        .map(|v| date(v, "startDate"))
        .transpose()?
        .unwrap_or(before.start_date.clone());
    let end = match input.end_date {
        Some(v) => optional_date(v, "endDate")?,
        None => before.end_date.clone(),
    };
    if end.as_deref().is_some_and(|value| value < start.as_str()) {
        return Err(AppError::validation(
            "endDate",
            "cannot be before startDate",
        ));
    }
    let mut position = before.position;
    if track_id != before.track_id {
        position=tx.query_row("SELECT COALESCE(MAX(position),-1)+1 FROM epics WHERE track_id=?1 AND deleted_at IS NULL",[&track_id],|row|row.get(0))?;
    }
    if track_id == before.track_id
        && title == before.title
        && description == before.description
        && start == before.start_date
        && end == before.end_date
    {
        return Err(AppError::validation("payload", "no epic fields changed"));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE epics SET track_id=?1,title=?2,description=?3,start_date=?4,end_date=?5,\
                     position=?6,updated_at=?7,revision=?8 WHERE id=?9 AND revision=?10",
        params![
            track_id,
            title,
            description,
            start,
            end,
            position,
            now,
            revision,
            input.epic_id,
            expected
        ],
    )?;
    if track_id != before.track_id {
        compact_positions(tx, "epics", "track_id", &before.track_id, None, now)?;
        move_epic_tasks(
            tx,
            actor,
            &before.project_id,
            &input.epic_id,
            (&before.track_id, &track_id),
            now,
        )?;
    }
    let mut events = Vec::new();
    for (field, old, new) in [
        ("trackId", json!(before.track_id), json!(track_id)),
        ("title", json!(before.title), json!(title)),
        ("description", json!(before.description), json!(description)),
        ("startDate", json!(before.start_date), json!(start)),
        ("endDate", json!(before.end_date), json!(end)),
    ] {
        if old == new {
            continue;
        }
        events.push(record_activity_tx(
            tx,
            actor,
            ActivityInput {
                project_id: Some(&before.project_id),
                entity_type: "epic",
                entity_id: &input.epic_id,
                task_id: None,
                event_type: "epic.updated",
                field_key: Some(field),
                before: Some(old),
                after: Some(new),
                metadata: json!({}),
                entity_revision: Some(revision),
            },
            now,
        )?);
    }
    let entity = Entity::Epic(EpicView {
        id: input.epic_id.clone(),
        project_id: before.project_id,
        track_id,
        title,
        description,
        start_date: start,
        end_date: end,
        state: before.state,
        position,
        summary: None,
        revision,
    })
    .value()?;
    Ok(Mutation::new(entity, events, "epic", &input.epic_id))
}

pub(super) fn complete_epic(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    set_epic_state(tx, actor, &input.id, expected, "done", now)
}

pub(super) fn reopen_epic(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let work: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE epic_id=?1 AND deleted_at IS NULL AND status IN \
                     ('in_progress','in_review'))",
        [&input.id],
        |row| row.get(0),
    )?;
    set_epic_state(
        tx,
        actor,
        &input.id,
        expected,
        if work { "active" } else { "planning" },
        now,
    )
}

pub(super) fn set_epic_state(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    expected: i64,
    state: &str,
    now: i64,
) -> AppResult<Mutation> {
    let (project_id, before, revision): (String, String, i64) = tx
        .query_row(
            "SELECT project_id,state,revision FROM epics WHERE id=?1 AND deleted_at IS NULL",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "epic" })?;
    require_project(tx, actor, &project_id, Need::Roadmap, false)?;
    check_revision(expected, revision)?;
    if before == state {
        return Err(AppError::validation(
            "state",
            "epic is already in the requested state",
        ));
    }
    if state != "done" && before != "done" {
        return Err(AppError::PreconditionFailed(
            "only completed epics can be explicitly reopened".into(),
        ));
    }
    let next = expected + 1;
    tx.execute(
        SET_EPIC_STATE_SQL,
        params![
            state,
            if state == "done" { Some(now) } else { None },
            now,
            next,
            id,
            expected
        ],
    )?;
    let entity =
        json!({"entityType":"epic","id":id,"projectId":project_id,"state":state,"revision":next});
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "epic",
            entity_id: id,
            task_id: None,
            event_type: if state == "done" {
                "epic.completed"
            } else {
                "epic.reopened"
            },
            field_key: Some("state"),
            before: Some(json!(before)),
            after: Some(json!(state)),
            metadata: json!({}),
            entity_revision: Some(next),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "epic", id))
}

pub(super) fn delete_epic(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (project_id, track_id, revision): (String, String, i64) = tx
        .query_row(
            "SELECT project_id,track_id,revision FROM epics WHERE id=?1 AND deleted_at IS NULL",
            [&input.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "epic" })?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    check_revision(expected, revision)?;
    // Its tasks stay on its track without an epic. Deleted ones keep it, so
    // after the epic's Undo, restoring one puts it back in the epic.
    let detached = update_tasks(
        tx,
        "UPDATE tasks SET epic_id=NULL,updated_at=?1,revision=revision+1
         WHERE epic_id=?2 AND deleted_at IS NULL RETURNING id,revision",
        params![now, input.id],
    )?;
    for (task_id, task_revision) in &detached {
        record_follow_up_activity_tx(
            tx,
            actor,
            epic_change(&project_id, task_id, *task_revision, Some(&input.id), None),
            now,
        )?;
    }
    tx.execute("UPDATE epics SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    compact_positions(tx, "epics", "track_id", &track_id, None, now)?;
    let entity = deleted("epic", &input.id, &project_id, revision + 1);
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "epic",
            entity_id: &input.id,
            task_id: None,
            event_type: "epic.deleted",
            field_key: None,
            before: Some(json!({"id":input.id})),
            after: None,
            metadata: json!({}),
            entity_revision: Some(revision + 1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "epic", &input.id))
}

/// Undoes an epic's deletion within the Undo window. The tasks that the
/// deletion left without an epic come back to it, when they are still on its
/// track without one.
pub(super) fn restore_epic(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (project_id, track_id, title, position, revision, deleted_at): (
        String,
        String,
        String,
        i64,
        i64,
        Option<i64>,
    ) = tx
        .query_row(
            "SELECT project_id,track_id,title,position,revision,deleted_at FROM epics WHERE id=?1",
            [&input.id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "epic" })?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    let Some(deleted_at) = deleted_at else {
        return Err(AppError::Conflict("the epic is not deleted".into()));
    };
    check_revision(expected, revision)?;
    require_undo_window("epic", deleted_at, now)?;
    let track: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tracks WHERE id=?1 AND deleted_at IS NULL)",
        [&track_id],
        |row| row.get(0),
    )?;
    if !track {
        return Err(AppError::PreconditionFailed(
            "the epic's track was deleted, so the epic can't be restored".into(),
        ));
    }
    // The epic returns to its place, or to the end of its track's epics when
    // another one took it.
    let taken: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM epics WHERE track_id=?1 AND position=?2 AND deleted_at IS NULL)",
        params![track_id, position],
        |row| row.get(0),
    )?;
    let position: i64 = if taken {
        tx.query_row(
            "SELECT COALESCE(MAX(position),-1)+1 FROM epics WHERE track_id=?1 AND deleted_at IS NULL",
            [&track_id],
            |row| row.get(0),
        )?
    } else {
        position
    };
    let revision = expected + 1;
    tx.execute(
        "UPDATE epics SET deleted_at=NULL,position=?1,updated_at=?2,revision=?3
         WHERE id=?4 AND revision=?5 AND deleted_at IS NOT NULL",
        params![position, now, revision, input.id, expected],
    )?;
    // The deletion's activity names the tasks it left without an epic.
    let relinked = update_tasks(
        tx,
        "UPDATE tasks SET epic_id=?1,updated_at=?2,revision=revision+1
         FROM (SELECT entity_id FROM activity_events
               WHERE project_id=?3 AND created_at=?4 AND entity_type='task'
                 AND event_type='task.updated' AND field_key='epicId' AND before_json=?5
                 AND json_extract(metadata_json,'$.epicDeleted')) AS detached
         WHERE tasks.id=detached.entity_id AND tasks.track_id=?6 AND tasks.epic_id IS NULL
           AND tasks.deleted_at IS NULL
         RETURNING tasks.id,tasks.revision",
        params![
            input.id,
            now,
            project_id,
            deleted_at,
            json!(input.id).to_string(),
            track_id
        ],
    )?;
    for (task_id, task_revision) in &relinked {
        record_follow_up_activity_tx(
            tx,
            actor,
            epic_change(&project_id, task_id, *task_revision, None, Some(&input.id)),
            now,
        )?;
    }
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "epic",
            entity_id: &input.id,
            task_id: None,
            event_type: "epic.restored",
            field_key: None,
            before: None,
            after: Some(json!({"title":title})),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    let epic = tx.query_row(EPIC_ROW_SQL, [&input.id], EpicRow::from_row)?;
    let entity = Entity::Epic(EpicView {
        id: input.id.clone(),
        project_id: epic.project_id,
        track_id: epic.track_id,
        title: epic.title,
        description: epic.description,
        start_date: epic.start_date,
        end_date: epic.end_date,
        state: epic.state,
        position: epic.position,
        summary: None,
        revision: epic.revision,
    })
    .value()?;
    Ok(Mutation::one(entity, event, "epic", &input.id))
}

/// Moves an epic's tasks with it to its new track, deleted ones too, so that
/// restoring one puts it back in its epic. Each task that isn't deleted gets
/// a revision and activity of its own; the epic's event announces them all.
fn move_epic_tasks(
    tx: &Transaction<'_>,
    actor: &Actor,
    project_id: &str,
    epic_id: &str,
    (from, to): (&str, &str),
    now: i64,
) -> AppResult<()> {
    let moved = update_tasks(
        tx,
        "UPDATE tasks SET track_id=?1,updated_at=?2,revision=revision+1
         WHERE epic_id=?3 AND deleted_at IS NULL RETURNING id,revision",
        params![to, now, epic_id],
    )?;
    tx.execute(
        "UPDATE tasks SET track_id=?1 WHERE epic_id=?2 AND deleted_at IS NOT NULL",
        params![to, epic_id],
    )?;
    for (task_id, revision) in &moved {
        record_follow_up_activity_tx(
            tx,
            actor,
            ActivityInput {
                project_id: Some(project_id),
                entity_type: "task",
                entity_id: task_id,
                task_id: Some(task_id),
                event_type: "task.updated",
                field_key: Some("trackId"),
                before: Some(json!(from)),
                after: Some(json!(to)),
                metadata: json!({"epicId":epic_id}),
                entity_revision: Some(*revision),
            },
            now,
        )?;
    }
    Ok(())
}

/// Runs an UPDATE of tasks that returns the ID and new revision of each task
/// it changed.
fn update_tasks(
    tx: &Transaction<'_>,
    sql: &str,
    params: impl rusqlite::Params,
) -> AppResult<Vec<(String, i64)>> {
    Ok(tx
        .prepare(sql)?
        .query_map(params, |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?)
}

/// The activity of a task that its epic's deletion took out of the epic, or
/// its Undo put back.
fn epic_change<'a>(
    project_id: &'a str,
    task_id: &'a str,
    revision: i64,
    before: Option<&str>,
    after: Option<&str>,
) -> ActivityInput<'a> {
    ActivityInput {
        project_id: Some(project_id),
        entity_type: "task",
        entity_id: task_id,
        task_id: Some(task_id),
        event_type: "task.updated",
        field_key: Some("epicId"),
        before: Some(json!(before)),
        after: Some(json!(after)),
        metadata: if after.is_none() {
            json!({"epicDeleted":true})
        } else {
            json!({"epicRestored":true})
        },
        entity_revision: Some(revision),
    }
}

pub(super) fn create_milestone(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: MilestoneCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Roadmap, false)?;
    let title = text::single_line(&input.title, "title", NAME_MAX)?;
    let description = text::optional(&input.description, "description", MILESTONE_DESCRIPTION_MAX)?;
    let milestone_date = date(&input.milestone_date, "milestoneDate")?;
    let id = Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO milestones (id,project_id,title,description,milestone_date,created_by,\
                     created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        params![
            id,
            input.project_id,
            title,
            description,
            milestone_date,
            actor.user_id,
            now
        ],
    )?;
    let entity = Entity::Milestone(MilestoneView {
        id: id.clone(),
        project_id: input.project_id.clone(),
        title,
        description,
        milestone_date,
        revision: 1,
    })
    .value()?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "milestone",
            entity_id: &id,
            task_id: None,
            event_type: "milestone.created",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: json!({}),
            entity_revision: Some(1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "milestone", &id))
}

pub(super) fn update_milestone(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: MilestoneUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = tx
        .query_row(
            MILESTONE_ROW_SQL,
            [&input.milestone_id],
            MilestoneRow::from_row,
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "milestone",
        })?;
    require_project(tx, actor, &before.project_id, Need::Roadmap, false)?;
    check_revision(expected, before.revision)?;
    let title = input
        .title
        .as_deref()
        .map(|v| text::single_line(v, "title", NAME_MAX))
        .transpose()?
        .unwrap_or(before.title.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| text::optional(v, "description", MILESTONE_DESCRIPTION_MAX))
        .transpose()?
        .unwrap_or(before.description.clone());
    let milestone_date = input
        .milestone_date
        .as_deref()
        .map(|v| date(v, "milestoneDate"))
        .transpose()?
        .unwrap_or(before.milestone_date.clone());
    if title == before.title
        && description == before.description
        && milestone_date == before.milestone_date
    {
        return Err(AppError::validation(
            "payload",
            "no milestone fields changed",
        ));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE milestones SET title=?1,description=?2,milestone_date=?3,updated_at=?4,\
                     revision=?5 WHERE id=?6 AND revision=?7",
        params![
            title,
            description,
            milestone_date,
            now,
            revision,
            input.milestone_id,
            expected
        ],
    )?;
    let entity = Entity::Milestone(MilestoneView {
        id: input.milestone_id.clone(),
        project_id: before.project_id.clone(),
        title,
        description,
        milestone_date,
        revision,
    })
    .value()?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "milestone",
            entity_id: &input.milestone_id,
            task_id: None,
            event_type: "milestone.updated",
            field_key: None,
            before: Some(
                json!({"title":before.title,"description":before.description,"milestoneDate":before.milestone_date}),
            ),
            after: Some(entity.clone()),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    Ok(Mutation::one(
        entity,
        event,
        "milestone",
        &input.milestone_id,
    ))
}

pub(super) fn delete_milestone(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let (project_id, revision): (String, i64) = tx
        .query_row(
            "SELECT project_id,revision FROM milestones WHERE id=?1 AND deleted_at IS NULL",
            [&input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "milestone",
        })?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    check_revision(expected, revision)?;
    tx.execute("UPDATE milestones SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    let entity = deleted("milestone", &input.id, &project_id, revision + 1);
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&project_id),
            entity_type: "milestone",
            entity_id: &input.id,
            task_id: None,
            event_type: "milestone.deleted",
            field_key: None,
            before: Some(json!({"id":input.id})),
            after: None,
            metadata: json!({}),
            entity_revision: Some(revision + 1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "milestone", &input.id))
}

pub(super) fn ensure_track_project(
    tx: &Transaction<'_>,
    track_id: &str,
    project_id: &str,
) -> AppResult<()> {
    let valid: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tracks WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL)",
        params![track_id, project_id],
        |row| row.get(0),
    )?;
    if !valid {
        return Err(AppError::validation(
            "trackId",
            "track does not belong to this project",
        ));
    }
    Ok(())
}
