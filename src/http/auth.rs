//! Account and session routes, and the middleware that turns a session
//! cookie into the request's `Actor`.
use super::input::{ApiJson, ApiQuery};
use std::net::SocketAddr;

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppError, AppResult, AppState,
    auth::{
        AccountSummary, AccountUpdate, Actor, ConnectedAppSummary, IssuedSession, LoginResult,
        SessionMetadata, SessionSummary,
    },
    clock::unix_now,
};

use super::security::{
    clear_session_cookie, client_ip, require_canonical_origin, session_cookie, session_token,
};

// Two passwords can each expand to six JSON bytes per input byte. Leave room
// for field names, the longest username/display name and session metadata.
const ACCOUNT_BODY_LIMIT: usize = 2 * 6 * crate::auth::password::MAX_PASSWORD_BYTES + 4096;

pub(crate) fn router() -> Router<AppState> {
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

pub(crate) fn users_router() -> Router<AppState> {
    Router::new()
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", patch(update_user))
        .route("/api/users/{id}/reset-password", post(reset_user_password))
        .layer(DefaultBodyLimit::max(ACCOUNT_BODY_LIMIT))
        .layer(middleware::from_fn(auth_no_store))
}

/// Checks the origin of every account route and signs in every one except
/// login and logout, which handle sessions themselves. Handlers take the
/// signed-in `Actor` from the request extensions.
pub(crate) async fn account_boundary(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> AppResult<Response> {
    require_canonical_origin(
        request.method(),
        request.headers(),
        &state.config.public_url,
    )?;
    if !matches!(request.uri().path(), "/api/auth/login" | "/api/auth/logout") {
        let actor = authenticate_headers(&state, request.headers(), true).await?;
        request.extensions_mut().insert(actor);
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

pub(crate) async fn require_actor(
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
    let meaningful = path != "/api/events" && !passive_resource;
    let actor = authenticate_headers(&state, request.headers(), meaningful).await?;
    actor.require_ready()?;
    request.extensions_mut().insert(actor);
    Ok(next.run(request).await)
}

/// `require_actor` for the HTML preview routes, whose answers show inside the
/// preview frame: someone signed out reads there that they must sign in again.
pub(crate) async fn require_actor_in_frame(
    state: State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    require_actor(state, request, next)
        .await
        .unwrap_or_else(super::file_response::html_preview_error)
}

pub(crate) async fn authenticate_headers(
    state: &AppState,
    headers: &HeaderMap,
    meaningful: bool,
) -> AppResult<Actor> {
    let actor = authenticate_cookie(state, headers, meaningful).await?;
    if names_another_person(headers, &actor) {
        return Err(AppError::Unauthorized);
    }
    Ok(actor)
}

async fn authenticate_cookie(
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
    state.auth.authenticate_session(&token, meaningful).await
}

/// The web client names the person its page shows. Tabs share the session
/// cookie, so after someone else signs in, a page still showing the person
/// before them must not read or write as the new person: its session ended.
fn names_another_person(headers: &HeaderMap, actor: &Actor) -> bool {
    headers
        .get("x-oneloop-user")
        .is_some_and(|user| user.as_bytes() != actor.user_id.as_bytes())
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
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<LoginRequest>,
) -> AppResult<Response> {
    let metadata = SessionMetadata {
        client_name: clean_metadata(request.client_name, 100),
        client_ip: client_ip(
            peer.map(|Extension(ConnectInfo(address))| address),
            &headers,
            &state.config.trusted_proxies,
        )
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
            let cookie = session_cookie_for(&state, &issued)?;
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
    match authenticate_cookie(&state, &headers, false).await {
        // A page still showing someone who signed out signs out only itself:
        // the cookie and the session belong to whoever signed in after them.
        Ok(actor) if names_another_person(&headers, &actor) => return Err(AppError::Unauthorized),
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

async fn me(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<AuthResponse>> {
    Ok(Json(auth_response(&state, &actor).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateMeRequest {
    display_name: String,
}

async fn update_me(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    ApiJson(request): ApiJson<UpdateMeRequest>,
) -> AppResult<Json<AuthResponse>> {
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
    Extension(actor): Extension<Actor>,
    ApiJson(request): ApiJson<ChangePasswordRequest>,
) -> AppResult<Response> {
    let issued = state
        .auth
        .change_password(&actor, &request.current_password, &request.new_password)
        .await?;
    let cookie = session_cookie_for(&state, &issued)?;
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
    Extension(actor): Extension<Actor>,
    ApiJson(request): ApiJson<PasswordRequest>,
) -> AppResult<Response> {
    let issued = state
        .auth
        .recent_authenticate(&actor, &request.password)
        .await?;
    let cookie = session_cookie_for(&state, &issued)?;
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
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<SessionsResponse>> {
    let sessions = state.auth.list_sessions(&actor).await?;
    Ok(Json(SessionsResponse { sessions }))
}

async fn revoke_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Extension(actor): Extension<Actor>,
) -> AppResult<StatusCode> {
    state.auth.revoke_session(&actor, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_other_sessions(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<RevokedResponse>> {
    let revoked = state.auth.revoke_other_sessions(&actor).await?;
    Ok(Json(RevokedResponse { revoked }))
}

async fn connected_apps(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<ConnectedAppsResponse>> {
    let apps = state.auth.list_connected_apps(&actor).await?;
    Ok(Json(ConnectedAppsResponse { apps }))
}

async fn revoke_connected_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Extension(actor): Extension<Actor>,
) -> AppResult<StatusCode> {
    state.auth.revoke_connected_app(&actor, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthResponse {
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
    let mut response = AuthResponse::from(actor);
    response.user.avatar_url = state.auth.avatar_url(&actor.user_id).await?;
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
    Extension(actor): Extension<Actor>,
    ApiQuery(query): ApiQuery<UsersQuery>,
) -> AppResult<Json<UsersResponse>> {
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
    Extension(actor): Extension<Actor>,
    ApiJson(request): ApiJson<CreateUserRequest>,
) -> AppResult<(StatusCode, Json<CreatedUserResponse>)> {
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
    Extension(actor): Extension<Actor>,
    ApiJson(request): ApiJson<UpdateUserRequest>,
) -> AppResult<Json<AccountSummary>> {
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
    Extension(actor): Extension<Actor>,
) -> AppResult<Json<TemporaryPasswordResponse>> {
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

/// The cookie for a session that was just issued, valid until the session ends.
fn session_cookie_for(state: &AppState, issued: &IssuedSession) -> AppResult<HeaderValue> {
    let max_age = issued
        .absolute_expires_at
        .saturating_sub(unix_now()?)
        .max(0);
    session_cookie(&state.config.public_url, &issued.token, max_age)
}

fn clean_metadata(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.chars().take(max_chars).collect())
    })
}
