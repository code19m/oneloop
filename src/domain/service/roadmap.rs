//! Roadmap writes require roadmap permission and retain revision and child-deletion guards.
use super::*;

pub(super) fn create_track(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: TrackCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Roadmap, false)?;
    let name = text::single_line(&input.name, "name", NAME_MAX)?;
    let description = text::optional(&input.description, "description", TRACK_DESCRIPTION_MAX)?;
    let position: i64 = tx.query_row(NEXT_TRACK_POSITION_SQL, [&input.project_id], |row| {
        row.get(0)
    })?;
    let id = Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO tracks (id,project_id,name,description,position,created_by,created_at,\
                     updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
        params![
            id,
            input.project_id,
            name,
            description,
            position,
            actor.user_id,
            now
        ],
    )?;
    let entity = Entity::Track(TrackView {
        id: id.clone(),
        project_id: input.project_id.clone(),
        name,
        description,
        position,
        revision: 1,
    })
    .value()?;
    let event = activity(
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
            "SELECT project_id,name,description,position,revision FROM tracks WHERE id=?1 AND \
                     deleted_at IS NULL",
            [&input.track_id],
            TrackRow::from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("track"))?;
    require_project(tx, actor, &before.project_id, Need::Roadmap, false)?;
    ensure_revision(before.revision, expected)?;
    let name = input
        .name
        .as_deref()
        .map(|v| text::single_line(v, "name", NAME_MAX))
        .transpose()?
        .unwrap_or(before.name.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| text::optional(v, "description", TRACK_DESCRIPTION_MAX))
        .transpose()?
        .unwrap_or(before.description.clone());
    if name == before.name && description == before.description {
        return Err(AppError::validation("payload", "no track fields changed"));
    }
    let revision = expected + 1;
    tx.execute("UPDATE tracks SET name=?1,description=?2,updated_at=?3,revision=?4 WHERE id=?5 AND revision=?6",params![name,description,now,revision,input.track_id,expected])?;
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "track",
            entity_id: &input.track_id,
            task_id: None,
            event_type: "track.updated",
            field_key: None,
            before: Some(json!({"name":before.name,"description":before.description})),
            after: Some(json!({"name":name,"description":description})),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    let entity = Entity::Track(TrackView {
        id: input.track_id.clone(),
        project_id: before.project_id,
        name,
        description,
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
        .ok_or_else(|| not_found("track"))?;
    require_project(tx, actor, &project_id, Need::Roadmap, false)?;
    ensure_revision(revision, expected)?;
    let mut ids = active_ids(tx, "tracks", "project_id", &project_id, None)?;
    let old = ids
        .iter()
        .position(|id| id == &input.track_id)
        .ok_or_else(|| not_found("track"))?;
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
    let event = activity(
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
        .ok_or_else(|| not_found("track"))?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    ensure_revision(revision, expected)?;
    let has_children: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM epics WHERE track_id=?1 AND deleted_at IS NULL)",
        [&input.id],
        |row| row.get(0),
    )?;
    if has_children {
        return Err(AppError::PreconditionFailed(
            "move or delete this track's epics first".into(),
        ));
    }
    tx.execute("UPDATE tracks SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    compact_positions(tx, "tracks", "project_id", &project_id, None, now)?;
    let entity = deleted("track", &input.id, &project_id, revision + 1);
    let event = activity(
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
    let event = activity(
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
        .ok_or_else(|| not_found("epic"))?;
    require_project(tx, actor, &before.project_id, Need::Roadmap, false)?;
    ensure_revision(before.revision, expected)?;
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
        events.push(activity(
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
        .ok_or_else(|| not_found("epic"))?;
    require_project(tx, actor, &project_id, Need::Roadmap, false)?;
    ensure_revision(revision, expected)?;
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
    let event = activity(
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
        .ok_or_else(|| not_found("epic"))?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    ensure_revision(revision, expected)?;
    let tasks: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE epic_id=?1 AND deleted_at IS NULL)",
        [&input.id],
        |row| row.get(0),
    )?;
    if tasks {
        return Err(AppError::PreconditionFailed(
            "move or delete this epic's tasks first".into(),
        ));
    }
    tx.execute("UPDATE epics SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    compact_positions(tx, "epics", "track_id", &track_id, None, now)?;
    let entity = deleted("epic", &input.id, &project_id, revision + 1);
    let event = activity(
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
    let event = activity(
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
        .ok_or_else(|| not_found("milestone"))?;
    require_project(tx, actor, &before.project_id, Need::Roadmap, false)?;
    ensure_revision(before.revision, expected)?;
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
    let event = activity(
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
        .ok_or_else(|| not_found("milestone"))?;
    require_project(tx, actor, &project_id, Need::Roadmap, true)?;
    ensure_revision(revision, expected)?;
    tx.execute("UPDATE milestones SET deleted_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,input.id,expected])?;
    let entity = deleted("milestone", &input.id, &project_id, revision + 1);
    let event = activity(
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
