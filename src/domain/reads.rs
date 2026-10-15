//! Every read of projects, the Board, the Roadmap, tasks and the Pool, with
//! cursor paging.

mod board;
mod bootstrap;
mod paging;
mod roadmap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    access::{self, Need, require_project},
    auth::{Actor, refresh_actor_connection},
    clock::unix_now,
    error::{AppError, AppResult},
    timezone::TimeZone,
};

use super::{
    BlockView, BoardCounts, BoardView, BootstrapView, DomainService, DoneOrder, EpicSummary,
    EpicView, MembershipView, MilestoneView, Page, PageSummary, PoolItemView, PoolScope,
    ProjectMembers, ProjectView, SessionView, TaskStatus, TaskView, TrackView, UserView,
};

pub(super) use board::task_view;
use board::*;
use bootstrap::*;
use paging::*;
use roadmap::*;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapQuery {
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub view: Option<String>,
    /// The order of the Board's Done page, when the bootstrap has Board pages.
    #[serde(default)]
    pub done_order: DoneOrder,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

impl Default for PageQuery {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: Some(PAGE_SIZE),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardQuery {
    pub project_id: String,
    pub status: TaskStatus,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub search: Option<String>,
    #[serde(default)]
    pub track_ids: Vec<String>,
    #[serde(default)]
    pub epic_ids: Vec<String>,
    #[serde(default)]
    pub assignee_ids: Vec<String>,
    #[serde(default)]
    pub no_assignee: bool,
    #[serde(default)]
    pub blocked: bool,
    /// Applies to the Done column; other columns keep their manual order.
    #[serde(default)]
    pub done_order: DoneOrder,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardViewQuery {
    pub project_id: String,
    pub limit: Option<usize>,
    pub search: Option<String>,
    #[serde(default)]
    pub track_ids: Vec<String>,
    #[serde(default)]
    pub epic_ids: Vec<String>,
    #[serde(default)]
    pub assignee_ids: Vec<String>,
    #[serde(default)]
    pub no_assignee: bool,
    #[serde(default)]
    pub blocked: bool,
    #[serde(default)]
    pub done_order: DoneOrder,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
        actor.require_ready()?;
        // Without a view, the bootstrap has only what every view needs.
        let view = query.view.clone().unwrap_or_else(|| "metadata".into());
        if !["board", "roadmap", "task", "metadata"].contains(&view.as_str()) {
            return Err(AppError::validation("view", "unknown initial view"));
        }
        let actor = actor.clone();
        let time_zone = self.time_zone.clone();
        self.db
            .snapshot(move |connection| {
                bootstrap_snapshot(connection, &actor, query, view, &time_zone)
            })
            .await
    }

    /// The projects the actor may read, and what it may manage in each.
    pub async fn projects(&self, actor: &Actor) -> AppResult<Vec<ProjectView>> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                projects(connection, &actor)
            })
            .await
    }

    /// One project with its memberships and the people they name.
    pub async fn project_members(
        &self,
        actor: &Actor,
        project_id: String,
    ) -> AppResult<ProjectMembers> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                require_project(connection, &actor, &project_id, Need::Read, false)?;
                let project = projects(connection, &actor)?
                    .into_iter()
                    .find(|project| project.id == project_id)
                    .ok_or(AppError::NotFound {
                        resource: "project",
                    })?;
                Ok(ProjectMembers {
                    project,
                    memberships: memberships(connection, &project_id)?,
                    users: users(connection, &actor, &project_id)?,
                })
            })
            .await
    }

    pub async fn board_page(&self, actor: &Actor, query: BoardQuery) -> AppResult<Page<TaskView>> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                board_page_connection(connection, &actor, &query)
            })
            .await
    }

    pub async fn board_view(&self, actor: &Actor, query: BoardViewQuery) -> AppResult<BoardView> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                require_project(connection, &actor, &query.project_id, Need::Read, false)?;
                let counts = board_counts_connection(connection, &query.project_id)?;
                let unfiltered = query
                    .search
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                    && query.track_ids.is_empty()
                    && query.epic_ids.is_empty()
                    && query.assignee_ids.is_empty()
                    && !query.no_assignee
                    && !query.blocked;
                let page = |status: TaskStatus, total: i64| {
                    board_page_with_total(
                        connection,
                        &actor,
                        &BoardQuery {
                            project_id: query.project_id.clone(),
                            status,
                            cursor: None,
                            limit: query.limit,
                            search: query.search.clone(),
                            track_ids: query.track_ids.clone(),
                            epic_ids: query.epic_ids.clone(),
                            assignee_ids: query.assignee_ids.clone(),
                            no_assignee: query.no_assignee,
                            blocked: query.blocked,
                            done_order: query.done_order,
                        },
                        unfiltered.then_some(total),
                    )
                };
                let planning = page(TaskStatus::Planning, counts.planning)?;
                let in_progress = page(TaskStatus::InProgress, counts.in_progress)?;
                let in_review = page(TaskStatus::InReview, counts.in_review)?;
                let done = page(TaskStatus::Done, counts.done)?;

                let result = BoardView {
                    project_id: query.project_id,
                    planning,
                    in_progress,
                    in_review,
                    done,
                    counts,
                };
                Ok(result)
            })
            .await
    }

    pub async fn board_counts(&self, actor: &Actor, project_id: String) -> AppResult<BoardCounts> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                require_project(connection, &actor, &project_id, Need::Read, false)?;
                board_counts_connection(connection, &project_id)
            })
            .await
    }

    pub async fn roadmap(&self, actor: &Actor, project_id: String) -> AppResult<Value> {
        actor.require_ready()?;
        let actor = actor.clone();
        let time_zone = self.time_zone.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                require_project(connection, &actor, &project_id, Need::Read, false)?;
                Ok(json!({
                "projectId":project_id,
                "tracks":tracks(connection,&project_id)?,
                "epics":epics(connection,&project_id,&time_zone,Some(unix_now()?))?,
                "milestones":milestones(connection,&project_id)?
                }))
            })
            .await
    }

    pub async fn pool_page(
        &self,
        actor: &Actor,
        query: PoolQuery,
    ) -> AppResult<Page<PoolItemView>> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                pool_page_connection(
                    connection,
                    &actor,
                    &query.project_id,
                    query.scope,
                    query.cursor.as_deref(),
                    page_limit(query.limit),
                )
            })
            .await
    }

    pub async fn task(&self, actor: &Actor, task_id: String) -> AppResult<TaskView> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                let id = resolve_task_id(connection, &task_id)?
                    .ok_or(AppError::NotFound { resource: "task" })?;
                let project_id: String = connection
                    .query_row(
                        "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                        [&id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or(AppError::NotFound { resource: "task" })?;
                require_project(connection, &actor, &project_id, Need::Read, false)?;
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
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                let project_id = epic_project(connection, &epic_id)?;
                require_project(connection, &actor, &project_id, Need::Read, false)?;
                epic_task_page_connection(
                    connection,
                    &epic_id,
                    query.cursor.as_deref(),
                    page_limit(query.limit),
                )
            })
            .await
    }
}

fn epic_project(connection: &rusqlite::Connection, epic_id: &str) -> AppResult<String> {
    connection
        .query_row(
            "SELECT project_id FROM epics WHERE id=?1 AND deleted_at IS NULL",
            [epic_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "epic" })
}

fn projects(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<Vec<ProjectView>> {
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
    if !scope("project_read")? {
        return Ok(Vec::new());
    }
    let (manage_board, manage_roadmap) = (scope("board_manage")?, scope("roadmap_manage")?);
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
    require_project(connection, actor, project_id, Need::Read, false)?;
    if scope == PoolScope::Personal && !crate::access::can_read_private_pool(connection, actor)? {
        return Err(AppError::Forbidden);
    }
    let (cursor_time, cursor_id) = parse_position_cursor(cursor)?;
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
    let rows = s
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
    let more = rows.len() > limit;
    let items: Vec<_> = rows.into_iter().take(limit).collect();
    let next_cursor = if more {
        items.last().map(|i| format!("{}:{}", i.created_at, i.id))
    } else {
        None
    };
    Ok(Page {
        items,
        next_cursor,
        total,
    })
}

fn resolve_task_id(connection: &rusqlite::Connection, value: &str) -> AppResult<Option<String>> {
    connection.query_row("SELECT id FROM tasks WHERE (id=?1 OR task_key=?1 COLLATE NOCASE) AND deleted_at IS NULL",[value],|row|row.get(0)).optional().map_err(Into::into)
}

#[cfg(test)]
mod tests;
