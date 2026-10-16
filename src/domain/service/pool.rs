//! Pool items, personal and team, and their promotion to tasks.
use super::task::create_task;
use super::*;

pub(super) fn create_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: PoolItemCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_pool_scope(tx, actor, &input.project_id, input.scope, false)?;
    let title = text::single_line(&input.title, "title", TASK_TITLE_MAX)?;
    let description = text::optional(&input.description, "description", POOL_DESCRIPTION_MAX)?;
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
    let metadata = pool_activity_metadata(input.scope, owner.as_deref());
    let entity = Entity::PoolItem(PoolItemView {
        id: id.clone(),
        project_id: input.project_id.clone(),
        scope: input.scope.as_str().into(),
        owner_user_id: owner,
        title,
        description,
        created_at: now,
        revision: 1,
    })
    .value()?;
    let event = record_activity_tx(
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
            metadata,
            entity_revision: Some(1),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "poolItem", &id))
}

pub(super) fn update_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: PoolItemUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = pool_item_for(tx, actor, &input.pool_item_id, false)?;
    check_revision(expected, before.revision)?;
    let title = input
        .title
        .as_deref()
        .map(|v| text::single_line(v, "title", TASK_TITLE_MAX))
        .transpose()?
        .unwrap_or(before.title.clone());
    let description = input
        .description
        .as_deref()
        .map(|v| text::optional(v, "description", POOL_DESCRIPTION_MAX))
        .transpose()?
        .unwrap_or(before.description.clone());
    if title == before.title && description == before.description {
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
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "pool_item",
            entity_id: &input.pool_item_id,
            task_id: None,
            event_type: "pool_item.updated",
            field_key: None,
            before: Some(json!({"title":before.title,"description":before.description})),
            after: Some(json!({"title":title,"description":description})),
            metadata: pool_activity_metadata(before.scope, before.owner_user_id.as_deref()),
            entity_revision: Some(revision),
        },
        now,
    )?;
    let entity = Entity::PoolItem(PoolItemView {
        id: input.pool_item_id.clone(),
        project_id: before.project_id,
        scope: before.scope.as_str().into(),
        owner_user_id: before.owner_user_id,
        title,
        description,
        created_at: before.created_at,
        revision,
    })
    .value()?;
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
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = pool_item_for(tx, actor, &input.id, true)?;
    check_revision(expected, before.revision)?;
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&before.project_id),
            entity_type: "pool_item",
            entity_id: &input.id,
            task_id: None,
            event_type: "pool_item.deleted",
            field_key: None,
            before: Some(json!({"title":before.title})),
            after: None,
            metadata: pool_activity_metadata(before.scope, before.owner_user_id.as_deref()),
            entity_revision: Some(expected + 1),
        },
        now,
    )?;
    tx.execute(
        "DELETE FROM pool_items WHERE id=?1 AND revision=?2",
        params![input.id, expected],
    )?;
    let mut entity = deleted("poolItem", &input.id, &before.project_id, expected + 1);
    entity["scope"] = json!(before.scope.as_str());
    Ok(Mutation::one(entity, event, "poolItem", &input.id))
}

pub(super) fn promote_pool_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: PoolItemPromote,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let item = pool_item_for(tx, actor, &input.pool_item_id, false)?;
    check_revision(expected, item.revision)?;
    // Promotion creates shared project work, so personal ownership alone is insufficient.
    require_project(tx, actor, &item.project_id, Need::Board, false)?;
    let task = TaskCreate {
        project_id: item.project_id.clone(),
        epic_id: input.epic_id,
        title: input.title.unwrap_or_else(|| item.title.clone()),
        description: input.description.unwrap_or(item.description),
        deadline: input.deadline,
        assignee_ids: input.assignee_ids,
        checklist: Vec::new(),
    };
    let mut mutation = create_task(tx, actor, task, now, Some(&input.pool_item_id))?;
    tx.execute(
        "DELETE FROM pool_items WHERE id=?1 AND revision=?2",
        params![input.pool_item_id, expected],
    )?;
    let mut removed = deleted(
        "poolItem",
        &input.pool_item_id,
        &item.project_id,
        expected + 1,
    );
    removed["promoted"] = json!(true);
    let mut metadata = pool_activity_metadata(item.scope, item.owner_user_id.as_deref());
    if let Value::Object(values) = &mut metadata {
        values.insert("taskId".into(), json!(mutation.resource_id));
    }
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&item.project_id),
            entity_type: "pool_item",
            entity_id: &input.pool_item_id,
            task_id: None,
            event_type: "pool_item.promoted",
            field_key: None,
            before: Some(json!({"title":item.title})),
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

struct PoolItemRow {
    project_id: String,
    scope: PoolScope,
    owner_user_id: Option<String>,
    title: String,
    description: String,
    created_at: i64,
    revision: i64,
}

/// Loads a Pool item that `actor` may change. Another person's personal item
/// is not found, as if it did not exist.
fn pool_item_for(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    destructive: bool,
) -> AppResult<PoolItemRow> {
    let item = tx
        .query_row(POOL_ITEM_SQL, [id], |row| {
            Ok(PoolItemRow {
                project_id: row.get(0)?,
                scope: if row.get::<_, String>(1)? == "personal" {
                    PoolScope::Personal
                } else {
                    PoolScope::Team
                },
                owner_user_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                created_at: row.get(5)?,
                revision: row.get(6)?,
            })
        })
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "pool item",
        })?;
    require_pool_scope(tx, actor, &item.project_id, item.scope, destructive)?;
    if item.scope == PoolScope::Personal && item.owner_user_id.as_deref() != Some(&actor.user_id) {
        return Err(AppError::NotFound {
            resource: "pool item",
        });
    }
    Ok(item)
}

pub(super) fn require_pool_scope(
    tx: &Transaction<'_>,
    actor: &Actor,
    project_id: &str,
    scope: PoolScope,
    destructive: bool,
) -> AppResult<()> {
    match scope {
        PoolScope::Team => require_project(tx, actor, project_id, Need::Board, destructive),
        PoolScope::Personal => {
            crate::access::require_private_pool(tx, actor, project_id, destructive)
        }
    }
}

pub(super) fn pool_activity_metadata(scope: PoolScope, owner_user_id: Option<&str>) -> Value {
    if scope == PoolScope::Personal {
        json!({"visibility":"owner","ownerUserId":owner_user_id})
    } else {
        json!({})
    }
}
