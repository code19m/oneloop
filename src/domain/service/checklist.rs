//! A task's checklist: adding, changing, moving and deleting its items. An
//! item keeps its own revision, so a checklist change leaves the task as it is.
use super::ordering::resequence;
use super::*;

/// The most items a task's checklist holds.
const CHECKLIST_MAX: usize = 50;

/// A checklist item, with the project of its task.
struct ItemRow {
    task_id: String,
    project_id: String,
    position: i64,
    title: String,
    done: bool,
    revision: i64,
}

fn item_row(tx: &Transaction<'_>, id: &str) -> AppResult<ItemRow> {
    tx.query_row(
        "SELECT i.task_id,t.project_id,i.position,i.title,i.done,i.revision
         FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id
         WHERE i.id=?1 AND t.deleted_at IS NULL",
        [id],
        |row| {
            Ok(ItemRow {
                task_id: row.get(0)?,
                project_id: row.get(1)?,
                position: row.get(2)?,
                title: row.get(3)?,
                done: row.get(4)?,
                revision: row.get(5)?,
            })
        },
    )
    .optional()?
    .ok_or(AppError::NotFound {
        resource: "checklist item",
    })
}

/// The IDs of a task's checklist items, in order.
fn item_ids(tx: &Transaction<'_>, task_id: &str) -> AppResult<Vec<String>> {
    let mut statement = tx
        .prepare_cached("SELECT id FROM task_checklist_items WHERE task_id=?1 ORDER BY position")?;
    Ok(statement
        .query_map([task_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

/// The titles of a new task's checklist, checked as an added item's title is.
pub(super) fn checklist_titles(titles: &[String]) -> AppResult<Vec<String>> {
    if titles.len() > CHECKLIST_MAX {
        return Err(AppError::validation(
            "checklist",
            format!("must contain at most {CHECKLIST_MAX} items"),
        ));
    }
    titles
        .iter()
        .map(|title| text::single_line(title, "checklist", TASK_TITLE_MAX))
        .collect()
}

/// Adds an item that isn't done to the task's checklist at `position`.
pub(super) fn insert_item(
    tx: &Transaction<'_>,
    task_id: &str,
    position: i64,
    title: &str,
    now: i64,
) -> AppResult<String> {
    let id = Uuid::now_v7().to_string();
    tx.prepare_cached(
        "INSERT INTO task_checklist_items (id,task_id,position,title,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?5)",
    )?
    .execute(params![id, task_id, position, title, now])?;
    Ok(id)
}

/// Records a checklist change for the audit trail. The activity feeds don't
/// show it. The task's revision stays, so the live hint names none, and other
/// tabs read the task again.
fn record_change(
    tx: &Transaction<'_>,
    actor: &Actor,
    (project_id, task_id, item_id): (&str, &str, &str),
    event_type: &str,
    (before, after): (Option<Value>, Option<Value>),
    now: i64,
) -> AppResult<ActivityEvent> {
    record_activity_tx(
        tx,
        actor,
        ActivityInput {
            project_id: Some(project_id),
            entity_type: "task",
            entity_id: task_id,
            task_id: Some(task_id),
            event_type,
            field_key: Some("checklist"),
            before,
            after,
            metadata: json!({"itemId": item_id}),
            entity_revision: None,
        },
        now,
    )
}

/// What a checklist command returns: the item, unless it was deleted, and
/// the task with its new counts and its next checklist version.
fn changed(
    tx: &Transaction<'_>,
    item: Value,
    task_id: &str,
    event: ActivityEvent,
    item_id: &str,
) -> AppResult<Mutation> {
    tx.prepare_cached("UPDATE tasks SET checklist_version=checklist_version+1 WHERE id=?1")?
        .execute([task_id])?;
    Ok(Mutation {
        entities: vec![item, task_entity(tx, task_id)?],
        events: vec![event],
        resource_type: "checklistItem",
        resource_id: Some(item_id.to_owned()),
    })
}

fn item_entity(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    Entity::ChecklistItem(crate::domain::reads::checklist_item(tx, id)?).value()
}

pub(super) fn add_checklist_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    mut input: ChecklistItemAdd,
    now: i64,
) -> AppResult<Mutation> {
    input.task_id = resolve_task_id(tx, &input.task_id)?;
    let task = task_row(tx, &input.task_id)?;
    require_project(tx, actor, &task.project_id, Need::Board, false)?;
    let title = text::single_line(&input.title, "title", TASK_TITLE_MAX)?;
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM task_checklist_items WHERE task_id=?1",
        [&input.task_id],
        |row| row.get(0),
    )?;
    if count >= CHECKLIST_MAX as i64 {
        return Err(AppError::Conflict(format!(
            "a task's checklist can have at most {CHECKLIST_MAX} items"
        )));
    }
    let id = insert_item(tx, &input.task_id, count, &title, now)?;
    let event = record_change(
        tx,
        actor,
        (&task.project_id, &input.task_id, &id),
        "task.checklist.added",
        (None, Some(json!({"title": title, "done": false}))),
        now,
    )?;
    changed(tx, item_entity(tx, &id)?, &input.task_id, event, &id)
}

pub(super) fn update_checklist_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: ChecklistItemUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = item_row(tx, &input.item_id)?;
    require_project(tx, actor, &before.project_id, Need::Board, false)?;
    check_revision(expected, before.revision)?;
    let title = input
        .title
        .as_deref()
        .map(|title| text::single_line(title, "title", TASK_TITLE_MAX))
        .transpose()?
        .unwrap_or_else(|| before.title.clone());
    let done = input.done.unwrap_or(before.done);
    if title == before.title && done == before.done {
        return Err(AppError::validation(
            "payload",
            "no checklist item fields changed",
        ));
    }
    tx.execute(
        "UPDATE task_checklist_items SET title=?1,done=?2,updated_at=?3,revision=?4
         WHERE id=?5 AND revision=?6",
        params![title, done, now, expected + 1, input.item_id, expected],
    )?;
    let event = record_change(
        tx,
        actor,
        (&before.project_id, &before.task_id, &input.item_id),
        "task.checklist.updated",
        (
            Some(json!({"title": before.title, "done": before.done})),
            Some(json!({"title": title, "done": done})),
        ),
        now,
    )?;
    let item = item_entity(tx, &input.item_id)?;
    changed(tx, item, &before.task_id, event, &input.item_id)
}

pub(super) fn move_checklist_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: ChecklistItemMove,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = item_row(tx, &input.item_id)?;
    require_project(tx, actor, &before.project_id, Need::Board, false)?;
    check_revision(expected, before.revision)?;
    let mut ids = item_ids(tx, &before.task_id)?;
    ids.retain(|id| id != &input.item_id);
    let anchor = |field: &str, anchor: &str| {
        ids.iter()
            .position(|id| id == anchor)
            .ok_or_else(|| AppError::validation(field, "names no other item of this checklist"))
    };
    let position = match (
        input.position,
        input.before_item_id.as_deref(),
        input.after_item_id.as_deref(),
    ) {
        (Some(position), None, None) if position <= ids.len() => position,
        (Some(_), None, None) => {
            return Err(AppError::validation("position", "is outside the checklist"));
        }
        (None, Some(before_id), None) => anchor("beforeItemId", before_id)?,
        (None, None, Some(after_id)) => anchor("afterItemId", after_id)? + 1,
        _ => {
            return Err(AppError::validation(
                "position",
                "provide one of position, beforeItemId or afterItemId",
            ));
        }
    };
    if position as i64 == before.position {
        return Err(AppError::validation(
            "position",
            "item is already at that position",
        ));
    }
    ids.insert(position, input.item_id.clone());
    resequence(
        tx,
        "task_checklist_items",
        &ids,
        now,
        Some((&input.item_id, expected)),
    )?;
    let event = record_change(
        tx,
        actor,
        (&before.project_id, &before.task_id, &input.item_id),
        "task.checklist.moved",
        (Some(json!(before.position)), Some(json!(position))),
        now,
    )?;
    let item = item_entity(tx, &input.item_id)?;
    changed(tx, item, &before.task_id, event, &input.item_id)
}

pub(super) fn delete_checklist_item(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: EntityId,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    let before = item_row(tx, &input.id)?;
    require_project(tx, actor, &before.project_id, Need::Board, true)?;
    check_revision(expected, before.revision)?;
    tx.execute(
        "DELETE FROM task_checklist_items WHERE id=?1 AND revision=?2",
        params![input.id, expected],
    )?;
    // The items after it move up, so positions stay without gaps.
    let ids = item_ids(tx, &before.task_id)?;
    resequence(tx, "task_checklist_items", &ids, now, None)?;
    let event = record_change(
        tx,
        actor,
        (&before.project_id, &before.task_id, &input.id),
        "task.checklist.deleted",
        (
            Some(json!({"title": before.title, "done": before.done})),
            None,
        ),
        now,
    )?;
    let item = deleted("checklistItem", &input.id, &before.project_id, expected + 1);
    changed(tx, item, &before.task_id, event, &input.id)
}
