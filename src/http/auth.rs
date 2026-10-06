use super::input::{ApiJson, ApiQuery};
use std::{convert::Infallible, net::SocketAddr};

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path, State},
    http::{HeaderMap, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppError, AppResult, AppState,
    auth::{
        AccountSummary, AccountUpdate, Actor, ConnectedAppSummary, LoginResult, SessionMetadata,
        SessionSummary, unix_now,
    },
};

use super::security::{
    clear_session_cookie, client_ip, require_canonical_origin, session_cookie, session_token,
};

// Two passwords can each expand to six JSON bytes per input byte. Leave room
// for field names, the longest username/display name and session metadata.
const ACCOUNT_BODY_LIMIT: usize = 2 * 6 * crate::auth::password::MAX_PASSWORD_BYTES + 4096;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me).patch(update_me))
        .route("/change-password", post(change_password))
        .route("/recent-auth", post(recent_auth))
        .route("/sessions", get(sessions))
        .route("/sessions/{id}", delete(revoke_session))
        .route("/sessions/revoke-others", post(revoke_other_sessions))
        .route("/apps", get(connected_apps))
        .route("/apps/{id}", delete(revoke_connected_app))
        .layer(DefaultBodyLimit::max(ACCOUNT_BODY_LIMIT))
        .layer(middleware::from_fn(auth_no_store))
}

pub fn users_router() -> Router<AppState> {
    Router::new()
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", patch(update_user))
        .route("/api/users/{id}/reset-password", post(reset_user_password))
        .layer(DefaultBodyLimit::max(ACCOUNT_BODY_LIMIT))
        .layer(middleware::from_fn(auth_no_store))
}

pub async fn account_boundary(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> AppResult<Response> {
    require_canonical_origin(
        request.method(),
        request.headers(),
        &state.config.public_url,
    )?;
    if !matches!(request.uri().path(), "/api/auth/login" | "/api/auth/logout") {
        let actor = authenticate_headers(&state, request.headers(), false).await?;
        if request.uri().path().starts_with("/api/users") {
            actor.require_admin()?;
        }
    }
    Ok(next.run(request).await)
}

async fn auth_no_store(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

pub async fn require_actor(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> AppResult<Response> {
    let path = request.uri().path();
    let destination = request
        .headers()
        .get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok());
    // Background rerenders may fetch avatars/thumbnails/iframes without an API
    // client header. Those subresources must not keep an unattended session alive.
    let passive_resource = matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) && ((path.starts_with("/api/users/") && path.ends_with("/avatar"))
        || ((path.starts_with("/api/attachments/")
            || (path.starts_with("/api/projects/") && path.contains("/knowledge/")))
            && matches!(destination, Some("image" | "iframe"))));
    let meaningful = path != "/api/events"
        && !passive_resource
        && request
            .headers()
            .get("x-oneloop-background")
            .and_then(|value| value.to_str().ok())
            != Some("1");
    let actor = authenticate_headers(&state, request.headers(), meaningful).await?;
    actor.require_ready()?;
    request.extensions_mut().insert(actor);
    Ok(next.run(request).await)
}

pub async fn authenticate_headers(
    state: &AppState,
    headers: &HeaderMap,
    meaningful: bool,
) -> AppResult<Actor> {
    let token = session_token(headers, &state.config.public_url).ok_or(AppError::Unauthorized)?;
    let meaningful = meaningful
        && headers
            .get("x-oneloop-background")
            .and_then(|value| value.to_str().ok())
            != Some("1");
    let actor = state.auth.authenticate_session(&token, meaningful).await?;
    // The web client names the person its page shows. Tabs share the session
    // cookie, so after someone else signs in, a page still showing the person
    // before them must not read or write as the new person: its session ended.
    if headers
        .get("x-oneloop-user")
        .is_some_and(|user| user.as_bytes() != actor.user_id.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(actor)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginRequest {
    username: String,
    password: String,
    #[serde(default)]
    revoke_session_id: Option<String>,
    #[serde(default)]
    client_name: Option<String>,
}

async fn login(
    State(state): State<AppState>,
    OptionalPeer(peer): OptionalPeer,
    headers: HeaderMap,
    ApiJson(request): ApiJson<LoginRequest>,
) -> AppResult<Response> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let metadata = SessionMetadata {
        client_name: clean_metadata(request.client_name, 100),
        client_ip: client_ip(peer, &headers, &state.config.trusted_proxies)
            .map(|value| value.to_string()),
        user_agent: clean_metadata(
            headers
                .get(header::USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            512,
        ),
    };
    match state
        .auth
        .login(
            &request.username,
            &request.password,
            metadata,
            request.revoke_session_id,
        )
        .await?
    {
        LoginResult::Authenticated(issued) => {
            let cookie = session_cookie(
                &state.config.public_url,
                &issued.token,
                issued
                    .absolute_expires_at
                    .saturating_sub(unix_now()?)
                    .max(0),
            )?;
            let body = Json(auth_response(&state, &issued.actor).await?);
            Ok(([(header::SET_COOKIE, cookie)], body).into_response())
        }
        LoginResult::SessionLimit { sessions } => Ok((
            StatusCode::CONFLICT,
            Json(SessionLimitResponse {
                error: SessionLimitError {
                    code: "session_limit",
                    message: "Choose an existing session to revoke before signing in".into(),
                    details: SessionLimitDetails {
                        sessions,
                        time_zone: state.config.timezone.name().to_owned(),
                    },
                },
            }),
        )
            .into_response()),
    }
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    match authenticate_headers(&state, &headers, false).await {
        Ok(actor) => state.auth.logout(&actor).await?,
        Err(AppError::Unauthorized) => {}
        Err(error) => return Err(error),
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            clear_session_cookie(&state.config.public_url),
        )],
    )
        .into_response())
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<AuthResponse>> {
    let actor = authenticate_headers(&state, &headers, true).await?;
    Ok(Json(auth_response(&state, &actor).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateMeRequest {
    display_name: String,
}

async fn update_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<UpdateMeRequest>,
) -> AppResult<Json<AuthResponse>> {
    require_canonical_origin(
        &axum::http::Method::PATCH,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let actor = state
        .auth
        .update_profile(&actor, &request.display_name)
        .await?;
    Ok(Json(auth_response(&state, &actor).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<ChangePasswordRequest>,
) -> AppResult<Response> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let issued = state
        .auth
        .change_password(&actor, &request.current_password, &request.new_password)
        .await?;
    let cookie = session_cookie(
        &state.config.public_url,
        &issued.token,
        issued
            .absolute_expires_at
            .saturating_sub(unix_now()?)
            .max(0),
    )?;
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(auth_response(&state, &issued.actor).await?),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PasswordRequest {
    password: String,
}

async fn recent_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<PasswordRequest>,
) -> AppResult<Response> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let issued = state
        .auth
        .recent_authenticate(&actor, &request.password)
        .await?;
    let cookie = session_cookie(
        &state.config.public_url,
        &issued.token,
        issued
            .absolute_expires_at
            .saturating_sub(unix_now()?)
            .max(0),
    )?;
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(RecentAuthResponse {
            authenticated_at: issued.actor.authenticated_at,
        }),
    )
        .into_response())
}

async fn sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<SessionsResponse>> {
    let actor = authenticate_headers(&state, &headers, true).await?;
    let sessions = state.auth.list_sessions(&actor).await?;
    Ok(Json(SessionsResponse { sessions }))
}

async fn revoke_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    require_canonical_origin(
        &axum::http::Method::DELETE,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    state.auth.revoke_session(&actor, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_other_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<RevokedResponse>> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let revoked = state.auth.revoke_other_sessions(&actor).await?;
    Ok(Json(RevokedResponse { revoked }))
}

async fn connected_apps(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<ConnectedAppsResponse>> {
    let actor = authenticate_headers(&state, &headers, true).await?;
    let apps = state.auth.list_connected_apps(&actor).await?;
    Ok(Json(ConnectedAppsResponse { apps }))
}

async fn revoke_connected_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    require_canonical_origin(
        &axum::http::Method::DELETE,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    state.auth.revoke_connected_app(&actor, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    user: AuthUserResponse,
    session_id: String,
    authenticated_at: i64,
    must_change_password: bool,
}

impl From<&Actor> for AuthResponse {
    fn from(actor: &Actor) -> Self {
        Self {
            user: AuthUserResponse {
                id: actor.user_id.clone(),
                username: actor.username.clone(),
                display_name: actor.display_name.clone(),
                is_admin: actor.is_admin,
                avatar_url: None,
            },
            session_id: actor.session_id().unwrap_or_default().to_owned(),
            authenticated_at: actor.authenticated_at,
            must_change_password: actor.must_change_password,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthUserResponse {
    id: String,
    username: String,
    display_name: String,
    is_admin: bool,
    avatar_url: Option<String>,
}

async fn auth_response(state: &AppState, actor: &Actor) -> AppResult<AuthResponse> {
    let user_id = actor.user_id.clone();
    let avatar = state
        .db
        .run(move |connection| {
            let blob: Option<String> = connection.query_row(
                "SELECT avatar_blob_id FROM users WHERE id=?1",
                [&user_id],
                |row| row.get(0),
            )?;
            Ok(blob.map(|blob| format!("/api/users/{user_id}/avatar?v={blob}")))
        })
        .await?;
    let mut response = AuthResponse::from(actor);
    response.user.avatar_url = avatar;
    Ok(response)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentAuthResponse {
    authenticated_at: i64,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<SessionSummary>,
}

#[derive(Serialize)]
struct RevokedResponse {
    revoked: u64,
}
#[derive(Serialize)]
struct ConnectedAppsResponse {
    apps: Vec<ConnectedAppSummary>,
}

#[derive(Serialize)]
struct SessionLimitResponse {
    error: SessionLimitError,
}
#[derive(Serialize)]
struct SessionLimitError {
    code: &'static str,
    message: String,
    details: SessionLimitDetails,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionLimitDetails {
    sessions: Vec<SessionSummary>,
    time_zone: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsersQuery {
    after_username: Option<String>,
}

async fn list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<UsersQuery>,
) -> AppResult<Json<UsersResponse>> {
    let actor = authenticate_headers(&state, &headers, true).await?;
    let (users, next_cursor) = state
        .auth
        .list_accounts(&actor, query.after_username.as_deref())
        .await?;
    Ok(Json(UsersResponse { users, next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateUserRequest {
    username: String,
    display_name: String,
    #[serde(default)]
    is_admin: bool,
}

async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<CreateUserRequest>,
) -> AppResult<(StatusCode, Json<CreatedUserResponse>)> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let created = state
        .auth
        .create_account(
            &actor,
            &request.username,
            &request.display_name,
            request.is_admin,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedUserResponse {
            user: created.user,
            temporary_password: created.temporary_password,
        }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateUserRequest {
    display_name: String,
    is_admin: bool,
    is_active: bool,
    expected_revision: i64,
}

async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<UpdateUserRequest>,
) -> AppResult<Json<AccountSummary>> {
    require_canonical_origin(
        &axum::http::Method::PATCH,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let user = state
        .auth
        .update_account(
            &actor,
            &id,
            AccountUpdate {
                display_name: request.display_name,
                is_admin: request.is_admin,
                is_active: request.is_active,
                expected_revision: request.expected_revision,
            },
        )
        .await?;
    Ok(Json(user))
}

async fn reset_user_password(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<TemporaryPasswordResponse>> {
    require_canonical_origin(
        &axum::http::Method::POST,
        &headers,
        &state.config.public_url,
    )?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    let temporary_password = state.auth.reset_account_password(&actor, &id).await?;
    Ok(Json(TemporaryPasswordResponse { temporary_password }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsersResponse {
    users: Vec<AccountSummary>,
    next_cursor: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedUserResponse {
    user: AccountSummary,
    temporary_password: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryPasswordResponse {
    temporary_password: String,
}

fn clean_metadata(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.chars().take(max_chars).collect())
    })
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
                .map(|value| value.0),
        ))
    }
}
