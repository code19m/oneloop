//! The MCP routes: the stateless endpoint at `/mcp` with bearer-token
//! authentication, the OAuth server and the file transfer routes.
pub(crate) mod client_metadata;
mod cors;
mod oauth;
mod tools;
mod transfer;

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, session::never::NeverSessionManager, tower::StreamableHttpService,
};

use crate::{AppError, AppState};

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
    // The handler holds no per-request state, and building its tool router
    // generates every schema, so each request gets a clone.
    let handler = OneloopMcp::new(state.clone());
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([host, authority])
        .with_allowed_origins(origins)
        .with_json_response(true)
        .with_legacy_session_mode(false)
        .with_max_request_body_bytes(1024 * 1024);
    let service = StreamableHttpService::new(
        move || Ok(handler.clone()),
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
    oauth::router(&state)
        .merge(transport)
        .merge(transfer::router(&state))
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
        state.config.base_url()
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
