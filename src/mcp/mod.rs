pub(crate) mod client_metadata;
mod cors;
mod oauth;
mod tools;

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, session::never::NeverSessionManager, tower::StreamableHttpService,
};
use sha2::{Digest, Sha256};
use tokio_stream::StreamExt;
use tokio_util::io::ReaderStream;

use crate::{
    AppError, AppResult, AppState,
    auth::{Actor, ActorSource},
    clock::unix_now,
    files::{ReadMode, UploadStart},
};

pub use tools::OneloopMcp;

pub fn router(state: AppState) -> Router<AppState> {
    let host = state
        .config
        .public_url
        .host_str()
        .unwrap_or("localhost")
        .to_owned();
    let authority = match state.config.public_url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.clone(),
    };
    // With explicit ports, rmcp matches each origin exactly.
    let origins = std::iter::once(state.config.public_url.clone())
        .chain(
            state
                .config
                .mcp_allowed_origins
                .iter()
                .filter_map(|origin| url::Url::parse(origin).ok()),
        )
        .filter_map(|url| {
            Some(format!(
                "{}://{}:{}",
                url.scheme(),
                url.host_str()?,
                url.port_or_known_default()?
            ))
        })
        .collect::<Vec<_>>();
    let server_state = state.clone();
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([host, authority])
        .with_allowed_origins(origins)
        .with_json_response(true)
        .with_legacy_session_mode(false)
        .with_max_request_body_bytes(1024 * 1024);
    let service = StreamableHttpService::new(
        move || Ok(OneloopMcp::new(server_state.clone())),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    let transport = Router::new()
        .route_service("/mcp", service)
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_mcp_actor,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors::listed_origins,
        ));
    let transfers = Router::new()
        .route("/mcp/files/upload", put(upload_file))
        .route("/mcp/files/download", get(download_file))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors::listed_origins,
        ));
    oauth::router(&state).merge(transport).merge(transfers)
}

async fn require_mcp_actor(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let token = bearer(request.headers());
    let token_presented = token.is_some();
    let actor = match token {
        Some(token) => state.auth.authenticate_mcp_access_token(token).await,
        None => Err(AppError::Unauthorized),
    };
    match actor.and_then(|actor| actor.require_ready().map(|()| actor)) {
        Ok(actor) => {
            request.extensions_mut().insert(actor);
            next.run(request).await
        }
        Err(AppError::Unauthorized) => unauthorized(&state, token_presented),
        Err(AppError::PreconditionFailed(_)) => AppError::Forbidden.into_response(),
        Err(error) => error.into_response(),
    }
}

fn unauthorized(state: &AppState, token_presented: bool) -> Response {
    let metadata = format!(
        "{}/.well-known/oauth-protected-resource/mcp",
        state.config.public_url.as_str().trim_end_matches('/')
    );
    let mut response = (StatusCode::UNAUTHORIZED, "authentication is required").into_response();
    let error = if token_presented {
        ", error=\"invalid_token\""
    } else {
        ""
    };
    if let Ok(value) =
        HeaderValue::from_str(&format!("Bearer resource_metadata=\"{metadata}\"{error}"))
    {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let (scheme, token) = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .split_once(' ')?;
    (scheme.eq_ignore_ascii_case("Bearer")
        && !token.is_empty()
        && !token.bytes().any(|b| b.is_ascii_whitespace()))
    .then_some(token)
}

struct Transfer {
    task_id: Option<String>,
    attachment_id: Option<String>,
    file_name: Option<String>,
    size_bytes: Option<u64>,
    temporary: bool,
    idempotency_key: Option<String>,
}

async fn claim_transfer(
    state: &AppState,
    headers: &HeaderMap,
    direction: &'static str,
) -> AppResult<(Actor, Transfer)> {
    let token = bearer(headers).ok_or(AppError::Unauthorized)?;
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let now = unix_now()?;
    let claimed = state
        .db
        .transaction(move |tx| {
            let row = tx
                .query_row(
                    SELECT_MCP_FILE_TRANSFERS_SQL,
                    rusqlite::params![hash, direction, now],
                    |r| {
                        Ok((
                            Transfer {
                                task_id: r.get(2)?,
                                attachment_id: r.get(3)?,
                                file_name: r.get(4)?,
                                size_bytes: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                                temporary: r.get(6)?,
                                idempotency_key: r.get(7)?,
                            },
                            Actor {
                                user_id: r.get(8)?,
                                username: r.get(9)?,
                                display_name: r.get(10)?,
                                is_admin: r.get(11)?,
                                must_change_password: r.get(12)?,
                                authenticated_at: 0,
                                source: ActorSource::McpGrant {
                                    grant_id: r.get(0)?,
                                },
                            },
                        ))
                    },
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => AppError::Unauthorized,
                    other => other.into(),
                })?;
            let grant = row.1.mcp_grant_id().ok_or(AppError::Unauthorized)?;
            if !crate::auth::revoke_unless_current(tx, grant, now)? {
                return Ok(None);
            }
            row.1.require_ready()?;
            tx.execute(UPDATE_MCP_FILE_TRANSFERS_SQL, rusqlite::params![now, hash])?;
            Ok(Some((row.1, row.0)))
        })
        .await?;
    claimed.ok_or(AppError::Unauthorized)
}

async fn upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<axum::Json<ValueResponse>> {
    let deadline = crate::files::UploadDeadline::new();
    let (actor, transfer) = claim_transfer(&state, &headers, "upload").await?;
    let task = transfer
        .task_id
        .ok_or_else(|| AppError::internal("upload ticket has no task"))?;
    let name = transfer
        .file_name
        .ok_or_else(|| AppError::internal("upload ticket has no file name"))?;
    let size = transfer
        .size_bytes
        .ok_or_else(|| AppError::internal("upload ticket has no size"))?;
    let key = transfer
        .idempotency_key
        .ok_or_else(|| AppError::internal("upload ticket has no idempotency key"))?;
    if let Some(length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        && length != size
    {
        return Err(AppError::validation(
            "content-length",
            "does not match the reserved upload size",
        ));
    }
    let service = state.files;
    let start = service
        .begin_attachment_upload(&actor, &task, &name, size, transfer.temporary, &key)
        .await?;
    let mut upload = match start {
        UploadStart::Pending(upload) => upload,
        UploadStart::Replayed(attachment) => {
            let mut stream = body.into_data_stream();
            let mut received = 0_u64;
            let mut checksum = Sha256::new();
            while let Some(chunk) = deadline.read(stream.next()).await? {
                let chunk = chunk.map_err(body_error)?;
                received = received.saturating_add(chunk.len() as u64);
                if received > size {
                    return Err(AppError::validation(
                        "file",
                        "received more bytes than declared",
                    ));
                }
                checksum.update(&chunk);
            }
            if received != size {
                return Err(AppError::validation(
                    "file",
                    "upload size does not match declared size",
                ));
            }
            if hex::encode(checksum.finalize()) != attachment.checksum {
                return Err(AppError::rule(
                    crate::error::RuleKind::IdempotencyKeyReused,
                    "idempotency key was already used for different file bytes",
                ));
            }
            return Ok(axum::Json(ValueResponse {
                value: serde_json::to_value(attachment)
                    .map_err(|e| AppError::internal(e.to_string()))?,
            }));
        }
    };
    let mut stream = body.into_data_stream();
    while let Some(chunk) = deadline.read(stream.next()).await? {
        let chunk = chunk.map_err(body_error)?;
        upload.write_chunk(&chunk).await?;
    }
    let attachment = upload.finish().await?;
    Ok(axum::Json(ValueResponse {
        value: serde_json::to_value(attachment).map_err(|e| AppError::internal(e.to_string()))?,
    }))
}

/// A body that ends early or stalls is the client's failure, as for browser
/// uploads; the server's request-body limit turns a stall into a 408.
fn body_error(_: axum::Error) -> AppError {
    AppError::validation("file", "upload stream ended unexpectedly")
}

async fn download_file(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let (actor, transfer) = claim_transfer(&state, &headers, "download").await?;
    let attachment = transfer
        .attachment_id
        .ok_or_else(|| AppError::internal("download ticket has no attachment"))?;
    let read = state
        .files
        .open_for_read(&actor, &attachment, ReadMode::Download)
        .await?;
    let length = read.attachment.size;
    let media = read.media_type.clone();
    let mut response = Response::new(Body::from_stream(ReaderStream::with_capacity(
        read.file,
        64 * 1024,
    )));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string())
            .map_err(|e| AppError::internal(e.to_string()))?,
    );
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&media)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[derive(serde::Serialize)]
struct ValueResponse {
    value: serde_json::Value,
}
const SELECT_MCP_FILE_TRANSFERS_SQL: &str = "SELECT f.grant_id,f.direction,f.task_id,f.attachment_id,f.file_name,f.size_bytes,f.is_ephemeral,f.idempotency_key,
                    u.id,u.username,u.display_name,u.is_admin,u.must_change_password
             FROM mcp_file_transfers f JOIN mcp_grants g ON g.id=f.grant_id JOIN users u ON u.id=g.user_id
             WHERE f.token_hash=?1 AND f.direction=?2 AND f.consumed_at IS NULL AND f.expires_at>?3";
const UPDATE_MCP_FILE_TRANSFERS_SQL: &str =
    "UPDATE mcp_file_transfers SET consumed_at=?1 WHERE token_hash=?2 AND consumed_at IS NULL";
