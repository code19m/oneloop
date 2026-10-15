//! The OAuth authorization server for MCP clients: discovery, client
//! registration, the Connect page and tokens. `auth` stores grants and tokens.

mod authorize;
mod consent_page;
mod register;
mod token;

use std::collections::BTreeSet;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{StatusCode, header},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use url::Url;

use super::{client_metadata, cors};
use crate::{
    AppError, AppResult, AppState, access::McpScope, auth::token::hash as hash_token,
    clock::unix_now, config::is_loopback, http::security::escape_html,
};

use authorize::{authorize, consent};
use consent_page::{consent_script, consent_style};
use register::register_client;
use token::{revoke, token};

pub(super) fn router(state: &AppState) -> Router<AppState> {
    // These use no cookies, so any page may call them (see `cors`).
    let public = Router::new()
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
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke))
        .layer(middleware::from_fn(cors::any_origin));
    let registration = Router::new()
        .route(
            "/oauth/register",
            post(register_client).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors::listed_origins,
        ));
    Router::new()
        .route("/oauth/authorize", get(authorize).post(consent))
        .route("/mcp/assets/consent.js", get(consent_script))
        .route("/mcp/assets/consent.css", get(consent_style))
        .merge(public)
        .merge(registration)
}

#[derive(Serialize)]
struct ProtectedResourceMetadata {
    resource: String,
    authorization_servers: Vec<String>,
    scopes_supported: [McpScope; McpScope::ALL.len()],
    bearer_methods_supported: [&'static str; 1],
}

async fn protected_resource_metadata(
    State(state): State<AppState>,
) -> Json<ProtectedResourceMetadata> {
    Json(ProtectedResourceMetadata {
        resource: resource_url(&state),
        authorization_servers: vec![issuer(&state)],
        scopes_supported: McpScope::ALL,
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
    scopes_supported: [McpScope; McpScope::ALL.len()],
    authorization_response_iss_parameter_supported: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    client_id_metadata_document_supported: bool,
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
        scopes_supported: McpScope::ALL,
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: state.client_documents.enabled(),
    })
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

fn redirect_matches(registered: &str, requested: &str) -> bool {
    let (Ok(mut registered), Ok(mut requested)) = (Url::parse(registered), Url::parse(requested))
    else {
        return false;
    };
    if registered.scheme() == "http"
        && requested.scheme() == "http"
        && is_loopback(&registered)
        && is_loopback(&requested)
    {
        let _ = registered.set_port(None);
        let _ = requested.set_port(None);
    }
    registered == requested
}

/// Checks a callback: `https`, loopback `http`, or a scheme an admin listed
/// in `ONELOOP_MCP_REDIRECT_SCHEMES` for apps that receive their own links.
pub(super) fn validate_redirect_uri(value: &str, schemes: &[String]) -> AppResult<String> {
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
        "http" => is_loopback(&url),
        scheme => !url.cannot_be_a_base() && schemes.iter().any(|listed| listed == scheme),
    };
    if !safe {
        return Err(AppError::validation(
            "redirect_uris",
            if schemes.is_empty() {
                "must use HTTPS or loopback HTTP"
            } else {
                "must use HTTPS, loopback HTTP or an allowed app scheme"
            },
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

pub(super) fn validate_client_uri(value: &str) -> AppResult<String> {
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

fn issuer(state: &AppState) -> String {
    state.config.base_url().to_owned()
}
fn resource_url(state: &AppState) -> String {
    format!("{}/mcp", issuer(state))
}

/// An error in the protocol's shape. The endpoints name the code for a
/// mistake in the request, such as `invalid_scope`; other errors convert by
/// their kind.
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

    /// The error as the authorization page shows it to a person.
    fn page(self) -> Response {
        let page = Html(format!(
            "<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1><p>{}</p>",
            escape_html(&self.description)
        ));
        self.respond(page)
    }

    fn respond(self, body: impl IntoResponse) -> Response {
        let mut response = (self.status, body).into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.into());
        }
        response
    }
}
impl From<AppError> for OAuthError {
    fn from(error: AppError) -> Self {
        let code = match &error {
            AppError::Unauthorized | AppError::Forbidden => "invalid_grant",
            AppError::Unavailable(_) | AppError::RateLimited { .. } => "temporarily_unavailable",
            _ if error.status().is_server_error() => "server_error",
            _ => "invalid_request",
        };
        let mut mapped = Self::invalid(code);
        if error.status().is_server_error() || matches!(error, AppError::RateLimited { .. }) {
            mapped.status = error.status();
            mapped.description = error.reported_message().0;
        }
        mapped.retry_after = error.retry_after();
        mapped
    }
}
impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({
            "error": self.code, "error_description": &self.description
        }));
        let mut response = self.respond(body);
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        response
    }
}
