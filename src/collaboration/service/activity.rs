//! Activity reads from the consolidated projection: a project's or task's
//! feed, an epic's history and a block's history.
use super::*;

/// The projection columns that `activity_row` reads, in its order.
const COLUMNS: &str = "id,project_id,entity_type,entity_id,task_id,actor_user_id,\
    actor_name_snapshot,event_type,field_key,before_json,after_json,metadata_json,\
    entity_revision,latest_at";

impl CollaborationService {
    pub async fn block_context(
        &self,
        actor: &Actor,
        task_id: &str,
        block_id: &str,
    ) -> AppResult<ActivityPage> {
        let task_id = task_id.to_owned();
        let block_id = block_id.to_owned();
        access::read(&self.db, actor, move |connection, actor| {
            let project_id: String = connection
                .query_row(
                    "SELECT b.project_id FROM task_blocks b JOIN tasks t ON t.id=b.task_id
                 WHERE b.id=?1 AND b.task_id=?2 AND t.deleted_at IS NULL",
                    params![block_id, task_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(AppError::NotFound {
                    resource: "task block",
                })?;
            require_project(connection, actor, &project_id, Need::Read, false)?;
            let mut statement = connection.prepare_cached(&format!(
                "SELECT {COLUMNS} FROM activity_projection WHERE entity_type='task_block'
                 AND entity_id=?1 AND task_id=?2 AND visibility='public' AND is_hidden=0
                 ORDER BY latest_at DESC,id DESC LIMIT 50"
            ))?;
            let mut items = statement
                .query_map(params![block_id, task_id], activity_row)?
                .collect::<Result<Vec<_>, _>>()?;
            if !items.iter().any(|item| item.event_type == "task.blocked") {
                let original = connection
                    .prepare_cached(&format!(
                        "SELECT {COLUMNS} FROM activity_projection WHERE entity_type='task_block'
                     AND entity_id=?1 AND task_id=?2 AND event_type='task.blocked'
                     AND visibility='public' AND is_hidden=0 ORDER BY latest_at,id LIMIT 1"
                    ))?
                    .query_row(params![block_id, task_id], activity_row)
                    .optional()?;
                if let Some(original) = original {
                    items.push(original);
                }
            }
            Ok(ActivityPage {
                items,
                next_cursor: None,
            })
        })
        .await
    }

    /// A project's feed, or one task's. It merges the public feed with the
    /// reader's private one, such as their personal Pool.
    pub async fn activity(
        &self,
        actor: &Actor,
        project_id: &str,
        task_id: Option<&str>,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<ActivityPage> {
        let project_id = project_id.to_owned();
        let task_id = task_id.map(str::to_owned);
        let cursor: Option<TimeCursor> = cursor.map(paging::decode).transpose()?;
        let limit = paging::page_limit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &project_id, Need::Read, false)?;
            let task_id = task_id.as_deref();
            let mut items = project_feed(
                connection,
                &project_id,
                task_id,
                None,
                cursor.as_ref(),
                limit,
            )?;
            if crate::access::can_read_private_pool(connection, actor)? {
                items.extend(project_feed(
                    connection,
                    &project_id,
                    task_id,
                    Some(&actor.user_id),
                    cursor.as_ref(),
                    limit,
                )?);
            }
            items.sort_by(|left, right| {
                (right.created_at, &right.id).cmp(&(left.created_at, &left.id))
            });
            Ok(activity_page(items, limit))
        })
        .await
    }

    pub async fn epic_activity(
        &self,
        actor: &Actor,
        epic_id: &str,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<ActivityPage> {
        let epic_id = epic_id.to_owned();
        let cursor: Option<TimeCursor> = cursor.map(paging::decode).transpose()?;
        let limit = paging::page_limit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        access::read(&self.db, actor, move |connection, actor| {
            access::require_epic(connection, actor, &epic_id, Need::Read, false)?;
            let items = feed(
                connection,
                "entity_type='epic' AND entity_id=?1 AND visibility='public' AND is_hidden=0",
                vec![epic_id.into()],
                cursor.as_ref(),
                limit,
            )?;
            Ok(activity_page(items, limit))
        })
        .await
    }
}

/// A project's public feed, or the private feed of `owner`, optionally for
/// one task.
fn project_feed(
    connection: &rusqlite::Connection,
    project_id: &str,
    task_id: Option<&str>,
    owner: Option<&str>,
    cursor: Option<&TimeCursor>,
    limit: usize,
) -> AppResult<Vec<ActivityEvent>> {
    let values = [Some(project_id), task_id, owner]
        .into_iter()
        .flatten()
        .map(|value| value.to_owned().into())
        .collect();
    let filter = project_filter(task_id.is_some(), owner.is_some());
    feed(connection, &filter, values, cursor, limit)
}

/// The filter of a project's feed, with the project, then the task, then
/// the owner as its parameters. Each case matches one partial feed index.
fn project_filter(task: bool, owner: bool) -> String {
    let mut filter = "project_id=?1 AND is_hidden=0".to_owned();
    if task {
        filter += " AND task_id=?2";
    }
    if owner {
        let next = 2 + usize::from(task);
        filter += &format!(" AND visibility='owner' AND private_owner_user_id=?{next}");
    } else {
        filter += " AND visibility='public'";
    }
    filter
}

/// The newest activity that `filter` selects, after `cursor`: at most
/// `limit` items and one more, which tells that another page follows.
/// `values` bind the filter's numbered parameters.
fn feed(
    connection: &rusqlite::Connection,
    filter: &str,
    mut values: Vec<rusqlite::types::Value>,
    cursor: Option<&TimeCursor>,
    limit: usize,
) -> AppResult<Vec<ActivityEvent>> {
    let (time, id) = cursor.map_or((i64::MAX, "\u{10ffff}"), |cursor| {
        (cursor.time, cursor.id.as_str())
    });
    let sql = feed_sql(filter, values.len() + 1);
    values.extend([time.into(), id.to_owned().into(), (limit as i64 + 1).into()]);
    let mut statement = connection.prepare_cached(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(values), activity_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A page of what `filter` selects, newest first, from a cursor. `next` is
/// the number of the first parameter after the filter's own.
fn feed_sql(filter: &str, next: usize) -> String {
    format!(
        "SELECT {COLUMNS} FROM activity_projection WHERE {filter}
         AND (latest_at,id)<(?{next},?{}) ORDER BY latest_at DESC,id DESC LIMIT ?{}",
        next + 1,
        next + 2
    )
}

fn activity_page(mut items: Vec<ActivityEvent>, limit: usize) -> ActivityPage {
    let next_cursor = next_cursor(&mut items, limit, |item| (item.created_at, &item.id));
    ActivityPage { items, next_cursor }
}

fn activity_row(row: &Row<'_>) -> rusqlite::Result<ActivityEvent> {
    fn parse(value: Option<String>) -> Option<Value> {
        value.and_then(|value| serde_json::from_str(&value).ok())
    }
    let field: Option<String> = row.get(8)?;
    let metadata = crate::legacy_values::payload(parse(row.get(11)?).unwrap_or_else(|| json!({})));
    let event_type: String = row.get(7)?;
    let private_comparison = event_type == "comment.edited";
    let value = |index| -> rusqlite::Result<Option<Value>> {
        Ok(if private_comparison {
            None
        } else {
            crate::legacy_values::activity(parse(row.get(index)?), field.as_deref())
        })
    };
    Ok(ActivityEvent {
        id: row.get(0)?,
        project_id: row.get(1)?,
        entity_type: row.get(2)?,
        entity_id: row.get(3)?,
        task_id: row.get(4)?,
        actor_user_id: row.get(5)?,
        actor_name: row.get(6)?,
        actor_mcp_grant_id: metadata
            .get("actorMcpGrantId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        actor_app_name: metadata
            .get("actorAppName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        before: value(9)?,
        after: value(10)?,
        event_type,
        field_key: field,
        metadata,
        entity_revision: row.get(12)?,
        created_at: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrated_connection, query_plan};

    #[test]
    fn project_feeds_read_their_partial_index_in_order() {
        let (_root, connection) = migrated_connection();
        for (task, owner, index) in [
            (false, false, "activity_projection_project_public_feed_idx"),
            (true, false, "activity_projection_task_public_feed_idx"),
            (false, true, "activity_projection_project_owner_feed_idx"),
            (true, true, "activity_projection_task_owner_feed_idx"),
        ] {
            let next = 2 + usize::from(task) + usize::from(owner);
            let plan = query_plan(&connection, &feed_sql(&project_filter(task, owner), next));
            assert!(
                plan.contains(index) && !plan.contains("TEMP B-TREE"),
                "{plan}"
            );
        }
    }
}
