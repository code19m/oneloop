//! Private/team Pool commands preserve ownership and atomically promote into tasks.
use super::*;

pub(super) fn create_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: PoolItemCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_pool_scope(tx, actor, stored, &input.project_id, &input.scope, false)?;
    let title = text(&input.title, "title", TASK_TITLE_MAX)?;
    let description = optional_text(&input.description, "description", POOL_DESCRIPTION_MAX)?;
    let id = Uuid::now_v7().to_string();
    let owner = matches!(input.scope, PoolScope::Personal).then(|| actor.user_id.clone());
    tx.execute(
        "INSERT INTO pool_items (id,project_id,scope,owner_user_id,title,description,created_by,\
                     created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
        params![
            id,
            input.project_id,
            input.scope.as_str(),
            owner,
            title,
            description,
            actor.user_id,
            now
        ],
    )?;
    let entity = json!({
    "entityType":"poolItem",
    "id":id,
    "projectId":input.project_id,
    "scope":input.scope.as_str(),
    "ownerUserId":owner,
    "title":title,
    "description":description,
    "createdAt":now,
    "revision":1
    });
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "pool_item",
            entity_id: &id,
            task_id: None,
            event_type: "pool_item.created",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: pool_activity_metadata(input.scope.as_str(), owner.as_deref()),
            entity_revision: Some(1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "poolItem", &id))
}

pub(super) fn update_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: PoolItemUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before: (String, String, Option<String>, String, String, i64) = tx
        .query_row(SELECT_POOL_ITEMS_SQL, [&input.pool_item_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .optional()?
        .ok_or_else(|| not_found("pool item"))?;
    let scope = if before.1 == "personal" {
        PoolScope::Personal
    } else {
        PoolScope::Team
    };
    require_pool_scope(tx, actor, stored, &before.0, &scope, false)?;
    if matches!(scope, PoolScope::Personal) && before.2.as_deref() != Some(&actor.user_id) {
        return Err(not_found("pool item"));
    }
    ensure_revision(before.5, expected)?;
    let title = input
        .title
        .as_deref()
        .map(|v| text(v, "title", TASK_TITLE_MAX))
        .transpose()?
        .unwrap_or(before.3.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| optional_text(v, "description", POOL_DESCRIPTION_MAX))
        .transpose()?
        .unwrap_or(before.4.clone());
    if title == before.3 && description == before.4 {
        return Err(AppError::validation(
            "payload",
            "no pool item fields changed",
        ));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE pool_items SET title=?1,description=?2,updated_at=?3,revision=?4 WHERE id=?5 AND \
                     revision=?6",
        params![
            title,
            description,
            now,
            revision,
            input.pool_item_id,
            expected
        ],
    )?;
    let entity = json!({
    "entityType":"poolItem",
    "id":input.pool_item_id,
    "projectId":before.0,
    "scope":before.1,
    "ownerUserId":before.2,
    "title":title,
    "description":description,
    "revision":revision
    });
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.0),
            entity_type: "pool_item",
            entity_id: &input.pool_item_id,
            task_id: None,
            event_type: "pool_item.updated",
            field_key: None,
            before: Some(json!({"title":before.3,"description":before.4})),
            after: Some(json!({"title":title,"description":description})),
            metadata: pool_activity_metadata(&before.1, before.2.as_deref()),
            entity_revision: Some(revision),
        },
        now,
    )?;
    Ok(Mutation::one(
        entity,
        event,
        "poolItem",
        &input.pool_item_id,
    ))
}

pub(super) fn delete_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before: (String, String, Option<String>, String, i64) = tx
        .query_row(
            "SELECT project_id,scope,owner_user_id,title,revision FROM pool_items WHERE id=?1",
            [&input.id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("pool item"))?;
    let scope = if before.1 == "personal" {
        PoolScope::Personal
    } else {
        PoolScope::Team
    };
    require_pool_scope(tx, actor, stored, &before.0, &scope, true)?;
    if matches!(scope, PoolScope::Personal) && before.2.as_deref() != Some(&actor.user_id) {
        return Err(not_found("pool item"));
    }
    ensure_revision(before.4, expected)?;
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.0),
            entity_type: "pool_item",
            entity_id: &input.id,
            task_id: None,
            event_type: "pool_item.deleted",
            field_key: None,
            before: Some(json!({"title":before.3})),
            after: None,
            metadata: pool_activity_metadata(&before.1, before.2.as_deref()),
            entity_revision: Some(expected + 1),
        },
        now,
    )?;
    tx.execute(
        "DELETE FROM pool_items WHERE id=?1 AND revision=?2",
        params![input.id, expected],
    )?;
    let entity = json!({"entityType":"poolItem","id":input.id,"projectId":before.0,"scope":before.1,"deleted":true,"revision":expected+1});
    Ok(Mutation::one(entity, event, "poolItem", &input.id))
}

pub(super) fn promote_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: PoolItemPromote,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let item: (String, String, Option<String>, String, String, i64) = tx
        .query_row(SELECT_POOL_ITEMS_SQL, [&input.pool_item_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .optional()?
        .ok_or_else(|| not_found("pool item"))?;
    let scope = if item.1 == "personal" {
        PoolScope::Personal
    } else {
        PoolScope::Team
    };
    require_pool_scope(tx, actor, stored, &item.0, &scope, false)?;
    if matches!(scope, PoolScope::Personal) && item.2.as_deref() != Some(&actor.user_id) {
        return Err(not_found("pool item"));
    }
    ensure_revision(item.5, expected)?;
    // Promotion creates shared project work, so personal ownership alone is insufficient.
    require_project(tx, actor, stored, &item.0, Permission::Board, false)?;
    let task = TaskCreate {
        project_id: item.0.clone(),
        epic_id: input.epic_id,
        title: input.title.unwrap_or_else(|| item.3.clone()),
        description: input.description.unwrap_or_else(|| item.4.clone()),
        deadline: input.deadline,
        assignee_ids: input.assignee_ids,
    };
    let mut mutation = create_task(tx, actor, stored, task, now, Some(&input.pool_item_id))?;
    tx.execute(
        "DELETE FROM pool_items WHERE id=?1 AND revision=?2",
        params![input.pool_item_id, expected],
    )?;
    let removed = json!({
    "entityType":"poolItem",
    "id":input.pool_item_id,
    "projectId":item.0,
    "deleted":true,
    "promoted":true,
    "revision":expected+1
    });
    let mut metadata = pool_activity_metadata(&item.1, item.2.as_deref());
    if let Value::Object(values) = &mut metadata {
        values.insert("taskId".into(), json!(mutation.resource_id));
    }
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&item.0),
            entity_type: "pool_item",
            entity_id: &input.pool_item_id,
            task_id: None,
            event_type: "pool_item.promoted",
            field_key: None,
            before: Some(json!({"title":item.3})),
            after: None,
            metadata,
            entity_revision: Some(expected + 1),
        },
        now,
    )?;
    mutation.entities.push(removed);
    mutation.events.push(event);
    Ok(mutation)
}

pub(super) fn require_pool_scope(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    project_id: &str,
    scope: &PoolScope,
    destructive: bool,
) -> AppResult<()> {
    match scope {
        PoolScope::Team => require_project(
            tx,
            actor,
            stored,
            project_id,
            Permission::Board,
            destructive,
        ),
        PoolScope::Personal => {
            require_project(tx, actor, stored, project_id, Permission::Read, destructive)?;
            if !crate::auth::can_read_private_pool(tx, actor)? {
                return Err(AppError::Forbidden);
            }
            Ok(())
        }
    }
}

pub(super) fn pool_activity_metadata(scope: &str, owner_user_id: Option<&str>) -> Value {
    if scope == "personal" {
        json!({"visibility":"owner","ownerUserId":owner_user_id})
    } else {
        json!({})
    }
}
