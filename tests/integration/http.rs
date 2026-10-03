use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use oneloop::{
    AppState, Db, application, auth::unix_now, http::security::require_canonical_origin,
};
use proptest::prelude::*;
use serde_json::{Value, json};
use sha2::Digest;
use tempfile::TempDir;
use tower::ServiceExt;

use crate::support;
use crate::support::http::{body_bytes, body_json, body_text};

async fn fixture() -> (TempDir, Router, String) {
    let support::TestInstance {
        root: directory,
        db,
        owner: session,
    } = support::TestInstance::new().await;
    let config = support::config(
        directory.path(),
        "http://127.0.0.1:8080",
        &[("ONELOOP_TIMEZONE", "Asia/Tashkent")],
    );
    (
        directory,
        application(AppState::new(config, db)).router,
        session.token,
    )
}

#[tokio::test]
async fn serves_frontend_tree_and_excludes_development_files() {
    let (_directory, app, _token) = fixture().await;
    let response = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let policy = response.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    assert!(policy.contains("script-src 'self'"));
    assert!(!policy.contains("script-src 'self' 'unsafe-inline'"));
    let body = body_bytes(response).await;
    let html = std::str::from_utf8(&body).unwrap();
    assert!(html.contains("/src/app/main.js"));
    assert!(!html.contains("data.js"));
    for path in [
        "/package.json",
        "/README.md",
        "/tests/support/dom.cjs",
        "/tests/support/fixtures/fixture.json",
        "/vendor/katex/fonts/KaTeX_Main-Regular.ttf",
        "/vendor/katex/fonts/KaTeX_Main-Regular.woff",
        "/vendor/pdfjs/README.md",
        "/vendor/mermaid/package-lock.json",
        "/vendor/github-markdown-css/light.css",
        "/vendor/github-markdown-css/dark.css",
        "/vendor/cdn-assets/light.css",
        "/vendor/cdn-assets/dark.css",
        "/assets/recovery.js",
        "/assets/samples/markdown/01-markdown-basics.md",
        "/api/unknown",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("accept", "text/html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    for path in [
        "/views/app.js",
        "/views/collaboration.js",
        "/vendor/pdfjs/pdf.mjs",
        "/vendor/pdfjs/pdf.worker.mjs",
        "/vendor/pdfjs/cmaps/RKSJ-H.bcmap",
        "/vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
        "/vendor/katex/fonts/KaTeX_Main-Regular.woff2",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "required preview/renderer asset {path}"
        );
        assert!(!body_bytes(response).await.is_empty(), "{path}");
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/src/data/api-client.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
}

#[tokio::test]
async fn distribution_notices_are_embedded_as_plain_text() {
    let (_directory, app, _token) = fixture().await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/THIRD_PARTY_NOTICES.md")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/plain")
    );
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let body = body_bytes(response).await;
    let text = std::str::from_utf8(&body).unwrap();
    // A Rust crate, an EPL text from the Mermaid bundle and a vendored stylesheet's copyright.
    for expected in ["rmcp@", "Eclipse Public License", "Sindre Sorhus"] {
        assert!(text.contains(expected), "{expected}");
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/THIRD_PARTY_NOTICES.md")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-length"],
        body.len().to_string().as_str()
    );
    assert!(body_bytes(response).await.is_empty());
}

#[tokio::test]
async fn asset_revalidation_and_head_do_not_return_stale_bodies() {
    let (_directory, app, _token) = fixture().await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/views/theme.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tag = response.headers()["etag"].clone();
    assert_eq!(response.headers()["vary"], "Accept-Encoding");
    let original = body_bytes(response).await;
    let expected_tag = format!("\"{}\"", hex::encode(sha2::Sha256::digest(&original)));
    assert_eq!(tag.to_str().unwrap(), expected_tag);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/views/theme.js")
                .header("if-none-match", tag.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert!(body_bytes(response).await.is_empty());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/views/theme.js")
                .header("if-none-match", format!("W/{}", tag.to_str().unwrap()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(response.headers()["vary"], "Accept-Encoding");
    let response = app
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/views/theme.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body_bytes(response).await.is_empty());
}

#[tokio::test]
async fn composed_commands_enforce_auth_origin_and_idempotency() {
    let (_directory, app, token) = fixture().await;
    let input = json!({"operation":"project.create","payload":{"name":"Test project","taskPrefix":"TST"},"idempotencyKey":"http-project-create"});
    let make = |with_cookie: bool, with_origin: bool| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/commands")
            .header("content-type", "application/json");
        if with_cookie {
            request = request.header("cookie", format!("oneloop_session={token}"));
        }
        if with_origin {
            request = request.header("origin", "http://127.0.0.1:8080");
        }
        request.body(Body::from(input.to_string())).unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(make(false, true))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(make(true, false))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let first = app.clone().oneshot(make(true, true)).await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first: Value = body_json(first).await;
    assert_eq!(first["replayed"], false);
    let second = app.clone().oneshot(make(true, true)).await.unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second: Value = body_json(second).await;
    assert_eq!(second["replayed"], true);
    assert_eq!(first["entities"], second["entities"]);
    let bootstrap = app
        .oneshot(
            Request::builder()
                .uri("/api/bootstrap")
                .header("cookie", format!("oneloop_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::OK);
    let bootstrap: Value = body_json(bootstrap).await;
    assert_eq!(bootstrap["projects"].as_array().unwrap().len(), 1);
    assert_eq!(bootstrap["timeZone"], "Asia/Tashkent");
}

#[tokio::test]
async fn automatic_media_reads_do_not_keep_an_unattended_session_alive() {
    let (directory, app, token) = fixture().await;
    let db = Db::open(directory.path()).unwrap();
    let before = unix_now().unwrap() - 3600;
    db.run(move |connection| {
        connection.execute("UPDATE sessions SET last_activity_at=?1", [before])?;
        Ok(())
    })
    .await
    .unwrap();
    for (path, destination) in [
        ("/api/users/missing/avatar", None),
        ("/api/attachments/missing/content", Some("image")),
        ("/api/attachments/missing/preview/html", Some("iframe")),
    ] {
        let mut request = Request::builder()
            .uri(path)
            .header("cookie", format!("oneloop_session={token}"));
        if let Some(destination) = destination {
            request = request.header("sec-fetch-dest", destination);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let last = db
            .run(|connection| {
                Ok(
                    connection.query_row("SELECT last_activity_at FROM sessions", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(last, before, "passive fetch {path}");
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/bootstrap")
                .header("cookie", format!("oneloop_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let after = db
        .run(|connection| {
            Ok(
                connection.query_row("SELECT last_activity_at FROM sessions", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert!(after > before);
}

#[tokio::test]
async fn malformed_requests_have_field_errors_after_origin_and_authentication() {
    let (_directory, app, token) = fixture().await;
    for (path, method, origin, authenticated, body, expected, field) in [
        (
            "/api/auth/login",
            "POST",
            "http://127.0.0.1:8080",
            false,
            r#"{"username":"owner"}"#,
            400,
            Some("password"),
        ),
        ("/api/auth/login", "POST", "null", false, "{", 403, None),
        (
            "/api/users",
            "POST",
            "http://127.0.0.1:8080",
            false,
            "{",
            401,
            None,
        ),
        (
            "/api/auth/me",
            "PATCH",
            "https://foreign.example",
            true,
            "{",
            403,
            None,
        ),
        (
            "/api/users",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"{"username":1}"#,
            400,
            Some("username"),
        ),
        (
            "/api/commands",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"{"operation":"task.create","payload":{},"idempotencyKey":"x","idempotencyKey":"y"}"#,
            400,
            Some("idempotencyKey"),
        ),
        (
            "/api/commands",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"{"operation":"task.create","payload":{}}"#,
            400,
            Some("idempotencyKey"),
        ),
        (
            "/api/commands",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"{"operation":"not.real","payload":{},"idempotencyKey":"x"}"#,
            400,
            Some("operation"),
        ),
        (
            "/api/commands",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"["task.create",{},"x"]"#,
            400,
            Some("body"),
        ),
        (
            "/api/commands",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"{"operation":"task.create","payload":[],"idempotencyKey":"x"}"#,
            400,
            Some("payload"),
        ),
        (
            "/api/commands",
            "POST",
            "http://127.0.0.1:8080",
            true,
            r#"{"operation":"task.create","payload":{"projectId":7},"idempotencyKey":"x"}"#,
            400,
            Some("projectId"),
        ),
        (
            "/api/projects/absent/board?limit=oops",
            "GET",
            "http://127.0.0.1:8080",
            true,
            "",
            400,
            Some("limit"),
        ),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Origin", origin)
            .header("Content-Type", "APPLICATION/EXAMPLE+JSON");
        if authenticated {
            request = request.header("Cookie", format!("oneloop_session={token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected, "{path} {body}");
        let body: Value = body_json(response).await;
        if let Some(field) = field {
            assert_eq!(body["error"]["code"], "validation_failed", "{body}");
            assert_eq!(body["error"]["details"]["field"], field, "{body}");
        }
        assert!(!body.to_string().contains("unknown variant"));
    }
}

// Keep this inventory in sync with router declarations. Native OAuth/MCP writes
// intentionally have their own credential/origin policy, not browser-cookie CSRF.
const BROWSER_ROUTES: &[(&str, &str, bool)] = &[
    ("POST", "/api/auth/login", true),
    ("POST", "/api/auth/logout", true),
    ("GET", "/api/auth/me", false),
    ("PATCH", "/api/auth/me", false),
    ("POST", "/api/auth/change-password", false),
    ("POST", "/api/auth/recent-auth", false),
    ("GET", "/api/auth/sessions", false),
    ("DELETE", "/api/auth/sessions/missing", false),
    ("POST", "/api/auth/sessions/revoke-others", false),
    ("GET", "/api/auth/apps", false),
    ("DELETE", "/api/auth/apps/missing", false),
    ("GET", "/api/users", false),
    ("POST", "/api/users", false),
    ("PATCH", "/api/users/missing", false),
    ("POST", "/api/users/missing/reset-password", false),
    ("POST", "/api/commands", false),
    ("GET", "/api/bootstrap", false),
    ("GET", "/api/projects/missing/board?status=planning", false),
    ("GET", "/api/projects/missing/board-view", false),
    ("GET", "/api/projects/missing/counts", false),
    ("GET", "/api/projects/missing/roadmap", false),
    ("GET", "/api/projects/missing/pool?scope=personal", false),
    ("GET", "/api/epics/missing/tasks", false),
    ("GET", "/api/epics/missing/activity", false),
    ("GET", "/api/tasks/missing", false),
    ("GET", "/api/discussion/tasks/missing/comments", false),
    (
        "GET",
        "/api/discussion/tasks/missing/comments/missing",
        false,
    ),
    ("GET", "/api/discussion/tasks/missing/blocks/missing", false),
    ("GET", "/api/activity/projects/missing", false),
    ("GET", "/api/inbox", false),
    ("GET", "/api/events", false),
    ("GET", "/api/tasks/missing/attachments", false),
    ("POST", "/api/tasks/missing/attachments", false),
    ("POST", "/api/tasks/missing/attachments/reorder", false),
    ("PATCH", "/api/attachments/missing", false),
    ("DELETE", "/api/attachments/missing", false),
    ("GET", "/api/attachments/missing/download", false),
    ("GET", "/api/attachments/missing/content", false),
    ("GET", "/api/attachments/missing/source", false),
    ("GET", "/api/attachments/missing/preview/html", false),
    ("PUT", "/api/auth/avatar", false),
    ("DELETE", "/api/auth/avatar", false),
    ("GET", "/api/users/missing/avatar", false),
    ("GET", "/api/storage", false),
    ("POST", "/api/storage/cleanup", false),
];

#[tokio::test]
async fn browser_route_inventory_enforces_auth_and_origin_before_extraction() {
    let (directory, app, token) = fixture().await;
    let connection = rusqlite::Connection::open(directory.path().join("oneloop.sqlite3")).unwrap();
    let version = || {
        connection
            .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };
    for &(method, path, public) in BROWSER_ROUTES {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("origin", "http://127.0.0.1:8080")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        if path == "/api/auth/logout" {
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
        } else if !public {
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
        }
        if method == "GET" {
            continue;
        }
        for origin in [None, Some("https://foreign.example")] {
            let before = version();
            let mut request = Request::builder()
                .method(method)
                .uri(path)
                .header("cookie", format!("oneloop_session={token}"));
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            // No content-type: CSRF must run even before a would-be 415.
            let response = app
                .clone()
                .oneshot(request.body(Body::from("{}")).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
            let value: Value = body_json(response).await;
            assert_eq!(value["error"]["code"], "invalid_origin", "{method} {path}");
            assert_eq!(
                version(),
                before,
                "rejected request wrote database: {method} {path}"
            );
        }
    }
    for &(method, path, _) in BROWSER_ROUTES {
        // Fresh session per route so logout/revoke-others cannot invalidate later checks.
        let now = unix_now().unwrap();
        connection.execute("INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
            SELECT ?1,user_id,?2,?3,?3,?3,?4,?4 FROM sessions LIMIT 1",
            rusqlite::params![uuid::Uuid::now_v7().to_string(), oneloop::auth::token_hash("inventory-session-00000000000000000000"), now, now+3600]).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("origin", "http://127.0.0.1:8080")
                    .header("content-type", "application/json")
                    .header(
                        "cookie",
                        "oneloop_session=inventory-session-00000000000000000000",
                    )
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(
            response.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {path}"
        );
        assert_ne!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
        assert!(
            !response.status().is_server_error(),
            "{method} {path}: {}",
            response.status()
        );
        // Resource routes deliberately use nonexistent IDs: their authenticated 404
        // exercises access-safe lookup. SSE is dropped without collecting its body.
        drop(response);
        connection
            .execute(
                "DELETE FROM sessions WHERE token_hash=?1",
                [oneloop::auth::token_hash(
                    "inventory-session-00000000000000000000",
                )],
            )
            .unwrap();
    }
}

#[tokio::test]
async fn public_discovery_shapes_and_native_routes_are_reachable() {
    let (_directory, app, _) = fixture().await;
    for (path, field, expected) in [
        ("/healthz", "status", "ok"),
        (
            "/.well-known/oauth-authorization-server",
            "issuer",
            "http://127.0.0.1:8080",
        ),
        (
            "/.well-known/oauth-protected-resource",
            "resource",
            "http://127.0.0.1:8080/mcp",
        ),
        (
            "/.well-known/oauth-protected-resource/mcp",
            "resource",
            "http://127.0.0.1:8080/mcp",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body: Value = body_json(response).await;
        assert_eq!(body[field], expected, "{path}");
        if path == "/healthz" {
            assert_eq!(body["schemaVersion"], oneloop::db::CURRENT_SCHEMA_VERSION);
            assert!(body["version"].is_string());
        }
        if field == "issuer" {
            assert_eq!(body["code_challenge_methods_supported"], json!(["S256"]));
        }
    }
    for (method, path) in [
        ("POST", "/oauth/register"),
        ("GET", "/oauth/authorize"),
        ("POST", "/oauth/authorize"),
        ("POST", "/oauth/token"),
        ("POST", "/oauth/revoke"),
        ("GET", "/mcp/assets/consent.js"),
        ("GET", "/mcp/assets/consent.css"),
        ("POST", "/mcp"),
        ("GET", "/mcp"),
        ("DELETE", "/mcp"),
        ("PUT", "/mcp/files/upload"),
        ("GET", "/mcp/files/download"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "127.0.0.1:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
        assert_ne!(
            response.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn foreign_hosts_and_registration_origins_are_rejected() {
    use axum::extract::ConnectInfo;
    let (_directory, app, _) = fixture().await;
    for path in ["/healthz", "/", "/oauth/register", "/api/auth/me"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "attacker.example:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::MISDIRECTED_REQUEST, "{path}");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "foreign.example")
                .header("accept", "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::MISDIRECTED_REQUEST);
    let html = body_text(response).await;
    assert!(html.contains("href=\"http://127.0.0.1:8080/\""));
    assert!(!html.contains("foreign.example"));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header("host", "foreign.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let error: Value = body_json(response).await;
    assert_eq!(error["error"]["code"], "invalid_origin");
    assert_eq!(
        error["error"]["details"]["canonicalUrl"],
        "http://127.0.0.1:8080/"
    );
    for (host, peer, path, status) in [
        (
            "localhost:19100",
            "127.0.0.1:40000",
            "/healthz",
            StatusCode::OK,
        ),
        (
            "localhost:19100",
            "192.0.2.1:40000",
            "/healthz",
            StatusCode::MISDIRECTED_REQUEST,
        ),
        (
            "localhost:19100",
            "127.0.0.1:40000",
            "/",
            StatusCode::MISDIRECTED_REQUEST,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", host)
                    .extension(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .extension(ConnectInfo(
                    "127.0.0.1:40000".parse::<std::net::SocketAddr>().unwrap(),
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::MISDIRECTED_REQUEST);
    for origin in [
        Some("https://foreign.example"),
        None,
        Some("http://127.0.0.1:8080"),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/oauth/register")
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = app.clone().oneshot(request.body(Body::from(json!({"client_name":"Test", "redirect_uris":["https://client.example/callback"]}).to_string())).unwrap()).await.unwrap();
        assert_eq!(
            response.status(),
            if origin == Some("https://foreign.example") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::CREATED
            }
        );
    }
}

#[tokio::test]
async fn content_versioned_assets_are_immutable_only_for_the_current_version() {
    let (_directory, app, _) = fixture().await;
    let response = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-cache");
    let html = body_text(response).await;
    let prefix = html
        .split("href=\"")
        .find(|part| part.starts_with("/v/"))
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let version = prefix.split('/').nth(2).unwrap();
    assert_eq!(version.len(), 64);
    for path in [
        format!("/v/{version}/views/theme.js"),
        format!("/v/{version}/src/app/main.js"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        let tag = response.headers()["etag"].clone();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header("if-none-match", tag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path.replacen(version, &"0".repeat(64), 1))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(
            !response
                .headers()
                .get("cache-control")
                .is_some_and(|v| v.to_str().unwrap().contains("immutable"))
        );
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v/{version}/views/data.js"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn misspelled_query_and_attachment_fields_are_actionable_validation_errors() {
    let (_root, app, token) = fixture().await;
    for (path, method, body, field) in [
        ("/api/bootstrap?projetId=p1", "GET", "", "projetId"),
        (
            "/api/projects/p1/board?status=planning&trackId=wrong",
            "GET",
            "",
            "trackId",
        ),
        (
            "/api/projects/p1/board-view?serch=wrong",
            "GET",
            "",
            "serch",
        ),
        (
            "/api/projects/p1/pool?scope=team&wrong=1",
            "GET",
            "",
            "wrong",
        ),
        ("/api/epics/e1/tasks?wrong=1", "GET", "", "wrong"),
        ("/api/inbox?unreadOnli=true", "GET", "", "unreadOnli"),
        ("/api/events?wrong=1", "GET", "", "wrong"),
        ("/api/activity/projects/p1?wrong=1", "GET", "", "wrong"),
        (
            "/api/discussion/tasks/task/comments?wrong=1",
            "GET",
            "",
            "wrong",
        ),
        (
            "/api/attachments/missing",
            "PATCH",
            r#"{"isEphemeral":true,"expectedRevision":1,"wrong":1}"#,
            "wrong",
        ),
        (
            "/api/attachments/missing?expectedRevision=0",
            "DELETE",
            "",
            "expectedRevision",
        ),
        (
            "/api/attachments/missing?expectedRevision=-1",
            "DELETE",
            "",
            "expectedRevision",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("Origin", "http://127.0.0.1:8080")
                    .header("Cookie", format!("oneloop_session={token}"))
                    .header("Content-Type", "application/json")
                    .header("Idempotency-Key", "strict-delete")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body: Value = body_json(response).await;
        assert_eq!(status.as_u16(), 400, "{path}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{path}: {body}");
    }
}

#[tokio::test]
async fn health_reports_build_metadata_without_authentication() {
    let (root, db) = support::database();
    let config = support::config(root.path(), "http://127.0.0.1:8080", &[]);
    let app = application(AppState::new(config, db)).router;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let health: Value = body_json(response).await;
    assert_eq!(health["status"], "ok");
    assert_eq!(health["version"], oneloop::build_info::VERSION);
    assert_eq!(health["revision"], oneloop::build_info::REVISION);
    assert_eq!(health["schemaVersion"], oneloop::db::CURRENT_SCHEMA_VERSION);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/assets/version.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let script = body_text(response).await;
    assert!(!script.contains("ONELOOP_BUILD"));
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, failure_persistence: None, ..ProptestConfig::default() })]
    #[test]
    fn origin_check_accepts_only_the_canonical_origin(raw in ".{0,512}") {
        let mut headers = axum::http::HeaderMap::new();
        if let Ok(value) = raw.parse() { headers.insert(axum::http::header::ORIGIN, value); }
        let url = url::Url::parse("https://work.example.com").unwrap();
        if require_canonical_origin(&axum::http::Method::POST, &headers, &url).is_ok() {
            prop_assert_eq!(url::Url::parse(&raw).unwrap().origin(), url.origin());
        }
    }
}
