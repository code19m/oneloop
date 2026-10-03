//! Knowledge reads for the browser. File responses follow the attachment
//! rules: detected types only, `nosniff`, downloads as attachments and HTML
//! only through the sandboxed preview.

use super::{
    files::{content_disposition, html_preview_response, require_safe_file_destination, validator},
    input::ApiQuery,
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;

use crate::{
    AppResult, AppState,
    auth::Actor,
    knowledge::{FileMode, KnowledgeView, SearchResults},
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects/{project_id}/knowledge", get(view))
        .route("/api/projects/{project_id}/knowledge/search", get(search))
        .route("/api/projects/{project_id}/knowledge/content", get(content))
        .route("/api/projects/{project_id}/knowledge/text", get(text))
        .route(
            "/api/projects/{project_id}/knowledge/preview/html",
            get(html_preview),
        )
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

async fn html_preview(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let read = state
        .knowledge
        .file(
            &actor,
            &project_id,
            &query.path,
            FileMode::HtmlPreview,
            None,
        )
        .await?;
    Ok(html_preview_response(read.bytes.unwrap_or_default()))
}

async fn file(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(project_id): Path<String>,
    ApiQuery(query): ApiQuery<FileQuery>,
    headers: HeaderMap,
    mode: FileMode,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let read = state
        .knowledge
        .file(&actor, &project_id, &query.path, mode, validator(&headers))
        .await?;
    let mut response = match read.bytes {
        Some(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&read.media_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            headers.insert(
                header::CONTENT_DISPOSITION,
                content_disposition(&read.name, mode == FileMode::Download)?,
            );
            response
        }
        None => StatusCode::NOT_MODIFIED.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if mode == FileMode::Download {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    } else {
        headers.insert(
            header::ETAG,
            HeaderValue::from_str(&read.etag).expect("checksum ETag"),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        );
    }
    Ok(response)
}
