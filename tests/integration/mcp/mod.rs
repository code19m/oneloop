//! The MCP endpoint and its OAuth authorization server.

mod oauth;
mod tools;

use std::net::SocketAddr;

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{HeaderValue, Request, StatusCode, header},
};
use oneloop::{
    AppState, Db, application,
    auth::{AuthService, LoginResult, NewUser, SessionMetadata, create_user, unix_now},
    db::{create_backup, restore_backup},
};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::support;
use crate::support::http::{body_bytes, body_json, body_text};

pub(crate) async fn fixture() -> (tempfile::TempDir, Db, Router, String, String) {
    fixture_with_trusted_proxies("").await
}

async fn fixture_with_trusted_proxies(
    trusted_proxies: &str,
) -> (tempfile::TempDir, Db, Router, String, String) {
    // These independent fixtures share the process-wide password workers. Bound
    // setup hashing so a parallel test run does not test overload accidentally.
    static SETUP: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let _setup = SETUP.acquire().await.unwrap();
    let (dir, db) = support::database();
    let user=db.transaction(|tx|{let user=create_user(tx,NewUser{username:"owner".into(),display_name:"Owner".into(),password:"test-only-password-012345".into(),is_admin:false,must_change_password:false},unix_now()?)?;tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('project-1','Project','PRJ',1,1)",[])?;tx.execute("INSERT INTO project_sequences(project_id,next_task_number) VALUES('project-1',1)",[])?;tx.execute("INSERT INTO project_memberships(project_id,user_id,manage_board,manage_roadmap,created_at,updated_at) VALUES('project-1',?1,1,1,1,1)",[&user.id])?;Ok(user.id)}).await.unwrap();
    let LoginResult::Authenticated(session) = AuthService::new(db.clone())
        .login(
            "owner",
            "test-only-password-012345",
            SessionMetadata::default(),
            None,
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    let config = support::config(
        dir.path(),
        "http://127.0.0.1:8080",
        &[("ONELOOP_TRUSTED_PROXIES", trusted_proxies)],
    );
    (
        dir,
        db.clone(),
        application(AppState::new(config, db.clone())).router,
        session.token,
        user,
    )
}

async fn register_from(app: &Router, peer: &str, forwarded_for: Option<&str>) -> StatusCode {
    let mut request = Request::builder()
        .method("POST")
        .uri("/oauth/register")
        .header(header::HOST, "127.0.0.1:8080")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(forwarded_for) = forwarded_for {
        request = request.header("x-forwarded-for", forwarded_for);
    }
    let mut request = request
        .body(Body::from(
            json!({
                "client_name": "Quota test",
                "redirect_uris": ["http://127.0.0.1:49152/callback"],
            })
            .to_string(),
        ))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    app.clone().oneshot(request).await.unwrap().status()
}

async fn mcp_body(response: axum::response::Response) -> Value {
    let bytes = body_bytes(response).await;
    if let Ok(value) = serde_json::from_slice(&bytes) {
        return value;
    }
    let text = std::str::from_utf8(&bytes).unwrap();
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .find(|line| !line.trim().is_empty())
        .expect("MCP response contains a JSON or SSE data body");
    serde_json::from_str(data).unwrap()
}

fn form(path: &str, value: &[(&str, &str)]) -> Request<Body> {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(value.iter().copied())
        .finish();
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(encoded))
        .unwrap()
}

pub(crate) struct McpClient<'a> {
    app: &'a Router,
    access: String,
    session_id: Option<HeaderValue>,
    request_id: u64,
}

impl<'a> McpClient<'a> {
    pub(crate) async fn connect(app: &'a Router, access: impl Into<String>) -> Self {
        let access = access.into();
        let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"integration-test","version":"1"}}});
        let response = app
            .clone()
            .oneshot(mcp_request(&access, None, initialize))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let session_id = response.headers().get("mcp-session-id").cloned();
        assert!(session_id.is_none(), "transport must remain stateless");
        let initialized = mcp_body(response).await;
        assert_eq!(
            initialized["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(initialized["result"]["serverInfo"]["name"], "oneloop");
        Self {
            app,
            access,
            session_id,
            request_id: 2,
        }
    }

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.request_id;
        self.request_id += 1;
        let response = self
            .app
            .clone()
            .oneshot(mcp_request(
                &self.access,
                self.session_id.as_ref(),
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        mcp_body(response).await
    }

    async fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name,"arguments":arguments}))
            .await
    }
}

fn mcp_request(access: &str, session_id: Option<&HeaderValue>, payload: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::HOST, "127.0.0.1:8080")
        .header(header::AUTHORIZATION, format!("Bearer {access}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25");
    if let Some(session_id) = session_id {
        builder = builder.header("mcp-session-id", session_id);
    }
    builder.body(Body::from(payload.to_string())).unwrap()
}

fn tool_value(response: &Value) -> Value {
    assert!(
        response.get("error").is_none(),
        "protocol error: {response}"
    );
    assert_ne!(
        response["result"]["isError"], true,
        "tool error: {response}"
    );
    if let Some(value) = response["result"].get("structuredContent") {
        return value.clone();
    }
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool response has text or structured content");
    serde_json::from_str(text).expect("tool text is JSON")
}

fn assert_tool_error(response: &Value, expected: &str) {
    let rendered = response.to_string();
    assert!(
        response.get("error").is_none() && response["result"]["isError"] == true,
        "expected tool error, got {response}"
    );
    assert!(rendered.contains(expected), "{rendered}");
}

async fn create_protocol_task(mcp: &mut McpClient<'_>, project_id: &str, suffix: &str) -> String {
    let track = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"track.create","payload":{"projectId":project_id,"name":format!("Track {suffix}")},"idempotencyKey":format!("track-{suffix}")}),
        )
        .await,
    );
    let epic = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"epic.create","payload":{"projectId":project_id,"trackId":track["entities"][0]["id"],"title":format!("Epic {suffix}"),"startDate":"2026-09-20"},"idempotencyKey":format!("epic-{suffix}")}),
        )
        .await,
    );
    let task = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"task.create","payload":{"projectId":project_id,"epicId":epic["entities"][0]["id"],"title":format!("Task {suffix}")},"idempotencyKey":format!("task-{suffix}")}),
        )
        .await,
    );
    task["entities"][0]["id"].as_str().unwrap().to_owned()
}

pub(crate) async fn register(app: &Router) -> String {
    let response=app.clone().oneshot(Request::builder().method("POST").uri("/oauth/register").header(header::CONTENT_TYPE,"application/json").body(Body::from(json!({"client_name":"MCP Test","redirect_uris":["http://127.0.0.1:49152/callback"],"token_endpoint_auth_method":"none"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let registered = body_json(response).await;
    assert!(
        registered
            .as_object()
            .unwrap()
            .values()
            .all(|value| !value.is_null())
    );
    registered["client_id"].as_str().unwrap().to_owned()
}

fn authorization_path(client: &str, redirect: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", redirect),
            (
                "code_challenge",
                "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
            ),
            ("code_challenge_method", "S256"),
            ("resource", "http://127.0.0.1:8080/mcp"),
            ("scope", "project_read discussion"),
            ("state", "opaque-login-state"),
        ])
        .finish();
    format!("/oauth/authorize?{query}")
}

pub(crate) async fn authorize(app: &Router, session: &str, client: &str) -> (String, String) {
    authorize_with(
        app,
        session,
        client,
        &[
            "project_read",
            "discussion",
            "board_manage",
            "roadmap_manage",
            "inbox_private",
            "my_pool_private",
            "attachments",
            "destructive",
        ],
        &["project-1"],
    )
    .await
}

async fn authorize_with(
    app: &Router,
    session: &str,
    client: &str,
    scopes: &[&str],
    projects: &[&str],
) -> (String, String) {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use sha2::{Digest, Sha256};
    let verifier = "verifier-with-forty-three-characters-0123456789ABCDE";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", "http://127.0.0.1:49152/callback"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("resource", "http://127.0.0.1:8080/mcp"),
            ("scope", &scopes.join(" ")),
            ("state", "oauth-test-state"),
        ])
        .finish();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/oauth/authorize?{query}"))
                .header(header::COOKIE, format!("oneloop_session={session}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::REFERRER_POLICY], "same-origin");
    assert!(
        response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("form-action 'self' http://127.0.0.1:49152;")
    );
    let html = body_text(response).await;
    assert!(html.contains("can send permitted oneloop data to its AI provider"));
    if scopes.contains(&"destructive") {
        assert!(html.contains("value=\"destructive\">"));
        assert!(!html.contains("value=\"destructive\" checked"));
    }
    let marker = "name=request_id value=\"";
    let at = html.find(marker).unwrap() + marker.len();
    let request_id = &html[at..html[at..].find('"').unwrap() + at];
    let mut values = vec![("request_id", request_id), ("decision", "allow")];
    values.extend(projects.iter().copied().map(|project| ("project", project)));
    values.extend(scopes.iter().copied().map(|scope| ("scope", scope)));
    let response = app
        .clone()
        .oneshot({
            let mut r = form("/oauth/authorize", &values);
            r.headers_mut()
                .insert(header::ORIGIN, "http://127.0.0.1:8080".parse().unwrap());
            r.headers_mut().insert(
                header::COOKIE,
                format!("oneloop_session={session}").parse().unwrap(),
            );
            r
        })
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = response.headers()[header::LOCATION].to_str().unwrap();
    let url = url::Url::parse(location).unwrap();
    assert_eq!(
        url.query_pairs().find(|(key, _)| key == "iss").unwrap().1,
        "http://127.0.0.1:8080"
    );
    let code = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(
        url.query_pairs().find(|(key, _)| key == "state").unwrap().1,
        "oauth-test-state"
    );
    (code, verifier.into())
}

pub(crate) async fn issue(app: &Router, client: &str, code: &str, verifier: &str) -> Value {
    let response = app
        .clone()
        .oneshot(code_request(client, code, verifier))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

fn code_request(client: &str, code: &str, verifier: &str) -> Request<Body> {
    form(
        "/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client),
            ("code", code),
            ("redirect_uri", "http://127.0.0.1:49152/callback"),
            ("code_verifier", verifier),
            ("resource", "http://127.0.0.1:8080/mcp"),
        ],
    )
}

async fn scoped_mcp<'a>(
    app: &'a Router,
    session: &str,
    scopes: &[&str],
    projects: &[&str],
) -> McpClient<'a> {
    let client = register(app).await;
    let (code, verifier) = authorize_with(app, session, &client, scopes, projects).await;
    let tokens = issue(app, &client, &code, &verifier).await;
    McpClient::connect(app, tokens["access_token"].as_str().unwrap().to_owned()).await
}

async fn registration(app: &Router, metadata: Value) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/register")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(metadata.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn consent_page(app: &Router, session: &str, path: &str) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header(header::COOKIE, format!("oneloop_session={session}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let text = body_text(response).await;
    (status, text)
}

fn request_id(html: &str) -> &str {
    html.split("name=request_id value=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
}

fn consent_submit(session: &str, values: &[(&str, &str)]) -> Request<Body> {
    let mut request = form("/oauth/authorize", values);
    request
        .headers_mut()
        .insert(header::ORIGIN, "http://127.0.0.1:8080".parse().unwrap());
    request.headers_mut().insert(
        header::COOKIE,
        format!("oneloop_session={session}").parse().unwrap(),
    );
    request
}

fn refresh_request(client: &str, token: &str) -> Request<Body> {
    form(
        "/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client),
            ("refresh_token", token),
            ("resource", "http://127.0.0.1:8080/mcp"),
        ],
    )
}
