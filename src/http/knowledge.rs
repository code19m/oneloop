//! Knowledge reads for the browser. Files are served as attachments are, and
//! HTML only through the sandboxed preview.

use super::{
    file_response::{self, Caching, Disposition},
    input::ApiQuery,
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
    routing::get,
};
use serde::Deserialize;

use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    knowledge::{FileMode, KnowledgeView, SearchResults},
};

/// The HTML preview, whose answers show inside the preview frame.
pub(crate) fn preview_router() -> Router<AppState> {
    Router::new().route(
        "/api/projects/{project_id}/knowledge/preview/html",
        get(html_preview),
    )
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects/{project_id}/knowledge", get(view))
        .route("/api/projects/{project_id}/knowledge/search", get(search))
        .route("/api/projects/{project_id}/knowledge/content", get(content))
        .route("/api/projects/{project_id}/knowledge/text", get(text))
        .route(
            "/api/projects/{project_id}/knowledge/download",
            get(download),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    q: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileQuery {
    path: String,
}

/// **Reload preview** adds `reload`, so the page is read and cleaned again.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewQuery {
    path: String,
    reload: Option<String>,
}

async fn view(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
) -> AppResult<Json<KnowledgeView>> {
    Ok(Json(state.knowledge.view(&actor, &project_id).await?))
}

async fn search(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<SearchQuery>,
) -> AppResult<Json<SearchResults>> {
    Ok(Json(
        state
            .knowledge
            .search(&actor, &project_id, &query.q)
            .await?,
    ))
}

async fn content(
    state: State<AppState>,
    actor: Extension<Actor>,
    project_id: Path<String>,
    query: ApiQuery<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file(state, actor, project_id, query, headers, FileMode::Content).await
}

async fn text(
    state: State<AppState>,
    actor: Extension<Actor>,
    project_id: Path<String>,
    query: ApiQuery<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file(state, actor, project_id, query, headers, FileMode::Text).await
}

async fn download(
    state: State<AppState>,
    actor: Extension<Actor>,
    project_id: Path<String>,
    query: ApiQuery<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file(state, actor, project_id, query, headers, FileMode::Download).await
}

/// An error shows in the preview frame, as a page that says why.
async fn html_preview(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    query: Result<ApiQuery<PreviewQuery>, AppError>,
    headers: HeaderMap,
) -> Response {
    let response: AppResult<Response> = async {
        file_response::require_safe_destination(&headers)?;
        let ApiQuery(query) = query?;
        let reload = query.reload.is_some();
        let validator = file_response::preview_validator(&headers, reload);
        let preview = state
            .knowledge
            .html_preview(&actor, &project_id, &query.path, validator)
            .await?;
        Ok(file_response::html_preview(preview, reload))
    }
    .await;
    response.unwrap_or_else(file_response::html_preview_error)
}

async fn file(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<FileQuery>,
    headers: HeaderMap,
    mode: FileMode,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    let download = mode == FileMode::Download;
    // Downloads are never cached, so a validator never applies to them.
    let validator = if download {
        None
    } else {
        file_response::validator(&headers)
    };
    let read = state
        .knowledge
        .file(&actor, &project_id, &query.path, mode, validator)
        .await?;
    let Some(body) = read.body else {
        return Ok(file_response::not_modified(read.etag));
    };
    let (disposition, caching) = if download {
        (Disposition::Attachment, Caching::NoStore)
    } else {
        (Disposition::Inline, Caching::Revalidate(read.etag))
    };
    let length = body.len();
    // Streamed, so a client that stops reading holds one chunk.
    file_response::full(
        Body::from_stream(body.into_stream()),
        length,
        &read.media_type,
        &read.name,
        disposition,
        caching,
    )
}
