//! Dynamic client registration (RFC 7591), with a quota per caller and in all.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Extension},
    http::{HeaderMap, Method},
};
use rusqlite::params;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;
use crate::{
    http::security::{client_ip, require_canonical_origin},
    mcp::client_metadata::{ClientMetadata, ValidClient},
};

const MAX_CLIENTS_PER_CALLER_HOUR: i64 = 10;
const MAX_CLIENTS_GLOBAL_HOUR: i64 = 300;

#[derive(Serialize)]
struct RegistrationResponse {
    client_id: String,
    client_name: String,
    redirect_uris: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_uri: Option<String>,
    token_endpoint_auth_method: &'static str,
    grant_types: [&'static str; 2],
    response_types: [&'static str; 1],
}

/// Registers a client. Errors take the protocol's shape, also when the body
/// can't be read.
pub(super) async fn register_client(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    request: Result<Json<ClientMetadata>, axum::extract::rejection::JsonRejection>,
) -> Result<impl IntoResponse, OAuthError> {
    let request = request.map_err(|rejection| {
        let mut error = OAuthError::invalid("invalid_client_metadata");
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            error.status = StatusCode::PAYLOAD_TOO_LARGE;
        }
        error
    })?;
    register_client_inner(State(state), peer, headers, request)
        .await
        .map_err(|error| match &error {
            // The fields are RFC 7591's metadata names, which pick the code.
            AppError::Validation { field, .. } if field == "redirect_uris" => {
                OAuthError::invalid("invalid_redirect_uri")
            }
            AppError::Validation { .. } => OAuthError::invalid("invalid_client_metadata"),
            _ => error.into(),
        })
}

async fn register_client_inner(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(mut request): Json<ClientMetadata>,
) -> AppResult<(StatusCode, Json<RegistrationResponse>)> {
    if headers.contains_key(header::ORIGIN) && !cors::listed_origin(&state, &headers) {
        require_canonical_origin(&Method::POST, &headers, &state.config.public_url)?;
    }
    request
        .client_name
        .get_or_insert_with(|| "Unnamed app".to_owned());
    let schemes = &state.config.mcp_redirect_schemes;
    let ValidClient {
        client_name: name,
        redirect_uris: redirects,
        client_uri,
    } = request.validate(|value| validate_redirect_uri(value, schemes))?;
    let client_id = format!("olc_{}", Uuid::now_v7().simple());
    let inserted_id = client_id.clone();
    let stored_name = name.clone();
    let stored_redirects = serde_json::to_string(&redirects)
        .map_err(|error| AppError::internal(format!("serialize redirect URIs: {error}")))?;
    let stored_client_uri = client_uri.clone();
    let now = unix_now()?;
    let peer = peer.map(|Extension(ConnectInfo(address))| address);
    let caller = client_ip(peer, &headers, &state.config.trusted_proxies)
        .map(crate::auth::throttle_bucket)
        .unwrap_or_else(|| "unknown".to_owned());
    let caller_hash = Sha256::digest(format!("oauth-register-v1:{caller}").as_bytes()).to_vec();
    let allowed = state
        .db
        .transaction(move |tx| {
            tx.execute(
                "DELETE FROM oauth_registration_attempts WHERE created_at<=?1",
                [now - 3600],
            )?;
            tx.execute(
                "DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at<=?1",
                [now - 24 * 3600],
            )?;
            // Clients described by metadata documents didn't register.
            let global_recent: i64 = tx.query_row(
                "SELECT COUNT(*) FROM oauth_clients
                 WHERE created_at>?1 AND client_id NOT LIKE 'https://%'",
                [now - 3600],
                |row| row.get(0),
            )?;
            let caller_recent: i64 = tx.query_row(
                "SELECT COUNT(*) FROM oauth_registration_attempts WHERE caller_hash=?1",
                [&caller_hash],
                |row| row.get(0),
            )?;
            if global_recent >= MAX_CLIENTS_GLOBAL_HOUR
                || caller_recent >= MAX_CLIENTS_PER_CALLER_HOUR
            {
                return Ok(false);
            }
            tx.execute(
                "INSERT INTO oauth_clients
                 (client_id,client_name,redirect_uris_json,client_uri,created_at)
                 VALUES(?1,?2,?3,?4,?5)",
                params![
                    inserted_id,
                    stored_name,
                    stored_redirects,
                    stored_client_uri,
                    now
                ],
            )?;
            tx.execute(
                "INSERT INTO oauth_registration_attempts(caller_hash,created_at) VALUES(?1,?2)",
                params![caller_hash, now],
            )?;
            Ok(true)
        })
        .await?;
    if !allowed {
        return Err(AppError::RateLimited { retry_after: 60 });
    }
    Ok((
        StatusCode::CREATED,
        Json(RegistrationResponse {
            client_id,
            client_name: name,
            redirect_uris: redirects,
            client_uri,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
        }),
    ))
}
