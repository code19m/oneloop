//! Knowledge: connecting a Git folder, syncing it with the real `git` program
//! from local repositories, and reading, downloading and searching its files.

use std::{
    path::Path,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    response::Response,
};
use oneloop::{AppState, Db, application, auth::unix_now};
use rusqlite::params;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::support::{
    self,
    http::{body_bytes, body_json},
};

const ORIGIN: &str = "https://tasks.example.test";
const FIRST: i64 = 1_700_000_000;
const SECOND: i64 = 1_700_086_400;
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

/// A Git repository on disk, reached through a `file://` URL.
struct Repository {
    directory: TempDir,
}

impl Repository {
    fn new() -> Self {
        let repository = Self {
            directory: support::scratch_dir(),
        };
        repository.git(&["init", "--quiet", "--initial-branch=main"], FIRST);
        // Let clones filter file contents, as hosting services do.
        repository.git(&["config", "uploadpack.allowFilter", "true"], FIRST);
        repository
    }

    fn path(&self) -> &Path {
        self.directory.path()
    }

    fn url(&self) -> String {
        format!("file://{}", self.path().display())
    }

    fn write(&self, path: &str, content: &[u8]) {
        let target = self.path().join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }

    fn commit(&self, time: i64) {
        self.git(&["add", "--all"], time);
        self.git(&["commit", "--quiet", "--message", "Change"], time);
    }

    fn git(&self, arguments: &[&str], time: i64) {
        let date = format!("{time} +0000");
        let output = Command::new("git")
            .current_dir(self.path())
            .args(["-c", "commit.gpgsign=false", "-c", "user.name=Test"])
            .args(["-c", "user.email=test@example.com"])
            .args(arguments)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("HOME", self.path())
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// A handbook in `docs/` with a guide, an image, a script, a link and a file
/// outside the folder.
fn handbook() -> Repository {
    let repository = Repository::new();
    repository.write(
        "docs/README.md",
        b"# Handbook\n\nStart with the [onboarding guide](guides/onboarding.md).\n\n## Setup\n\nInstall the tools.\n",
    );
    repository.write(
        "docs/guides/onboarding.md",
        b"# Joining\n\n## First day\n\nMeet the team.\n",
    );
    repository.write("docs/diagram.png", PNG);
    repository.write("docs/run.sh", b"#!/bin/sh\necho ready\n");
    repository.write("docs/page.html", b"<!doctype html><p>Hello</p>");
    repository.write("other/secret.md", b"# Not shared\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = repository.path().join("docs/run.sh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("README.md", repository.path().join("docs/link.md")).unwrap();
    }
    repository.commit(FIRST);
    repository
}

struct Fixture {
    _directory: TempDir,
    app: Router,
    state: AppState,
    db: Db,
    admin: String,
    member: String,
    outsider: String,
}

impl Fixture {
    async fn new() -> Self {
        let (directory, db) = support::database();
        let admin = support::add_user(&db, "admin", true).await;
        let member = support::add_user(&db, "member", false).await;
        let outsider = support::add_user(&db, "outsider", false).await;
        let member_id = member.actor.user_id.clone();
        db.run(move |connection| {
            let now = unix_now()?;
            connection.execute(
                "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p1','Project','PRJ',?1,?1)",
                [now],
            )?;
            connection.execute(
                "INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES('p1',?1,?2,?2)",
                params![member_id, now],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let mut config = support::config(directory.path(), ORIGIN, &[]);
        config.disk_min_free_bytes = 0;
        let mut state = AppState::new(config, db.clone());
        state.knowledge = state.knowledge.allowing_local_repositories();
        Self {
            _directory: directory,
            app: application(state.clone()).router,
            state,
            db,
            admin: cookie(&admin.token),
            member: cookie(&member.token),
            outsider: cookie(&outsider.token),
        }
    }

    async fn command(
        &self,
        cookie: &str,
        operation: &str,
        payload: Value,
        expected_revision: Option<i64>,
    ) -> (StatusCode, Value) {
        static KEY: AtomicU64 = AtomicU64::new(0);
        let key = format!("knowledge-{}", KEY.fetch_add(1, Ordering::Relaxed));
        self.command_with_key(cookie, operation, payload, expected_revision, &key)
            .await
    }

    async fn command_with_key(
        &self,
        cookie: &str,
        operation: &str,
        payload: Value,
        expected_revision: Option<i64>,
        key: &str,
    ) -> (StatusCode, Value) {
        let mut body = json!({"operation": operation, "payload": payload, "idempotencyKey": key});
        if let Some(revision) = expected_revision {
            body["expectedRevision"] = json!(revision);
        }
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/commands")
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        (status, body_json(response).await)
    }

    async fn get(&self, cookie: &str, uri: &str) -> Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn view(&self, cookie: &str) -> Value {
        let response = self.get(cookie, "/api/projects/p1/knowledge").await;
        assert_eq!(response.status(), StatusCode::OK);
        body_json(response).await
    }

    async fn connect(&self, repository: &Repository) -> Value {
        let (status, body) = self
            .command(
                &self.admin,
                "knowledge.connect",
                json!({"projectId": "p1", "url": repository.url(), "branch": "main", "folder": "docs"}),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn sync(&self) {
        let (status, body) = self
            .command(
                &self.admin,
                "knowledge.sync",
                json!({"projectId": "p1"}),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(self.state.knowledge.sync_due().await, 1);
    }

    async fn revision(&self) -> i64 {
        self.view(&self.admin).await["source"]["revision"]
            .as_i64()
            .unwrap()
    }

    async fn events(&self, event_type: &str) -> i64 {
        let event_type = event_type.to_owned();
        self.db
            .run(move |connection| {
                Ok(connection.query_row(
                    "SELECT count(*) FROM activity_events WHERE project_id='p1' AND event_type=?1",
                    [event_type],
                    |row| row.get(0),
                )?)
            })
            .await
            .unwrap()
    }
}

fn cookie(token: &str) -> String {
    format!("__Host-oneloop_session={token}")
}

fn paths(view: &Value) -> Vec<&str> {
    view["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap())
        .collect()
}

fn file<'a>(view: &'a Value, path: &str) -> &'a Value {
    view["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == path)
        .unwrap_or_else(|| panic!("{path} is listed"))
}

#[tokio::test]
async fn administrators_connect_a_folder_and_members_read_its_files() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    assert_eq!(fixture.view(&fixture.member).await["state"], "unconnected");

    let (status, _) = fixture
        .command(
            &fixture.member,
            "knowledge.connect",
            json!({"projectId": "p1", "url": repository.url(), "branch": "main", "folder": "docs"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let connected = fixture.connect(&repository).await;
    let source = &connected["entities"][0];
    assert_eq!(source["entityType"], "knowledgeSource");
    assert_eq!(
        (source["state"].as_str(), source["syncing"].as_bool()),
        (Some("pending"), Some(true))
    );
    assert_eq!(source["hasToken"], false);
    let waiting = fixture.view(&fixture.member).await;
    assert_eq!(
        (
            waiting["state"].as_str(),
            waiting["files"].as_array().map(Vec::len)
        ),
        (Some("pending"), Some(0))
    );

    assert_eq!(fixture.state.knowledge.sync_due().await, 1);
    let view = fixture.view(&fixture.member).await;
    assert_eq!(view["state"], "ready");
    assert_eq!(view["syncing"], false);
    assert_eq!(view["folder"], "docs");
    assert!(view.get("source").is_none(), "members never see the source");
    // Links, files outside the folder and Git metadata are never synced.
    assert_eq!(
        paths(&view),
        [
            "README.md",
            "diagram.png",
            "guides/onboarding.md",
            "page.html",
            "run.sh"
        ]
    );
    for (path, kind) in [
        ("README.md", json!("markdown")),
        ("diagram.png", json!("image")),
        ("page.html", json!("html")),
        ("run.sh", json!("text")),
    ] {
        assert_eq!(file(&view, path)["kind"], kind, "{path}");
        assert_eq!(file(&view, path)["updatedAt"], FIRST, "{path}");
    }

    let version = file(&view, "README.md")["version"].as_str().unwrap();
    assert_eq!(
        version.len(),
        16,
        "a short content checksum keys client caches"
    );

    let admin = fixture.view(&fixture.admin).await;
    let source = &admin["source"];
    assert_eq!(source["branch"], "main");
    assert_eq!(source["folder"], "docs");
    assert_eq!(source["state"], "ready");
    assert!(source["checkedAt"].as_i64().is_some());
    assert_eq!(fixture.events("knowledge.connected").await, 1);
    assert_eq!(fixture.events("knowledge.synced").await, 1);

    let response = fixture
        .get(&fixture.outsider, "/api/projects/p1/knowledge")
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // An unchanged branch is checked without another activity entry.
    fixture.sync().await;
    assert_eq!(fixture.events("knowledge.synced").await, 1);
}

#[tokio::test]
async fn files_follow_the_attachment_safety_rules() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    fixture.connect(&repository).await;
    fixture.state.knowledge.sync_due().await;

    let response = fixture
        .get(
            &fixture.member,
            "/api/projects/p1/knowledge/text?path=README.md",
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/plain; charset=utf-8"
    );
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    let etag = response.headers()[header::ETAG]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(body_bytes(response).await.starts_with(b"# Handbook"));
    let unchanged = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/projects/p1/knowledge/text?path=README.md")
                .header(header::COOKIE, &fixture.member)
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);

    let image = fixture
        .get(
            &fixture.member,
            "/api/projects/p1/knowledge/content?path=diagram.png",
        )
        .await;
    assert_eq!(image.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(body_bytes(image).await.as_ref(), PNG);
    // Only images and PDFs are served with their own type.
    for uri in [
        "/api/projects/p1/knowledge/content?path=README.md",
        "/api/projects/p1/knowledge/content?path=page.html",
        "/api/projects/p1/knowledge/text?path=diagram.png",
        "/api/projects/p1/knowledge/preview/html?path=README.md",
        "/api/projects/p1/knowledge/download?path=../other/secret.md",
        "/api/projects/p1/knowledge/download?path=other/secret.md",
        "/api/projects/p1/knowledge/download?path=link.md",
        "/api/projects/p1/knowledge/download?path=%2Fetc%2Fpasswd",
    ] {
        assert_eq!(
            fixture.get(&fixture.member, uri).await.status(),
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }

    let download = fixture
        .get(
            &fixture.member,
            "/api/projects/p1/knowledge/download?path=run.sh",
        )
        .await;
    assert_eq!(
        download.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert!(
        download.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .starts_with("attachment; filename=\"run.sh\"")
    );
    assert_eq!(
        body_bytes(download).await.as_ref(),
        b"#!/bin/sh\necho ready\n"
    );

    let preview = fixture
        .get(
            &fixture.member,
            "/api/projects/p1/knowledge/preview/html?path=page.html&reload=1",
        )
        .await;
    assert_eq!(preview.status(), StatusCode::OK);
    assert!(
        preview.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox allow-scripts;")
    );

    let script = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/projects/p1/knowledge/download?path=run.sh")
                .header(header::COOKIE, &fixture.member)
                .header("sec-fetch-dest", "script")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(script.status(), StatusCode::FORBIDDEN);
    let outsider = fixture
        .get(
            &fixture.outsider,
            "/api/projects/p1/knowledge/download?path=run.sh",
        )
        .await;
    assert_eq!(outsider.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn search_finds_names_and_section_text() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    fixture.connect(&repository).await;
    fixture.state.knowledge.sync_due().await;

    let response = fixture
        .get(
            &fixture.member,
            "/api/projects/p1/knowledge/search?q=install%20tools",
        )
        .await;
    let results = body_json(response).await;
    assert_eq!(results["hitCount"], 1);
    assert_eq!(results["documents"][0]["path"], "README.md");
    assert_eq!(results["documents"][0]["hits"][0]["heading"], "Setup");

    let names = body_json(
        fixture
            .get(
                &fixture.member,
                "/api/projects/p1/knowledge/search?q=onboard",
            )
            .await,
    )
    .await;
    assert_eq!(names["files"][0]["path"], "guides/onboarding.md");
    let folders = body_json(
        fixture
            .get(
                &fixture.member,
                "/api/projects/p1/knowledge/search?q=guides",
            )
            .await,
    )
    .await;
    assert_eq!(
        folders["files"][0],
        json!({"path": "guides", "folder": true})
    );
    let outsider = fixture
        .get(
            &fixture.outsider,
            "/api/projects/p1/knowledge/search?q=install",
        )
        .await;
    assert_eq!(outsider.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn new_commits_replace_files_and_unchanged_files_keep_their_dates() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    fixture.connect(&repository).await;
    fixture.state.knowledge.sync_due().await;

    repository.write(
        "docs/guides/onboarding.md",
        b"# Joining\n\n## First week\n\nPair with a teammate.\n",
    );
    repository.write("docs/news.md", b"# News\n");
    std::fs::remove_file(repository.path().join("docs/run.sh")).unwrap();
    repository.commit(SECOND);
    fixture.sync().await;

    let view = fixture.view(&fixture.member).await;
    assert_eq!(
        paths(&view),
        [
            "README.md",
            "diagram.png",
            "guides/onboarding.md",
            "news.md",
            "page.html"
        ]
    );
    assert_eq!(file(&view, "README.md")["updatedAt"], FIRST);
    assert_eq!(file(&view, "guides/onboarding.md")["updatedAt"], SECOND);
    assert_eq!(file(&view, "news.md")["updatedAt"], SECOND);
    assert_eq!(fixture.events("knowledge.synced").await, 2);
    let results = body_json(
        fixture
            .get(
                &fixture.member,
                "/api/projects/p1/knowledge/search?q=teammate",
            )
            .await,
    )
    .await;
    assert_eq!(results["documents"][0]["hits"][0]["heading"], "First week");
}

#[tokio::test]
async fn a_failed_sync_keeps_the_last_files_and_reports_the_reason_to_administrators() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    fixture.connect(&repository).await;
    fixture.state.knowledge.sync_due().await;

    let moved = repository.path().with_extension("moved");
    std::fs::rename(repository.path(), &moved).unwrap();
    fixture.sync().await;
    let member = fixture.view(&fixture.member).await;
    assert_eq!(member["state"], "failed");
    assert_eq!(member["files"].as_array().unwrap().len(), 5);
    assert!(!member.to_string().contains("repository_not_found"));
    let admin = fixture.view(&fixture.admin).await;
    assert_eq!(admin["source"]["errorCode"], "repository_not_found");
    fixture.sync().await;
    assert_eq!(
        fixture.events("knowledge.sync_failed").await,
        1,
        "a repeated reason is not new activity"
    );

    std::fs::rename(&moved, repository.path()).unwrap();
    fixture.sync().await;
    let recovered = fixture.view(&fixture.admin).await;
    assert_eq!(recovered["state"], "ready");
    assert_eq!(recovered["source"]["errorCode"], Value::Null);
    assert_eq!(fixture.events("knowledge.synced").await, 2);
}

#[tokio::test]
async fn changing_the_location_clears_files_and_missing_branches_and_folders_fail() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    fixture.connect(&repository).await;
    fixture.state.knowledge.sync_due().await;
    let revision = fixture.revision().await;

    let update = |branch: &str, folder: &str| json!({"projectId": "p1", "url": repository.url(), "branch": branch, "folder": folder, "tokenAction": "keep"});
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update("main", "docs"),
            Some(revision),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update("missing", "docs"),
            Some(revision - 1),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update("missing", "docs"),
            Some(revision),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pending = fixture.view(&fixture.member).await;
    assert_eq!(
        (
            pending["state"].as_str(),
            pending["files"].as_array().map(Vec::len)
        ),
        (Some("pending"), Some(0))
    );
    assert_eq!(fixture.state.knowledge.sync_due().await, 1);
    assert_eq!(
        fixture.view(&fixture.admin).await["source"]["errorCode"],
        "branch_not_found"
    );

    let (status, _) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update("main", "nowhere"),
            Some(revision + 1),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    fixture.state.knowledge.sync_due().await;
    assert_eq!(
        fixture.view(&fixture.admin).await["source"]["errorCode"],
        "folder_not_found"
    );

    let (status, _) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update("main", ""),
            Some(revision + 2),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    fixture.state.knowledge.sync_due().await;
    let root = fixture.view(&fixture.member).await;
    assert_eq!(root["state"], "ready");
    assert!(paths(&root).contains(&"docs/README.md"));
    assert!(paths(&root).contains(&"other/secret.md"));
}

#[tokio::test]
async fn search_never_returns_files_from_a_previous_folder() {
    let fixture = Fixture::new().await;
    let repository = handbook();
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.connect",
            json!({"projectId": "p1", "url": repository.url(), "branch": "main", "folder": ""}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    fixture.state.knowledge.sync_due().await;
    let search = || async {
        body_json(
            fixture
                .get(
                    &fixture.member,
                    "/api/projects/p1/knowledge/search?q=shared",
                )
                .await,
        )
        .await
    };
    assert_eq!(search().await["documents"][0]["path"], "other/secret.md");

    // The same commit, a narrower folder.
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            json!({"projectId": "p1", "url": repository.url(), "branch": "main", "folder": "docs", "tokenAction": "keep"}),
            Some(1),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    fixture.state.knowledge.sync_due().await;
    let results = search().await;
    assert_eq!(results["hitCount"], 0, "{results}");
    assert_eq!(results["fileCount"], 0, "{results}");
}

#[tokio::test]
async fn credentials_stay_encrypted_and_disconnecting_removes_them() {
    let fixture = Fixture::new().await;
    let token = "glpat-private-token-0123456789";
    let https = "https://reader@git.example.test/team/docs.git";
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.connect",
            json!({"projectId": "p1", "url": https, "branch": "main", "folder": "docs", "token": token}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.to_string().contains(token));
    let source = fixture.view(&fixture.admin).await["source"].clone();
    assert_eq!(source["hasToken"], true);
    assert_eq!(source["repository"], "git.example.test/team/docs");
    assert_eq!(source["transport"], "https");
    let stored: Vec<u8> = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT token_ciphertext FROM knowledge_sources WHERE project_id='p1'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(
        !stored
            .windows(token.len())
            .any(|window| window == token.as_bytes())
    );
    let key = fixture.db.layout().keys().join("knowledge.key");
    assert_eq!(std::fs::read(&key).unwrap().len(), 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let update = |url: &str, action: &str, token: Option<&str>| json!({"projectId": "p1", "url": url, "branch": "main", "folder": "docs", "tokenAction": action, "token": token});
    let (status, _) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update(https, "replace", Some(" ")),
            Some(1),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an empty replacement is refused"
    );
    // A saved token only ever goes to the host it was entered for.
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update("https://git.attacker.test/team/docs.git", "keep", None),
            Some(1),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("token"), "{body}");
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update(
                "https://reader@git.example.test/team/handbook.git",
                "keep",
                None,
            ),
            Some(1),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["entities"][0]["hasToken"], true,
        "the same host keeps it"
    );
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update(https, "remove", None),
            Some(2),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["entities"][0]["hasToken"], false);

    let ssh = "git@git.example.test:team/docs.git";
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update(ssh, "replace", Some(token)),
            Some(3),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "tokens are for HTTPS: {body}"
    );
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            update(ssh, "keep", None),
            Some(3),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let public = body["entities"][0]["deployKey"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(public.starts_with("ssh-ed25519 "));
    assert_eq!(body["entities"][0]["transport"], "ssh");
    let (status, created) = fixture
        .command(
            &fixture.admin,
            "knowledge.deploy-key.create",
            json!({"projectId": "p1"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        created["entities"][0]["publicKey"], public,
        "the key is kept"
    );
    let private: Vec<u8> = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT private_key_ciphertext FROM knowledge_deploy_keys WHERE project_id='p1'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(!private.windows(7).any(|window| window == b"OPENSSH"));

    let (status, _) = fixture
        .command(
            &fixture.member,
            "knowledge.disconnect",
            json!({"projectId": "p1"}),
            Some(4),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.disconnect",
            json!({"projectId": "p1"}),
            Some(4),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(fixture.view(&fixture.admin).await["state"], "unconnected");
    let remaining: i64 = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT count(*) FROM knowledge_sources)+(SELECT count(*) FROM knowledge_deploy_keys)
                       +(SELECT count(*) FROM knowledge_files)",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    assert_eq!(fixture.events("knowledge.disconnected").await, 1);
}

#[tokio::test]
async fn commands_validate_locations_and_replay_retries() {
    let fixture = Fixture::new().await;
    let connect = |url: &str, branch: &str, folder: &str| json!({"projectId": "p1", "url": url, "branch": branch, "folder": folder});
    for (payload, field) in [
        (
            connect("http://git.example.test/team/docs.git", "main", "docs"),
            "url",
        ),
        (
            connect(
                "https://bot:secret@git.example.test/team/docs.git",
                "main",
                "docs",
            ),
            "url",
        ),
        (connect("ext::sh -c touch% /tmp/x", "main", "docs"), "url"),
        (
            connect("https://git.example.test/team/docs.git", "-main", "docs"),
            "branch",
        ),
        (
            connect("https://git.example.test/team/docs.git", "main", "../docs"),
            "folder",
        ),
    ] {
        let (status, body) = fixture
            .command(&fixture.admin, "knowledge.connect", payload, None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body.to_string().contains(field), "{field}: {body}");
    }
    let (status, body) = fixture
        .command(
            &fixture.admin,
            "knowledge.connect",
            json!({"projectId": "p1", "url": "git@git.example.test:team/docs.git", "branch": "main", "token": "secret"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let payload = connect("https://git.example.test/team/docs.git", "main", "docs");
    let first = fixture
        .command_with_key(
            &fixture.admin,
            "knowledge.connect",
            payload.clone(),
            None,
            "same-key",
        )
        .await;
    let retry = fixture
        .command_with_key(
            &fixture.admin,
            "knowledge.connect",
            payload.clone(),
            None,
            "same-key",
        )
        .await;
    assert_eq!((first.0, retry.0), (StatusCode::OK, StatusCode::OK));
    assert_eq!(retry.1["replayed"], true);
    let (status, _) = fixture
        .command(&fixture.admin, "knowledge.connect", payload, None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "one source per project");
    let (status, _) = fixture
        .command(
            &fixture.admin,
            "knowledge.update",
            json!({"projectId": "p1"}),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "updates need a revision");
}
