use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    auth::{Actor, ActorSource},
    collaboration::{ActivityEvent, ActivityPage},
    error::{AppError, AppResult},
};

use super::{
    BlockView, BoardCounts, BoardView, BootstrapPageInfo, BootstrapView, DomainService, EpicView,
    MembershipView, MilestoneView, Page, PoolItemView, ProjectView, SessionView, TaskView,
    TrackView, UserView,
};

const PAGE_SIZE: usize = 50;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapQuery {
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub view: Option<String>,
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
        if query
            .view
            .as_deref()
            .is_some_and(|view| !["board", "roadmap", "task", "metadata"].contains(&view))
        {
            return Err(AppError::validation("view", "unknown initial view"));
        }
        let actor = actor.clone();
        let time_zone = self.time_zone;
        self.db
            .run(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
                let result = bootstrap_snapshot(&transaction, &actor, query, time_zone)?;
                transaction.commit()?;
                Ok(result)
            })
            .await
    }

    pub async fn sync_cursor(&self, actor: &Actor) -> AppResult<String> {
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                ensure_current_actor(connection, &actor)?;
                snapshot_cursor(connection)
            })
            .await
    }

    pub async fn board_page(&self, actor: &Actor, query: BoardQuery) -> AppResult<Page<TaskView>> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = ensure_current_actor(connection, &actor)?;
                board_page_connection(connection, &actor, &query)
            })
            .await
    }

    pub async fn board_view(&self, actor: &Actor, query: BoardViewQuery) -> AppResult<BoardView> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .run(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
                let actor = ensure_current_actor(&transaction, &actor)?;
                require_read(&transaction, &actor, &query.project_id)?;
                let counts = board_counts_connection(&transaction, &query.project_id)?;
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
                        &transaction,
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
                transaction.commit()?;
                Ok(result)
            })
            .await
    }

    pub async fn board_counts(&self, actor: &Actor, project_id: String) -> AppResult<BoardCounts> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .run(move |connection| {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
                let actor = ensure_current_actor(&transaction, &actor)?;
                require_read(&transaction, &actor, &project_id)?;
                let counts = board_counts_connection(&transaction, &project_id)?;
                transaction.commit()?;
                Ok(counts)
            })
            .await
    }

    pub async fn roadmap(&self, actor: &Actor, project_id: String) -> AppResult<Value> {
        actor.require_ready()?;
        let actor = actor.clone();
        let time_zone = self.time_zone;
        self.db
            .snapshot(move |connection| {
                let actor = ensure_current_actor(connection, &actor)?;
                require_read(connection, &actor, &project_id)?;
                Ok(json!({
                "projectId":project_id,
                "tracks":tracks(connection,&project_id)?,
                "epics":epics(connection,&project_id,time_zone)?,
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
                let actor = ensure_current_actor(connection, &actor)?;
                pool_page_connection(
                    connection,
                    &actor,
                    &query.project_id,
                    Some(query.scope.as_str()),
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
                let actor = ensure_current_actor(connection, &actor)?;
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
                require_read(connection, &actor, &project_id)?;
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
                let actor = ensure_current_actor(connection, &actor)?;
                let project_id = epic_project(connection, &epic_id)?;
                require_read(connection, &actor, &project_id)?;
                epic_task_page_connection(
                    connection,
                    &epic_id,
                    query.cursor.as_deref(),
                    page_limit(query.limit),
                )
            })
            .await
    }

    pub async fn epic_activity(
        &self,
        actor: &Actor,
        epic_id: String,
        query: PageQuery,
    ) -> AppResult<ActivityPage> {
        actor.require_ready()?;
        let actor = actor.clone();
        self.db
            .snapshot(move |connection| {
                let actor = ensure_current_actor(connection, &actor)?;
                let project_id = epic_project(connection, &epic_id)?;
                require_read(connection, &actor, &project_id)?;
                epic_activity_page_connection(
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

fn ensure_current_actor(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<Actor> {
    crate::auth::refresh_actor_connection(connection, actor)
}

fn require_read(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_id: &str,
) -> AppResult<()> {
    crate::access::require_project(
        connection,
        actor,
        project_id,
        crate::access::Need::Read,
        false,
    )
    .map_err(|error| {
        if matches!(error, AppError::Forbidden) {
            AppError::NotFound {
                resource: "project",
            }
        } else {
            error
        }
    })
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
    if let ActorSource::McpGrant { grant_id } = &actor.source {
        let has_read_scope: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_grant_scopes WHERE grant_id=?1 AND scope='project_read')",
            [grant_id],
            |row| row.get(0),
        )?;
        if !has_read_scope {
            return Ok(Vec::new());
        }
        let selected: std::collections::HashSet<String> = {
            let mut s = connection
                .prepare_cached("SELECT project_id FROM mcp_grant_projects WHERE grant_id=?1")?;
            s.query_map([grant_id], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        };
        Ok(rows
            .into_iter()
            .filter(|p| selected.contains(&p.id))
            .collect())
    } else {
        Ok(rows)
    }
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
        avatar_url: avatar.map(|blob| format!("/api/users/{id}/avatar?v={blob}")),
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
fn epics(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: Tz,
) -> AppResult<Vec<EpicView>> {
    epics_on(
        connection,
        project_id,
        timezone,
        Utc::now().with_timezone(&timezone).date_naive(),
    )
}

fn epics_on(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: Tz,
    today: NaiveDate,
) -> AppResult<Vec<EpicView>> {
    let week_start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let week_start_epoch = local_midnight(timezone, week_start)?;
    let trailing_start = today - Duration::days(6);
    let mut boundaries = Vec::with_capacity(8);
    for offset in 0..8 {
        boundaries.push(local_midnight(
            timezone,
            trailing_start + Duration::days(offset),
        )?);
    }
    let mut statement = connection.prepare_cached("SELECT id,project_id,track_id,title,description,start_date,end_date,state,position,\
                     revision FROM epics WHERE project_id=?1 AND deleted_at IS NULL ORDER BY start_date,position,id")?;
    let mut result = statement
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
                task_total: 0,
                task_done: 0,
                task_open: 0,
                completed_this_week: 0,
                completed_since_start: 0,
                weekly_completions: vec![0; 7],
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let starts = result
        .iter()
        .map(|epic| {
            let start = NaiveDate::parse_from_str(&epic.start_date, "%Y-%m-%d")
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
        let summary: [i64; 11] = serde_json::from_str(&row.get::<_, String>(1)?)
            .map_err(|error| AppError::internal(format!("invalid epic summary: {error}")))?;
        let epic = &mut result[index];
        epic.task_total = summary[0];
        epic.task_done = summary[1];
        epic.task_open = epic.task_total - epic.task_done;
        epic.completed_this_week = summary[2];
        epic.completed_since_start = summary[3];
        epic.weekly_completions.copy_from_slice(&summary[4..]);
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

fn local_midnight(timezone: Tz, mut date: NaiveDate) -> AppResult<i64> {
    // Midnight gaps and even skipped calendar dates map to the first following
    // representable local instant. Date-only records remain valid in every zone.
    loop {
        for minute in 0..1440 {
            let local = date.and_hms_opt(minute / 60, minute % 60, 0).unwrap();
            if let Some(value) = timezone.from_local_datetime(&local).earliest() {
                return Ok(value.timestamp());
            }
        }
        date = date
            .succ_opt()
            .ok_or_else(|| AppError::internal("calendar range exhausted"))?;
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
    require_read(connection, actor, &q.project_id)?;
    let limit = page_limit(q.limit);
    let generation = task_page_generation(connection, &q.project_id)?;
    let scope = format!("board:{}:{}", q.project_id, q.status.as_str());
    let cursor: Option<BoardCursor> = q.cursor.as_deref().map(decode_cursor).transpose()?;
    if let Some(cursor) = &cursor {
        check_task_cursor(cursor.generation, generation, &cursor.scope, &scope)?;
    }
    let cursor_position = cursor.as_ref().map(|c| c.position);
    let cursor_id = cursor.as_ref().map(|c| c.id.clone());
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
    let cursor_predicate = if let Some(position) = cursor_position {
        values.push(position.into());
        let n = values.len();
        values.push(cursor_id.into());
        format!(
            " WHERE (t.position>?{n} OR (t.position=?{n} AND t.id>?{}))",
            n + 1
        )
    } else {
        String::new()
    };
    values.push(((limit + 1) as i64).into());
    let limit_parameter = values.len();
    let (ids, total) = if let Some(total) = total {
        // Precomputed unfiltered totals retain the bounded index-only page path.
        let cursor = cursor_predicate.replacen(" WHERE ", " AND ", 1);
        let sql = format!(
            "SELECT t.id FROM tasks t WHERE {predicate}{cursor} ORDER BY t.position,t.id LIMIT ?{limit_parameter}"
        );
        let mut statement = connection.prepare_cached(&sql)?;
        let ids = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        (ids, total)
    } else {
        // Materialize matching IDs once: expensive substring/member filters run
        // only once per row. Apply the cursor after counting the full match set.
        // A left join preserves the total even when the requested page is empty.
        let sql = format!(
            "WITH matches AS MATERIALIZED (
            SELECT t.id,t.position FROM tasks t WHERE {predicate}
        ), page AS (
            SELECT t.id,t.position FROM matches t{cursor_predicate}
            ORDER BY t.position,t.id LIMIT ?{limit_parameter}
        ) SELECT page.id, totals.total FROM (SELECT COUNT(*) AS total FROM matches) totals
          LEFT JOIN page ON true ORDER BY page.position,page.id"
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
            encode_cursor(&BoardCursor {
                generation,
                scope,
                position: t.position,
                id: t.id.clone(),
            })
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
                     ELSE NULL END,status,position,deadline,created_at,updated_at,revision FROM tasks WHERE id \
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
            super::MentionInput {
                kind: if r.get::<_, String>(1)? == "everyone" {
                    super::MentionKind::Everyone
                } else {
                    super::MentionKind::User
                },
                user_id: r.get(2)?,
                start_offset: r.get::<_, i64>(3)? as usize,
                end_offset: r.get::<_, i64>(4)? as usize,
                label: r.get(5)?,
            },
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

#[derive(Serialize, Deserialize)]
struct ActivityCursor {
    time: i64,
    id: String,
}

fn epic_activity_page_connection(
    connection: &rusqlite::Connection,
    epic_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<ActivityPage> {
    let cursor = cursor.map(decode_activity_cursor).transpose()?;
    let (cursor_time, cursor_id) = cursor
        .as_ref()
        .map(|value| (value.time, value.id.as_str()))
        .unwrap_or((i64::MAX, "\u{10ffff}"));
    let mut statement = connection.prepare_cached(
        "SELECT id,project_id,entity_type,entity_id,task_id,actor_user_id,
                actor_name_snapshot,event_type,field_key,before_json,after_json,
                metadata_json,entity_revision,latest_at
         FROM activity_projection
         WHERE entity_type='epic' AND entity_id=?1 AND visibility='public' AND is_hidden=0
           AND (latest_at,id)<(?2,?3)
         ORDER BY latest_at DESC,id DESC LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![epic_id, cursor_time, cursor_id, (limit + 1) as i64],
            epic_activity_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = rows.len() > limit;
    let mut items: Vec<_> = rows.into_iter().take(limit).collect();
    let next_cursor = has_more.then(|| items.last()).flatten().map(|item| {
        encode_cursor(&ActivityCursor {
            time: item.created_at,
            id: item.id.clone(),
        })
    });
    Ok(ActivityPage {
        items: std::mem::take(&mut items),
        next_cursor,
    })
}

fn epic_activity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityEvent> {
    let parse =
        |value: Option<String>| value.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let field: Option<String> = row.get(8)?;
    let metadata = crate::legacy_values::payload(parse(row.get(11)?).unwrap_or_else(|| json!({})));
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
        event_type: row.get(7)?,
        field_key: row.get(8)?,
        before: crate::legacy_values::activity(parse(row.get(9)?), field.as_deref()),
        after: crate::legacy_values::activity(parse(row.get(10)?), field.as_deref()),
        metadata,
        entity_revision: row.get(12)?,
        created_at: row.get(13)?,
    })
}

fn encode_cursor<T: Serialize>(value: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap_or_default())
}

fn decode_epic_task_cursor(value: &str) -> AppResult<EpicTaskCursor> {
    decode_cursor(value)
}

fn decode_activity_cursor(value: &str) -> AppResult<ActivityCursor> {
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
    scope: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<Page<PoolItemView>> {
    require_read(connection, actor, project_id)?;
    if scope.is_some_and(|s| s != "personal" && s != "team") {
        return Err(AppError::validation("scope", "must be personal or team"));
    }
    if scope != Some("team") && !crate::auth::can_read_private_pool(connection, actor)? {
        return Err(AppError::Forbidden);
    }
    let (cursor_time, cursor_id) = parse_position_cursor(cursor)?;
    let own = &actor.user_id;
    let predicate = "project_id=?1 AND ((scope='personal' AND owner_user_id=?2) OR scope='team') AND (?3 IS NULL OR scope=?3)";
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

fn notifications(
    connection: &rusqlite::Connection,
    actor: &Actor,
    limit: usize,
) -> AppResult<Vec<Value>> {
    let mut s=connection.prepare_cached("SELECT e.id,e.project_id,e.event_type,e.task_id,e.comment_id,e.block_id,e.created_at,
        r.project_name_snapshot,r.task_key_snapshot,r.task_title_snapshot,r.actor_name_snapshot,
        r.excerpt_snapshot,r.read_at,r.archived_at,
        (p.id IS NOT NULL AND p.deleted_at IS NULL AND t.id IS NOT NULL AND t.deleted_at IS NULL
         AND (?3 OR EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=p.id AND m.user_id=?1))
         AND (?4 IS NULL OR (EXISTS(SELECT 1 FROM mcp_grant_projects gp WHERE gp.grant_id=?4 AND gp.project_id=p.id)
              AND EXISTS(SELECT 1 FROM mcp_grant_scopes gs WHERE gs.grant_id=?4 AND gs.scope='project_read'))))
        FROM notification_events e JOIN notification_recipients r ON r.notification_id=e.id
        LEFT JOIN projects p ON p.id=e.project_id LEFT JOIN tasks t ON t.id=e.task_id AND t.project_id=p.id
        WHERE r.user_id=?1 AND r.delivered_at IS NOT NULL
        ORDER BY e.created_at DESC,e.id DESC LIMIT ?2")?;
    let rows = s
        .query_map(
            params![
                actor.user_id,
                limit as i64,
                actor.is_admin,
                actor.mcp_grant_id()
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, Option<String>>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<i64>>(12)?,
                    r.get::<_, Option<i64>>(13)?,
                    r.get::<_, bool>(14)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let available = row.14;
        result.push(json!({
        "id":row.0,
        "projectId":if available{row.1}else{None},
        "eventType":row.2,
        "taskId":if available{row.3}else{None},
        "commentId":if available{row.4}else{None},
        "blockId":if available{row.5}else{None},
        "createdAt":row.6,
        "projectName":if available{Some(row.7)}else{None},
        "taskKey":if available{row.8}else{None},
        "taskTitle":if available{row.9}else{None},
        "actorName":if available{row.10}else{None},
        "excerpt":if available{row.11}else{None},
        "destinationAvailable":available,
        "readAt":row.12,
        "archivedAt":row.13
        }));
    }
    Ok(result)
}
fn notification_count(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_recipients WHERE user_id=?1 AND delivered_at IS NOT NULL",
        [&actor.user_id],
        |r| r.get(0),
    )?)
}
fn unread_notification_count(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_recipients WHERE user_id=?1 AND delivered_at IS NOT \
                     NULL AND read_at IS NULL AND archived_at IS NULL",
        [&actor.user_id],
        |row| row.get(0),
    )?)
}
fn browser_sessions(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<Vec<Value>> {
    let current = match &actor.source {
        ActorSource::BrowserSession { session_id } => Some(session_id.as_str()),
        _ => None,
    };
    let mut s=connection.prepare_cached("SELECT id,created_at,last_activity_at,absolute_expires_at,client_name,client_ip,\
                     user_agent FROM sessions WHERE user_id=?1 AND revoked_at IS NULL AND \
                     idle_expires_at>unixepoch() AND absolute_expires_at>unixepoch() ORDER BY last_activity_at \
                     DESC,id DESC")?;
    Ok(s.query_map([&actor.user_id], |r| {
        let id: String = r.get(0)?;
        Ok(json!({
        "id":id,
        "createdAt":r.get::<_,i64>(1)?,
        "lastActivityAt":r.get::<_,i64>(2)?,
        "absoluteExpiresAt":r.get::<_,i64>(3)?,
        "clientName":r.get::<_,Option<String>>(4)?,
        "clientIp":r.get::<_,Option<String>>(5)?,
        "userAgent":r.get::<_,Option<String>>(6)?,
        "current":current==Some(id.as_str())
        }))
    })?
    .collect::<Result<Vec<_>, _>>()?)
}
fn app_grants(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<Vec<Value>> {
    let mut s=connection.prepare_cached("SELECT id,client_name,created_at,updated_at,expires_at,last_used_at,revision FROM \
                     mcp_grants WHERE user_id=?1 AND revoked_at IS NULL ORDER BY updated_at DESC,id DESC")?;
    let rows = s
        .query_map([&actor.user_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let mut projects = connection.prepare_cached(
            "SELECT project_id FROM mcp_grant_projects WHERE grant_id=?1 ORDER BY project_id",
        )?;
        let project_ids = projects
            .query_map([&row.0], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        let mut scopes = connection.prepare_cached(
            "SELECT scope FROM mcp_grant_scopes WHERE grant_id=?1 ORDER BY scope",
        )?;
        let scope_names = scopes
            .query_map([&row.0], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        result.push(json!({
        "id":row.0,
        "clientName":row.1,
        "createdAt":row.2,
        "updatedAt":row.3,
        "expiresAt":row.4,
        "lastUsedAt":row.5,
        "revision":row.6,
        "projectIds":project_ids,
        "scopes":scope_names
        }));
    }
    Ok(result)
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

// Both logs are append-only for mutations affecting bootstrap data. Compare
// their last inserted identities, not timestamps (multiple writes share a second).
fn snapshot_cursor(connection: &rusqlite::Connection) -> AppResult<String> {
    let outbox: Option<String> = connection
        .query_row(
            "SELECT id FROM outbox_messages ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let security: Option<String> = connection
        .query_row(
            "SELECT id FROM security_events ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    // Delivery changes Inbox visibility without appending another outbox row.
    let pending: i64 = connection.query_row(
        "SELECT COUNT(*) FROM outbox_messages WHERE delivered_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    let boundary = format!(
        "{}:{}:{pending}",
        outbox.as_deref().unwrap_or("0"),
        security.as_deref().unwrap_or("0")
    );
    Ok(hex::encode(Sha256::digest(boundary.as_bytes())))
}

fn bootstrap_snapshot(
    connection: &rusqlite::Connection,
    actor: &Actor,
    query: BootstrapQuery,
    time_zone: Tz,
) -> AppResult<BootstrapView> {
    let actor = ensure_current_actor(connection, actor)?;
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
    let legacy = query.view.is_none();
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
        pool: Vec::new(),
        notifications: if legacy {
            notifications(connection, &actor, 50)?
        } else {
            Vec::new()
        },
        inbox_unread_count: unread_notification_count(connection, &actor)?,
        browser_sessions: if legacy {
            browser_sessions(connection, &actor)?
        } else {
            Vec::new()
        },
        app_grants: if legacy {
            app_grants(connection, &actor)?
        } else {
            Vec::new()
        },
        page_info: BootstrapPageInfo {
            tasks_truncated: false,
            tasks_next_cursor: None,
            notifications_truncated: legacy && notification_count(connection, &actor)? > 50,
        },
        selected_project_id: selected.clone(),
        view: query.view.clone(),
        board_counts: None,
        board_pages: Default::default(),
        pool_counts: Default::default(),
        sync_cursor: snapshot_cursor(connection)?,
    };
    if let Some(project_id) = selected.as_deref() {
        result.memberships = memberships(connection, project_id)?;
        result.users = users(connection, &actor, project_id)?;
        result.tracks = tracks(connection, project_id)?;
        result.epics = epics(connection, project_id, time_zone)?;
        result.milestones = milestones(connection, project_id)?;
        let counts = board_counts_connection(connection, project_id)?;
        if legacy || query.view.as_deref() == Some("board") {
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
                    },
                    Some(total),
                )?;
                result.page_info.tasks_truncated |= page.next_cursor.is_some();
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
        if legacy {
            result.pool =
                pool_page_connection(connection, &actor, project_id, None, None, PAGE_SIZE)?.items;
        }
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

// SQL is kept outside calls so rustfmt can format the surrounding control flow.

#[cfg(test)]
mod tests;
