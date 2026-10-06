//! Application composition for the shared browser and MCP services. Transport adapters never bypass domain authorization or validation.

#![warn(unreachable_pub)]

mod access;
pub mod auth;
pub mod cli;
mod clock;
pub mod collaboration;
pub mod config;
pub mod db;
pub mod domain;
pub mod error;
pub mod files;
pub mod http;
mod idempotency;
pub mod knowledge;
mod legacy_values;
pub mod mcp;
pub mod retention;
pub mod runtime;
pub mod state;
#[cfg(test)]
mod test_memory;
mod text;
pub mod timezone;

pub mod build_info {
    include!(concat!(env!("OUT_DIR"), "/build_info.rs"));
}

pub use config::Config;
pub use db::Db;
pub use error::{AppError, AppResult};
pub use state::AppState;

use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    middleware,
    routing::{get, post},
};
use serde::Serialize;

pub struct Application {
    pub router: Router,
    pub collaboration: collaboration::CollaborationRuntime,
    pub files: files::FileService,
    pub knowledge: knowledge::KnowledgeService,
}

pub fn application(state: AppState) -> Application {
    let collaboration = state.collaboration_runtime.clone();
    let files = state.files.clone();
    let knowledge = state.knowledge.clone();
    let work = http::domain::read_router()
        .route("/api/commands", post(http::commands::execute))
        .merge(http::files::router())
        .merge(http::knowledge::router())
        .nest("/api", http::collaboration::router())
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            http::auth::require_actor,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            http::security::enforce_browser_origin,
        ));
    let account = Router::new()
        .nest("/api/auth", http::auth::router())
        .merge(http::auth::users_router())
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            http::auth::account_boundary,
        ));
    let router = Router::new()
        .route("/healthz", get(health))
        .merge(account)
        .merge(work)
        .merge(mcp::router(state.clone()))
        .fallback(http::assets::serve)
        .layer(DefaultBodyLimit::max(256 * 1024))
        // Inside the layers below, so a 408 gets the usual headers and request ID.
        .layer(middleware::from_fn(http::server::pace_request_body))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            http::security::enforce_host,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            http::security::add_main_security_headers,
        ))
        .layer(middleware::from_fn(request_span))
        .with_state(state);
    Application {
        router,
        collaboration,
        files,
        knowledge,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    status: &'static str,
    version: &'static str,
    revision: &'static str,
    schema_version: i64,
}

async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> AppResult<Json<Health>> {
    state
        .db
        .run(|connection| {
            connection.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
        .await?;
    Ok(Json(Health {
        status: "ok",
        version: build_info::VERSION,
        revision: build_info::REVISION,
        schema_version: db::CURRENT_SCHEMA_VERSION,
    }))
}

async fn request_span(
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    use tracing::Instrument;
    // Generate our own identifier: untrusted headers cannot inject log fields.
    let request_id = uuid::Uuid::now_v7().to_string();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map_or("<unmatched>", |path| path.as_str());
    let span = tracing::error_span!("request", %request_id, method = %request.method(), route);
    let mut response = next.run(request).instrument(span).await;
    response.headers_mut().insert(
        "x-request-id",
        request_id.parse().expect("UUID is a header value"),
    );
    response
}
