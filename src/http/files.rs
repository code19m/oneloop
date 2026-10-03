use super::input::{ApiJson, ApiQuery};
use std::io::SeekFrom;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Extension, Multipart, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    files::{
        AttachmentList, AttachmentPatch, AttachmentReorder, AttachmentView, FileRead,
        MAX_ATTACHMENT_BYTES, MAX_AVATAR_BYTES, ReadMode, UploadDeadline, UploadStart,
    },
};

use super::security::require_canonical_origin;

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
            "/api/attachments/{attachment_id}/download",
            get(download_attachment),
        )
        .route(
            "/api/attachments/{attachment_id}/content",
            get(content_attachment),
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
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let idempotency_key = required_header(&headers, "idempotency-key", "idempotencyKey")?;
    let declared_size = required_header(&headers, "x-file-size", "file")?
        .parse::<u64>()
        .map_err(|_| AppError::validation("file", "X-File-Size must be an integer"))?;
    if declared_size == 0 || declared_size > MAX_ATTACHMENT_BYTES {
        return Err(AppError::validation(
            "file",
            "must contain 1 byte to 25 MiB",
        ));
    }
    let deadline = UploadDeadline::new();
    let mut pending = None;
    let mut replay = None;
    let envelope = async {
        let mut found = false;
        while let Some(mut field) = deadline
            .read(multipart.next_field())
            .await?
            .map_err(|error| multipart_error(error, "file", "invalid multipart upload"))?
        {
            if found || field.name() != Some("file") {
                return Err(AppError::validation("file", "upload exactly one file"));
            }
            found = true;
            let name = field
                .file_name()
                .ok_or_else(|| AppError::validation("file", "filename is required"))?
                .to_owned();
            match state
                .files
                .begin_attachment_upload(
                    &actor,
                    &task_id,
                    &name,
                    declared_size,
                    query.ephemeral,
                    &idempotency_key,
                )
                .await?
            {
                UploadStart::Replayed(view) => replay = Some(*view),
                UploadStart::Pending(upload) => pending = Some(upload),
            }
            let mut received = 0_u64;
            let mut replay_hash = Sha256::new();
            while let Some(chunk) = deadline.read(field.chunk()).await?.map_err(|error| {
                multipart_error(error, "file", "upload stream ended unexpectedly")
            })? {
                received = received.saturating_add(chunk.len() as u64);
                if received > declared_size {
                    return Err(AppError::validation(
                        "file",
                        "received more bytes than declared",
                    ));
                }
                if let Some(upload) = pending.as_mut() {
                    upload.write_chunk(&chunk).await?;
                } else {
                    replay_hash.update(&chunk);
                }
            }
            if let Some(view) = &replay
                && hex::encode(replay_hash.finalize()) != view.checksum
                && received == declared_size
            {
                return Err(AppError::rule(
                    crate::error::RuleKind::IdempotencyKeyReused,
                    "idempotency key was already used for different file bytes",
                ));
            }
            if received != declared_size {
                return Err(AppError::validation(
                    "file",
                    format!("declared {declared_size} bytes but received {received}"),
                ));
            }
        }
        if !found {
            return Err(AppError::validation("file", "file field is required"));
        }
        Ok(())
    }
    .await;
    if let Err(error) = envelope {
        if let Some(upload) = pending
            && let Err(cleanup_error) = upload.abort().await
        {
            tracing::warn!(error=%cleanup_error, "upload abort failed; reconciliation will retry");
        }
        return Err(error);
    }
    let (status, view) = if let Some(upload) = pending {
        (StatusCode::CREATED, upload.finish().await?)
    } else {
        (StatusCode::OK, replay.expect("validated replay"))
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
    headers: HeaderMap,
    ApiJson(patch): ApiJson<AttachmentPatch>,
) -> AppResult<Json<AttachmentView>> {
    require_canonical_origin(
        &axum::http::Method::PATCH,
        &headers,
        &state.config.public_url,
    )?;
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
    headers: HeaderMap,
    ApiJson(input): ApiJson<AttachmentReorder>,
) -> AppResult<Json<AttachmentList>> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
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
    require_canonical_origin(
        &axum::http::Method::DELETE,
        &headers,
        &state.config.public_url,
    )?;
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

async fn download_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let read = state
        .files
        .open_for_read(&actor, &attachment_id, ReadMode::Download)
        .await?;
    file_response(read, &headers, true).await
}

async fn content_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let read = state
        .files
        .open_for_read_conditional(
            &actor,
            &attachment_id,
            ReadMode::Content,
            validator(&headers),
        )
        .await?;
    conditional_file_response(read, &headers).await
}

async fn source_attachment(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let read = state
        .files
        .open_for_read_conditional(
            &actor,
            &attachment_id,
            ReadMode::Source,
            validator(&headers),
        )
        .await?;
    conditional_file_response(read, &headers).await
}

async fn html_preview(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(attachment_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let bytes = state
        .files
        .html_preview_bytes(&actor, &attachment_id)
        .await?;
    Ok(html_preview_response(bytes))
}

/// Sanitized HTML for a sandboxed, same-origin preview frame.
pub(super) fn html_preview_response(bytes: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=()",
        ),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "sandbox allow-scripts; default-src 'none'; base-uri 'none'; object-src 'none'; \
             frame-src 'none'; child-src 'none'; frame-ancestors 'self'; form-action 'none'; \
             script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; \
             img-src data: blob: https:; font-src data: https:; connect-src 'none'; \
             worker-src 'none'; media-src 'none'",
        ),
    );
    response
}

async fn upload_avatar(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    require_canonical_origin(&axum::http::Method::PUT, &headers, &state.config.public_url)?;
    let deadline = UploadDeadline::new();
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
            bytes.ok_or_else(|| AppError::validation("avatar", "file field is required"))?,
        )
        .await?;
    Ok(Json(serde_json::json!({ "avatarUrl": url })))
}

async fn remove_avatar(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    require_canonical_origin(
        &axum::http::Method::DELETE,
        &headers,
        &state.config.public_url,
    )?;
    state.files.remove_avatar(&actor).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn avatar(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_safe_file_destination(&headers)?;
    let read = state
        .files
        .open_avatar_conditional(&actor, &user_id, validator(&headers))
        .await?;
    conditional_file_response(read, &headers).await
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
    headers: HeaderMap,
) -> AppResult<Json<crate::files::FileRuntimeReport>> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    actor.require_admin()?;
    state.files.cleanup_if_needed().await.map(Json)
}

pub(super) fn validator(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn conditional_file_response(
    read: crate::files::ConditionalRead,
    headers: &HeaderMap,
) -> AppResult<Response> {
    let (mut response, etag) = match read {
        crate::files::ConditionalRead::NotModified(etag) => {
            (StatusCode::NOT_MODIFIED.into_response(), etag)
        }
        crate::files::ConditionalRead::Modified(read) => {
            let etag =
                crate::files::file_etag(&read.attachment.checksum, read.byte_limit.is_some());
            // A stale If-Range requires the whole representation, not a partial body.
            let mut headers = headers.clone();
            if headers
                .get(header::IF_RANGE)
                .is_some_and(|value| value.to_str().ok() != Some(&etag))
            {
                headers.remove(header::RANGE);
            }
            (file_response(*read, &headers, false).await?, etag)
        }
    };
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("checksum ETag"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    Ok(response)
}

async fn file_response(
    mut read: FileRead,
    request_headers: &HeaderMap,
    attachment: bool,
) -> AppResult<Response> {
    let full_size = read.byte_limit.map_or(read.attachment.size, |limit| {
        read.attachment.size.min(limit)
    });
    let range = if request_headers.get_all(header::RANGE).iter().count() > 1 {
        SingleRange::Ignore
    } else {
        parse_single_range(request_headers.get(header::RANGE), full_size)
    };
    let (start, end, status) = match range {
        SingleRange::Range(start, end) => (start, end, StatusCode::PARTIAL_CONTENT),
        SingleRange::Ignore => (0, full_size.saturating_sub(1), StatusCode::OK),
        SingleRange::Unsatisfiable => {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{full_size}"))
                    .expect("integer content range"),
            );
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            );
            response.headers_mut().insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            return Ok(response);
        }
    };
    if start > 0 {
        read.file.seek(SeekFrom::Start(start)).await?;
    }
    let length = if full_size == 0 { 0 } else { end - start + 1 };
    let stream = ReaderStream::with_capacity(read.file.take(length), 64 * 1024);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&read.media_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).expect("integer header"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        content_disposition(&read.attachment.name, attachment)?,
    );
    if status == StatusCode::PARTIAL_CONTENT {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{full_size}"))
                .expect("integer range header"),
        );
    }
    Ok(response)
}

#[derive(Debug, PartialEq, Eq)]
enum SingleRange {
    Ignore,
    Unsatisfiable,
    Range(u64, u64),
}

fn parse_single_range(value: Option<&HeaderValue>, size: u64) -> SingleRange {
    let Some(raw) = value
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
    else {
        return SingleRange::Ignore;
    };
    let Some((start, end)) = raw.split_once('-') else {
        return SingleRange::Ignore;
    };
    if (start.is_empty() && end.is_empty())
        || !start.bytes().chain(end.bytes()).all(|b| b.is_ascii_digit())
    {
        return SingleRange::Ignore;
    }
    // Decimal values larger than u64 are valid syntax. Saturation preserves
    // suffix/end clipping and makes an enormous start unsatisfiable.
    let number = |s: &str| s.parse::<u64>().unwrap_or(u64::MAX);
    if start.is_empty() {
        let suffix = number(end);
        if size == 0 || suffix == 0 {
            return SingleRange::Unsatisfiable;
        }
        return SingleRange::Range(size.saturating_sub(suffix), size - 1);
    }
    let start = number(start);
    let end = if end.is_empty() {
        u64::MAX
    } else {
        number(end)
    };
    if start > end {
        return SingleRange::Ignore;
    }
    if start >= size {
        return SingleRange::Unsatisfiable;
    }
    SingleRange::Range(start, end.min(size - 1))
}

pub(super) fn content_disposition(name: &str, attachment: bool) -> AppResult<HeaderValue> {
    // Old uploads may predate filename validation. Do not propagate directional
    // overrides to download-manager labels; preserve ordinary RTL and joiners.
    let name: String = name
        .chars()
        .filter(|c| {
            !matches!(c,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && !matches!(c, '"' | '\\' | '/' | ';') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if fallback.trim().is_empty() {
        "download"
    } else {
        &fallback
    };
    let encoded = name
        .as_bytes()
        .iter()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric()
                || matches!(
                    *byte,
                    b'!' | b'#'
                        | b'$'
                        | b'&'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
            {
                vec![(*byte as char).to_string()]
            } else {
                vec![format!("%{byte:02X}")]
            }
        })
        .collect::<String>();
    HeaderValue::from_str(&format!(
        "{}; filename=\"{fallback}\"; filename*=UTF-8''{}",
        if attachment { "attachment" } else { "inline" },
        encoded
    ))
    .map_err(|error| AppError::internal(format!("content disposition failed: {error}")))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_bounded_and_single() {
        let exact = HeaderValue::from_static("bytes=10-19");
        assert_eq!(
            parse_single_range(Some(&exact), 100),
            SingleRange::Range(10, 19)
        );
        let suffix = HeaderValue::from_static("bytes=-10");
        assert_eq!(
            parse_single_range(Some(&suffix), 100),
            SingleRange::Range(90, 99)
        );
        for raw in [
            "bytes=0-1,4-5",
            "items=0-1",
            "bytes=9-3",
            "bytes=abc",
            "bytes=+1-2",
            "bytes=-",
        ] {
            assert_eq!(
                parse_single_range(Some(&HeaderValue::from_str(raw).unwrap()), 100),
                SingleRange::Ignore
            );
        }
        for raw in ["bytes=100-", "bytes=-0", "bytes=999999999999999999999999-"] {
            assert_eq!(
                parse_single_range(Some(&HeaderValue::from_str(raw).unwrap()), 100),
                SingleRange::Unsatisfiable
            );
        }
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_bytes(b"bytes=\xff").unwrap()), 100),
            SingleRange::Ignore
        );
        assert_eq!(
            parse_single_range(Some(&exact), 0),
            SingleRange::Unsatisfiable
        );
    }

    #[test]
    fn filenames_are_encoded_in_content_disposition() {
        let value = content_disposition("report \"final\".pdf", true)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(value.starts_with("attachment;"));
        assert!(value.contains("report%20%22final%22.pdf"));
        assert!(value.contains("filename=\"report _final_.pdf\""));
        let unicode = content_disposition("Résumé;\\\r\n.pdf", true).unwrap();
        assert!(
            unicode
                .to_str()
                .unwrap()
                .contains("filename=\"R_sum_____.pdf\"")
        );
        assert!(!value.contains("\r"));
    }
}

#[cfg(test)]
mod generated_tests {
    use super::*;
    proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config { failure_persistence: None, ..proptest::test_runner::Config::default() })]
        #[test]
        fn generated_ranges_are_bounded(size in proptest::prelude::any::<u64>(), start in proptest::prelude::any::<u64>(), end in proptest::prelude::any::<u64>(), form in 0u8..4) {
            let raw = match form { 0 => format!("bytes={start}-{end}"), 1 => format!("bytes=-{end}"), 2 => format!("bytes={start}-"), _ => format!("bytes={start}-{end},0-1") };
            if let SingleRange::Range(s,e) = parse_single_range(Some(&raw.parse().unwrap()), size) {
                proptest::prop_assert!(s <= e && e < size);
            }
        }
    }
}

pub(super) fn require_safe_file_destination(headers: &HeaderMap) -> AppResult<()> {
    if headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| {
            matches!(
                value,
                "script"
                    | "worker"
                    | "sharedworker"
                    | "serviceworker"
                    | "style"
                    | "object"
                    | "embed"
            )
        })
    {
        return Err(AppError::Forbidden);
    }
    Ok(())
}
