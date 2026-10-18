//! Every read of projects, the Board, the Roadmap, tasks and the Pool, with
//! cursor paging.

mod board;
mod bootstrap;
mod lanes;
mod roadmap;

use board::{
    board_columns, board_counts_connection, board_page_connection, epic_task_page_connection,
};
use bootstrap::bootstrap_snapshot;
use lanes::timeline;
use roadmap::{epics, local_date, milestones, tracks};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    access::{self, McpScope, Need, require_project},
    auth::Actor,
    clock::unix_now,
    error::{AppError, AppResult},
    paging::{self, PageQuery, TimeCursor, next_cursor},
    timezone::TimeZone,
};

use super::{
    BlockView, BoardCounts, BoardView, BootstrapView, ChecklistItemView, DomainService, DoneOrder,
    EpicSummary, EpicView, MembershipView, MilestoneView, Page, PageSummary, PoolItemView,
    PoolScope, ProjectMembers, ProjectView, RoadmapDays, RoadmapList, RoadmapView, SessionView,
    TaskStatus, TaskView, TrackView, UserView,
};

pub(super) use board::{checklist_item, task_view};

/// How many tasks and epics a track has, not counting deleted ones. Reads of
/// a track's tasks name its index, as the Board's track filter does: each
/// deleted task has its own `deleted_at`, so the statistics make the tasks
/// that aren't deleted look few, and SQLite would read the project's tasks
/// through `tasks_project_status_idx` instead.
pub(in crate::domain) const TRACK_CONTENTS_SQL: &str =
    "SELECT (SELECT COUNT(*) FROM tasks INDEXED BY tasks_project_track_status_idx
             WHERE project_id=?1 AND track_id=?2 AND deleted_at IS NULL),
            (SELECT COUNT(*) FROM epics WHERE track_id=?2 AND deleted_at IS NULL)";

#[derive(Clone, Debug, Default)]
pub struct BootstrapQuery {
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub view: Option<String>,
    /// The project that this browser last switched to, and the person who
    /// switched. It opens when nothing else names a project, but only for
    /// that person and while they can open it.
    pub switched_to: Option<String>,
    pub switched_by: Option<String>,
    /// The filter and Done order of the Board pages, when the bootstrap has them.
    pub filter: TaskFilter,
    /// The days of the Roadmap's lanes, when the bootstrap is for the Roadmap.
    pub roadmap: RoadmapWindow,
}

/// The days a read of the Roadmap's lanes covers, `from` to `to`; each left
/// out is the one the Roadmap opens with, counted from today. On days with
/// one task each, `marks` of those tasks (none when left out) come with the
/// counts, the ones nearest `anchor` (today when left out) first. With
/// `apart`, only of the
/// days that many days or more from the section's other days with tasks of
/// their kind, done or planned: the ones the page draws on their own.
#[derive(Clone, Debug, Default)]
pub struct RoadmapWindow {
    pub from: Option<String>,
    pub to: Option<String>,
    pub anchor: Option<String>,
    pub marks: Option<usize>,
    pub apart: Option<f64>,
}

/// A read of the Roadmap's lanes: their counts, work in progress and late
/// tasks, and the days of `window`. A change made elsewhere names the tasks
/// it changed (`tasks`), and the sections they may have left (`sections`,
/// each `trackId/epicId`, or `trackId/` for a track's own work); the read
/// then has the work in progress and the days of those sections and of the
/// ones the named tasks are in only, and the longest overdue tasks only when
/// a named task is among them, or was (`late`).
#[derive(Clone, Debug, Default)]
pub struct LanesQuery {
    pub window: RoadmapWindow,
    pub tasks: Option<Vec<String>>,
    pub sections: Vec<String>,
    pub late: bool,
}

/// The most tasks one read of changed tasks names.
pub const NAMED_TASKS_LIMIT: usize = 50;

/// What a list of a section's tasks on the Roadmap holds.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ListKind {
    /// Tasks done from `from` to `to`, the latest first.
    Done,
    /// Plans due from `from` to `to`, the earliest first.
    Plans,
    /// Work in progress, the most urgent first.
    Open,
}

/// The tasks of one section that a mark counting several stands for.
#[derive(Clone, Debug)]
pub struct RoadmapListQuery {
    pub project_id: String,
    pub track_id: String,
    pub epic_id: Option<String>,
    pub kind: ListKind,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// The size of a page of tasks or Pool items, and the most one may hold.
const PAGE_SIZE: usize = 50;

/// What `epic_ids` names for the tasks without an epic.
const NO_EPIC: &str = "none";

/// Which tasks a Board read shows, and the order of its Done column.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFilter {
    /// Text in the task key or title, in any case.
    pub search: Option<String>,
    pub track_ids: Vec<String>,
    /// Epics, with `none` for the tasks without an epic.
    pub epic_ids: Vec<String>,
    /// With `no_assignee`, tasks of any of these people or of nobody.
    pub assignee_ids: Vec<String>,
    pub no_assignee: bool,
    pub blocked: bool,
    /// Applies to the Done column; other columns keep their manual order.
    pub done_order: DoneOrder,
}

impl TaskFilter {
    /// Whether the filter shows every task. The Done order only sorts them.
    pub fn is_empty(&self) -> bool {
        self.search
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
            && self.track_ids.is_empty()
            && self.epic_ids.is_empty()
            && self.assignee_ids.is_empty()
            && !self.no_assignee
            && !self.blocked
    }
}

/// A page of one Board column.
#[derive(Clone, Debug)]
pub struct BoardQuery {
    pub project_id: String,
    pub status: TaskStatus,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub filter: TaskFilter,
}

/// The first page of every Board column, read at one moment.
#[derive(Clone, Debug)]
pub struct BoardViewQuery {
    pub project_id: String,
    pub limit: Option<usize>,
    pub filter: TaskFilter,
}

#[derive(Clone, Debug)]
pub struct PoolQuery {
    pub project_id: String,
    pub scope: PoolScope,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

impl DomainService {
    pub async fn bootstrap(
        &self,
        actor: &Actor,
        query: BootstrapQuery,
    ) -> AppResult<BootstrapView> {
        let time_zone = self.time_zone.clone();
        access::read(&self.db, actor, move |connection, actor| {
            // Without a view, the bootstrap has only what every view needs.
            let view = query.view.clone().unwrap_or_else(|| "metadata".into());
            if !["board", "roadmap", "task", "metadata"].contains(&view.as_str()) {
                return Err(AppError::validation("view", "unknown initial view"));
            }
            bootstrap_snapshot(connection, actor, query, view, &time_zone)
        })
        .await
    }

    /// The projects the actor may read, and what it may manage in each.
    pub async fn projects(&self, actor: &Actor) -> AppResult<Vec<ProjectView>> {
        access::read(&self.db, actor, move |connection, actor| {
            projects(connection, actor)
        })
        .await
    }

    /// One project with its memberships and the people they name.
    pub async fn project_members(
        &self,
        actor: &Actor,
        project_id: String,
    ) -> AppResult<ProjectMembers> {
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &project_id, Need::Read, false)?;
            let project = projects(connection, actor)?
                .into_iter()
                .find(|project| project.id == project_id)
                .ok_or(AppError::NotFound {
                    resource: "project",
                })?;
            Ok(ProjectMembers {
                project,
                memberships: memberships(connection, &project_id)?,
                users: users(connection, actor, &project_id)?,
            })
        })
        .await
    }

    pub async fn board_page(&self, actor: &Actor, query: BoardQuery) -> AppResult<Page<TaskView>> {
        access::read(&self.db, actor, move |connection, actor| {
            board_page_connection(connection, actor, &query)
        })
        .await
    }

    pub async fn board_view(&self, actor: &Actor, query: BoardViewQuery) -> AppResult<BoardView> {
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &query.project_id, Need::Read, false)?;
            board_columns(connection, &query.project_id, query.limit, &query.filter)
        })
        .await
    }

    pub async fn board_counts(&self, actor: &Actor, project_id: String) -> AppResult<BoardCounts> {
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &project_id, Need::Read, false)?;
            board_counts_connection(connection, &project_id)
        })
        .await
    }

    /// A project's tracks, its epics with their task counts, and its
    /// milestones; with `lanes`, also what the Roadmap's lanes draw.
    pub async fn roadmap(
        &self,
        actor: &Actor,
        project_id: String,
        lanes: Option<LanesQuery>,
    ) -> AppResult<RoadmapView> {
        let time_zone = self.time_zone.clone();
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &project_id, Need::Read, false)?;
            let now = unix_now()?;
            let (lanes, changed) = match lanes {
                Some(query) => {
                    let today = local_date(&time_zone, now)?;
                    let (lanes, changed) =
                        timeline(connection, &project_id, &time_zone, today, &query)?;
                    (Some(lanes), changed)
                }
                None => (None, None),
            };
            let mut epics = epics(connection, &project_id, &time_zone, Some(now))?;
            // A change made elsewhere to tasks changed the epics they were or
            // are in only, and left the tracks and milestones as they are.
            let (tracks, milestones) = match changed {
                Some(changed) => {
                    epics.retain(|epic| {
                        changed
                            .iter()
                            .any(|(_, id)| id.as_deref() == Some(epic.id.as_str()))
                    });
                    (Vec::new(), Vec::new())
                }
                None => (
                    tracks(connection, &project_id)?,
                    milestones(connection, &project_id)?,
                ),
            };
            Ok(RoadmapView {
                tracks,
                epics,
                milestones,
                lanes,
                project_id,
            })
        })
        .await
    }

    /// The done tasks and dated plans of a window of days on the Roadmap,
    /// counted by day, as its view comes to them.
    pub async fn roadmap_days(
        &self,
        actor: &Actor,
        project_id: String,
        window: RoadmapWindow,
    ) -> AppResult<RoadmapDays> {
        let time_zone = self.time_zone.clone();
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &project_id, Need::Read, false)?;
            let today = local_date(&time_zone, unix_now()?)?;
            lanes::days(
                connection,
                &project_id,
                &time_zone,
                today,
                &window,
                true,
                None,
            )
        })
        .await
    }

    /// The tasks of one section that a mark counting several stands for.
    pub async fn roadmap_list(
        &self,
        actor: &Actor,
        query: RoadmapListQuery,
    ) -> AppResult<RoadmapList> {
        let time_zone = self.time_zone.clone();
        access::read(&self.db, actor, move |connection, actor| {
            require_project(connection, actor, &query.project_id, Need::Read, false)?;
            let today = local_date(&time_zone, unix_now()?)?;
            lanes::list(connection, &time_zone, today, &query)
        })
        .await
    }

    pub async fn pool_page(
        &self,
        actor: &Actor,
        query: PoolQuery,
    ) -> AppResult<Page<PoolItemView>> {
        access::read(&self.db, actor, move |connection, actor| {
            pool_page_connection(
                connection,
                actor,
                &query.project_id,
                query.scope,
                query.cursor.as_deref(),
                paging::page_limit(query.limit, PAGE_SIZE, PAGE_SIZE),
            )
        })
        .await
    }

    pub async fn task(&self, actor: &Actor, task_id: String) -> AppResult<TaskView> {
        access::read(&self.db, actor, move |connection, actor| {
            let id = resolve_task_id(connection, &task_id)?;
            access::require_task(connection, actor, &id, Need::Read, false)?;
            task_view(connection, &id)
        })
        .await
    }

    pub async fn epic_tasks(
        &self,
        actor: &Actor,
        epic_id: String,
        query: PageQuery,
    ) -> AppResult<Page<TaskView>> {
        access::read(&self.db, actor, move |connection, actor| {
            let project_id = access::require_epic(connection, actor, &epic_id, Need::Read, false)?;
            epic_task_page_connection(
                connection,
                &project_id,
                &epic_id,
                query.cursor.as_deref(),
                paging::page_limit(query.limit, PAGE_SIZE, PAGE_SIZE),
            )
        })
        .await
    }
}

/// The projects the actor may read, with what it may manage in each and the
/// prefixes each had before.
fn projects(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<Vec<ProjectView>> {
    let mut projects = readable_projects(connection, actor)?;
    let mut earlier = earlier_prefixes(
        connection,
        &projects
            .iter()
            .map(|project| (project.id.as_str(), project.task_prefix.as_str()))
            .collect::<Vec<_>>(),
    )?;
    for project in &mut projects {
        project.earlier_prefixes = earlier.remove(&project.id).unwrap_or_default();
    }
    Ok(projects)
}

/// The prefixes that each project, given by its ID and current prefix, had
/// before, in one query for all of them.
pub(in crate::domain) fn earlier_prefixes(
    connection: &rusqlite::Connection,
    projects: &[(&str, &str)],
) -> AppResult<std::collections::HashMap<String, Vec<String>>> {
    let current: std::collections::HashMap<&str, &str> = projects.iter().copied().collect();
    let ids = serde_json::to_string(&current.keys().collect::<Vec<_>>())
        .map_err(|error| AppError::internal(error.to_string()))?;
    let mut statement = connection.prepare_cached(
        "SELECT project_id,prefix FROM project_prefixes
         WHERE project_id IN (SELECT value FROM json_each(?1)) ORDER BY prefix",
    )?;
    let mut earlier = std::collections::HashMap::<String, Vec<String>>::new();
    for row in statement.query_map([ids], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (project, prefix) = row?;
        if current.get(project.as_str()) != Some(&prefix.as_str()) {
            earlier.entry(project).or_default().push(prefix);
        }
    }
    Ok(earlier)
}

/// The projects the actor may read, and what it may manage in each.
fn readable_projects(
    connection: &rusqlite::Connection,
    actor: &Actor,
) -> AppResult<Vec<ProjectView>> {
    let sql = if actor.is_admin {
        "SELECT p.id,p.name,p.task_prefix,p.revision,1,1 FROM projects p WHERE p.deleted_at IS \
                     NULL ORDER BY lower(p.name),p.id"
    } else {
        "SELECT p.id,p.name,p.task_prefix,p.revision,m.manage_roadmap,m.manage_board FROM \
                     projects p JOIN project_memberships m ON m.project_id=p.id WHERE p.deleted_at IS NULL AND \
                     m.user_id=?1 ORDER BY lower(p.name),p.id"
    };
    let mut statement = connection.prepare_cached(sql)?;
    let rows = if actor.is_admin {
        statement
            .query_map([], project_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        statement
            .query_map([&actor.user_id], project_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let Some(grant_id) = actor.mcp_grant_id() else {
        return Ok(rows);
    };
    // A grant narrows what the person may do to its projects and scopes.
    let scope = |scope| access::allowed(access::require_scope(connection, actor, scope, None));
    if !scope(McpScope::ProjectRead)? {
        return Ok(Vec::new());
    }
    let (manage_board, manage_roadmap) = (
        scope(McpScope::BoardManage)?,
        scope(McpScope::RoadmapManage)?,
    );
    let selected: std::collections::HashSet<String> = connection
        .prepare_cached("SELECT project_id FROM mcp_grant_projects WHERE grant_id=?1")?
        .query_map([grant_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|project| selected.contains(&project.id))
        .map(|project| ProjectView {
            manage_board: project.manage_board && manage_board,
            manage_roadmap: project.manage_roadmap && manage_roadmap,
            ..project
        })
        .collect())
}

fn project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectView> {
    Ok(ProjectView {
        id: row.get(0)?,
        name: row.get(1)?,
        task_prefix: row.get(2)?,
        earlier_prefixes: Vec::new(),
        revision: row.get(3)?,
        manage_roadmap: row.get(4)?,
        manage_board: row.get(5)?,
    })
}

fn memberships(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<Vec<MembershipView>> {
    let mut s = connection.prepare_cached(
        "SELECT project_id,user_id,manage_roadmap,manage_board,revision FROM project_memberships \
                     WHERE project_id=?1 ORDER BY user_id",
    )?;
    Ok(s.query_map([project_id], |r| {
        Ok(MembershipView {
            project_id: r.get(0)?,
            user_id: r.get(1)?,
            manage_roadmap: r.get(2)?,
            manage_board: r.get(3)?,
            revision: r.get(4)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?)
}
fn users(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
) -> AppResult<Vec<UserView>> {
    let mut s=connection.prepare_cached("SELECT DISTINCT u.id,u.username,u.display_name,u.is_admin,u.is_active,u.avatar_blob_id,\
                     u.revision FROM users u LEFT JOIN project_memberships m ON m.user_id=u.id WHERE \
                     m.project_id=?1 OR u.id=?2 ORDER BY u.is_active DESC,lower(u.display_name),u.id")?;
    Ok(s.query_map(params![project_id, actor.user_id], user_row)?
        .collect::<Result<Vec<_>, _>>()?)
}
fn user_view(connection: &rusqlite::Connection, user_id: &str) -> AppResult<UserView> {
    connection
        .query_row(
        "SELECT id,username,display_name,is_admin,is_active,avatar_blob_id,revision FROM users WHERE id=?1",
            [user_id],
            user_row,
        )
        .map_err(Into::into)
}
fn user_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<UserView> {
    let id: String = r.get(0)?;
    let avatar: Option<String> = r.get(5)?;
    Ok(UserView {
        avatar_url: avatar.map(|blob| crate::auth::avatar_url(&id, &blob)),
        id,
        username: r.get(1)?,
        name: r.get(2)?,
        is_admin: r.get(3)?,
        is_active: r.get(4)?,
        revision: r.get(6)?,
    })
}

fn pool_page_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
    scope: PoolScope,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<Page<PoolItemView>> {
    match scope {
        PoolScope::Team => require_project(connection, actor, project_id, Need::Read, false)?,
        PoolScope::Personal => access::require_private_pool(connection, actor, project_id, false)?,
    }
    let cursor: Option<TimeCursor> = cursor.map(paging::decode).transpose()?;
    let (cursor_time, cursor_id) = cursor.map(|cursor| (cursor.time, cursor.id)).unzip();
    let own = &actor.user_id;
    let scope = scope.as_str();
    let predicate = "project_id=?1 AND scope=?3 AND (scope='team' OR owner_user_id=?2)";
    let total = connection.query_row(
        &format!("SELECT COUNT(*) FROM pool_items WHERE {predicate}"),
        params![project_id, own, scope],
        |r| r.get(0),
    )?;
    let mut s=connection.prepare_cached(&format!("SELECT id,project_id,scope,owner_user_id,title,description,created_at,revision FROM \
                     pool_items WHERE {predicate} AND (?4 IS NULL OR created_at>?4 OR (created_at=?4 AND \
                     id>?5)) ORDER BY created_at,id LIMIT ?6"))?;
    let mut items = s
        .query_map(
            params![
                project_id,
                own,
                scope,
                cursor_time,
                cursor_id,
                (limit + 1) as i64
            ],
            |r| {
                Ok(PoolItemView {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    scope: r.get(2)?,
                    owner_user_id: r.get(3)?,
                    title: r.get(4)?,
                    description: r.get(5)?,
                    created_at: r.get(6)?,
                    revision: r.get(7)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = next_cursor(&mut items, limit, |item| (item.created_at, &item.id));
    Ok(Page {
        items,
        next_cursor,
        total,
    })
}

/// The ID of the task that `value` names by its ID or its key, such as
/// `WEB-042`. Callers check access to the task's project.
pub(crate) fn resolve_task_id(connection: &rusqlite::Connection, value: &str) -> AppResult<String> {
    connection
        .prepare_cached(TASK_BY_ID_OR_KEY_SQL)?
        .query_row([value], |row| row.get(0))
        .optional()?
        .ok_or(AppError::NotFound { resource: "task" })
}

/// A task by its ID or its key, as two lookups that each search their own
/// unique index whatever the statistics say. As one lookup with OR, SQLite
/// read the tasks one by one until it met the one named, with any
/// statistics, which was slow on large instances.
const TASK_BY_ID_OR_KEY_SQL: &str = "SELECT id FROM tasks WHERE id=?1 AND deleted_at IS NULL
    UNION ALL SELECT id FROM tasks WHERE task_key=?1 COLLATE NOCASE AND deleted_at IS NULL";

#[cfg(test)]
mod tests;
