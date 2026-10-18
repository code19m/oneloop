//! Task pages: Board columns in either Done order, the counts per column,
//! an epic's tasks, and the task views they all return.

use super::*;
use crate::paging;

pub(super) fn board_page_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    q: &BoardQuery,
) -> AppResult<Page<TaskView>> {
    require_project(connection, actor, &q.project_id, Need::Read, false)?;
    let generation = task_page_generation(connection, &q.project_id)?;
    board_page_with_total(connection, q, None, generation)
}

/// One column of a project the caller checked read access to. A read of
/// several columns checks once and passes the same task `generation`.
pub(super) fn board_page_with_total(
    connection: &rusqlite::Connection,
    q: &BoardQuery,
    total: Option<i64>,
    generation: i64,
) -> AppResult<Page<TaskView>> {
    let limit = paging::page_limit(q.limit, PAGE_SIZE, PAGE_SIZE);
    // Only Done has a newest-first order; other columns ignore the choice.
    let filter = &q.filter;
    let newest = q.status == TaskStatus::Done && filter.done_order == DoneOrder::Completed;
    let scope = if newest {
        format!("board:{}:done:completed", q.project_id)
    } else {
        format!("board:{}:{}", q.project_id, q.status.as_str())
    };
    let start = match q.cursor.as_deref() {
        None => None,
        Some(raw) if newest => {
            let cursor: CompletedCursor = paging::decode(raw)?;
            check_task_cursor(cursor.generation, generation, &cursor.scope, &scope)?;
            Some(PageStart::Completed {
                at: cursor.completed_at,
                order: cursor.completion_order,
                id: cursor.id,
            })
        }
        Some(raw) => {
            let cursor: BoardCursor = paging::decode(raw)?;
            check_task_cursor(cursor.generation, generation, &cursor.scope, &scope)?;
            Some(PageStart::Position(cursor.position, cursor.id))
        }
    };
    let mut values = vec![
        rusqlite::types::Value::Text(q.project_id.clone()),
        rusqlite::types::Value::Text(q.status.as_str().into()),
    ];
    let mut conditions = vec![
        "t.project_id=?1".to_owned(),
        "t.status=?2".to_owned(),
        "t.deleted_at IS NULL".to_owned(),
    ];
    if let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        values.push(search.to_lowercase().into());
        let n = values.len();
        conditions.push(format!(
            "(instr(lower(t.task_key),?{n})>0 OR instr(t.search_title,?{n})>0)"
        ));
    }
    if !filter.track_ids.is_empty() {
        values.push(
            serde_json::to_string(&filter.track_ids)
                .map_err(|error| AppError::internal(error.to_string()))?
                .into(),
        );
        conditions.push(format!(
            "t.track_id IN (SELECT value FROM json_each(?{}))",
            values.len()
        ));
    }
    if !filter.epic_ids.is_empty() {
        let (none, epic_ids): (Vec<_>, Vec<_>) = filter
            .epic_ids
            .iter()
            .partition(|id| id.as_str() == NO_EPIC);
        let mut epics = Vec::new();
        if !epic_ids.is_empty() {
            values.push(
                serde_json::to_string(&epic_ids)
                    .map_err(|error| AppError::internal(error.to_string()))?
                    .into(),
            );
            epics.push(format!(
                "t.epic_id IN (SELECT value FROM json_each(?{}))",
                values.len()
            ));
        }
        if !none.is_empty() {
            epics.push("t.epic_id IS NULL".to_owned());
        }
        conditions.push(format!("({})", epics.join(" OR ")));
    }
    let mut assigned = Vec::new();
    if !filter.assignee_ids.is_empty() {
        values.push(
            serde_json::to_string(&filter.assignee_ids)
                .map_err(|error| AppError::internal(error.to_string()))?
                .into(),
        );
        assigned.push(format!("EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id IN (SELECT value FROM json_each(?{})))",values.len()));
    }
    if filter.no_assignee {
        assigned.push("NOT EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=t.id)".into());
    }
    if !assigned.is_empty() {
        conditions.push(format!("({})", assigned.join(" OR ")));
    }
    if filter.blocked {
        conditions.push(
            "EXISTS(SELECT 1 FROM task_blocks b WHERE b.task_id=t.id AND b.resolved_at IS NULL)"
                .into(),
        );
    }
    let predicate = conditions.join(" AND ");
    let total = if total.is_none() && filter.is_empty() {
        Some(connection.query_row(
            &format!("SELECT COUNT(*) FROM tasks t WHERE {predicate}"),
            rusqlite::params_from_iter(values.iter()),
            |row| row.get(0),
        )?)
    } else {
        total
    };
    // Where the page starts, in the column's order. Newest first lists tasks
    // without a completion time, which only very old data has, last, as
    // SQLite sorts NULL last in a descending order.
    let after = match &start {
        Some(PageStart::Position(position, id)) => {
            values.push((*position).into());
            values.push(id.clone().into());
            let n = values.len() - 1;
            format!("(t.position>?{n} OR (t.position=?{n} AND t.id>?{}))", n + 1)
        }
        Some(PageStart::Completed {
            at: Some(completed),
            order,
            id,
        }) => {
            values.push((*completed).into());
            values.push((*order).into());
            values.push(id.clone().into());
            let n = values.len() - 2;
            format!(
                "((t.completed_at,t.completion_order,t.id)<(?{n},?{},?{}) OR t.completed_at IS NULL)",
                n + 1,
                n + 2
            )
        }
        Some(PageStart::Completed {
            at: None,
            order,
            id,
        }) => {
            values.push((*order).into());
            values.push(id.clone().into());
            let n = values.len() - 1;
            format!(
                "(t.completed_at IS NULL AND (t.completion_order,t.id)<(?{n},?{}))",
                n + 1
            )
        }
        None => String::new(),
    };
    values.push(((limit + 1) as i64).into());
    let limit_parameter = values.len();
    let (ids, total) = if let Some(total) = total {
        // Precomputed unfiltered totals retain the bounded index-only page path.
        let ids = if newest {
            let start = match &start {
                Some(PageStart::Completed { at, order, id }) => Some((*at, *order, id.as_str())),
                _ => None,
            };
            newest_done_ids(connection, &q.project_id, start, limit + 1)?
        } else {
            let after = if after.is_empty() {
                after
            } else {
                format!(" AND {after}")
            };
            let sql = format!(
                "SELECT t.id FROM tasks t WHERE {predicate}{after} ORDER BY t.position,t.id LIMIT ?{limit_parameter}"
            );
            let mut statement = connection.prepare_cached(&sql)?;
            statement
                .query_map(rusqlite::params_from_iter(values.iter()), |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?
        };
        (ids, total)
    } else {
        // Materialize matching IDs once: expensive substring/member filters run
        // only once per row. Apply the cursor after counting the full match set.
        // A left join preserves the total even when the requested page is empty.
        let after = if after.is_empty() {
            after
        } else {
            format!(" WHERE {after}")
        };
        let (order, page_order) = if newest {
            (
                "t.completed_at DESC,t.completion_order DESC,t.id DESC",
                "page.completed_at DESC,page.completion_order DESC,page.id DESC",
            )
        } else {
            ("t.position,t.id", "page.position,page.id")
        };
        let sql = format!(
            "WITH matches AS MATERIALIZED (
            SELECT t.id,t.position,t.completed_at,t.completion_order FROM tasks t WHERE {predicate}
        ), page AS (
            SELECT t.id,t.position,t.completed_at,t.completion_order FROM matches t{after}
            ORDER BY {order} LIMIT ?{limit_parameter}
        ) SELECT page.id, totals.total FROM (SELECT COUNT(*) AS total FROM matches) totals
          LEFT JOIN page ON true ORDER BY {page_order}"
        );
        let mut statement = connection.prepare_cached(&sql)?;
        let mut rows = statement.query(rusqlite::params_from_iter(values.iter()))?;
        let mut ids = Vec::new();
        let mut total = 0;
        while let Some(row) = rows.next()? {
            total = row.get(1)?;
            if let Some(id) = row.get::<_, Option<String>>(0)? {
                ids.push(id);
            }
        }
        (ids, total)
    };
    let has_more = ids.len() > limit;
    let ids: Vec<_> = ids.into_iter().take(limit).collect();
    let items = task_views(connection, &ids, false)?;
    let next_cursor = if has_more {
        items.last().map(|t| {
            if newest {
                paging::encode(&CompletedCursor {
                    generation,
                    scope,
                    completed_at: t.completed_at,
                    completion_order: t.completion_order.unwrap_or(0),
                    id: t.id.clone(),
                })
            } else {
                paging::encode(&BoardCursor {
                    generation,
                    scope,
                    position: t.position,
                    id: t.id.clone(),
                })
            }
        })
    } else {
        None
    };
    Ok(Page {
        items,
        next_cursor,
        total,
    })
}

/// The first page of each Board column for `filter`, read at one moment, with
/// the project's counts. The Board read and the bootstrap share it, so both
/// give the same pages and totals for the same filter.
pub(super) fn board_columns(
    connection: &rusqlite::Connection,
    project_id: &str,
    limit: Option<usize>,
    filter: &TaskFilter,
) -> AppResult<BoardView> {
    let counts = board_counts_connection(connection, project_id)?;
    let generation = task_page_generation(connection, project_id)?;
    let unfiltered = filter.is_empty();
    let page = |status: TaskStatus, total: i64| {
        board_page_with_total(
            connection,
            &BoardQuery {
                project_id: project_id.into(),
                status,
                cursor: None,
                limit,
                filter: filter.clone(),
            },
            unfiltered.then_some(total),
            generation,
        )
    };
    Ok(BoardView {
        project_id: project_id.into(),
        planning: page(TaskStatus::Planning, counts.planning)?,
        in_progress: page(TaskStatus::InProgress, counts.in_progress)?,
        in_review: page(TaskStatus::InReview, counts.in_review)?,
        done: page(TaskStatus::Done, counts.done)?,
        counts,
    })
}

pub(super) fn board_counts_connection(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<BoardCounts> {
    let mut counts = BoardCounts {
        planning: 0,
        in_progress: 0,
        in_review: 0,
        done: 0,
        blocked: 0,
    };
    let mut statement=connection.prepare_cached("SELECT status,COUNT(*) FROM tasks WHERE project_id=?1 AND deleted_at IS NULL GROUP BY status")?;
    for row in statement.query_map([project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })? {
        let (status, total) = row?;
        match status.as_str() {
            "planning" => counts.planning = total,
            "in_progress" => counts.in_progress = total,
            "in_review" => counts.in_review = total,
            "done" => counts.done = total,
            _ => return Err(AppError::internal("stored task has an invalid status")),
        }
    }
    counts.blocked = connection
        .prepare_cached(BLOCKED_COUNT_SQL)?
        .query_row([project_id], |row| row.get(0))?;
    Ok(counts)
}

/// How many checklist items each task of a page has, and how many are done.
pub(super) const CHECKLIST_COUNTS_SQL: &str =
    "SELECT task_id,COUNT(*),SUM(done) FROM task_checklist_items
    WHERE task_id IN (SELECT value FROM json_each(?1)) GROUP BY task_id";

/// Open blocks on unfinished tasks. As a join, the plan depended on the
/// statistics: with statistics for `tasks` but none for an empty
/// `task_blocks`, SQLite read every task of the instance.
pub(super) const BLOCKED_COUNT_SQL: &str = "SELECT COUNT(*) FROM task_blocks b
    WHERE b.resolved_at IS NULL AND b.project_id=?1 AND EXISTS(SELECT 1 FROM tasks t
      WHERE t.id=b.task_id AND t.deleted_at IS NULL AND t.status!='done')";

/// One task with its details: its description and its checklist.
pub(in crate::domain) fn task_view(
    connection: &rusqlite::Connection,
    id: &str,
) -> AppResult<TaskView> {
    let mut task = task_views(connection, &[id.to_owned()], true)?
        .pop()
        .ok_or(AppError::NotFound { resource: "task" })?;
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {CHECKLIST_ITEM_COLUMNS} FROM task_checklist_items WHERE task_id=?1 ORDER BY position"
    ))?;
    task.checklist = Some(
        statement
            .query_map([id], checklist_item_row)?
            .collect::<Result<_, _>>()?,
    );
    Ok(task)
}

/// One checklist item, as a command that changed it returns it.
pub(in crate::domain) fn checklist_item(
    connection: &rusqlite::Connection,
    id: &str,
) -> AppResult<ChecklistItemView> {
    connection
        .prepare_cached(&format!(
            "SELECT {CHECKLIST_ITEM_COLUMNS} FROM task_checklist_items WHERE id=?1"
        ))?
        .query_row([id], checklist_item_row)
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "checklist item",
        })
}

/// The columns `checklist_item_row` reads, in its order.
const CHECKLIST_ITEM_COLUMNS: &str = "id,task_id,position,title,done,revision";

fn checklist_item_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChecklistItemView> {
    Ok(ChecklistItemView {
        id: row.get(0)?,
        task_id: row.get(1)?,
        position: row.get(2)?,
        title: row.get(3)?,
        done: row.get(4)?,
        revision: row.get(5)?,
    })
}

/// One bounded set of queries for a page, preserving the caller's order.
pub(super) fn task_views(
    connection: &rusqlite::Connection,
    ids: &[String],
    details: bool,
) -> AppResult<Vec<TaskView>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let encoded =
        serde_json::to_string(ids).map_err(|error| AppError::internal(error.to_string()))?;
    let mut statement=connection.prepare_cached("SELECT id,project_id,epic_id,task_number,task_key,title,CASE WHEN ?2 THEN description \
                     ELSE NULL END,status,position,deadline,created_at,updated_at,revision,completed_at,completion_order,checklist_version,\
                     track_id,started_at FROM tasks WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL")?;
    let mut tasks = statement
        .query_map(params![encoded, details], |r| {
            Ok(TaskView {
                id: r.get(0)?,
                project_id: r.get(1)?,
                track_id: r.get(16)?,
                epic_id: r.get(2)?,
                task_number: r.get(3)?,
                task_key: r.get(4)?,
                title: r.get(5)?,
                description: r.get(6)?,
                status: r.get(7)?,
                position: r.get(8)?,
                deadline: r.get(9)?,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
                started_at: r.get(17)?,
                // Only a task in Done has a completion time to show.
                completed_at: if r.get::<_, String>(7)? == "done" {
                    r.get(13)?
                } else {
                    None
                },
                completion_order: (r.get::<_, String>(7)? == "done")
                    .then(|| r.get(14))
                    .transpose()?,
                revision: r.get(12)?,
                assignee_ids: Vec::new(),
                active_block: None,
                checklist_done: 0,
                checklist_total: 0,
                checklist_version: r.get(15)?,
                checklist: None,
            })
        })?
        .map(|row| row.map(|task| (task.id.clone(), task)))
        .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
    let mut statement = connection.prepare_cached(
        "SELECT task_id,user_id FROM task_assignees WHERE task_id IN (SELECT value FROM \
                     json_each(?1)) ORDER BY assigned_at,user_id",
    )?;
    for row in statement.query_map([&encoded], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, user) = row?;
        if let Some(task) = tasks.get_mut(&id) {
            task.assignee_ids.push(user);
        }
    }
    let mut statement = connection.prepare_cached(
        "SELECT task_id,id,reason,created_by,created_at,revision FROM task_blocks WHERE task_id \
                     IN (SELECT value FROM json_each(?1)) AND resolved_at IS NULL",
    )?;
    for row in statement.query_map([&encoded], |r| {
        Ok((
            r.get::<_, String>(0)?,
            BlockView {
                id: r.get(1)?,
                reason: r.get(2)?,
                created_by: r.get(3)?,
                created_at: r.get(4)?,
                revision: r.get(5)?,
                mentions: Vec::new(),
            },
        ))
    })? {
        let (id, block) = row?;
        if let Some(task) = tasks.get_mut(&id) {
            task.active_block = Some(block);
        }
    }
    // One grouped read gives each task of the page its checklist counts.
    let mut statement = connection.prepare_cached(CHECKLIST_COUNTS_SQL)?;
    for row in statement.query_map([&encoded], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })? {
        let (id, total, done) = row?;
        if let Some(task) = tasks.get_mut(&id) {
            task.checklist_total = total;
            task.checklist_done = done;
        }
    }
    // Mentions are needed when opening an existing blocker editor from a card.
    let mut statement=connection.prepare_cached("SELECT b.task_id,m.kind,m.user_id,m.start_offset,m.end_offset,m.label FROM \
                     block_mentions m JOIN task_blocks b ON b.id=m.block_id WHERE b.task_id IN (SELECT value \
                     FROM json_each(?1)) AND b.resolved_at IS NULL ORDER BY m.start_offset,m.id")?;
    for row in statement.query_map([&encoded], |r| {
        Ok((
            r.get::<_, String>(0)?,
            crate::collaboration::mentions::token(r, 1)?,
        ))
    })? {
        let (id, mention) = row?;
        if let Some(block) = tasks
            .get_mut(&id)
            .and_then(|task| task.active_block.as_mut())
        {
            block.mentions.push(mention);
        }
    }
    ids.iter()
        .map(|id| {
            tasks
                .remove(id)
                .ok_or(AppError::NotFound { resource: "task" })
        })
        .collect()
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BoardCursor {
    generation: i64,
    scope: String,
    position: i64,
    id: String,
}

/// A cursor in a newest-first Done column.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletedCursor {
    generation: i64,
    scope: String,
    completed_at: Option<i64>,
    completion_order: i64,
    id: String,
}

/// The card a Board page continues after.
enum PageStart {
    Position(i64, String),
    Completed {
        at: Option<i64>,
        order: i64,
        id: String,
    },
}

/// One newest-first Done page of a project, read in order from the partial
/// index. `start` is the completion time, completion order and ID of the card
/// to continue after.
pub(super) fn newest_done_ids(
    connection: &rusqlite::Connection,
    project_id: &str,
    start: Option<(Option<i64>, i64, &str)>,
    take: usize,
) -> AppResult<Vec<String>> {
    let read = |sql: &str, values: &[&dyn rusqlite::ToSql]| -> AppResult<Vec<String>> {
        let mut statement = connection.prepare_cached(sql)?;
        Ok(statement
            .query_map(values, |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?)
    };
    let (mut ids, undated_after) = match start {
        None => return read(NEWEST_DONE_SQL, params![project_id, take as i64]),
        Some((Some(completed), order, id)) => (
            read(
                NEWEST_DONE_AFTER_SQL,
                params![project_id, completed, order, id, take as i64],
            )?,
            None,
        ),
        Some((None, order, id)) => (Vec::new(), Some((order, id))),
    };
    // The row comparison skips tasks without a completion time; they follow.
    if ids.len() < take {
        let rest = (take - ids.len()) as i64;
        let (order, id) = undated_after.unzip();
        ids.extend(read(
            UNDATED_DONE_SQL,
            params![project_id, id, order, rest],
        )?);
    }
    Ok(ids)
}

pub(super) const NEWEST_DONE_SQL: &str =
    "SELECT id FROM tasks WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
    ORDER BY completed_at DESC,completion_order DESC,id DESC LIMIT ?2";
pub(super) const NEWEST_DONE_AFTER_SQL: &str =
    "SELECT id FROM tasks WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
    AND (completed_at,completion_order,id)<(?2,?3,?4)
    ORDER BY completed_at DESC,completion_order DESC,id DESC LIMIT ?5";
pub(super) const UNDATED_DONE_SQL: &str =
    "SELECT id FROM tasks WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
    AND completed_at IS NULL AND (?2 IS NULL OR (completion_order,id)<(?3,?2))
    ORDER BY completion_order DESC,id DESC LIMIT ?4";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EpicTaskCursor {
    generation: i64,
    scope: String,
    status_rank: i64,
    task_number: i64,
    id: String,
}

pub(super) fn epic_task_page_connection(
    connection: &rusqlite::Connection,
    project_id: &str,
    epic_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<Page<TaskView>> {
    let generation = task_page_generation(connection, project_id)?;
    let cursor = cursor.map(decode_epic_task_cursor).transpose()?;
    if let Some(cursor) = &cursor {
        check_task_cursor(cursor.generation, generation, &cursor.scope, epic_id)?;
    }
    let total = connection.query_row(
        "SELECT COUNT(*) FROM tasks WHERE epic_id=?1 AND deleted_at IS NULL",
        [epic_id],
        |row| row.get(0),
    )?;
    let status_rank = "CASE status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'planning' THEN 2 WHEN 'done' THEN 3 ELSE 4 END";
    let mut statement = connection.prepare_cached(&format!(
        "SELECT id,{status_rank},task_number FROM tasks
         WHERE epic_id=?1 AND deleted_at IS NULL
           AND (?2 IS NULL OR {status_rank}>?2
             OR ({status_rank}=?2 AND task_number>?3)
             OR ({status_rank}=?2 AND task_number=?3 AND id>?4))
         ORDER BY {status_rank},task_number,id LIMIT ?5"
    ))?;
    let rows = statement
        .query_map(
            params![
                epic_id,
                cursor.as_ref().map(|value| value.status_rank),
                cursor.as_ref().map(|value| value.task_number),
                cursor.as_ref().map(|value| value.id.as_str()),
                (limit + 1) as i64,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = rows.len() > limit;
    let rows: Vec<_> = rows.into_iter().take(limit).collect();
    let ids = rows.iter().map(|(id, _, _)| id.clone()).collect::<Vec<_>>();
    let items = task_views(connection, &ids, true)?;
    let next_cursor = has_more
        .then(|| rows.last())
        .flatten()
        .map(|(id, rank, key)| {
            paging::encode(&EpicTaskCursor {
                generation,
                scope: epic_id.into(),
                status_rank: *rank,
                task_number: *key,
                id: id.clone(),
            })
        });
    Ok(Page {
        items,
        next_cursor,
        total,
    })
}

fn decode_epic_task_cursor(value: &str) -> AppResult<EpicTaskCursor> {
    paging::decode(value)
}

pub(super) fn task_page_generation(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<i64> {
    Ok(connection
        .prepare_cached("SELECT generation FROM project_task_versions WHERE project_id=?1")?
        .query_row([project_id], |r| r.get(0))?)
}

pub(super) fn check_task_cursor(
    saved: i64,
    current: i64,
    saved_scope: &str,
    scope: &str,
) -> AppResult<()> {
    if saved_scope != scope {
        return Err(AppError::validation(
            "cursor",
            "cursor belongs to another collection",
        ));
    }
    if saved != current {
        return Err(AppError::rule(
            crate::error::RuleKind::CursorStale,
            "Tasks changed while paging; reload the collection from its first page",
        ));
    }
    Ok(())
}
