//! Track/epic compaction and gapped task ordering under a single write transaction.
use super::*;

pub(super) fn active_ids(
    tx: &Transaction<'_>,
    table: &str,
    scope_column: &str,
    scope_id: &str,
    status: Option<&str>,
) -> AppResult<Vec<String>> {
    let sql = if status.is_some() {
        format!(
            "SELECT id FROM {table} WHERE {scope_column}=?1 AND status=?2 AND deleted_at IS NULL \
                     ORDER BY position,id"
        )
    } else {
        format!(
            "SELECT id FROM {table} WHERE {scope_column}=?1 AND deleted_at IS NULL ORDER BY position,id"
        )
    };
    let mut statement = tx.prepare(&sql)?;
    let rows = if let Some(status) = status {
        statement
            .query_map(params![scope_id, status], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?
    } else {
        statement
            .query_map([scope_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?
    };
    Ok(rows)
}

pub(super) fn resequence(
    tx: &Transaction<'_>,
    table: &str,
    ids: &[String],
    now: i64,
    changed: Option<(&str, i64)>,
) -> AppResult<()> {
    // The desired integer order already lives in this request. Let SQLite join
    // that mapping by primary key, and write only displaced rows. Moving
    // them into negative temporary positions first preserves the immediate unique
    // constraint, including cards temporarily parked above the normal range.
    let desired = serde_json::to_string(ids)
        .map_err(|error| AppError::internal(format!("serialize ordering: {error}")))?;
    let changed_id = changed.map(|(id, _)| id).unwrap_or("");
    let mapping =
        "WITH desired AS (SELECT value AS id, CAST(key AS INTEGER) AS position FROM json_each(?1))";
    tx.execute(
        &format!(
            "{mapping} UPDATE {table} SET position=-{table}.position-1
            FROM desired WHERE {table}.id=desired.id
            AND ({table}.position<>desired.position OR {table}.id=?2)"
        ),
        params![desired, changed_id],
    )?;
    tx.execute(
        &format!(
            "{mapping} UPDATE {table} SET position=desired.position,updated_at=?2,
            revision={table}.revision+CASE WHEN {table}.id=?3 THEN 1 ELSE 0 END
            FROM desired WHERE {table}.id=desired.id AND {table}.position<>desired.position"
        ),
        params![desired, now, changed_id],
    )?;
    Ok(())
}

pub(super) fn compact_positions(
    tx: &Transaction<'_>,
    table: &str,
    scope_column: &str,
    scope_id: &str,
    status: Option<&str>,
    now: i64,
) -> AppResult<()> {
    let ids = active_ids(tx, table, scope_column, scope_id, status)?;
    resequence(tx, table, &ids, now, None)
}

pub(super) fn task_append_position(
    tx: &Transaction<'_>,
    project: &str,
    status: &str,
) -> AppResult<i64> {
    let last: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position),0) FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL",
        params![project,status], |r| r.get(0))?;
    if let Some(position) = last.checked_add(TASK_POSITION_GAP) {
        return Ok(position);
    }
    space_task_positions(tx, project, status)?;
    task_append_position(tx, project, status)
}

pub(super) fn space_task_positions(
    tx: &Transaction<'_>,
    project: &str,
    status: &str,
) -> AppResult<()> {
    // Rare gap exhaustion: rebuild only the destination column, preserving all
    // other cards' revisions/timestamps. Negative staging avoids unique collisions.
    tx.execute("UPDATE tasks SET position=-position-1 WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL", params![project,status])?;
    tx.execute("WITH ordered AS (SELECT id, row_number() OVER (ORDER BY position DESC)*?3 AS position FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL)
        UPDATE tasks SET position=ordered.position FROM ordered WHERE tasks.id=ordered.id", params![project,status,TASK_POSITION_GAP])?;
    Ok(())
}

pub(super) fn task_insert_position(
    tx: &Transaction<'_>,
    project: &str,
    status: &str,
    moving: &str,
    index: i64,
) -> AppResult<i64> {
    for attempt in 0..2 {
        let at = |offset: i64| -> AppResult<Option<i64>> {
            if offset < 0 {
                return Ok(None);
            }
            Ok(tx.query_row("SELECT position FROM tasks WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL AND id<>?3 ORDER BY position LIMIT 1 OFFSET ?4",
                params![project,status,moving,offset], |r| r.get(0)).optional()?)
        };
        let left = at(index - 1)?.unwrap_or(0);
        let right = at(index)?;
        let position = match right {
            Some(right) if right - left > 1 => Some(left + (right - left) / 2),
            None => left.checked_add(TASK_POSITION_GAP),
            _ => None,
        };
        if let Some(position) = position {
            return Ok(position);
        }
        if attempt == 0 {
            space_task_positions(tx, project, status)?;
        }
    }
    Err(AppError::internal("task position space exhausted"))
}
