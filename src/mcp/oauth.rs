//! OAuth authorization-code/PKCE and rotating credentials. Bind callbacks, client/resource and replay handling before issuing or revoking grants.

use crate::auth::token::hash as hash_token;
use crate::auth::token::random_token;
use crate::clock::unix_now;
use std::{collections::BTreeSet, convert::Infallible, net::SocketAddr};

use axum::{
    Form, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Query, RawForm, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    http::{
        auth::authenticate_headers,
        security::{client_ip, require_canonical_origin},
    },
};

const REFRESH_REUSE_GRACE_SECONDS: i64 = 30;
pub(super) const ACCESS_TOKEN_SECONDS: i64 = 15 * 60;
pub(crate) const REFRESH_IDLE_SECONDS: i64 = 30 * 24 * 60 * 60;
pub(super) const GRANT_ABSOLUTE_SECONDS: i64 = 90 * 24 * 60 * 60;
const AUTHORIZATION_REQUEST_SECONDS: i64 = 10 * 60;
const AUTHORIZATION_CODE_SECONDS: i64 = 5 * 60;
const MAX_CLIENTS_PER_CALLER_HOUR: i64 = 10;
const MAX_CLIENTS_GLOBAL_HOUR: i64 = 300;

pub(super) const SCOPES: &[&str] = &[
    crate::auth::McpScope::ProjectRead.as_str(),
    crate::auth::McpScope::Discussion.as_str(),
    crate::auth::McpScope::BoardManage.as_str(),
    crate::auth::McpScope::RoadmapManage.as_str(),
    crate::auth::McpScope::InboxPrivate.as_str(),
    crate::auth::McpScope::MyPoolPrivate.as_str(),
    crate::auth::McpScope::Attachments.as_str(),
    crate::auth::McpScope::Destructive.as_str(),
];

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_server_metadata),
        )
        .route(
            "/oauth/register",
            post(register_client).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/oauth/authorize", get(authorize).post(consent))
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke))
        .route("/mcp/assets/consent.js", get(consent_script))
        .route("/mcp/assets/consent.css", get(consent_style))
}

#[derive(Serialize)]
struct ProtectedResourceMetadata {
    resource: String,
    authorization_servers: Vec<String>,
    scopes_supported: &'static [&'static str],
    bearer_methods_supported: [&'static str; 1],
}

async fn protected_resource_metadata(
    State(state): State<AppState>,
) -> Json<ProtectedResourceMetadata> {
    Json(ProtectedResourceMetadata {
        resource: resource_url(&state),
        authorization_servers: vec![issuer(&state)],
        scopes_supported: SCOPES,
        bearer_methods_supported: ["header"],
    })
}

#[derive(Serialize)]
struct AuthorizationServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: String,
    revocation_endpoint: String,
    response_types_supported: [&'static str; 1],
    grant_types_supported: [&'static str; 2],
    token_endpoint_auth_methods_supported: [&'static str; 1],
    code_challenge_methods_supported: [&'static str; 1],
    scopes_supported: &'static [&'static str],
    authorization_response_iss_parameter_supported: bool,
}

async fn authorization_server_metadata(
    State(state): State<AppState>,
) -> Json<AuthorizationServerMetadata> {
    let base = issuer(&state);
    Json(AuthorizationServerMetadata {
        issuer: base.clone(),
        authorization_endpoint: format!("{base}/oauth/authorize"),
        token_endpoint: format!("{base}/oauth/token"),
        registration_endpoint: format!("{base}/oauth/register"),
        revocation_endpoint: format!("{base}/oauth/revoke"),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: SCOPES,
        authorization_response_iss_parameter_supported: true,
    })
}

#[derive(Deserialize)]
struct RegistrationRequest {
    client_name: Option<String>,
    redirect_uris: Vec<String>,
    #[serde(default)]
    client_uri: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    grant_types: Vec<String>,
    #[serde(default)]
    response_types: Vec<String>,
}

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

struct OptionalPeer(Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for OptionalPeer {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|peer| peer.0),
        ))
    }
}

async fn register_client_inner(
    State(state): State<AppState>,
    OptionalPeer(peer): OptionalPeer,
    headers: HeaderMap,
    Json(request): Json<RegistrationRequest>,
) -> AppResult<(StatusCode, Json<RegistrationResponse>)> {
    if headers.contains_key(header::ORIGIN) {
        require_canonical_origin(&Method::POST, &headers, &state.config.public_url)?;
    }
    if let Some(name) = request.client_name.as_deref() {
        crate::text::validate(name, "client_name", crate::text::Lines::Single, true)?;
    }
    let name = request
        .client_name
        .as_deref()
        .unwrap_or("Unnamed app")
        .trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::validation(
            "client_name",
            "must contain 1 to 100 characters",
        ));
    }
    if request.redirect_uris.is_empty() || request.redirect_uris.len() > 10 {
        return Err(AppError::validation(
            "redirect_uris",
            "must contain 1 to 10 safe redirect URIs",
        ));
    }
    if request
        .token_endpoint_auth_method
        .as_deref()
        .unwrap_or("none")
        != "none"
    {
        return Err(AppError::validation(
            "token_endpoint_auth_method",
            "only public clients using none are supported",
        ));
    }
    if !request.grant_types.is_empty()
        && request
            .grant_types
            .iter()
            .any(|v| v != "authorization_code" && v != "refresh_token")
    {
        return Err(AppError::validation(
            "grant_types",
            "only authorization_code and refresh_token are supported",
        ));
    }
    if !request.response_types.is_empty() && request.response_types.iter().any(|v| v != "code") {
        return Err(AppError::validation(
            "response_types",
            "only code is supported",
        ));
    }
    let mut redirects = BTreeSet::new();
    for value in request.redirect_uris {
        redirects.insert(validate_redirect_uri(&value)?);
    }
    let client_uri = request
        .client_uri
        .map(|value| validate_client_uri(&value))
        .transpose()?;
    let redirects = redirects.into_iter().collect::<Vec<_>>();
    let client_id = format!("olc_{}", Uuid::now_v7().simple());
    let inserted_id = client_id.clone();
    let stored_name = name.to_owned();
    let stored_redirects = serde_json::to_string(&redirects)
        .map_err(|error| AppError::internal(format!("serialize redirect URIs: {error}")))?;
    let stored_client_uri = client_uri.clone();
    let now = unix_now()?;
    let caller = client_ip(peer, &headers, &state.config.trusted_proxies)
        .map(crate::http::security::throttle_bucket)
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
            let global_recent: i64 = tx.query_row(
                "SELECT COUNT(*) FROM oauth_clients WHERE created_at>?1",
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
                "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,client_uri,created_at)
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
            client_name: name.to_owned(),
            redirect_uris: redirects,
            client_uri,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
        }),
    ))
}

#[derive(Deserialize)]
struct AuthorizationQuery {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    #[serde(default)]
    state: Option<String>,
    resource: String,
    #[serde(default)]
    scope: String,
}

async fn authorize_inner(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AuthorizationQuery>,
) -> AppResult<Response> {
    validate_authorization_query(&state, &query).await?;
    let scopes = parse_requested_scopes(&query.scope)?;
    let actor = match authenticate_headers(&state, &headers, true).await {
        Ok(actor) if !actor.must_change_password => actor,
        Ok(_) | Err(AppError::Unauthorized) => return Ok(authorization_login_redirect(&query)),
        Err(error) => return Err(error),
    };
    let projects = accessible_projects(&state, &actor).await?;
    let request_id = random_token(24)?;
    let stored_id = hash_token(&request_id);
    let user_id = actor.user_id.clone();
    let client_id = query.client_id.clone();
    let redirect_uri = query.redirect_uri.clone();
    let state_value = query.state.clone();
    let resource = query.resource.clone();
    let requested_scopes = serde_json::to_string(&scopes)
        .map_err(|error| AppError::internal(format!("serialize scopes: {error}")))?;
    let challenge = query.code_challenge.clone();
    let now = unix_now()?;
    state.db.transaction(move |connection| {
        connection.execute("DELETE FROM oauth_authorization_requests WHERE expires_at<=?1 OR consumed_at IS NOT NULL", [now])?;
        connection.execute(
            "INSERT INTO oauth_authorization_requests
             (id,user_id,client_id,redirect_uri,state,resource,requested_scopes_json,code_challenge,created_at,expires_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![stored_id,user_id,client_id,redirect_uri,state_value,resource,requested_scopes,challenge,now,now+AUTHORIZATION_REQUEST_SECONDS],
        )?;
        Ok(())
    }).await?;
    let client_name = client_name(&state, &query.client_id).await?;
    consent_response(
        Html(consent_html(
            &request_id,
            &client_name,
            &actor.display_name,
            &actor.username,
            &projects,
            &scopes,
            ConsentPresentation {
                redirect: &query.redirect_uri,
                retry: None,
            },
        ))
        .into_response(),
        &query.redirect_uri,
    )
}

fn consent_response(mut response: Response, redirect: &str) -> AppResult<Response> {
    let callback =
        Url::parse(redirect).map_err(|_| AppError::internal("invalid stored callback"))?;
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("same-origin"),
    );
    // CSP host-sources cannot express IPv6 literals. Those callbacks use a
    // local continuation response after the canonical-origin form POST.
    let callback = (!matches!(callback.host(), Some(url::Host::Ipv6(_)))).then_some(&callback);
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        crate::http::security::content_security_policy(callback),
    );
    Ok(response)
}

fn authorization_login_redirect(query: &AuthorizationQuery) -> Response {
    let target = authorization_return_target(query);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("oauth_return", &target)
        .finish();
    Redirect::to(&format!("/?{query}")).into_response()
}

fn authorization_return_target(query: &AuthorizationQuery) -> String {
    let mut parameters = url::form_urlencoded::Serializer::new(String::new());
    parameters
        .append_pair("response_type", &query.response_type)
        .append_pair("client_id", &query.client_id)
        .append_pair("redirect_uri", &query.redirect_uri)
        .append_pair("code_challenge", &query.code_challenge)
        .append_pair("code_challenge_method", &query.code_challenge_method)
        .append_pair("resource", &query.resource)
        .append_pair("scope", &query.scope);
    if let Some(state) = &query.state {
        parameters.append_pair("state", state);
    }
    format!("/oauth/authorize?{}", parameters.finish())
}

struct ConsentForm {
    request_id: String,
    decision: String,
    project: Vec<String>,
    scope: Vec<String>,
}

#[derive(Clone, Debug)]
struct StoredAuthorizationRequest {
    user_id: String,
    client_id: String,
    client_name: String,
    redirect_uri: String,
    state: Option<String>,
    resource: String,
    requested_scopes: Vec<String>,
    challenge: String,
}

async fn consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawForm(raw): RawForm,
) -> AppResult<Response> {
    let form = parse_consent_form(&raw)?;
    require_canonical_origin(&Method::POST, &headers, &state.config.public_url)?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    actor.require_ready()?;
    let request_hash = hash_token(&form.request_id);
    let user_id = actor.user_id.clone();
    let now = unix_now()?;
    let stored = state
        .db
        .run(move |tx| {
            let row = tx
                .query_row(
                    "SELECT r.user_id,r.client_id,c.client_name,r.redirect_uri,r.state,r.resource,
                    r.requested_scopes_json,r.code_challenge
             FROM oauth_authorization_requests r JOIN oauth_clients c ON c.client_id=r.client_id
             WHERE r.id=?1 AND r.user_id=?2 AND r.consumed_at IS NULL AND r.expires_at>?3",
                    params![request_hash, user_id, now],
                    |row| {
                        Ok(StoredAuthorizationRequest {
                            user_id: row.get(0)?,
                            client_id: row.get(1)?,
                            client_name: row.get(2)?,
                            redirect_uri: row.get(3)?,
                            state: row.get(4)?,
                            resource: row.get(5)?,
                            requested_scopes: serde_json::from_str::<Vec<String>>(
                                &row.get::<_, String>(6)?,
                            )
                            .map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    6,
                                    rusqlite::types::Type::Text,
                                    Box::new(e),
                                )
                            })?,
                            challenge: row.get(7)?,
                        })
                    },
                )
                .optional()?
                .ok_or(AppError::PreconditionFailed(
                    "authorization request expired or was already used".into(),
                ))?;
            Ok(row)
        })
        .await?;

    let request_hash = hash_token(&form.request_id);
    let user_id = actor.user_id.clone();
    if form.decision == "deny" {
        state
            .db
            .transaction(move |tx| consume_request(tx, &request_hash, &user_id, unix_now()?))
            .await?;
        return oauth_redirect(
            &issuer(&state),
            &stored.redirect_uri,
            [("error", "access_denied")],
            stored.state.as_deref(),
        );
    }
    let result = approve_consent(&state, &actor, &form, &stored).await;
    match result {
        Ok(code) => oauth_redirect(
            &issuer(&state),
            &stored.redirect_uri,
            [("code", code.as_str())],
            stored.state.as_deref(),
        ),
        Err(error @ AppError::Validation { .. }) => {
            let projects = accessible_projects(&state, &actor).await?;
            consent_response(
                (
                    StatusCode::BAD_REQUEST,
                    Html(consent_html(
                        &form.request_id,
                        &stored.client_name,
                        &actor.display_name,
                        &actor.username,
                        &projects,
                        &stored.requested_scopes,
                        ConsentPresentation {
                            redirect: &stored.redirect_uri,
                            retry: Some((&form, &error.client_message())),
                        },
                    )),
                )
                    .into_response(),
                &stored.redirect_uri,
            )
        }
        Err(error) => Err(error),
    }
}

fn consume_request(
    tx: &rusqlite::Transaction<'_>,
    hash: &str,
    user: &str,
    now: i64,
) -> AppResult<()> {
    if tx.execute(
        "UPDATE oauth_authorization_requests SET consumed_at=?1 WHERE id=?2 AND user_id=?3 AND \
                     consumed_at IS NULL AND expires_at>?1",
        params![now, hash, user],
    )? != 1
    {
        return Err(AppError::PreconditionFailed(
            "authorization request expired or was already used".into(),
        ));
    }
    Ok(())
}

async fn approve_consent(
    state: &AppState,
    actor: &Actor,
    form: &ConsentForm,
    stored: &StoredAuthorizationRequest,
) -> AppResult<String> {
    if form.project.is_empty() {
        return Err(AppError::validation(
            "project",
            "select at least one project",
        ));
    }
    let requested = stored
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut selected_scopes = form.scope.iter().cloned().collect::<BTreeSet<_>>();
    selected_scopes.insert("project_read".to_owned());
    if selected_scopes
        .iter()
        .any(|scope| !requested.contains(scope.as_str()) || !SCOPES.contains(&scope.as_str()))
    {
        return Err(AppError::validation(
            "scope",
            "contains an unrequested capability",
        ));
    }
    if selected_scopes.contains("destructive")
        && !selected_scopes
            .iter()
            .any(|v| v == "board_manage" || v == "roadmap_manage" || v == "attachments")
    {
        return Err(AppError::validation(
            "scope",
            "destructive access requires a management capability",
        ));
    }
    let projects = form
        .project
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let scopes = selected_scopes.into_iter().collect::<Vec<_>>();
    let code = random_token(32)?;
    let code_hash = hash_token(&code);
    let projects_json =
        serde_json::to_string(&projects).map_err(|e| AppError::internal(e.to_string()))?;
    let scopes_json =
        serde_json::to_string(&scopes).map_err(|e| AppError::internal(e.to_string()))?;
    let issued_at = unix_now()?;
    let stored = stored.clone();
    let request_hash = hash_token(&form.request_id);
    let actor = actor.clone();
    state.db.transaction(move |connection| {
        // The session may have been revoked since this request was authenticated.
        let actor = crate::auth::refresh_actor_connection(connection, &actor)?;
        validate_selected_projects(connection, &actor, &projects)?;
        consume_request(connection, &request_hash, &actor.user_id, unix_now()?)?;
        connection.execute(
            "INSERT INTO oauth_authorization_codes
             (code_hash,user_id,client_id,client_name,redirect_uri,resource,projects_json,scopes_json,code_challenge,issued_at,expires_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![code_hash,stored.user_id,stored.client_id,stored.client_name,stored.redirect_uri,
                stored.resource,projects_json,scopes_json,stored.challenge,issued_at,issued_at+AUTHORIZATION_CODE_SECONDS],
        )?;
        Ok(())
    }).await?;
    Ok(code)
}

fn parse_consent_form(raw: &[u8]) -> AppResult<ConsentForm> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| AppError::validation("form", "must be valid UTF-8"))?;
    let mut request_id = None;
    let mut decision = None;
    let mut project = Vec::new();
    let mut scope = Vec::new();
    for (key, value) in url::form_urlencoded::parse(text.as_bytes()) {
        match key.as_ref() {
            "request_id" => request_id = Some(value.into_owned()),
            "decision" => decision = Some(value.into_owned()),
            "project" => project.push(value.into_owned()),
            "scope" => scope.push(value.into_owned()),
            _ => {}
        }
    }
    Ok(ConsentForm {
        request_id: request_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::validation("request_id", "is required"))?,
        decision: decision
            .filter(|value| value == "allow" || value == "deny")
            .ok_or_else(|| AppError::validation("decision", "must be allow or deny"))?,
        project,
        scope,
    })
}

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

/// URL-encoded extractors do not collect repeated fields into a Vec inside a
/// struct. Normalize resources first, while retaining singleton validation.
fn resource_parameters<T: serde::de::DeserializeOwned>(
    state: &AppState,
    pairs: Vec<(String, String)>,
) -> AppResult<T> {
    let canonical = resource_url(state);
    let mut resources = 0;
    let mut valid_resources = true;
    let mut singletons = BTreeSet::new();
    let mut normalized = Vec::new();
    for (name, value) in pairs {
        if name == "resource" {
            resources += 1;
            valid_resources &= value == canonical;
        } else {
            if !singletons.insert(name.clone()) {
                return Err(AppError::validation("request", "duplicate parameter"));
            }
            normalized.push((name, value));
        }
    }
    // An empty target fails the existing resource check after required fields
    // have been parsed, preserving invalid_request for incomplete requests.
    normalized.push((
        "resource".to_owned(),
        if resources > 0 && valid_resources {
            canonical
        } else {
            String::new()
        },
    ));
    let encoded = serde_urlencoded::to_string(normalized)
        .map_err(|error| AppError::internal(format!("normalize OAuth parameters: {error}")))?;
    serde_urlencoded::from_str(&encoded)
        .map_err(|_| AppError::validation("request", "invalid request"))
}

#[derive(Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    refresh_token: String,
    scope: String,
}

struct RefreshTokenRow {
    id: String,
    grant_id: String,
    family_id: String,
    expires_at: i64,
    last_used_at: Option<i64>,
    rotated_to_id: Option<String>,
    revoked_at: Option<i64>,
}

struct NewToken<'a> {
    id: &'a str,
    grant_id: &'a str,
    family_id: &'a str,
    kind: &'a str,
    hash: &'a str,
    issued_at: i64,
    expires_at: i64,
}

async fn token_inner(
    State(state): State<AppState>,
    Form(form): Form<TokenForm>,
) -> AppResult<Json<TokenResponse>> {
    if form.resource != resource_url(&state) {
        return Err(AppError::validation(
            "resource",
            "must identify this oneloop MCP server",
        ));
    }
    let response = match form.grant_type.as_str() {
        "authorization_code" => exchange_code(&state, form).await?,
        "refresh_token" => exchange_refresh(&state, form).await?,
        _ => return Err(AppError::validation("grant_type", "unsupported grant type")),
    };
    Ok(Json(response))
}

#[derive(Deserialize)]
struct RevokeForm {
    token: String,
    #[serde(default)]
    client_id: Option<String>,
}

async fn revoke_inner(
    State(state): State<AppState>,
    Form(form): Form<RevokeForm>,
) -> AppResult<StatusCode> {
    let hash = hash_token(&form.token);
    let client = form.client_id;
    let now = unix_now()?;
    let target = state
        .db
        .run(move |tx| {
            let target: Option<(String,String)> = tx.query_row(
            "SELECT t.grant_id,t.family_id FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
             WHERE t.token_hash=?1 AND (?2 IS NULL OR g.client_id=?2)",
            params![hash,client], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
            Ok(target)
        })
        .await?;
    if let Some((grant, family)) = target {
        state
            .db
            .transaction(move |tx| {
                tx.execute(
                    "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE family_id=?2",
                    params![now, family],
                )?;
                tx.execute(
                    "UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,?1),updated_at=?1,\
                     revision=revision+1 WHERE id=?2",
                    params![now, grant],
                )?;
                Ok(())
            })
            .await?;
    }
    Ok(StatusCode::OK)
}

async fn exchange_code(state: &AppState, form: TokenForm) -> AppResult<TokenResponse> {
    let code = form
        .code
        .ok_or_else(|| AppError::validation("code", "is required"))?;
    let redirect_uri = form
        .redirect_uri
        .ok_or_else(|| AppError::validation("redirect_uri", "is required"))?;
    let verifier = form
        .code_verifier
        .ok_or_else(|| AppError::validation("code_verifier", "is required"))?;
    validate_pkce_verifier(&verifier)?;
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
                SELECT_OAUTH_AUTHORIZATION_CODES_SQL,
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
        return Err(AppError::Unauthorized);
    }
    let access = random_token(32)?;
    let refresh = random_token(48)?;
    let access_hash = hash_token(&access);
    let refresh_hash = hash_token(&refresh);
    let grant_id = Uuid::now_v7().to_string();
    let family_id = Uuid::now_v7().to_string();
    let access_id = Uuid::now_v7().to_string();
    let refresh_id = Uuid::now_v7().to_string();
    let scopes = state
        .db
        .transaction(move |tx| {
            let now = unix_now()?;
            // Revalidate bindings under the writer lock before honoring replay evidence.
            let replay: Option<String> = tx
                .query_row(
                    "SELECT grant_id FROM oauth_authorization_codes WHERE code_hash=?1
                 AND client_id=?2 AND redirect_uri=?3 AND resource=?4 AND code_challenge=?5
                 AND used_at IS NOT NULL AND grant_id IS NOT NULL",
                    params![code_hash, client_id, redirect_uri, resource, challenge],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(grant) = replay {
                tx.execute(
                    "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE grant_id=?2",
                    params![now, grant],
                )?;
                tx.execute(UPDATE_MCP_GRANTS_SQL, params![now, grant])?;
                // Returning success commits revocation; the caller returns invalid_grant.
                return Ok(None);
            }
            let row: Option<(String, String, String, String, String, String, String)> = tx
                .query_row(
                    SELECT_OAUTH_AUTHORIZATION_CODES_2_SQL,
                    params![code_hash, now],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                user_id,
                stored_client,
                client_name,
                stored_redirect,
                stored_resource,
                projects_json,
                scopes_json,
            )) = row
            else {
                return Err(AppError::Unauthorized);
            };
            let stored_challenge: String = tx.query_row(
                SELECT_OAUTH_AUTHORIZATION_CODES_3_SQL,
                [&code_hash],
                |row| row.get(0),
            )?;
            if stored_client != client_id
                || stored_redirect != redirect_uri
                || stored_resource != resource
                || !constant_time_eq(stored_challenge.as_bytes(), challenge.as_bytes())
            {
                return Err(AppError::Unauthorized);
            }
            let projects: Vec<String> = serde_json::from_str(&projects_json)
                .map_err(|e| AppError::internal(e.to_string()))?;
            let scopes: Vec<String> = serde_json::from_str(&scopes_json)
                .map_err(|e| AppError::internal(e.to_string()))?;
            tx.execute(
                "UPDATE oauth_clients SET last_used_at=?1 WHERE client_id=?2",
                params![now, client_id],
            )?;
            tx.execute(
                INSERT_MCP_GRANTS_SQL,
                params![
                    grant_id,
                    user_id,
                    client_id,
                    client_name,
                    now,
                    now + GRANT_ABSOLUTE_SECONDS
                ],
            )?;
            tx.execute(
                UPDATE_OAUTH_AUTHORIZATION_CODES_SQL,
                params![now, code_hash, grant_id],
            )?;
            for project in projects {
                tx.execute(INSERT_MCP_GRANT_PROJECTS_SQL, params![grant_id, project])?;
            }
            for scope in &scopes {
                tx.execute(
                    "INSERT INTO mcp_grant_scopes(grant_id,scope) VALUES(?1,?2)",
                    params![grant_id, scope],
                )?;
            }
            insert_token(
                tx,
                NewToken {
                    id: &access_id,
                    grant_id: &grant_id,
                    family_id: &family_id,
                    kind: "access",
                    hash: &access_hash,
                    issued_at: now,
                    expires_at: now + ACCESS_TOKEN_SECONDS,
                },
            )?;
            insert_token(
                tx,
                NewToken {
                    id: &refresh_id,
                    grant_id: &grant_id,
                    family_id: &family_id,
                    kind: "refresh",
                    hash: &refresh_hash,
                    issued_at: now,
                    expires_at: now + GRANT_ABSOLUTE_SECONDS,
                },
            )?;
            Ok(Some(scopes))
        })
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok(TokenResponse {
        access_token: access,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_SECONDS,
        refresh_token: refresh,
        scope: scopes.join(" "),
    })
}

async fn exchange_refresh(state: &AppState, form: TokenForm) -> AppResult<TokenResponse> {
    let old = form
        .refresh_token
        .ok_or_else(|| AppError::validation("refresh_token", "is required"))?;
    let old_hash = hash_token(&old);
    let client_id = form.client_id;
    let lookup_hash = old_hash.clone();
    let lookup_client = client_id.clone();
    let known = state
        .db
        .run(move |c| {
            Ok(c.query_row(
                SELECT_MCP_TOKENS_SQL,
                params![lookup_hash, lookup_client],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .await?;
    if !known {
        return Err(AppError::Unauthorized);
    }
    let access = random_token(32)?;
    let refresh = random_token(48)?;
    let access_hash = hash_token(&access);
    let refresh_hash = hash_token(&refresh);
    let access_id = Uuid::now_v7().to_string();
    let refresh_id = Uuid::now_v7().to_string();
    let outcome = state
        .db
        .transaction(move |tx| {
            let now = unix_now()?;
            let row: Option<RefreshTokenRow> = tx
                .query_row(
                    SELECT_MCP_TOKENS_2_SQL,
                    params![old_hash, client_id],
                    |row| {
                        Ok(RefreshTokenRow {
                            id: row.get(0)?,
                            grant_id: row.get(1)?,
                            family_id: row.get(2)?,
                            expires_at: row.get(3)?,
                            last_used_at: row.get(4)?,
                            rotated_to_id: row.get(5)?,
                            revoked_at: row.get(6)?,
                        })
                    },
                )
                .optional()?;
            let Some(row) = row else { return Ok(None) };
            let rotated = row.rotated_to_id.is_some();
            let within_grace = rotated
                && row.last_used_at.is_some_and(|rotation| {
                    (0..=REFRESH_REUSE_GRACE_SECONDS).contains(&(now - rotation))
                });
            if rotated && !within_grace {
                tx.execute(UPDATE_MCP_TOKENS_SQL, params![now, row.family_id])?;
                tx.execute(UPDATE_MCP_GRANTS_SQL, params![now, row.grant_id])?;
                return Ok(None);
            }
            let RefreshTokenRow {
                id: old_id,
                grant_id,
                family_id,
                expires_at,
                last_used_at: last_used,
                revoked_at,
                ..
            } = row;
            if (revoked_at.is_some() && !within_grace)
                || expires_at <= now
                || last_used.unwrap_or(now) <= now - REFRESH_IDLE_SECONDS
            {
                tx.execute(UPDATE_MCP_TOKENS_2_SQL, params![now, old_id])?;
                return Ok(None);
            }
            let active: bool =
                tx.query_row(SELECT_MCP_GRANTS_SQL, params![grant_id, now], |row| {
                    row.get(0)
                })?;
            if !active {
                tx.execute(UPDATE_MCP_TOKENS_3_SQL, params![now, family_id])?;
                tx.execute(UPDATE_MCP_GRANTS_2_SQL, params![now, grant_id])?;
                return Ok(None);
            }
            let grant_expiry: i64 = tx.query_row(
                "SELECT expires_at FROM mcp_grants WHERE id=?1",
                [&grant_id],
                |row| row.get(0),
            )?;
            insert_token(
                tx,
                NewToken {
                    id: &access_id,
                    grant_id: &grant_id,
                    family_id: &family_id,
                    kind: "access",
                    hash: &access_hash,
                    issued_at: now,
                    expires_at: now + ACCESS_TOKEN_SECONDS,
                },
            )?;
            insert_token(
                tx,
                NewToken {
                    id: &refresh_id,
                    grant_id: &grant_id,
                    family_id: &family_id,
                    kind: "refresh",
                    hash: &refresh_hash,
                    issued_at: now,
                    expires_at: grant_expiry,
                },
            )?;
            // Preserve the first rotation time: retries cannot extend the grace window.
            if !rotated {
                tx.execute(UPDATE_MCP_TOKENS_4_SQL, params![now, refresh_id, old_id])?;
            }
            tx.execute(
                "UPDATE mcp_grants SET last_used_at=?1,updated_at=?1 WHERE id=?2",
                params![now, grant_id],
            )?;
            let mut stmt = tx.prepare(SELECT_MCP_GRANT_SCOPES_SQL)?;
            let values = stmt
                .query_map([grant_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(values))
        })
        .await?;
    let scopes = outcome.ok_or(AppError::Unauthorized)?;
    Ok(TokenResponse {
        access_token: access,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_SECONDS,
        refresh_token: refresh,
        scope: scopes.join(" "),
    })
}

fn insert_token(tx: &rusqlite::Transaction<'_>, token: NewToken<'_>) -> AppResult<()> {
    tx.execute(
        INSERT_MCP_TOKENS_SQL,
        params![
            token.id,
            token.grant_id,
            token.family_id,
            token.kind,
            token.hash,
            token.issued_at,
            token.expires_at
        ],
    )?;
    Ok(())
}

async fn validate_authorization_query(
    state: &AppState,
    query: &AuthorizationQuery,
) -> AppResult<()> {
    if query.response_type != "code" {
        return Err(AppError::validation(
            "response_type",
            "only code is supported",
        ));
    }
    if query.code_challenge_method != "S256" {
        return Err(AppError::validation(
            "code_challenge_method",
            "S256 is required",
        ));
    }
    validate_challenge(&query.code_challenge)?;
    if query.resource != resource_url(state) {
        return Err(AppError::validation(
            "resource",
            "must identify this oneloop MCP server",
        ));
    }
    let client = query.client_id.clone();
    let redirect = validate_redirect_uri(&query.redirect_uri)?;
    let valid = state
        .db
        .run(move |connection| {
            let json: Option<String> = connection
                .query_row(
                    "SELECT redirect_uris_json FROM oauth_clients WHERE client_id=?1",
                    [client],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(json) = json else { return Ok(false) };
            let values: Vec<String> =
                serde_json::from_str(&json).map_err(|e| AppError::internal(e.to_string()))?;
            Ok(values
                .iter()
                .any(|value| redirect_matches(value, &redirect)))
        })
        .await?;
    if !valid {
        return Err(AppError::validation(
            "redirect_uri",
            "is not registered for this client",
        ));
    }
    Ok(())
}

fn parse_requested_scopes(raw: &str) -> AppResult<Vec<String>> {
    let mut set = raw
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    if set.is_empty() {
        set.insert("project_read".into());
    }
    if set.iter().any(|v| !SCOPES.contains(&v.as_str())) {
        return Err(AppError::validation(
            "scope",
            "contains an unsupported capability",
        ));
    }
    set.insert("project_read".into());
    Ok(set.into_iter().collect())
}

async fn accessible_projects(state: &AppState, actor: &Actor) -> AppResult<Vec<(String, String)>> {
    let actor = actor.clone();
    state
        .db
        .run(move |connection| {
            let mut statement = connection.prepare(SELECT_PROJECTS_2_SQL)?;
            Ok(statement
                .query_map(params![actor.is_admin, actor.user_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

fn validate_selected_projects(
    connection: &rusqlite::Connection,
    actor: &Actor,
    projects: &[String],
) -> AppResult<()> {
    for id in projects {
        let allowed: bool =
            connection.query_row(SELECT_PROJECTS_SQL, params![id, actor.user_id], |row| {
                row.get(0)
            })?;
        if !allowed {
            return Err(AppError::validation(
                "project",
                "contains an inaccessible project",
            ));
        }
    }
    Ok(())
}

async fn client_name(state: &AppState, id: &str) -> AppResult<String> {
    let id = id.to_owned();
    state
        .db
        .run(move |c| {
            c.query_row(
                "SELECT client_name FROM oauth_clients WHERE client_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(AppError::NotFound {
                resource: "OAuth client",
            })
        })
        .await
}

fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    }
}

fn redirect_matches(registered: &str, requested: &str) -> bool {
    let (Ok(mut registered), Ok(mut requested)) = (Url::parse(registered), Url::parse(requested))
    else {
        return false;
    };
    if registered.scheme() == "http"
        && requested.scheme() == "http"
        && loopback(&registered)
        && loopback(&requested)
    {
        let _ = registered.set_port(None);
        let _ = requested.set_port(None);
    }
    registered == requested
}

fn validate_redirect_uri(value: &str) -> AppResult<String> {
    if value.len() > 512 {
        return Err(AppError::validation(
            "redirect_uris",
            "must be at most 512 bytes each",
        ));
    }
    let url = Url::parse(value)
        .map_err(|_| AppError::validation("redirect_uris", "must contain absolute URIs"))?;
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::validation(
            "redirect_uris",
            "must not contain credentials or fragments",
        ));
    }
    let safe = match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => loopback(&url),
        _ => false,
    };
    if !safe {
        return Err(AppError::validation(
            "redirect_uris",
            "must use HTTPS or loopback HTTP",
        ));
    }
    if url.as_str().len() > 512 {
        return Err(AppError::validation(
            "redirect_uris",
            "must be at most 512 bytes after normalization",
        ));
    }
    Ok(url.to_string())
}

fn validate_client_uri(value: &str) -> AppResult<String> {
    if value.len() > 2048 {
        return Err(AppError::validation(
            "client_uri",
            "must be at most 2048 bytes",
        ));
    }
    let url = Url::parse(value)
        .map_err(|_| AppError::validation("client_uri", "must be an HTTPS URL"))?;
    if url.as_str().len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::validation(
            "client_uri",
            "must be a safe HTTPS URL",
        ));
    }
    Ok(url.to_string())
}
fn validate_challenge(v: &str) -> AppResult<()> {
    if v.len() != 43
        || !v
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::validation(
            "code_challenge",
            "must be a base64url SHA-256 challenge",
        ));
    }
    Ok(())
}
fn validate_pkce_verifier(v: &str) -> AppResult<()> {
    if !(43..=128).contains(&v.len())
        || !v
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
    {
        return Err(AppError::validation(
            "code_verifier",
            "must be a valid PKCE verifier",
        ));
    }
    Ok(())
}

fn oauth_redirect<const N: usize>(
    issuer: &str,
    base: &str,
    pairs: [(&str, &str); N],
    state: Option<&str>,
) -> AppResult<Response> {
    let mut url =
        Url::parse(base).map_err(|_| AppError::internal("stored redirect URI is invalid"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("iss", issuer);
        for (k, v) in pairs {
            q.append_pair(k, v);
        }
        if let Some(state) = state {
            q.append_pair("state", state);
        }
    }
    if matches!(url.host(), Some(url::Host::Ipv6(_))) {
        let target = escape(url.as_str());
        return Ok(Html(format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url={target}\"><title>Continue to app</title></head><body><a href=\"{target}\">Continue to app</a></body></html>"
        )).into_response());
    }
    Ok(Redirect::to(url.as_str()).into_response())
}
fn issuer(state: &AppState) -> String {
    state
        .config
        .public_url
        .as_str()
        .trim_end_matches('/')
        .to_owned()
}
fn resource_url(state: &AppState) -> String {
    format!("{}/mcp", issuer(state))
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

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
struct ConsentPresentation<'a> {
    redirect: &'a str,
    retry: Option<(&'a ConsentForm, &'a str)>,
}

fn scope_label(scope: &str) -> &str {
    match scope {
        "discussion" => "Read and write comments and replies",
        "board_manage" => "Create and manage tasks and Pool items",
        "roadmap_manage" => "Create and manage roadmap work",
        "inbox_private" => "Read and manage your private Inbox (selected projects only)",
        "my_pool_private" => "Read and manage your private My Pool",
        "attachments" => "Read and manage attachments",
        "destructive" => "Permanently delete permitted work and files",
        _ => scope,
    }
}

fn consent_html(
    request_id: &str,
    client: &str,
    display_name: &str,
    username: &str,
    projects: &[(String, String)],
    scopes: &[String],
    presentation: ConsentPresentation<'_>,
) -> String {
    let project_rows = projects
        .iter()
        .map(|(id, name)| {
            format!(
                "<label><input type=checkbox name=project value=\"{}\"{}> <span>{}</span></label>",
                escape(id),
                if presentation
                    .retry
                    .is_some_and(|(form, _)| form.project.contains(id))
                {
                    " checked"
                } else {
                    ""
                },
                escape(name)
            )
        })
        .collect::<String>();
    let scope_rows = scopes
        .iter()
        .filter(|v| v.as_str() != "project_read")
        .map(|scope| {
            let selected = presentation.retry.map_or_else(
                || {
                    !matches!(
                        scope.as_str(),
                        "destructive" | "inbox_private" | "my_pool_private"
                    )
                },
                |(form, _)| form.scope.contains(scope),
            );
            let checked = if selected { " checked" } else { "" };
            format!(
                "<label><input type=checkbox name=scope value=\"{}\"{}> <span>{}</span></label>",
                escape(scope),
                checked,
                escape(scope_label(scope))
            )
        })
        .collect::<String>();
    let destination = Url::parse(presentation.redirect)
        .map(|url| {
            if url.scheme() == "http" && loopback(&url) {
                format!(
                    "An app on this computer ({})",
                    &url[url::Position::BeforeHost..url::Position::AfterPort]
                )
            } else {
                format!("You will be sent to {}", url.origin().ascii_serialization())
            }
        })
        .unwrap_or_else(|_| presentation.redirect.to_owned());
    let destination = escape(&destination);
    let error = presentation
        .retry
        .map(|(_, error)| format!("<p class=warning role=alert>{}</p>", escape(error)))
        .unwrap_or_default();
    format!(
        include_str!("consent/page.html"),
        destination = destination,
        error = error,
        project_rows = project_rows,
        scope_rows = scope_rows,
        client = escape(client),
        display_name = escape(display_name),
        username = escape(username),
        request_id = escape(request_id)
    )
}

async fn consent_script() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        include_str!("consent/consent.js"),
    )
}

async fn consent_style() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        include_str!("consent/consent.css"),
    )
}

struct OAuthError {
    code: &'static str,
    status: StatusCode,
    description: String,
    retry_after: Option<u64>,
}
impl OAuthError {
    fn invalid(code: &'static str) -> Self {
        Self {
            code,
            status: StatusCode::BAD_REQUEST,
            description: code.replace('_', " "),
            retry_after: None,
        }
    }
    fn from_app(error: AppError, registration: bool) -> Self {
        let code = match &error {
            AppError::Unauthorized | AppError::Forbidden => "invalid_grant",
            AppError::Validation { field, .. }
                if registration && matches!(field.as_str(), "redirect_uri" | "redirect_uris") =>
            {
                "invalid_redirect_uri"
            }
            AppError::Validation { .. } if registration => "invalid_client_metadata",
            AppError::Validation { field, .. } if field == "scope" => "invalid_scope",
            AppError::Validation { field, .. } if field == "resource" => "invalid_target",
            AppError::Validation { field, .. } if field == "grant_type" => "unsupported_grant_type",
            AppError::Validation { field, .. } if field == "code_verifier" => "invalid_grant",
            AppError::Unavailable(_) | AppError::RateLimited { .. } => "temporarily_unavailable",
            _ if error.status().is_server_error() => "server_error",
            _ => "invalid_request",
        };
        let mut mapped = Self::invalid(code);
        if error.status().is_server_error() || matches!(error, AppError::RateLimited { .. }) {
            mapped.status = error.status();
            mapped.description = error.client_message();
            if let Some(reference) = error.log_server_error() {
                mapped
                    .description
                    .push_str(&format!(" (reference: {reference})"));
            }
        }
        mapped.retry_after = match error {
            AppError::RateLimited { retry_after } => Some(retry_after),
            AppError::Unavailable(_) => Some(1),
            _ => None,
        };
        mapped
    }
}
impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(serde_json::json!({
                "error": self.code, "error_description": self.description
            })),
        )
            .into_response();
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        if let Some(seconds) = self.retry_after {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                seconds.to_string().parse().expect("integer header"),
            );
        }
        response
    }
}
async fn register_client(
    State(state): State<AppState>,
    peer: OptionalPeer,
    headers: HeaderMap,
    request: Result<Json<RegistrationRequest>, axum::extract::rejection::JsonRejection>,
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
        .map_err(|e| OAuthError::from_app(e, true))
}
async fn token(
    State(state): State<AppState>,
    form: Result<Form<Vec<(String, String)>>, axum::extract::rejection::FormRejection>,
) -> Result<impl IntoResponse, OAuthError> {
    let form = form.map_err(|_| OAuthError::invalid("invalid_request"))?;
    let form = Form(
        resource_parameters::<TokenForm>(&state, form.0)
            .map_err(|e| OAuthError::from_app(e, false))?,
    );
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
        .await
        .map_err(|e| OAuthError::from_app(e, false))?;
    if !known {
        let mut error = OAuthError::invalid("invalid_client");
        error.status = StatusCode::UNAUTHORIZED;
        return Err(error);
    }
    token_inner(State(state), form)
        .await
        .map_err(|e| OAuthError::from_app(e, false))
}
async fn revoke(
    State(state): State<AppState>,
    form: Result<Form<RevokeForm>, axum::extract::rejection::FormRejection>,
) -> Result<impl IntoResponse, OAuthError> {
    let form = form.map_err(|_| OAuthError::invalid("invalid_request"))?;
    revoke_inner(State(state), form)
        .await
        .map_err(|e| OAuthError::from_app(e, false))
}
async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let result = match query {
        Ok(query) => match resource_parameters::<AuthorizationQuery>(&state, query.0) {
            Ok(query) => authorize_inner(State(state), headers, Query(query)).await,
            Err(error) => Err(error),
        },
        Err(_) => Err(AppError::validation(
            "request",
            "invalid authorization request",
        )),
    };
    match result {
        Ok(response) => response,
        Err(error) => {
            let mapped = OAuthError::from_app(error, false);
            (mapped.status, Html(format!("<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1><p>{}</p>", escape(&mapped.description)))).into_response()
        }
    }
}

// SQL is kept outside calls so rustfmt can format the surrounding control flow.
const SELECT_OAUTH_AUTHORIZATION_CODES_SQL: &str = "SELECT EXISTS(SELECT 1 FROM oauth_authorization_codes WHERE code_hash=?1 AND \
                     client_id=?2 AND redirect_uri=?3 AND resource=?4 AND code_challenge=?5 AND ((used_at IS NULL AND expires_at>?6) OR (used_at IS NOT NULL AND grant_id IS NOT NULL)))";
const INSERT_MCP_GRANTS_SQL: &str = "INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at,last_used_at)
                    VALUES(?1,?2,?3,?4,?5,?5,?6,?5)";
const SELECT_MCP_GRANTS_SQL: &str =
    "SELECT EXISTS(SELECT 1 FROM mcp_grants g JOIN users u ON u.id=g.user_id
            WHERE g.id=?1 AND g.revoked_at IS NULL AND g.expires_at>?2 AND u.is_active=1
              AND EXISTS(SELECT 1 FROM mcp_grant_projects WHERE grant_id=g.id)
              AND NOT EXISTS(
                SELECT 1 FROM mcp_grant_projects gp
                LEFT JOIN projects p ON p.id=gp.project_id AND p.deleted_at IS NULL
                LEFT JOIN project_memberships m ON m.project_id=gp.project_id AND m.user_id=u.id
                WHERE gp.grant_id=g.id AND (p.id IS NULL OR (u.is_admin=0 AND m.user_id IS NULL))
              ))";
const INSERT_MCP_TOKENS_SQL: &str = "INSERT INTO mcp_tokens(id,grant_id,family_id,kind,token_hash,issued_at,expires_at,last_used_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?6)";
const SELECT_PROJECTS_SQL: &str = "SELECT EXISTS(SELECT 1 FROM projects p JOIN users u ON u.id=?2 WHERE p.id=?1 AND \
                     p.deleted_at IS NULL AND u.is_active=1 AND (u.is_admin=1 OR EXISTS(SELECT 1 FROM \
                     project_memberships m WHERE m.project_id=p.id AND m.user_id=u.id)))";

// Like refresh, a code needs the account to be active now.
const SELECT_OAUTH_AUTHORIZATION_CODES_2_SQL: &str = "SELECT c.user_id,c.client_id,c.client_name,c.redirect_uri,c.resource,c.projects_json,c.scopes_json
             FROM oauth_authorization_codes c JOIN users u ON u.id=c.user_id
             WHERE c.code_hash=?1 AND c.used_at IS NULL AND c.expires_at>?2 AND u.is_active=1";
const SELECT_OAUTH_AUTHORIZATION_CODES_3_SQL: &str =
    "SELECT code_challenge FROM oauth_authorization_codes WHERE code_hash=?1";
const UPDATE_OAUTH_AUTHORIZATION_CODES_SQL: &str = "UPDATE oauth_authorization_codes SET used_at=?1,grant_id=?3 WHERE code_hash=?2 AND used_at IS NULL";
const INSERT_MCP_GRANT_PROJECTS_SQL: &str =
    "INSERT INTO mcp_grant_projects(grant_id,project_id) VALUES(?1,?2)";
const SELECT_MCP_TOKENS_SQL: &str = "SELECT EXISTS(SELECT 1 FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id WHERE \
                     t.token_hash=?1 AND t.kind='refresh' AND g.client_id=?2)";
const SELECT_MCP_TOKENS_2_SQL: &str =
    "SELECT t.id,t.grant_id,t.family_id,t.expires_at,t.last_used_at,t.rotated_to_id,t.revoked_at
             FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
             WHERE t.token_hash=?1 AND t.kind='refresh' AND g.client_id=?2";
const UPDATE_MCP_TOKENS_SQL: &str =
    "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE family_id=?2";
const UPDATE_MCP_GRANTS_SQL: &str = "UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,?1),updated_at=?1,\
                     revision=revision+1 WHERE id=?2";
const UPDATE_MCP_TOKENS_2_SQL: &str =
    "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE id=?2";
const UPDATE_MCP_TOKENS_3_SQL: &str =
    "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE family_id=?2";
const UPDATE_MCP_GRANTS_2_SQL: &str = "UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,?1),updated_at=?1,\
                     revision=revision+1 WHERE id=?2";
const UPDATE_MCP_TOKENS_4_SQL: &str = "UPDATE mcp_tokens SET revoked_at=?1,last_used_at=?1,rotated_to_id=?2 WHERE id=?3 AND \
                     revoked_at IS NULL";
const SELECT_MCP_GRANT_SCOPES_SQL: &str =
    "SELECT scope FROM mcp_grant_scopes WHERE grant_id=?1 ORDER BY scope";
const SELECT_PROJECTS_2_SQL: &str = "SELECT p.id,p.name FROM projects p WHERE p.deleted_at IS NULL
            AND (?1=1 OR EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=p.id AND m.user_id=?2)) ORDER BY p.name,p.id";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Config, Db,
        auth::{LoginResult, NewUser, create_user},
    };

    const CALLBACK: &str = "http://127.0.0.1/callback";
    const RESOURCE: &str = "https://tasks.example.test/mcp";

    #[tokio::test]
    async fn consent_from_a_session_revoked_after_sign_in_creates_no_code() {
        let root = tempfile::tempdir_in("target").unwrap();
        crate::db::migrate(root.path(), None).unwrap();
        let db = Db::open(root.path()).unwrap();
        let config = Config::from_os_iter([
            ("ONELOOP_PUBLIC_URL", "https://tasks.example.test"),
            ("ONELOOP_DATA_DIR", root.path().to_str().unwrap()),
        ])
        .unwrap();
        let state = AppState::new(config, db.clone());
        let user = NewUser {
            username: "owner".into(),
            display_name: "Owner".into(),
            password: "test-only-password-012345".into(),
            is_admin: true,
            must_change_password: false,
        };
        db.transaction(move |tx| create_user(tx, user, unix_now()?))
            .await
            .unwrap();
        let LoginResult::Authenticated(session) = state
            .auth
            .login(
                "owner",
                "test-only-password-012345",
                Default::default(),
                None,
            )
            .await
            .unwrap()
        else {
            panic!("the owner signs in");
        };
        let actor = session.actor;
        let request_id = "consent-request";
        let (hash, user_id, now) = (
            hash_token(request_id),
            actor.user_id.clone(),
            unix_now().unwrap(),
        );
        db.run(move |c| {
            c.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p1','One','ONE',1,1)", [])?;
            c.execute(
                "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at) VALUES('client','Client',?1,1)",
                [serde_json::json!([CALLBACK]).to_string()],
            )?;
            c.execute(
                "INSERT INTO oauth_authorization_requests(id,user_id,client_id,redirect_uri,resource,requested_scopes_json,code_challenge,created_at,expires_at)
                 VALUES(?1,?2,'client',?3,?4,'[\"project_read\"]','challenge',?5,?6)",
                params![hash, user_id, CALLBACK, RESOURCE, now, now + 600],
            )?;
            // A plain revocation, such as from another tab, commits after the
            // consent request was authenticated.
            c.execute("UPDATE sessions SET revoked_at=?1", [now])?;
            Ok(())
        })
        .await
        .unwrap();
        let form = ConsentForm {
            request_id: request_id.into(),
            decision: "allow".into(),
            project: vec!["p1".into()],
            scope: Vec::new(),
        };
        let stored = StoredAuthorizationRequest {
            user_id: actor.user_id.clone(),
            client_id: "client".into(),
            client_name: "Client".into(),
            redirect_uri: CALLBACK.into(),
            state: None,
            resource: RESOURCE.into(),
            requested_scopes: vec!["project_read".into()],
            challenge: "challenge".into(),
        };
        let result = approve_consent(&state, &actor, &form, &stored).await;
        assert!(matches!(result, Err(AppError::Unauthorized)), "{result:?}");
        let codes: i64 = db
            .run(|c| {
                Ok(
                    c.query_row("SELECT count(*) FROM oauth_authorization_codes", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(codes, 0);
    }
}
