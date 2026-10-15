//! One-use tickets that move file bytes for MCP clients. A tool issues a
//! ticket, and one plain HTTP request with its token claims it.

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, header},
    middleware,
    response::Response,
    routing::{get, put},
};
use rusqlite::{OptionalExtension, params};
use tokio_stream::StreamExt;

use super::{
    bearer, cors,
    tools::{TransferTicket, UploadTicketInput},
};
use crate::{
    AppError, AppResult, AppState,
    auth::{Actor, ActorSource, refresh_actor_connection, revoke_unless_current, token},
    clock::unix_now,
    files::{ReadMode, UploadDeadline},
};

/// How long a ticket works.
const TICKET_SECONDS: i64 = 5 * 60;

/// The routes that claim tickets. The ticket is the credential, and bodies
/// are as large as an attachment.
pub(super) fn router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/mcp/files/upload", put(upload))
        .route("/mcp/files/download", get(download))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors::listed_origins,
        ))
}

/// What a ticket lets its holder do.
enum Ticket {
    Upload {
        task_id: String,
        file_name: String,
        size: u64,
        temporary: bool,
        idempotency_key: String,
    },
    Download {
        attachment_id: String,
    },
}

impl Ticket {
    fn direction(&self) -> &'static str {
        match self {
            Self::Upload { .. } => "upload",
            Self::Download { .. } => "download",
        }
    }
}

/// A ticket to upload one attachment, checked now as the upload will be.
pub(super) async fn issue_upload(
    state: &AppState,
    actor: &Actor,
    input: UploadTicketInput,
) -> AppResult<TransferTicket> {
    // The caller may name the task by its key; the ticket keeps its ID.
    let task_id = state
        .files
        .check_attachment_upload(
            actor,
            &input.task_id,
            &input.file_name,
            input.size_bytes,
            &input.idempotency_key,
        )
        .await?;
    let ticket = Ticket::Upload {
        task_id,
        file_name: input.file_name,
        size: input.size_bytes,
        temporary: input.temporary,
        idempotency_key: input.idempotency_key,
    };
    issue(state, actor, ticket, input.size_bytes).await
}

/// A ticket to download an attachment's original bytes.
pub(super) async fn issue_download(
    state: &AppState,
    actor: &Actor,
    attachment_id: &str,
) -> AppResult<TransferTicket> {
    let attachment = state.files.attachment(actor, attachment_id).await?;
    let ticket = Ticket::Download {
        attachment_id: attachment.id,
    };
    issue(state, actor, ticket, attachment.size).await
}

async fn issue(
    state: &AppState,
    actor: &Actor,
    ticket: Ticket,
    content_length: u64,
) -> AppResult<TransferTicket> {
    let grant = actor.mcp_grant_id().ok_or(AppError::Forbidden)?.to_owned();
    let secret = token::random_token(32)?;
    let hash = token::hash(&secret);
    let direction = ticket.direction();
    let now = unix_now()?;
    state
        .db
        .transaction(move |tx| {
            tx.execute(
                "DELETE FROM mcp_file_transfers WHERE expires_at<=?1 OR consumed_at IS NOT NULL",
                [now],
            )?;
            let (task, attachment, name, size, temporary, key) = match ticket {
                Ticket::Upload {
                    task_id,
                    file_name,
                    size,
                    temporary,
                    idempotency_key,
                } => (
                    Some(task_id),
                    None,
                    Some(file_name),
                    Some(size as i64),
                    temporary,
                    Some(idempotency_key),
                ),
                Ticket::Download { attachment_id } => {
                    (None, Some(attachment_id), None, None, false, None)
                }
            };
            tx.execute(
                "INSERT INTO mcp_file_transfers
                 (token_hash,grant_id,direction,task_id,attachment_id,file_name,size_bytes,
                  is_ephemeral,idempotency_key,created_at,expires_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    hash,
                    grant,
                    direction,
                    task,
                    attachment,
                    name,
                    size,
                    temporary,
                    key,
                    now,
                    now + TICKET_SECONDS
                ],
            )?;
            Ok(())
        })
        .await?;
    Ok(TransferTicket {
        url: format!("{}/mcp/files/{direction}", state.config.base_url()),
        method: if direction == "upload" { "PUT" } else { "GET" }.into(),
        authorization: format!("Bearer {secret}"),
        expires_in: TICKET_SECONDS,
        content_length,
    })
}

/// Uses up the ticket that the request presents, for the grant's person as
/// the database knows them now. A grant that no longer works is revoked.
async fn claim(
    state: &AppState,
    headers: &HeaderMap,
    direction: &'static str,
) -> AppResult<(Actor, Ticket)> {
    let hash = token::hash(bearer(headers).ok_or(AppError::Unauthorized)?);
    let now = unix_now()?;
    let claimed = state
        .db
        .transaction(move |tx| {
            let Some((grant_id, user_id, ticket)) = tx
                .query_row(
                    "SELECT f.grant_id,g.user_id,f.task_id,f.attachment_id,f.file_name,
                            f.size_bytes,f.is_ephemeral,f.idempotency_key
                     FROM mcp_file_transfers f JOIN mcp_grants g ON g.id=f.grant_id
                     WHERE f.token_hash=?1 AND f.direction=?2 AND f.consumed_at IS NULL
                       AND f.expires_at>?3",
                    params![hash, direction, now],
                    |row| {
                        let ticket = if direction == "upload" {
                            Ticket::Upload {
                                task_id: row.get(2)?,
                                file_name: row.get(4)?,
                                size: row.get::<_, i64>(5)?.max(0) as u64,
                                temporary: row.get(6)?,
                                idempotency_key: row.get(7)?,
                            }
                        } else {
                            Ticket::Download {
                                attachment_id: row.get(3)?,
                            }
                        };
                        Ok((row.get::<_, String>(0)?, row.get(1)?, ticket))
                    },
                )
                .optional()?
            else {
                return Err(AppError::Unauthorized);
            };
            // A revocation must commit, so it is answered as data.
            if !revoke_unless_current(tx, &grant_id, now)? {
                return Ok(None);
            }
            // The rest of the actor comes from the account as it is now.
            let actor = refresh_actor_connection(
                tx,
                &Actor {
                    user_id,
                    username: String::new(),
                    display_name: String::new(),
                    is_admin: false,
                    must_change_password: false,
                    authenticated_at: 0,
                    source: ActorSource::McpGrant { grant_id },
                },
            )?;
            tx.execute(
                "UPDATE mcp_file_transfers SET consumed_at=?1
                 WHERE token_hash=?2 AND consumed_at IS NULL",
                params![now, hash],
            )?;
            Ok(Some((actor, ticket)))
        })
        .await?;
    claimed.ok_or(AppError::Unauthorized)
}

async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<axum::Json<ValueResponse>> {
    let deadline = UploadDeadline::new();
    let (actor, ticket) = claim(&state, &headers, "upload").await?;
    let Ticket::Upload {
        task_id,
        file_name,
        size,
        temporary,
        idempotency_key,
    } = ticket
    else {
        unreachable!("an upload claim returns an upload ticket")
    };
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
    let mut upload = state
        .files
        .begin_attachment_upload(
            &actor,
            &task_id,
            &file_name,
            size,
            temporary,
            &idempotency_key,
        )
        .await?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = deadline.read(stream.next()).await? {
        upload.write_chunk(&chunk.map_err(body_error)?).await?;
    }
    let (attachment, _) = upload.finish().await?;
    Ok(axum::Json(ValueResponse {
        value: serde_json::to_value(attachment).map_err(|e| AppError::internal(e.to_string()))?,
    }))
}

/// A body that ends early or stalls is the client's failure, as for browser
/// uploads; the server's request-body limit turns a stall into a 408.
fn body_error(_: axum::Error) -> AppError {
    AppError::validation("file", "upload stream ended unexpectedly")
}

async fn download(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let (actor, ticket) = claim(&state, &headers, "download").await?;
    let Ticket::Download { attachment_id } = ticket else {
        unreachable!("a download claim returns a download ticket")
    };
    let read = state
        .files
        .open_for_read(&actor, &attachment_id, ReadMode::Download)
        .await?;
    // A ticket works once, so the response is always the whole file.
    crate::http::files::file_response(read, &HeaderMap::new(), true).await
}

#[derive(serde::Serialize)]
struct ValueResponse {
    value: serde_json::Value,
}
