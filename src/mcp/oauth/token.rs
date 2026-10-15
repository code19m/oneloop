//! The token endpoint, which exchanges codes and refresh tokens, and the
//! revocation endpoint (RFC 7009).

use axum::Form;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::*;
use crate::auth::{ACCESS_TOKEN_SECONDS, AppTokens, NewGrant, issue_grant, revoke_grant};

#[derive(Deserialize)]
struct TokenForm {
    grant_type: String,
    client_id: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    redirect_uri: Option<String>,
    #[serde(default)]
    code_verifier: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    resource: String,
}

#[derive(Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    refresh_token: String,
    scope: String,
}

impl From<AppTokens> for TokenResponse {
    fn from(tokens: AppTokens) -> Self {
        Self {
            access_token: tokens.access,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_SECONDS,
            refresh_token: tokens.refresh,
            scope: tokens.scopes.join(" "),
        }
    }
}

/// Issues tokens for a code or a refresh token, with errors in the
/// protocol's shape.
pub(super) async fn token(
    State(state): State<AppState>,
    form: Result<Form<Vec<(String, String)>>, axum::extract::rejection::FormRejection>,
) -> Result<impl IntoResponse, OAuthError> {
    let Form(pairs) = form.map_err(|_| OAuthError::invalid("invalid_request"))?;
    let form: TokenForm = resource_parameters(&state, pairs)?;
    let client = form.client_id.clone();
    let known = state
        .db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM oauth_clients WHERE client_id=?1)",
                [client],
                |row| row.get::<_, bool>(0),
            )?)
        })
        .await?;
    if !known {
        let mut error = OAuthError::invalid("invalid_client");
        error.status = StatusCode::UNAUTHORIZED;
        return Err(error);
    }
    if form.resource != resource_url(&state) {
        return Err(OAuthError::invalid("invalid_target"));
    }
    let response = match form.grant_type.as_str() {
        "authorization_code" => exchange_code(&state, form).await?,
        "refresh_token" => exchange_refresh(&state, form).await?,
        _ => return Err(OAuthError::invalid("unsupported_grant_type")),
    };
    Ok(Json(response))
}

#[derive(Deserialize)]
pub(super) struct RevokeForm {
    token: String,
    #[serde(default)]
    client_id: Option<String>,
}

pub(super) async fn revoke(
    State(state): State<AppState>,
    form: Result<Form<RevokeForm>, axum::extract::rejection::FormRejection>,
) -> Result<StatusCode, OAuthError> {
    let Form(form) = form.map_err(|_| OAuthError::invalid("invalid_request"))?;
    state
        .auth
        .revoke_app_token(&form.token, form.client_id)
        .await?;
    Ok(StatusCode::OK)
}

async fn exchange_code(state: &AppState, form: TokenForm) -> Result<TokenResponse, OAuthError> {
    let (Some(code), Some(redirect_uri)) = (form.code, form.redirect_uri) else {
        return Err(OAuthError::invalid("invalid_request"));
    };
    // A missing or malformed verifier can't match the code's challenge.
    let verifier = form
        .code_verifier
        .filter(|verifier| is_pkce_verifier(verifier))
        .ok_or_else(|| OAuthError::invalid("invalid_grant"))?;
    let code_hash = hash_token(&code);
    let client_id = form.client_id;
    let resource = form.resource;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let lookup_hash = code_hash.clone();
    let lookup_client = client_id.clone();
    let lookup_redirect = redirect_uri.clone();
    let lookup_resource = resource.clone();
    let lookup_challenge = challenge.clone();
    let lookup_now = unix_now()?;
    let valid = state
        .db
        .run(move |c| {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM oauth_authorization_codes
                 WHERE code_hash=?1 AND client_id=?2 AND redirect_uri=?3 AND resource=?4
                   AND code_challenge=?5
                   AND ((used_at IS NULL AND expires_at>?6)
                        OR (used_at IS NOT NULL AND grant_id IS NOT NULL)))",
                params![
                    lookup_hash,
                    lookup_client,
                    lookup_redirect,
                    lookup_resource,
                    lookup_challenge,
                    lookup_now
                ],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .await?;
    if !valid {
        return Err(OAuthError::invalid("invalid_grant"));
    }
    let tokens = state
        .db
        .transaction(move |tx| {
            let now = unix_now()?;
            // Revalidate bindings under the writer lock before honoring replay evidence.
            let replay: Option<String> = tx
                .query_row(
                    "SELECT grant_id FROM oauth_authorization_codes
                     WHERE code_hash=?1 AND client_id=?2 AND redirect_uri=?3 AND resource=?4
                       AND code_challenge=?5 AND used_at IS NOT NULL AND grant_id IS NOT NULL",
                    params![code_hash, client_id, redirect_uri, resource, challenge],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(grant) = replay {
                revoke_grant(tx, &grant, now)?;
                // Returning success commits revocation; the caller returns invalid_grant.
                return Ok(None);
            }
            // Like refresh, a code needs the account to be active now.
            let code = tx
                .query_row(
                    "SELECT c.user_id,c.client_id,c.client_name,c.redirect_uri,c.resource,
                            c.projects_json,c.scopes_json,c.code_challenge
                     FROM oauth_authorization_codes c JOIN users u ON u.id=c.user_id
                     WHERE c.code_hash=?1 AND c.used_at IS NULL AND c.expires_at>?2
                       AND u.is_active=1",
                    params![code_hash, now],
                    |row| {
                        Ok(StoredCode {
                            user_id: row.get(0)?,
                            client_id: row.get(1)?,
                            client_name: row.get(2)?,
                            redirect_uri: row.get(3)?,
                            resource: row.get(4)?,
                            projects_json: row.get(5)?,
                            scopes_json: row.get(6)?,
                            challenge: row.get(7)?,
                        })
                    },
                )
                .optional()?
                .ok_or(AppError::Unauthorized)?;
            if code.client_id != client_id
                || code.redirect_uri != redirect_uri
                || code.resource != resource
                || !constant_time_eq(code.challenge.as_bytes(), challenge.as_bytes())
            {
                return Err(AppError::Unauthorized);
            }
            let json = |value: &str| -> AppResult<Vec<String>> {
                serde_json::from_str(value).map_err(|e| AppError::internal(e.to_string()))
            };
            let grant = NewGrant {
                projects: json(&code.projects_json)?,
                scopes: json(&code.scopes_json)?,
                user_id: code.user_id,
                client_id: code.client_id,
                client_name: code.client_name,
            };
            tx.execute(
                "UPDATE oauth_clients SET last_used_at=?1 WHERE client_id=?2",
                params![now, client_id],
            )?;
            let (grant_id, tokens) = issue_grant(tx, grant, now)?;
            tx.execute(
                "UPDATE oauth_authorization_codes SET used_at=?1,grant_id=?3
                 WHERE code_hash=?2 AND used_at IS NULL",
                params![now, code_hash, grant_id],
            )?;
            Ok(Some(tokens))
        })
        .await?
        .ok_or_else(|| OAuthError::invalid("invalid_grant"))?;
    Ok(tokens.into())
}

/// An authorization code waiting for exchange.
struct StoredCode {
    user_id: String,
    client_id: String,
    client_name: String,
    redirect_uri: String,
    resource: String,
    projects_json: String,
    scopes_json: String,
    challenge: String,
}

async fn exchange_refresh(state: &AppState, form: TokenForm) -> Result<TokenResponse, OAuthError> {
    let refresh = form
        .refresh_token
        .ok_or_else(|| OAuthError::invalid("invalid_request"))?;
    let tokens = state
        .auth
        .refresh_app_tokens(&refresh, &form.client_id)
        .await?
        .ok_or_else(|| OAuthError::invalid("invalid_grant"))?;
    Ok(tokens.into())
}

fn is_pkce_verifier(v: &str) -> bool {
    (43..=128).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b) {
        d |= x ^ y;
    }
    d == 0
}
