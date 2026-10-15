use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jiff::{
    Timestamp, ToSpan,
    civil::{Date, DateTime},
    tz::AmbiguousOffset,
};
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
    BlockView, BoardCounts, BoardView, BootstrapView, DomainService, EpicSummary, EpicView,
    MembershipView, MilestoneView, Page, PoolItemView, ProjectMembers, ProjectView, SessionView,
    TaskView, TrackView, UserView,
};

const PAGE_SIZE: usize = 50;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapQuery {
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub view: Option<String>,
    /// The order of the Board's Done page, when the bootstrap has Board pages.
    #[serde(default)]
    pub done_order: super::DoneOrder,
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
    pub status: super::TaskStatus,
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
    pub done_order: super::DoneOrder,
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
    pub done_order: super::DoneOrder,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectReadQuery {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolQuery {
    pub project_id: String,
    pub scope: super::PoolScope,
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
                let page = |status: super::TaskStatus, total: i64| {
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
                let planning = page(super::TaskStatus::Planning, counts.planning)?;
                let in_progress = page(super::TaskStatus::InProgress, counts.in_progress)?;
                let in_review = page(super::TaskStatus::InReview, counts.in_review)?;
                let done = page(super::TaskStatus::Done, counts.done)?;

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

fn tracks(connection: &rusqlite::Connection, project_id: &str) -> AppResult<Vec<TrackView>> {
    let mut s = connection.prepare_cached(
        "SELECT id,project_id,name,description,position,revision FROM tracks WHERE project_id=?1 \
                     AND deleted_at IS NULL ORDER BY position,id",
    )?;
    Ok(s.query_map([project_id], |r| {
        Ok(TrackView {
            id: r.get(0)?,
            project_id: r.get(1)?,
            name: r.get(2)?,
            description: r.get(3)?,
            position: r.get(4)?,
            revision: r.get(5)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?)
}
/// Epics in timeline order, with their task counts as of `counted_at` when
/// it is given. Only the Roadmap shows the counts, which read every task of
/// the project.
fn epics(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    counted_at: Option<i64>,
) -> AppResult<Vec<EpicView>> {
    let Some(now) = counted_at else {
        return epic_rows(connection, project_id);
    };
    let now = Timestamp::from_second(now)
        .map_err(|error| AppError::internal(format!("read the current time: {error}")))?;
    epics_on(
        connection,
        project_id,
        timezone,
        timezone.rules().to_datetime(now).date(),
    )
}

fn epic_rows(connection: &rusqlite::Connection, project_id: &str) -> AppResult<Vec<EpicView>> {
    let mut statement = connection.prepare_cached("SELECT id,project_id,track_id,title,description,start_date,end_date,state,position,\
                     revision FROM epics WHERE project_id=?1 AND deleted_at IS NULL ORDER BY start_date,position,id")?;
    Ok(statement
        .query_map([project_id], |row| {
            Ok(EpicView {
                id: row.get(0)?,
                project_id: row.get(1)?,
                track_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                start_date: row.get(5)?,
                end_date: row.get(6)?,
                state: row.get(7)?,
                position: row.get(8)?,
                revision: row.get(9)?,
                summary: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn epics_on(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    today: Date,
) -> AppResult<Vec<EpicView>> {
    let week_start = today - today.weekday().to_monday_zero_offset().days();
    let week_start_epoch = local_midnight(timezone, week_start)?;
    let trailing_start = today - 6.days();
    let mut boundaries = Vec::with_capacity(8);
    for offset in 0..8 {
        boundaries.push(local_midnight(timezone, trailing_start + offset.days())?);
    }
    let mut result = epic_rows(connection, project_id)?;
    for epic in &mut result {
        epic.summary = Some(EpicSummary {
            task_total: 0,
            task_done: 0,
            task_open: 0,
            completed_this_week: 0,
            completed_since_start: 0,
            weekly_completions: vec![0; 7],
        });
    }
    let starts = result
        .iter()
        .map(|epic| {
            let start = epic
                .start_date
                .parse::<Date>()
                .map_err(|_| AppError::internal("stored epic start date is invalid"))?;
            Ok((&epic.id, local_midnight(timezone, start)?))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let starts =
        serde_json::to_string(&starts).map_err(|error| AppError::internal(error.to_string()))?;
    // Bounded covering-index ranges return one row per epic. COUNT ranges avoid
    // decoding completion groups or evaluating eleven sums for every task.
    // JSON packs the fixed-size result into a single scalar column.
    let mut counts = connection.prepare_cached(EPIC_SUMMARY_SQL)?;
    let mut rows = counts.query(params![
        project_id,
        starts,
        week_start_epoch,
        boundaries[0],
        boundaries[1],
        boundaries[2],
        boundaries[3],
        boundaries[4],
        boundaries[5],
        boundaries[6],
        boundaries[7]
    ])?;
    while let Some(row) = rows.next()? {
        let index = row.get::<_, i64>(0)? as usize;
        let counts: [i64; 11] = serde_json::from_str(&row.get::<_, String>(1)?)
            .map_err(|error| AppError::internal(format!("invalid epic summary: {error}")))?;
        result[index].summary = Some(EpicSummary {
            task_total: counts[0],
            task_done: counts[1],
            task_open: counts[0] - counts[1],
            completed_this_week: counts[2],
            completed_since_start: counts[3],
            weekly_completions: counts[4..].to_vec(),
        });
    }
    Ok(result)
}

const EPIC_SUMMARY_SQL: &str = "
    SELECT e.key,json_array(
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done'),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?3),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=json_extract(e.value,'$[1]')),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?4 AND t.completed_at<?5),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?5 AND t.completed_at<?6),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?6 AND t.completed_at<?7),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?7 AND t.completed_at<?8),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?8 AND t.completed_at<?9),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?9 AND t.completed_at<?10),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?10 AND t.completed_at<?11))
    FROM json_each(?2) e";

fn local_midnight(timezone: &TimeZone, mut date: Date) -> AppResult<i64> {
    // Midnight gaps and even skipped calendar dates map to the first following
    // representable local instant. Date-only records remain valid in every zone.
    // The instant is plain arithmetic because jiff timestamps end before
    // 9999-12-31, a valid date.
    const UNIX_EPOCH: DateTime = jiff::civil::date(1970, 1, 1).at(0, 0, 0, 0);
    loop {
        for hour in 0..24 {
            for minute in 0..60 {
                let local = date.at(hour, minute, 0, 0);
                let offset = match timezone.rules().to_ambiguous_timestamp(local).offset() {
                    AmbiguousOffset::Unambiguous { offset } => offset,
                    AmbiguousOffset::Fold { before, .. } => before,
                    AmbiguousOffset::Gap { .. } => continue,
                };
                let seconds = local.duration_since(UNIX_EPOCH).as_secs();
                return Ok(seconds - i64::from(offset.seconds()));
            }
        }
        date = date
            .tomorrow()
            .map_err(|_| AppError::internal("calendar range exhausted"))?;
    }
}

fn milestones(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<Vec<MilestoneView>> {
    let mut s = connection.prepare_cached(
        "SELECT id,project_id,title,description,milestone_date,revision FROM milestones WHERE \
                     project_id=?1 AND deleted_at IS NULL ORDER BY milestone_date,id",
    )?;
    Ok(s.query_map([project_id], |r| {
        Ok(MilestoneView {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            description: r.get(3)?,
            milestone_date: r.get(4)?,
            revision: r.get(5)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?)
}

fn board_page_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    q: &BoardQuery,
) -> AppResult<Page<TaskView>> {
    board_page_with_total(connection, actor, q, None)
}

fn board_page_with_total(
    connection: &rusqlite::Connection,
    actor: &Actor,
    q: &BoardQuery,
    total: Option<i64>,
) -> AppResult<Page<TaskView>> {
    require_project(connection, actor, &q.project_id, Need::Read, false)?;
    let limit = page_limit(q.limit);
    let generation = task_page_generation(connection, &q.project_id)?;
    // Only Done has a newest-first order; other columns ignore the choice.
    let newest = q.status == super::TaskStatus::Done && q.done_order == super::DoneOrder::Completed;
    let scope = if newest {
        format!("board:{}:done:completed", q.project_id)
    } else {
        format!("board:{}:{}", q.project_id, q.status.as_str())
    };
    let start = match q.cursor.as_deref() {
        None => None,
        Some(raw) if newest => {
            let cursor: CompletedCursor = decode_cursor(raw)?;
            check_task_cursor(cursor.generation, generation, &cursor.scope, &scope)?;
            Some(PageStart::Completed {
                at: cursor.completed_at,
                order: cursor.completion_order,
                id: cursor.id,
            })
        }
        Some(raw) => {
            let cursor: BoardCursor = decode_cursor(raw)?;
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
    if let Some(search) = q
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
    if !q.track_ids.is_empty() {
        values.push(
            serde_json::to_string(&q.track_ids)
                .map_err(|error| AppError::internal(error.to_string()))?
                .into(),
        );
        conditions.push(format!("EXISTS(SELECT 1 FROM epics e WHERE e.id=t.epic_id AND e.track_id IN (SELECT value FROM json_each(?{})))",values.len()));
    }
    if !q.epic_ids.is_empty() {
        values.push(
            serde_json::to_string(&q.epic_ids)
                .map_err(|error| AppError::internal(error.to_string()))?
                .into(),
        );
        conditions.push(format!(
            "t.epic_id IN (SELECT value FROM json_each(?{}))",
            values.len()
        ));
    }
    let mut assigned = Vec::new();
    if !q.assignee_ids.is_empty() {
        values.push(
            serde_json::to_string(&q.assignee_ids)
                .map_err(|error| AppError::internal(error.to_string()))?
                .into(),
        );
        assigned.push(format!("EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id IN (SELECT value FROM json_each(?{})))",values.len()));
    }
    if q.no_assignee {
        assigned.push("NOT EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=t.id)".into());
    }
    if !assigned.is_empty() {
        conditions.push(format!("({})", assigned.join(" OR ")));
    }
    if q.blocked {
        conditions.push(
            "EXISTS(SELECT 1 FROM task_blocks b WHERE b.task_id=t.id AND b.resolved_at IS NULL)"
                .into(),
        );
    }
    let predicate = conditions.join(" AND ");
    let total = if total.is_none() && conditions.len() == 3 {
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
                encode_cursor(&CompletedCursor {
                    generation,
                    scope,
                    completed_at: t.completed_at,
                    completion_order: t.completion_order.unwrap_or(0),
                    id: t.id.clone(),
                })
            } else {
                encode_cursor(&BoardCursor {
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

fn board_counts_connection(
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
    counts.blocked = connection.query_row(
        "SELECT COUNT(*) FROM task_blocks b JOIN tasks t ON t.id=b.task_id WHERE b.resolved_at IS \
                     NULL AND b.project_id=?1 AND t.deleted_at IS NULL AND t.status!='done'",
        [project_id],
        |row| row.get(0),
    )?;
    Ok(counts)
}

pub(super) fn task_view(connection: &rusqlite::Connection, id: &str) -> AppResult<TaskView> {
    task_views(connection, &[id.to_owned()], true)?
        .pop()
        .ok_or(AppError::NotFound { resource: "task" })
}

/// One bounded set of queries for a page, preserving the caller's order.
fn task_views(
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
                     ELSE NULL END,status,position,deadline,created_at,updated_at,revision,completed_at,completion_order FROM tasks WHERE id \
                     IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL")?;
    let mut tasks = statement
        .query_map(params![encoded, details], |r| {
            Ok(TaskView {
                id: r.get(0)?,
                project_id: r.get(1)?,
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
fn newest_done_ids(
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

const NEWEST_DONE_SQL: &str =
    "SELECT id FROM tasks WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
    ORDER BY completed_at DESC,completion_order DESC,id DESC LIMIT ?2";
const NEWEST_DONE_AFTER_SQL: &str =
    "SELECT id FROM tasks WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
    AND (completed_at,completion_order,id)<(?2,?3,?4)
    ORDER BY completed_at DESC,completion_order DESC,id DESC LIMIT ?5";
const UNDATED_DONE_SQL: &str =
    "SELECT id FROM tasks WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
    AND completed_at IS NULL AND (?2 IS NULL OR (completion_order,id)<(?3,?2))
    ORDER BY completion_order DESC,id DESC LIMIT ?4";

fn task_page_generation(connection: &rusqlite::Connection, project_id: &str) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT generation FROM project_task_versions WHERE project_id=?1",
        [project_id],
        |r| r.get(0),
    )?)
}

fn check_task_cursor(saved: i64, current: i64, saved_scope: &str, scope: &str) -> AppResult<()> {
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EpicTaskCursor {
    generation: i64,
    scope: String,
    status_rank: i64,
    task_number: i64,
    id: String,
}

fn epic_task_page_connection(
    connection: &rusqlite::Connection,
    epic_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<Page<TaskView>> {
    let project_id = epic_project(connection, epic_id)?;
    let generation = task_page_generation(connection, &project_id)?;
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
            encode_cursor(&EpicTaskCursor {
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

fn encode_cursor<T: Serialize>(value: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap_or_default())
}

fn decode_epic_task_cursor(value: &str) -> AppResult<EpicTaskCursor> {
    decode_cursor(value)
}

fn decode_cursor<T: for<'de> Deserialize<'de>>(value: &str) -> AppResult<T> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::validation("cursor", "invalid cursor"))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor", "invalid cursor"))
}

fn pool_page_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
    scope: super::PoolScope,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<Page<PoolItemView>> {
    require_project(connection, actor, project_id, Need::Read, false)?;
    if scope == super::PoolScope::Personal
        && !crate::access::can_read_private_pool(connection, actor)?
    {
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

fn unread_notification_count(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_recipients WHERE user_id=?1 AND delivered_at IS NOT \
                     NULL AND read_at IS NULL AND archived_at IS NULL",
        [&actor.user_id],
        |row| row.get(0),
    )?)
}

fn page_limit(value: Option<usize>) -> usize {
    value.unwrap_or(PAGE_SIZE).clamp(1, PAGE_SIZE)
}
fn parse_position_cursor(value: Option<&str>) -> AppResult<(Option<i64>, Option<String>)> {
    let Some(value) = value else {
        return Ok((None, None));
    };
    let Some((left, right)) = value.split_once(':') else {
        return Err(AppError::validation("cursor", "invalid cursor"));
    };
    let position = left
        .parse()
        .map_err(|_| AppError::validation("cursor", "invalid cursor"))?;
    if right.is_empty() {
        return Err(AppError::validation("cursor", "invalid cursor"));
    }
    Ok((Some(position), Some(right.into())))
}

fn resolve_task_id(connection: &rusqlite::Connection, value: &str) -> AppResult<Option<String>> {
    connection.query_row("SELECT id FROM tasks WHERE (id=?1 OR task_key=?1 COLLATE NOCASE) AND deleted_at IS NULL",[value],|row|row.get(0)).optional().map_err(Into::into)
}

fn bootstrap_snapshot(
    connection: &rusqlite::Connection,
    actor: &Actor,
    query: BootstrapQuery,
    view: String,
    time_zone: &TimeZone,
) -> AppResult<BootstrapView> {
    let actor = refresh_actor_connection(connection, actor)?;
    let projects = projects(connection, &actor)?;
    let direct_task = match query.task_id.as_deref() {
        Some(id) => {
            Some(resolve_task_id(connection, id)?.ok_or(AppError::NotFound { resource: "task" })?)
        }
        None => None,
    };
    let direct_project = match direct_task.as_deref() {
        Some(id) => connection
            .query_row(
                "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                [id],
                |row| row.get(0),
            )
            .optional()?,
        None => None,
    };
    let selected = direct_project
        .or(query.project_id)
        .or_else(|| projects.first().map(|project| project.id.clone()));
    if selected
        .as_ref()
        .is_some_and(|id| !projects.iter().any(|project| &project.id == id))
    {
        return Err(AppError::NotFound {
            resource: "project",
        });
    }
    let mut result = BootstrapView {
        limits: crate::files::FileLimits::default(),
        time_zone: time_zone.name().into(),
        users: vec![user_view(connection, &actor.user_id)?],
        session: SessionView {
            user_id: actor.user_id.clone(),
            username: actor.username.clone(),
            name: actor.display_name.clone(),
            is_admin: actor.is_admin,
        },
        projects,
        memberships: Vec::new(),
        tracks: Vec::new(),
        epics: Vec::new(),
        milestones: Vec::new(),
        tasks: Vec::new(),
        inbox_unread_count: unread_notification_count(connection, &actor)?,
        selected_project_id: selected.clone(),
        view,
        done_order: None,
        board_counts: None,
        board_pages: Default::default(),
        pool_counts: Default::default(),
        sync_cursor: crate::collaboration::sync_cursor(connection)?,
    };
    if let Some(project_id) = selected.as_deref() {
        result.memberships = memberships(connection, project_id)?;
        result.users = users(connection, &actor, project_id)?;
        result.tracks = tracks(connection, project_id)?;
        // Only the Roadmap shows epic task counts.
        let counted_at = (result.view == "roadmap").then(unix_now).transpose()?;
        result.epics = epics(connection, project_id, time_zone, counted_at)?;
        result.milestones = milestones(connection, project_id)?;
        let counts = board_counts_connection(connection, project_id)?;
        if result.view == "board" {
            result.done_order = Some(query.done_order);
            for (status, total) in [
                (super::TaskStatus::Planning, counts.planning),
                (super::TaskStatus::InProgress, counts.in_progress),
                (super::TaskStatus::InReview, counts.in_review),
                (super::TaskStatus::Done, counts.done),
            ] {
                let page = board_page_with_total(
                    connection,
                    &actor,
                    &BoardQuery {
                        project_id: project_id.into(),
                        status,
                        cursor: None,
                        limit: Some(PAGE_SIZE),
                        search: None,
                        track_ids: vec![],
                        epic_ids: vec![],
                        assignee_ids: vec![],
                        no_assignee: false,
                        blocked: false,
                        done_order: query.done_order,
                    },
                    Some(total),
                )?;
                result.board_pages.insert(
                    status.as_str().into(),
                    super::PageSummary {
                        next_cursor: page.next_cursor,
                        total: page.total,
                    },
                );
                result.tasks.extend(page.items);
            }
        }
        if let Some(id) = direct_task.as_deref() {
            result.tasks.retain(|task| task.id != id);
            result.tasks.push(task_view(connection, id)?);
        }
        result.board_counts = Some(counts);
        let mut statement = connection.prepare_cached(
            "SELECT scope,COUNT(*) FROM pool_items WHERE project_id=?1 AND (scope='team' OR \
                     owner_user_id=?2) GROUP BY scope",
        )?;
        for row in statement.query_map(params![project_id, actor.user_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })? {
            let (scope, total) = row?;
            result.pool_counts.insert(scope, total);
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests;
