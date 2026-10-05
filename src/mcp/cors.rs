//! Cross-origin access for MCP clients that run in a web page.
//!
//! oneloop never allows credentials across origins, so browsers send no
//! cookies with these requests: a page can use only the codes and tokens it
//! already holds. OAuth metadata, the token endpoint and revocation answer
//! every origin. Registration, `/mcp` and its file transfers answer only the
//! origins in `ONELOOP_MCP_ALLOWED_ORIGINS`; registration and rmcp also
//! refuse requests from other pages.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::AppState;

const PUBLIC_METHODS: &str = "GET, POST";
const LISTED_METHODS: &str = "GET, POST, PUT, DELETE";
const ALLOWED_HEADERS: &str =
    "authorization, content-type, last-event-id, mcp-protocol-version, mcp-session-id";
const EXPOSED_HEADERS: &str = "mcp-session-id, retry-after, www-authenticate";
const PREFLIGHT_SECONDS: &str = "600";

/// Whether the request comes from a page whose origin an admin listed.
pub(super) fn listed_origin(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|origin| origin.to_str().ok())
        .is_some_and(|origin| {
            state
                .config
                .mcp_allowed_origins
                .iter()
                .any(|listed| listed == origin)
        })
}

/// For endpoints that any page may call.
pub(super) async fn any_origin(request: Request<Body>, next: Next) -> Response {
    if is_preflight(&request) {
        return preflight(HeaderValue::from_static("*"), PUBLIC_METHODS);
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSED_HEADERS),
    );
    response
}

/// For endpoints that only listed pages may call. A preflight is answered
/// before authentication, so a page can learn that it must sign in.
pub(super) async fn listed_origins(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let origin = listed_origin(&state, request.headers())
        .then(|| request.headers().get(header::ORIGIN).cloned())
        .flatten();
    if is_preflight(&request) {
        let mut response = match origin {
            Some(origin) => preflight(origin, LISTED_METHODS),
            None => StatusCode::FORBIDDEN.into_response(),
        };
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("origin"));
        return response;
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("origin"));
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(EXPOSED_HEADERS),
        );
    }
    response
}

fn is_preflight(request: &Request<Body>) -> bool {
    request.method() == Method::OPTIONS
        && request.headers().contains_key(header::ORIGIN)
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
}

fn preflight(origin: HeaderValue, methods: &'static str) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(methods),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOWED_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(PREFLIGHT_SECONDS),
    );
    response
}
