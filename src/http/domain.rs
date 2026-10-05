use super::input::ApiQuery;
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    AppState,
    auth::Actor,
    domain::{
        BoardCounts, BoardQuery, BoardView, BoardViewQuery, BootstrapQuery, DoneOrder, Page,
        PageQuery, PoolItemView, PoolQuery, TaskView,
    },
    error::AppResult,
};

/// Read routes owned by the core domain. The application composition layer owns
/// the single `/api/commands` dispatcher because collaboration and files add
/// their own operation families.
pub fn read_router() -> Router<AppState> {
    Router::new()
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/projects/{project_id}/board", get(board))
        .route("/api/projects/{project_id}/board-view", get(board_view))
        .route("/api/projects/{project_id}/counts", get(board_counts))
        .route("/api/projects/{project_id}/roadmap", get(roadmap))
        .route("/api/projects/{project_id}/pool", get(pool))
        .route("/api/epics/{epic_id}/tasks", get(epic_tasks))
        .route("/api/epics/{epic_id}/activity", get(epic_activity))
        .route("/api/tasks/{task_id}", get(task))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoardViewParams {
    limit: Option<usize>,
    search: Option<String>,
    track_ids: Option<String>,
    epic_ids: Option<String>,
    assignee_ids: Option<String>,
    #[serde(default)]
    no_assignee: bool,
    #[serde(default)]
    blocked: bool,
    #[serde(default)]
    done_order: DoneOrder,
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
    ApiQuery(query): ApiQuery<BoardViewParams>,
) -> AppResult<Json<BoardView>> {
    state
        .domain
        .board_view(
            &actor,
            BoardViewQuery {
                project_id,
                limit: query.limit,
                search: query.search,
                track_ids: csv(query.track_ids),
                epic_ids: csv(query.epic_ids),
                assignee_ids: csv(query.assignee_ids),
                no_assignee: query.no_assignee,
                blocked: query.blocked,
                done_order: query.done_order,
            },
        )
        .await
        .map(Json)
}

async fn bootstrap(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    ApiQuery(query): ApiQuery<BootstrapQuery>,
) -> AppResult<Json<crate::domain::BootstrapView>> {
    state.domain.bootstrap(&actor, query).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoardParams {
    status: crate::domain::TaskStatus,
    cursor: Option<String>,
    limit: Option<usize>,
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

async fn board(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<BoardParams>,
) -> AppResult<Json<Page<TaskView>>> {
    state
        .domain
        .board_page(
            &actor,
            BoardQuery {
                project_id,
                status: query.status,
                cursor: query.cursor,
                limit: query.limit,
                search: query.search,
                track_ids: csv(query.track_ids),
                epic_ids: csv(query.epic_ids),
                assignee_ids: csv(query.assignee_ids),
                no_assignee: query.no_assignee,
                blocked: query.blocked,
                done_order: query.done_order,
            },
        )
        .await
        .map(Json)
}

async fn roadmap(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
) -> AppResult<Json<Value>> {
    state.domain.roadmap(&actor, project_id).await.map(Json)
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
        .domain
        .epic_activity(&actor, epic_id, query)
        .await
        .map(Json)
}

fn csv(value: Option<String>) -> Vec<String> {
    value
        .into_iter()
        .flat_map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}
