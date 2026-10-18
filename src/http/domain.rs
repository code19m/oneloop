//! Read routes for projects, the Board, the Roadmap, epics, tasks and the
//! Pool.
use super::input::{ApiQuery, id_list};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde::Deserialize;

use crate::{
    AppError, AppState,
    auth::Actor,
    domain::{
        BoardCounts, BoardQuery, BoardView, BoardViewQuery, BootstrapQuery, DoneOrder, LanesQuery,
        Page, PageQuery, PoolItemView, PoolQuery, RoadmapPage, RoadmapPageQuery, RoadmapView,
        RoadmapWindow, TaskFilter, TaskStatus, TaskView,
    },
    error::AppResult,
};

/// Read routes of the core domain. Its writes go through `/api/commands`, which
/// `commands` shares with discussions, the Inbox and Knowledge.
pub(crate) fn read_router() -> Router<AppState> {
    Router::new()
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/projects/{project_id}/board", get(board))
        .route("/api/projects/{project_id}/board-view", get(board_view))
        .route("/api/projects/{project_id}/counts", get(board_counts))
        .route("/api/projects/{project_id}/roadmap", get(roadmap))
        .route(
            "/api/projects/{project_id}/roadmap/lanes",
            get(roadmap_lanes),
        )
        .route(
            "/api/projects/{project_id}/roadmap/tasks",
            get(roadmap_tasks),
        )
        .route("/api/projects/{project_id}/pool", get(pool))
        .route("/api/epics/{epic_id}/tasks", get(epic_tasks))
        .route("/api/epics/{epic_id}/activity", get(epic_activity))
        .route("/api/tasks/{task_id}", get(task))
}

/// Declare the query struct of a read that can load the Board, with the Board
/// filter's fields after its own, and `filter()`, which reads them. The Board
/// reads and the bootstrap take the same filter fields, and this is their one
/// list: serde can't flatten a shared struct into structs that refuse unknown
/// fields, and URL-encoded flags fail under `flatten`.
macro_rules! with_board_filter {
    ($(#[$meta:meta])* struct $name:ident { $($(#[$field_meta:meta])* $field:ident: $type:ty,)* }) => {
        $(#[$meta])*
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $name {
            $($(#[$field_meta])* $field: $type,)*
            search: Option<String>,
            track_ids: Option<String>,
            epic_ids: Option<String>,
            assignee_ids: Option<String>,
            #[serde(default)]
            no_assignee: bool,
            #[serde(default)]
            blocked: bool,
            /// The Board's Done order; columns other than Done ignore it.
            #[serde(default)]
            done_order: DoneOrder,
        }

        impl $name {
            /// The Board filter that the query names. Tracks, epics and
            /// assignees come as IDs separated by commas.
            fn filter(&self) -> TaskFilter {
                TaskFilter {
                    search: self.search.clone(),
                    track_ids: id_list(self.track_ids.as_deref()),
                    epic_ids: id_list(self.epic_ids.as_deref()),
                    assignee_ids: id_list(self.assignee_ids.as_deref()),
                    no_assignee: self.no_assignee,
                    blocked: self.blocked,
                    done_order: self.done_order,
                }
            }
        }
    };
}

with_board_filter! {
    /// The query of both Board reads: the filter, and for a page of one
    /// column its status and cursor.
    struct BoardParams {
        status: Option<TaskStatus>,
        cursor: Option<String>,
        limit: Option<usize>,
    }
}

with_board_filter! {
    /// The bootstrap's query: what it loads, and for the Board the filter.
    struct BootstrapParams {
        project_id: Option<String>,
        task_id: Option<String>,
        view: Option<String>,
        switched_to: Option<String>,
        switched_by: Option<String>,
        roadmap_from: Option<String>,
        roadmap_to: Option<String>,
    }
}

async fn board_counts(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
) -> AppResult<Json<BoardCounts>> {
    state
        .domain
        .board_counts(&actor, project_id)
        .await
        .map(Json)
}

async fn board_view(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<BoardParams>,
) -> AppResult<Json<BoardView>> {
    // Every column starts at its first page.
    if query.status.is_some() {
        return Err(AppError::validation("status", "is not supported"));
    }
    if query.cursor.is_some() {
        return Err(AppError::validation("cursor", "is not supported"));
    }
    let query = BoardViewQuery {
        project_id,
        limit: query.limit,
        filter: query.filter(),
    };
    state.domain.board_view(&actor, query).await.map(Json)
}

async fn bootstrap(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    ApiQuery(query): ApiQuery<BootstrapParams>,
) -> AppResult<Json<crate::domain::BootstrapView>> {
    let filter = query.filter();
    let query = BootstrapQuery {
        project_id: query.project_id,
        task_id: query.task_id,
        view: query.view,
        switched_to: query.switched_to,
        switched_by: query.switched_by,
        filter,
        roadmap: RoadmapWindow {
            from: query.roadmap_from,
            to: query.roadmap_to,
        },
    };
    state.domain.bootstrap(&actor, query).await.map(Json)
}

async fn board(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<BoardParams>,
) -> AppResult<Json<Page<TaskView>>> {
    let query = BoardQuery {
        project_id,
        status: query
            .status
            .ok_or_else(|| AppError::validation("status", "is required"))?,
        filter: query.filter(),
        cursor: query.cursor,
        limit: query.limit,
    };
    state.domain.board_page(&actor, query).await.map(Json)
}

/// A project's tracks, epics and milestones.
async fn roadmap(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
) -> AppResult<Json<RoadmapView>> {
    state
        .domain
        .roadmap(&actor, project_id, None)
        .await
        .map(Json)
}

/// The Roadmap page: what `roadmap` gives, and what its lanes draw: the
/// tasks of a window of days, or only the tasks that `tasks` names, as for a
/// change made elsewhere.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoadmapLanesParams {
    from: Option<String>,
    to: Option<String>,
    tasks: Option<String>,
}

async fn roadmap_lanes(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<RoadmapLanesParams>,
) -> AppResult<Json<RoadmapView>> {
    let lanes = match query.tasks {
        Some(_) if query.from.is_some() || query.to.is_some() => {
            return Err(AppError::validation(
                "tasks",
                "is read without a window of days",
            ));
        }
        Some(tasks) => LanesQuery::Tasks(id_list(Some(&tasks))),
        None => LanesQuery::Days(RoadmapWindow {
            from: query.from,
            to: query.to,
        }),
    };
    state
        .domain
        .roadmap(&actor, project_id, Some(lanes))
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoadmapTasksParams {
    cursor: String,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
}

async fn roadmap_tasks(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<RoadmapTasksParams>,
) -> AppResult<Json<RoadmapPage>> {
    let query = RoadmapPageQuery {
        project_id,
        cursor: query.cursor,
        from: query.from,
        to: query.to,
        limit: query.limit,
    };
    state.domain.roadmap_tasks(&actor, query).await.map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PoolParams {
    scope: crate::domain::PoolScope,
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn pool(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<PoolParams>,
) -> AppResult<Json<Page<PoolItemView>>> {
    state
        .domain
        .pool_page(
            &actor,
            PoolQuery {
                project_id,
                scope: query.scope,
                cursor: query.cursor,
                limit: query.limit,
            },
        )
        .await
        .map(Json)
}

async fn task(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(task_id): Path<String>,
) -> AppResult<Json<TaskView>> {
    state.domain.task(&actor, task_id).await.map(Json)
}

async fn epic_tasks(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(epic_id): Path<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<TaskView>>> {
    state
        .domain
        .epic_tasks(&actor, epic_id, query)
        .await
        .map(Json)
}

async fn epic_activity(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(epic_id): Path<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<crate::collaboration::ActivityPage>> {
    state
        .collaboration
        .epic_activity(&actor, &epic_id, query.cursor.as_deref(), query.limit)
        .await
        .map(Json)
}
