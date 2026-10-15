use super::input::{ApiQuery, id_list};
use std::convert::Infallible;

use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::{HeaderMap, header},
    response::{
        IntoResponse,
        sse::{Event, KeepAlive, Sse},
    },
    routing::get,
};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::StreamExt;

use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    collaboration::{ActivityPage, CommentPage, InboxFilter, InboxPage, LiveEvent},
    domain::PageQuery,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/discussion/tasks/{task_id}/comments", get(comments))
        .route(
            "/discussion/tasks/{task_id}/comments/{comment_id}",
            get(comment_context),
        )
        .route("/activity/projects/{project_id}", get(activity))
        .route(
            "/discussion/tasks/{task_id}/blocks/{block_id}",
            get(block_context),
        )
        .route("/inbox", get(inbox))
        .route("/events", get(events))
}

async fn comments(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<CommentPage>> {
    state
        .collaboration
        .comments(&actor, &task_id, query.cursor.as_deref(), query.limit)
        .await
        .map(Json)
}

async fn comment_context(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path((task_id, comment_id)): Path<(String, String)>,
) -> AppResult<Json<CommentPage>> {
    state
        .collaboration
        .comment_context(&actor, &task_id, &comment_id)
        .await
        .map(Json)
}

async fn block_context(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path((task_id, block_id)): Path<(String, String)>,
) -> AppResult<Json<ActivityPage>> {
    state
        .collaboration
        .block_context(&actor, &task_id, &block_id)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityQuery {
    task_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn activity(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<ActivityQuery>,
) -> AppResult<Json<ActivityPage>> {
    state
        .collaboration
        .activity(
            &actor,
            &project_id,
            query.task_id.as_deref(),
            query.cursor.as_deref(),
            query.limit,
        )
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InboxQuery {
    #[serde(default)]
    project_ids: Option<String>,
    #[serde(default)]
    unread_only: bool,
    #[serde(default)]
    archived: bool,
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn inbox(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<InboxQuery>,
) -> AppResult<Json<InboxPage>> {
    let filter = InboxFilter {
        project_ids: id_list("projectIds", query.project_ids.as_deref())?
            .into_iter()
            .collect(),
        unread_only: query.unread_only,
        archived: query.archived,
    };
    state
        .collaboration
        .inbox(&actor, filter, query.cursor.as_deref(), query.limit)
        .await
        .map(Json)
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventQuery {
    cursor: Option<String>,
}

async fn events(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<EventQuery>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    // A page of another site, even one on a sibling subdomain, may not open
    // streams with the person's cookie: each one would close one of theirs.
    if headers
        .get("sec-fetch-site")
        .is_some_and(|site| !matches!(site.as_bytes(), b"same-origin" | b"none"))
    {
        return Err(AppError::Forbidden);
    }
    // Authentication middleware has already revalidated the session. The
    // initial reconciliation event makes Last-Event-ID a hint rather than a
    // promise of replay; authoritative reads repair missed messages.
    let resume = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if resume.len() > 128 || !resume.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(AppError::validation("Last-Event-ID", "is invalid"));
    }
    if query.cursor.as_ref().is_some_and(|cursor| {
        cursor.len() > 256 || !cursor.bytes().all(|byte| byte.is_ascii_graphic())
    }) {
        return Err(AppError::validation("cursor", "invalid snapshot cursor"));
    }
    let events = state
        .collaboration_runtime
        .live_updates(&actor, query.cursor)
        .await?;
    let user_id = actor.user_id;
    let events = events.map(move |event| {
        Ok::<_, Infallible>(match event {
            LiveEvent::Start { ready } => {
                let kind = if ready { "ready" } else { "reconcile" };
                // An event stream can't name its person in a header, so its
                // first event says whose it is: a page showing someone else
                // ends there.
                let data = json!({"kind":kind,"after":resume,"userId":user_id});
                Event::default().event(kind).data(data.to_string())
            }
            LiveEvent::Reconcile => Event::default()
                .event("reconcile")
                .data(r#"{"kind":"reconcile"}"#),
            LiveEvent::Hint(hint) => {
                let data = json!({
                    "kind":hint.kind,
                    "projectId":hint.project_id,
                    "taskId":hint.task_id,
                    "entityType":hint.entity_type,
                    "entityId":hint.entity_id,
                    "entityRevision":hint.entity_revision,
                    "notificationId":hint.notification_id,
                });
                Event::default()
                    .id(hint.id.clone())
                    .event("hint")
                    .data(data.to_string())
            }
            LiveEvent::Replaced => Event::default()
                .event("replaced")
                .data(r#"{"kind":"replaced"}"#),
        })
    });
    Ok((
        [
            ("x-accel-buffering", "no"),
            (header::CACHE_CONTROL.as_str(), "no-cache, no-transform"),
        ],
        Sse::new(events).keep_alive(KeepAlive::default()),
    ))
}
