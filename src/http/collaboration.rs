use super::input::ApiQuery;
use std::{collections::BTreeSet, convert::Infallible};

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
use tokio::{
    sync::mpsc,
    time::{Duration, MissedTickBehavior, interval},
};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    collaboration::{ActivityPage, CommentPage, InboxFilter, InboxPage},
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn comments(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let service = state.collaboration.clone();
    let page = service
        .comments(&actor, &task_id, query.cursor.as_deref(), query.limit)
        .await?;
    Ok(Json(
        serde_json::to_value(page).unwrap_or_else(|_| json!({"items":[]})),
    ))
}

async fn comment_context(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path((task_id, comment_id)): Path<(String, String)>,
) -> AppResult<Json<CommentPage>> {
    Ok(Json(
        state
            .collaboration
            .clone()
            .comment_context(&actor, &task_id, &comment_id)
            .await?,
    ))
}

async fn block_context(
    Extension(actor): Extension<Actor>,
    State(state): State<AppState>,
    Path((task_id, block_id)): Path<(String, String)>,
) -> AppResult<Json<ActivityPage>> {
    Ok(Json(
        state
            .collaboration
            .clone()
            .block_context(&actor, &task_id, &block_id)
            .await?,
    ))
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
    let service = state.collaboration.clone();
    Ok(Json(
        service
            .activity(
                &actor,
                &project_id,
                query.task_id.as_deref(),
                query.cursor.as_deref(),
                query.limit,
            )
            .await?,
    ))
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
    let project_ids = parse_project_ids(query.project_ids.as_deref())?;
    let filter = InboxFilter {
        project_ids,
        unread_only: query.unread_only,
        archived: query.archived,
    };
    let service = state.collaboration.clone();
    Ok(Json(
        service
            .inbox(&actor, filter, query.cursor.as_deref(), query.limit)
            .await?,
    ))
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
    let user_id = actor.user_id.clone();
    let service = state.collaboration.clone();
    let runtime = state.collaboration_runtime;
    // One person's streams can't take more than a few connections.
    let stream = runtime.open_stream(&user_id);
    let mut updates = runtime.subscribe();
    // Subscribe before checking the snapshot boundary. Later writes are then
    // queued for this stream even if they commit before its first event is sent.
    let matches_snapshot = if let Some(cursor) = query.cursor {
        state.domain.sync_cursor(&actor).await? == cursor
    } else {
        false
    };
    let mut shutdown = runtime.shutdown_receiver();
    let (sender, receiver) = mpsc::channel::<Result<Event, Infallible>>(64);
    tokio::spawn(async move {
        let pump = async {
            let kind = if matches_snapshot {
                "ready"
            } else {
                "reconcile"
            };
            let initial = Event::default()
                .event(kind)
                .data(json!({"kind":kind,"after":resume}).to_string());
            if sender.send(Ok(initial)).await.is_err() {
                return;
            }
            let mut revalidate = interval(Duration::from_secs(30));
            revalidate.set_missed_tick_behavior(MissedTickBehavior::Skip);
            revalidate.tick().await;
            loop {
                tokio::select! {
                    _ = revalidate.tick() => {
                        // Revalidation keeps authorization current. A successful check is
                        // intentionally quiet: the initial/reconnect event and lag recovery
                        // already trigger reconciliation, while a periodic event would make
                        // every healthy browser reload its projections every 30 seconds.
                        let _permit = runtime.authorization_permit().await;
                        if !service.actor_is_current(&actor).await.unwrap_or(false) { break; }
                    }
                    message = updates.recv() => {
                        match message {
                            Ok(hint) => {
                                if sender.is_closed() { break; }
                                if !hint.recipient_ids.contains(&user_id) { continue; }
                                let _permit = runtime.authorization_permit().await;
                                if hint.kind == "access.changed" {
                                    if !service.actor_is_current(&actor).await.unwrap_or(false) { break; }
                                    drop(_permit);
                                    let event = Event::default().event("reconcile").data("{\"kind\":\"reconcile\"}");
                                    if sender.send(Ok(event)).await.is_err() { break; }
                                    continue;
                                }
                                match service.actor_can_receive(&actor, hint.project_id.as_deref()).await {
                                    Ok(true) => {},
                                    Ok(false) => continue,
                                    // Under temporary database pressure, reconnect and
                                    // reconcile instead of silently losing this hint.
                                    Err(_) => break,
                                }
                                drop(_permit);
                                let data = json!({
                                    "kind":hint.kind,
                                    "projectId":hint.project_id,
                                    "taskId":hint.task_id,
                                    "entityType":hint.entity_type,
                                    "entityId":hint.entity_id,
                                    "entityRevision":hint.entity_revision,
                                    "notificationId":hint.notification_id,
                                });
                                let event = Event::default().id(hint.id.clone()).event("hint").data(data.to_string());
                                if sender.send(Ok(event)).await.is_err() { break; }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                let _permit = runtime.authorization_permit().await;
                                if !service.actor_is_current(&actor).await.unwrap_or(false) { break; }
                                drop(_permit);
                                let event = Event::default().event("reconcile").data("{\"kind\":\"reconcile\"}");
                                if sender.send(Ok(event)).await.is_err() { break; }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
        };
        // Dropping a body cancels even an authorization wait or blocked send.
        tokio::select! {
            biased;
            _ = sender.closed() => {},
            _ = async {
                while !*shutdown.borrow_and_update() {
                    if shutdown.changed().await.is_err() { break; }
                }
            } => {},
            // The person opened too many newer streams; the browser reconnects.
            _ = stream.replaced() => {},
            _ = pump => {},
        }
        drop(stream);
    });
    Ok((
        [
            ("x-accel-buffering", "no"),
            (header::CACHE_CONTROL.as_str(), "no-cache, no-transform"),
        ],
        Sse::new(ReceiverStream::new(receiver)).keep_alive(KeepAlive::default()),
    ))
}

fn parse_project_ids(value: Option<&str>) -> AppResult<BTreeSet<String>> {
    let mut result = BTreeSet::new();
    let Some(value) = value else {
        return Ok(result);
    };
    if value.len() > 4_096 {
        return Err(AppError::validation("projectIds", "is too long"));
    }
    for item in value.split(',') {
        let item = item.trim();
        if item.is_empty() || item.len() > 128 {
            return Err(AppError::validation(
                "projectIds",
                "must contain comma-separated project IDs",
            ));
        }
        result.insert(item.to_owned());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_project_filter_uses_one_comma_separated_query_value() {
        let ids = parse_project_ids(Some("project-a,project-b,project-a")).unwrap();
        assert_eq!(
            ids.into_iter().collect::<Vec<_>>(),
            ["project-a", "project-b"]
        );
        assert!(parse_project_ids(Some("project-a,,project-b")).is_err());
    }
}

#[cfg(test)]
mod generated_tests {
    use super::*;
    proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config { failure_persistence: None, ..proptest::test_runner::Config::default() })]
        #[test]
        fn generated_project_lists_do_not_panic(raw in ".{0,512}") {
            let _ = parse_project_ids(Some(&raw));
        }
    }
}
