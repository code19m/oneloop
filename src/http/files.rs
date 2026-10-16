//! Browser routes for attachments, avatars and storage: uploads, file
//! changes, file bytes, previews, the storage report and cleanup.
use super::{
    file_response::{self, Caching, Disposition},
    input::{ApiJson, ApiQuery},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Extension, Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use serde::Deserialize;

use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    files::{
        AttachmentList, AttachmentPatch, AttachmentReorder, AttachmentRestore, AttachmentView,
        MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES, NewAttachment, ReadMode, ThumbnailRead,
        UploadDeadline, check_attachment_size,
    },
};

const MULTIPART_OVERHEAD_BYTES: usize = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT: usize = MAX_ATTACHMENT_BYTES as usize + MULTIPART_OVERHEAD_BYTES;
const AVATAR_BODY_LIMIT: usize = MAX_AVATAR_BYTES as usize + MULTIPART_OVERHEAD_BYTES;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tasks/{task_id}/attachments",
            get(list_attachments)
                .post(upload_attachment)
                .layer(DefaultBodyLimit::max(ATTACHMENT_BODY_LIMIT)),
        )
        .route(
            "/api/tasks/{task_id}/attachments/reorder",
            post(reorder_attachments),
        )
        .route(
            "/api/attachments/{attachment_id}",
            patch(update_attachment).delete(delete_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/restore",
            post(restore_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/download",
            get(download_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/content",
            get(content_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/thumbnail",
            get(thumbnail_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/source",
            get(source_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/preview/html",
            get(html_preview),
        )
        .route(
            "/api/auth/avatar",
            put(upload_avatar)
                .delete(remove_avatar)
                .layer(DefaultBodyLimit::max(AVATAR_BODY_LIMIT)),
        )
        .route("/api/users/{user_id}/avatar", get(avatar))
        .route("/api/storage", get(storage_usage))
        .route("/api/storage/cleanup", post(storage_cleanup))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadQuery {
    #[serde(default)]
    #[serde(alias = "temporary")]
    ephemeral: bool,
}

async fn upload_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(task_id): Path<String>,
    ApiQuery(query): ApiQuery<UploadQuery>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Response> {
    let idempotency_key = required_header(&headers, "idempotency-key", "idempotencyKey")?;
    let declared_size = required_header(&headers, "x-file-size", "file")?
        .parse::<u64>()
        .map_err(|_| AppError::validation("file", "X-File-Size must be an integer"))?;
    check_attachment_size(declared_size, "file")?;
    let deadline = UploadDeadline::new();
    let mut upload = None;
    let received = async {
        while let Some(mut field) = deadline
            .read(multipart.next_field())
            .await?
            .map_err(|error| multipart_error(error, "file", "invalid multipart upload"))?
        {
            if upload.is_some() || field.name() != Some("file") {
                return Err(AppError::validation("file", "upload exactly one file"));
            }
            let name = field
                .file_name()
                .ok_or_else(|| AppError::validation("file", "filename is required"))?
                .to_owned();
            let started = upload.insert(
                state
                    .files
                    .begin_attachment_upload(
                        &actor,
                        &task_id,
                        NewAttachment {
                            name: &name,
                            size: declared_size,
                            temporary: query.ephemeral,
                            idempotency_key: &idempotency_key,
                            replaces: None,
                        },
                    )
                    .await?,
            );
            while let Some(chunk) = deadline.read(field.chunk()).await?.map_err(|error| {
                multipart_error(error, "file", "upload stream ended unexpectedly")
            })? {
                started.write_chunk(&chunk).await?;
            }
        }
        Ok(())
    }
    .await;
    let upload = match (received, upload) {
        (Ok(()), Some(upload)) => upload,
        (Ok(()), None) => return Err(AppError::validation("file", "file field is required")),
        (Err(error), None) => return Err(error),
        (Err(error), Some(upload)) => return Err(upload.fail(error).await),
    };
    let (view, created) = upload.finish().await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(view)).into_response())
}

async fn list_attachments(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(task_id): Path<String>,
) -> AppResult<Json<AttachmentList>> {
    state
        .files
        .list_attachments(&actor, &task_id)
        .await
        .map(Json)
}

async fn update_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    ApiJson(patch): ApiJson<AttachmentPatch>,
) -> AppResult<Json<AttachmentView>> {
    state
        .files
        .set_ephemeral(&actor, &attachment_id, patch)
        .await
        .map(Json)
}

async fn reorder_attachments(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(task_id): Path<String>,
    ApiJson(input): ApiJson<AttachmentReorder>,
) -> AppResult<Json<AttachmentList>> {
    state.files.reorder(&actor, &task_id, input).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteQuery {
    expected_revision: i64,
}

async fn delete_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    ApiQuery(query): ApiQuery<DeleteQuery>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    let idempotency_key = required_header(&headers, "idempotency-key", "idempotencyKey")?;
    state
        .files
        .delete_attachment(
            &actor,
            &attachment_id,
            query.expected_revision,
            &idempotency_key,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    ApiJson(input): ApiJson<AttachmentRestore>,
) -> AppResult<Json<AttachmentView>> {
    state
        .files
        .restore_attachment(&actor, &attachment_id, input)
        .await
        .map(Json)
}

async fn download_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    let read = state
        .files
        .open_for_read(&actor, &attachment_id, ReadMode::Download)
        .await?;
    file_response::leased(
        read,
        Some(&headers),
        Disposition::Attachment,
        Caching::NoStore,
    )
    .await
}

async fn content_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    let read = state
        .files
        .open_for_read_conditional(
            &actor,
            &attachment_id,
            ReadMode::Content,
            file_response::validator(&headers),
        )
        .await?;
    file_response::conditional(read, &headers).await
}

async fn thumbnail_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    match state
        .files
        .open_thumbnail(&actor, &attachment_id, file_response::validator(&headers))
        .await?
    {
        ThumbnailRead::Thumbnail {
            bytes,
            media_type,
            etag,
            name,
        } => {
            let length = bytes.len() as u64;
            let caching = Caching::Revalidate(etag);
            file_response::full(
                Body::from(bytes),
                length,
                media_type,
                &name,
                Disposition::Inline,
                caching,
            )
        }
        ThumbnailRead::NotModified(etag) => Ok(file_response::not_modified(etag)),
        ThumbnailRead::Original(read) => file_response::conditional(read, &headers).await,
    }
}

async fn source_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    let read = state
        .files
        .open_for_read_conditional(
            &actor,
            &attachment_id,
            ReadMode::Source,
            file_response::validator(&headers),
        )
        .await?;
    file_response::conditional(read, &headers).await
}

async fn html_preview(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    let bytes = state
        .files
        .html_preview_bytes(&actor, &attachment_id)
        .await?;
    Ok(file_response::html_preview(bytes))
}

async fn upload_avatar(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    mut multipart: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    // The image stays in memory until it is decoded, so only a few uploads may
    // read theirs at once.
    let deadline = UploadDeadline::new();
    let slot = match state.files.avatar_slot(&actor) {
        Ok(slot) => slot,
        Err(error) => {
            // Left unread, the body ends the connection, and browsers then
            // report a network error instead of this answer.
            while let Ok(Ok(Some(mut field))) = deadline.read(multipart.next_field()).await {
                while let Ok(Ok(Some(_))) = deadline.read(field.chunk()).await {}
            }
            return Err(error);
        }
    };
    let mut bytes = None;
    while let Some(mut field) = deadline
        .read(multipart.next_field())
        .await?
        .map_err(|error| multipart_error(error, "avatar", "invalid multipart upload"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        if bytes.is_some() {
            return Err(AppError::validation("avatar", "upload exactly one image"));
        }
        let mut value = Vec::new();
        while let Some(chunk) = deadline
            .read(field.chunk())
            .await?
            .map_err(|error| multipart_error(error, "avatar", "upload stream ended unexpectedly"))?
        {
            if value.len().saturating_add(chunk.len()) > MAX_AVATAR_BYTES as usize {
                return Err(AppError::RequestTooLarge);
            }
            value.extend_from_slice(&chunk);
        }
        bytes = Some(value);
    }
    let url = state
        .files
        .upload_avatar(
            &actor,
            slot,
            bytes.ok_or_else(|| AppError::validation("avatar", "file field is required"))?,
        )
        .await?;
    Ok(Json(serde_json::json!({ "avatarUrl": url })))
}

async fn remove_avatar(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
) -> AppResult<StatusCode> {
    state.files.remove_avatar(&actor).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn avatar(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    file_response::require_safe_destination(&headers)?;
    let read = state
        .files
        .open_avatar_conditional(&actor, &user_id, file_response::validator(&headers))
        .await?;
    file_response::conditional(read, &headers).await
}

async fn storage_usage(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<crate::files::StorageUsage>> {
    state.files.storage_usage(&actor).await.map(Json)
}

async fn storage_cleanup(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<crate::files::FileRuntimeReport>> {
    state.files.cleanup_for(&actor).await.map(Json)
}

fn multipart_error(
    error: axum::extract::multipart::MultipartError,
    field: &str,
    message: &str,
) -> AppError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        AppError::RequestTooLarge
    } else {
        AppError::validation(field, message)
    }
}

fn required_header(
    headers: &HeaderMap,
    name: &'static str,
    field: &'static str,
) -> AppResult<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::validation(field, format!("{name} header is required")))
}
