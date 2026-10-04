//! Project administration and atomic deletion; historical prefixes remain reserved.
use super::*;

pub(super) fn create_project(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: ProjectCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_admin(actor, stored)?;
    if matches!(actor.source, ActorSource::McpGrant { .. }) {
        return Err(AppError::Forbidden);
    }
    let name = text(&input.name, "name", NAME_MAX)?;
    let prefix = normalize_prefix(&input.task_prefix)?;
    let reserved: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_prefixes WHERE prefix=?1)",
        [&prefix],
        |row| row.get(0),
    )?;
    if reserved {
        return Err(AppError::rule(
            crate::error::RuleKind::PrefixReserved,
            "task prefix is reserved by another project or its history",
        ));
    }
    let id = Uuid::now_v7().to_string();
    tx.execute(
        "INSERT INTO projects (id,name,task_prefix,created_by,created_at,updated_at) VALUES (?1,\
                     ?2,?3,?4,?5,?5)",
        params![id, name, prefix, actor.user_id, now],
    )?;
    tx.execute(
        "INSERT INTO project_prefixes (prefix,project_id,reserved_at) VALUES (?1,?2,?3)",
        params![prefix, id, now],
    )?;
    tx.execute(
        "INSERT INTO project_sequences (project_id,next_task_number) VALUES (?1,1)",
        [&id],
    )?;
    let entity = json!({"entityType":"project","id":id,"name":name,"taskPrefix":prefix,"revision":1,"projectId":id});
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&id),
            entity_type: "project",
            entity_id: &id,
            task_id: None,
            event_type: "project.created",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: json!({}),
            entity_revision: Some(1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "project", &id))
}

pub(super) fn update_project(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: ProjectUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    require_admin(actor, stored)?;
    if matches!(actor.source, ActorSource::McpGrant { .. }) {
        return Err(AppError::Forbidden);
    }
    let before: (String, String, i64) = tx
        .query_row(
            "SELECT name,task_prefix,revision FROM projects WHERE id=?1 AND deleted_at IS NULL",
            [&input.project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("project"))?;
    ensure_revision(before.2, expected)?;
    let name = input
        .name
        .as_deref()
        .map(|value| text(value, "name", NAME_MAX))
        .transpose()?
        .unwrap_or(before.0.clone());
    let prefix = input
        .task_prefix
        .as_deref()
        .map(normalize_prefix)
        .transpose()?
        .unwrap_or(before.1.clone());
    if name == before.0 && prefix == before.1 {
        return Err(AppError::validation("payload", "no project fields changed"));
    }
    if prefix != before.1 {
        let reserved: Option<Option<String>> = tx
            .query_row(
                "SELECT project_id FROM project_prefixes WHERE prefix=?1",
                [&prefix],
                |row| row.get(0),
            )
            .optional()?;
        if reserved
            .as_ref()
            .is_some_and(|id| id.as_deref() != Some(input.project_id.as_str()))
        {
            return Err(AppError::rule(
                crate::error::RuleKind::PrefixReserved,
                "task prefix is reserved by another project or its history",
            ));
        }
        if reserved.is_none() {
            tx.execute(
                "INSERT INTO project_prefixes (prefix,project_id,reserved_at) VALUES (?1,?2,?3)",
                params![prefix, input.project_id, now],
            )?;
        }
    }
    let revision = expected + 1;
    tx.execute("UPDATE projects SET name=?1,task_prefix=?2,updated_at=?3,revision=?4 WHERE id=?5 AND revision=?6",
        params![name,prefix,now,revision,input.project_id,expected])?;
    let entity = json!({
    "entityType":"project",
    "id":input.project_id,
    "projectId":input.project_id,
    "name":name,
    "taskPrefix":prefix,
    "revision":revision
    });
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "project",
            entity_id: &input.project_id,
            task_id: None,
            event_type: "project.updated",
            field_key: None,
            before: Some(json!({"name":before.0,"taskPrefix":before.1})),
            after: Some(json!({"name":name,"taskPrefix":prefix})),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "project", &input.project_id))
}

pub(super) fn delete_project(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: ProjectDelete,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    require_sensitive_admin(actor, stored, now)?;
    let (name, revision): (String, i64) = tx
        .query_row(
            "SELECT name,revision FROM projects WHERE id=?1 AND deleted_at IS NULL",
            [&input.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("project"))?;
    ensure_revision(revision, expected)?;
    if input.confirmed_name != name {
        return Err(AppError::validation(
            "confirmedName",
            "must exactly match the project name",
        ));
    }
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if count <= 1 {
        return Err(AppError::PreconditionFailed(
            "the last project cannot be deleted".into(),
        ));
    }
    // Snapshot affected accounts before membership cascades erase the audience.
    let recipients = {
        let mut statement = tx.prepare("SELECT id FROM users WHERE is_active=1 AND
            (is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships m WHERE m.user_id=users.id AND m.project_id=?1))")?;
        statement
            .query_map([&input.project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for user_id in recipients {
        crate::collaboration::enqueue_access_change_tx(tx, &user_id, now)?;
    }
    // Revoke every connected app that selected this project, even one that
    // also selected others; the cascade below would erase that selection.
    crate::auth::revoke_project_app_access(tx, &input.project_id, now)?;
    // Audit first: project foreign keys become NULL while immutable snapshots remain.
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "project",
            entity_id: &input.project_id,
            task_id: None,
            event_type: "project.deleted",
            field_key: None,
            before: Some(json!({"name":name})),
            after: None,
            metadata: json!({}),
            entity_revision: Some(revision + 1),
        },
        now,
    )?;
    // RESTRICT edges and membership guards must not depend on cascade order.
    for table in ["tasks", "epics", "tracks"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE project_id=?1"),
            [&input.project_id],
        )?;
    }
    tx.execute(
        "DELETE FROM projects WHERE id=?1 AND revision=?2",
        params![input.project_id, expected],
    )?;
    let entity = json!({"entityType":"project","id":input.project_id,"projectId":input.project_id,"deleted":true,"revision":revision+1});
    Ok(Mutation::one(entity, event, "project", &input.project_id))
}
