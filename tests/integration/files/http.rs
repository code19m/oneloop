use super::png;
use crate::support::{
    self, Role,
    http::{body_bytes, body_json},
    query_one, seed_project, session_cookie,
};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use oneloop::{
    AppState, Db, application,
    auth::Actor,
    files::{AttachmentView, FileService},
};
use tempfile::TempDir;
use tower::ServiceExt;

pub(super) struct Fixture {
    pub(super) _directory: TempDir,
    pub(super) app: Router,
    pub(super) files: FileService,
    pub(super) db: Db,
    pub(super) manager: Actor,
    pub(super) admin: Actor,
    pub(super) manager_cookie: String,
    outsider_cookie: String,
}

impl Fixture {
    pub(super) async fn new() -> Self {
        Self::with_storage_limit(100 * 1024 * 1024).await
    }

    pub(super) async fn with_storage_limit(limit: u64) -> Self {
        let (directory, db) = crate::support::database();
        let [manager, _, admin] = seed_project(
            &db,
            [
                ("manager", Role::Manager),
                ("outsider", Role::Outsider),
                ("admin", Role::Admin),
            ],
        )
        .await;
        let mut config = support::config(directory.path(), "https://tasks.example.test", &[]);
        config.storage_limit_bytes = limit;
        config.disk_min_free_bytes = 0;
        let application = application(AppState::new(config, db.clone()));
        Self {
            _directory: directory,
            app: application.router,
            files: application.files,
            db,
            manager,
            admin,
            manager_cookie: session_cookie("manager"),
            outsider_cookie: session_cookie("outsider"),
        }
    }

    pub(super) async fn upload(
        &self,
        key: &str,
        name: &str,
        bytes: &[u8],
    ) -> (StatusCode, Vec<u8>) {
        let boundary = "oneloop-test-boundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        self.upload_body(key, bytes.len(), body).await
    }

    async fn put_avatar(&self, cookie: &str, body: Body) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/auth/avatar")
                    .header(header::ORIGIN, "https://tasks.example.test")
                    .header(header::COOKIE, cookie)
                    .header(
                        header::CONTENT_TYPE,
                        "multipart/form-data; boundary=oneloop-test-boundary",
                    )
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn upload_body(&self, key: &str, size: usize, body: Vec<u8>) -> (StatusCode, Vec<u8>) {
        let boundary = "oneloop-test-boundary";
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks/task/attachments")
                    .header(header::ORIGIN, "https://tasks.example.test")
                    .header(header::COOKIE, &self.manager_cookie)
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("idempotency-key", key)
                    .header("x-file-size", size)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = body_bytes(response).await.to_vec();
        (status, bytes)
    }
}

#[tokio::test]
async fn multipart_envelope_failure_aborts_staging_and_preserves_retry() {
    let boundary = "oneloop-test-boundary";
    let first = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"first.txt\"\r\n\r\nhello"
    );
    let invalid_bodies = [
        format!(
            "{first}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"second.txt\"\r\n\r\nworld\r\n--{boundary}--\r\n"
        ),
        format!(
            "{first}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"extra\"\r\n\r\nvalue\r\n--{boundary}--\r\n"
        ),
        format!(
            "{first}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"broken.txt\"\r\n\r\nbroken"
        ),
    ];
    for (index, body) in invalid_bodies.into_iter().enumerate() {
        let fixture = Fixture::new().await;
        let key = format!("invalid-{index}");
        let (status, _) = fixture.upload_body(&key, 5, body.into_bytes()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "case {index}");
        assert_eq!(
            std::fs::read_dir(fixture._directory.path().join("staging"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            std::fs::read_dir(fixture._directory.path().join("files"))
                .unwrap()
                .count(),
            0
        );
        let listed = fixture
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/tasks/task/attachments")
                    .header(header::COOKIE, &fixture.manager_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let list: serde_json::Value = body_json(listed).await;
        assert_eq!(list["items"].as_array().unwrap().len(), 0);
        let (status, _) = fixture.upload(&key, "first.txt", b"hello").await;
        assert_eq!(status, StatusCode::CREATED, "retry case {index}");
        let (status, _) = fixture.upload(&key, "first.txt", b"hello").await;
        assert_eq!(status, StatusCode::OK, "replay case {index}");
    }
}

#[tokio::test]
async fn multipart_upload_over_global_json_limit_and_range_download_are_real() {
    let fixture = Fixture::new().await;
    let original = vec![0x5a; 300 * 1024];
    let (status, body) = fixture.upload("large-upload", "large.bin", &original).await;
    assert_eq!(status, StatusCode::CREATED);
    let attachment: AttachmentView = serde_json::from_slice(&body).unwrap();

    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(attachment.download_url.unwrap())
                .header(header::COOKIE, &fixture.manager_cookie)
                .header(header::RANGE, "bytes=1024-2047")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        "bytes 1024-2047/307200"
    );
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "1024");
    assert_eq!(
        response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .split(';')
            .next(),
        Some("attachment")
    );
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    let downloaded = body_bytes(response).await;
    assert_eq!(downloaded.as_ref(), &original[1024..2048]);

    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/attachments/{}/download", attachment.id))
                .header(header::COOKIE, &fixture.manager_cookie)
                .header(header::RANGE, "bytes=999999-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */307200");

    // A range the server doesn't support, such as two parts, gets the file.
    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/attachments/{}/download", attachment.id))
                .header(header::COOKIE, &fixture.manager_cookie)
                .header(header::RANGE, "bytes=0-1,4-5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_bytes(response).await.as_ref(), original.as_slice());
}

#[tokio::test]
async fn html_preview_keeps_server_sandbox_and_rechecks_current_access() {
    let fixture = Fixture::new().await;
    let html = br#"<!doctype html><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="preconnect" href="https://evil.test"><iframe src="https://evil.test"></iframe><script>document.body.dataset.ok='yes'</script><p>Kept</p>"#;
    let (status, body) = fixture.upload("html-upload", "preview.html", html).await;
    assert_eq!(status, StatusCode::CREATED);
    let attachment: AttachmentView = serde_json::from_slice(&body).unwrap();
    let preview_url = attachment.html_preview_url.unwrap();
    for destination in ["iframe", "document"] {
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&preview_url)
                    .header(header::COOKIE, &fixture.manager_cookie)
                    .header("sec-fetch-dest", destination)
                    .header("sec-fetch-site", "same-origin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-security-policy"],
            PREVIEW_POLICY
        );
    }

    let unauthenticated = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&preview_url)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let hidden = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&preview_url)
                .header(header::COOKIE, &fixture.outsider_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&preview_url)
                .header(header::COOKIE, &fixture.manager_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // No scripts, and nothing from other sites: only inline styles and
    // images and fonts embedded as data.
    assert_eq!(
        response.headers()["content-security-policy"],
        PREVIEW_POLICY
    );
    assert_eq!(response.headers()["x-dns-prefetch-control"], "off");
    assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "SAMEORIGIN");
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    let rendered = body_bytes(response).await;
    let rendered = String::from_utf8(rendered.to_vec())
        .unwrap()
        .to_ascii_lowercase();
    assert!(!rendered.contains("<base"));
    assert!(!rendered.contains("http-equiv"));
    assert!(!rendered.contains("<iframe"));
    assert!(!rendered.contains("<link"));
    assert!(rendered.contains("<p>kept</p>"));
}

#[tokio::test]
async fn a_deleted_attachment_comes_back_through_its_restore_endpoint() {
    let fixture = Fixture::new().await;
    let (status, body) = fixture.upload("undo-upload", "undo.txt", b"undo me").await;
    assert_eq!(status, StatusCode::CREATED);
    let attachment: AttachmentView = serde_json::from_slice(&body).unwrap();
    let send = |method: &str, uri: String, body: Body| {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, &fixture.manager_cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .header("idempotency-key", "undo-delete")
            .header(header::ORIGIN, "https://tasks.example.test");
        fixture.app.clone().oneshot(request.body(body).unwrap())
    };
    let deleted = send(
        "DELETE",
        format!(
            "/api/attachments/{}?expectedRevision={}",
            attachment.id, attachment.revision
        ),
        Body::empty(),
    )
    .await
    .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let restore = serde_json::json!({
        "expectedRevision": attachment.revision + 1,
        "idempotencyKey": "undo-restore",
    })
    .to_string();
    let uri = format!("/api/attachments/{}/restore", attachment.id);
    let restored = send("POST", uri, Body::from(restore)).await.unwrap();
    assert_eq!(restored.status(), StatusCode::OK);
    let restored: AttachmentView = serde_json::from_value(body_json(restored).await).unwrap();
    assert_eq!(restored.id, attachment.id);
    assert_eq!(restored.revision, attachment.revision + 2);
    assert!(restored.download_url.is_some());
}

#[tokio::test]
async fn html_previews_revalidate_without_cleaning_again_and_reload_sends_a_new_copy() {
    let f = Fixture::new().await;
    let (_, bytes) = f
        .upload("cached-preview", "report.html", b"<p>Report</p>")
        .await;
    let attachment: AttachmentView = serde_json::from_slice(&bytes).unwrap();
    let url = attachment.html_preview_url.unwrap();
    let get = |uri: String, cookie: &str, etag: Option<&header::HeaderValue>| {
        let mut request = Request::builder()
            .uri(uri)
            .header(header::COOKIE, cookie)
            .header("sec-fetch-dest", "iframe");
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        f.app.clone().oneshot(request.body(Body::empty()).unwrap())
    };
    let first = get(url.clone(), &f.manager_cookie, None).await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()[header::CACHE_CONTROL], "private, no-cache");
    let etag = first.headers()[header::ETAG].clone();
    assert_eq!(body_bytes(first).await, &b"<p>Report</p>"[..]);

    // A current copy is answered from the snapshot: the file is not opened.
    f.db.transaction(|tx| {
        tx.execute_batch("CREATE TRIGGER forbid_new_read_lease BEFORE INSERT ON file_leases BEGIN SELECT RAISE(ABORT,'unexpected read lease'); END;")?; Ok(())
    }).await.unwrap();
    let current = get(url.clone(), &f.manager_cookie, Some(&etag))
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(current.headers()[header::ETAG], etag);
    assert_eq!(current.headers()["content-security-policy"], PREVIEW_POLICY);
    assert!(body_bytes(current).await.is_empty());
    let hidden = get(url.clone(), &f.outsider_cookie, Some(&etag))
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
    f.db.transaction(|tx| {
        tx.execute_batch("DROP TRIGGER forbid_new_read_lease")?;
        Ok(())
    })
    .await
    .unwrap();

    let reload = get(format!("{url}?reload=1"), &f.manager_cookie, Some(&etag))
        .await
        .unwrap();
    assert_eq!(reload.status(), StatusCode::OK);
    assert_eq!(reload.headers()[header::CACHE_CONTROL], "private, no-store");
    assert!(!reload.headers().contains_key(header::ETAG));
    assert_eq!(reload.headers()["content-security-policy"], PREVIEW_POLICY);
    assert_eq!(body_bytes(reload).await, &b"<p>Report</p>"[..]);
}

#[tokio::test]
async fn html_preview_errors_are_pages_the_frame_shows_that_say_why() {
    let f = Fixture::new().await;
    let (_, bytes) = f
        .upload("busy-preview", "report.html", b"<p>Report</p>")
        .await;
    let attachment: AttachmentView = serde_json::from_slice(&bytes).unwrap();
    let url = format!("{}?reload=1", attachment.html_preview_url.unwrap());
    let get = |uri: String| {
        f.app.clone().oneshot(
            Request::builder()
                .uri(uri)
                .header(header::COOKIE, &f.manager_cookie)
                .header("sec-fetch-dest", "iframe")
                .body(Body::empty())
                .unwrap(),
        )
    };
    // Three pages of one person are being sent, as their bodies aren't read.
    let mut sending = Vec::new();
    for _ in 0..3 {
        let response = get(url.clone()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        sending.push(response);
    }
    let busy = get(url.clone()).await.unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.headers()[header::RETRY_AFTER], "1");
    let missing = get("/api/attachments/missing/preview/html".into())
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    for (response, problem) in [
        (busy, "Your other previews are still loading"),
        (missing, "This file is no longer available"),
    ] {
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(headers["content-security-policy"], PREVIEW_POLICY);
        assert_eq!(headers[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        let page = String::from_utf8(body_bytes(response).await.to_vec()).unwrap();
        assert!(page.contains(problem), "{page}");
        assert!(page.contains("<strong>Reload preview</strong>"), "{page}");
    }
    // A page that has been sent frees its place.
    body_bytes(sending.pop().unwrap()).await;
    assert_eq!(get(url).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn a_signed_out_preview_says_to_sign_in_again_inside_the_frame() {
    let f = Fixture::new().await;
    let (_, bytes) = f
        .upload("signed-out-preview", "report.html", b"<p>Report</p>")
        .await;
    let attachment: AttachmentView = serde_json::from_slice(&bytes).unwrap();
    let get = |uri: String| {
        f.app.clone().oneshot(
            Request::builder()
                .uri(uri)
                .header(header::COOKIE, "oneloop_session=ended")
                .header("sec-fetch-dest", "iframe")
                .body(Body::empty())
                .unwrap(),
        )
    };
    for uri in [
        attachment.html_preview_url.unwrap(),
        "/api/projects/p1/knowledge/preview/html?path=page.html".into(),
    ] {
        let response = get(uri).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(headers["content-security-policy"], PREVIEW_POLICY);
        assert_eq!(headers[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        let page = String::from_utf8(body_bytes(response).await.to_vec()).unwrap();
        assert!(page.contains("Sign in to oneloop again."), "{page}");
        assert!(!page.contains("<form"), "{page}");
    }
    // Every other route answers as before.
    let download = get(attachment.download_url.unwrap()).await.unwrap();
    assert_eq!(download.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(download.headers()[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(body_json(download).await["error"]["code"], "unauthorized");
}

/// The policy of every attachment and Knowledge HTML preview.
pub(crate) const PREVIEW_POLICY: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'; \
     img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

#[tokio::test]
async fn originals_never_supply_executable_mime_types() {
    let fixture = Fixture::new().await;
    let samples: &[(&str, &[u8])] = &[
        ("plain.mjs", b"alert(1)"),
        ("control.mjs", b"// \x01 control\nalert(1)"),
        ("binary.mjs", b"// \xff\nalert(1)"),
        ("active.svg", b"<svg><script>alert(1)</script></svg>"),
        ("active.html", b"<!doctype html><script>alert(1)</script>"),
    ];
    for (i, (name, bytes)) in samples.iter().enumerate() {
        let (status, body) = fixture.upload(&format!("inert-{i}"), name, bytes).await;
        assert_eq!(status, StatusCode::CREATED);
        let attachment: AttachmentView = serde_json::from_slice(&body).unwrap();
        for route in ["download", "source"] {
            let response = fixture
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/attachments/{}/{route}", attachment.id))
                        .header(header::COOKIE, &fixture.manager_cookie)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            if route == "source" && attachment.preview_kind.is_none() {
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
                continue;
            }
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                if route == "download" {
                    "application/octet-stream"
                } else {
                    "text/plain; charset=utf-8"
                }
            );
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
            assert_eq!(&body_bytes(response).await[..], *bytes);
        }
        for destination in [
            "script",
            "worker",
            "sharedworker",
            "serviceworker",
            "style",
            "object",
            "embed",
        ] {
            let response = fixture
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/attachments/{}/download", attachment.id))
                        .header(header::COOKIE, &fixture.manager_cookie)
                        .header("sec-fetch-dest", destination)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }
    for route in [
        "/api/users/manager/avatar",
        "/api/attachments/missing/preview/html",
    ] {
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(route)
                    .header(header::COOKIE, &fixture.manager_cookie)
                    .header("sec-fetch-dest", "script")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn replay_checks_content_even_when_name_and_size_match() {
    let f = Fixture::new().await;
    assert_eq!(
        f.upload("same-key", "same.txt", b"AAAA").await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        f.upload("same-key", "same.txt", b"AAAA").await.0,
        StatusCode::OK
    );
    let (status, bytes) = f.upload("same-key", "same.txt", b"BBBB").await;
    assert_eq!(status, StatusCode::CONFLICT);
    let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(error["error"]["code"], "idempotency_key_reused");
}

#[tokio::test]
async fn conditional_sources_recheck_access_without_allocating_read_leases() {
    let f = Fixture::new().await;
    let (_, bytes) = f.upload("conditional", "source.txt", b"hello").await;
    let attachment: AttachmentView = serde_json::from_slice(&bytes).unwrap();
    let url = attachment.source_url.unwrap();
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&url)
                .header(header::COOKIE, &f.manager_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );
    let etag = response.headers()[header::ETAG].clone();
    assert_eq!(body_bytes(response).await, &b"hello"[..]);
    f.db.transaction(|tx| {
        tx.execute_batch("CREATE TRIGGER forbid_new_read_lease BEFORE INSERT ON file_leases BEGIN SELECT RAISE(ABORT,'unexpected read lease'); END;")?; Ok(())
    }).await.unwrap();
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&url)
                .header(header::COOKIE, &f.manager_cookie)
                .header(header::IF_NONE_MATCH, &etag)
                .header(header::RANGE, "bytes=0-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(response.headers()[header::ETAG], etag);
    assert!(body_bytes(response).await.is_empty());
    f.db.transaction(|tx| {
        tx.execute(
            "UPDATE tasks SET deleted_at=unixepoch() WHERE id='task'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    for endpoint in [url, attachment.download_url.unwrap()] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(endpoint)
                    .header(header::COOKIE, &f.manager_cookie)
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn avatars_revalidate_versioned_and_unversioned_urls_and_reject_lost_access() {
    let f = Fixture::new().await;
    let manager = f.manager.clone();
    let service = oneloop::files::FileService::new(f.db.clone(), 1000000, 0);
    let url = service
        .upload_avatar(
            &manager,
            service.avatar_slot(&manager).unwrap(),
            png(1, 1, false),
        )
        .await
        .unwrap();
    for url in [
        url.clone(),
        url.split('?').next().unwrap().to_owned(),
        format!("{}?v=old", url.split('?').next().unwrap()),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::COOKIE, &f.manager_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache"
        );
        let etag = response.headers()[header::ETAG].clone();
        response.into_body().collect().await.unwrap();
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::COOKIE, &f.manager_cookie)
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::COOKIE, &f.outsider_cookie)
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

fn file_envelope(bytes: &[u8]) -> Vec<u8> {
    let mut body = b"--oneloop-test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"size.bin\"\r\n\r\n".to_vec();
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--oneloop-test-boundary--\r\n");
    body
}

#[tokio::test]
async fn upload_size_mismatches_release_staging_and_allow_same_key_retry() {
    let f = Fixture::new().await;
    for (index, claimed) in [3, 8].into_iter().enumerate() {
        let key = format!("size-mismatch-{index}");
        let (status, body) = f.upload_body(&key, claimed, file_envelope(b"hello")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
        assert_eq!(
            std::fs::read_dir(f.db.layout().staging()).unwrap().count(),
            0
        );
        let reservations: i64 =
            query_one(&f.db, "SELECT count(*) FROM upload_reservations", []).await;
        assert_eq!(reservations, 0);
        assert_eq!(
            f.upload(&key, "size.bin", &vec![b'x'; claimed]).await.0,
            StatusCode::CREATED
        );
    }
}

#[tokio::test]
async fn upload_declarations_are_checked_without_reading_the_body() {
    let f = Fixture::new().await;
    let oversize = (oneloop::files::MAX_ATTACHMENT_BYTES + 1).to_string();
    for size in [None, Some("abc"), Some(oversize.as_str())] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/tasks/task/attachments")
            .header(header::ORIGIN, "https://tasks.example.test")
            .header(header::COOKIE, &f.manager_cookie)
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=oneloop-test-boundary",
            )
            .header("idempotency-key", "unread-body");
        if let Some(size) = size {
            request = request.header("x-file-size", size);
        }
        let stream = tokio_stream::iter(std::iter::from_fn(
            || -> Option<Result<axum::body::Bytes, std::io::Error>> {
                panic!("invalid declaration must be rejected before polling the body")
            },
        ));
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::from_stream(stream)).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn an_uploaded_avatar_is_served_as_a_256_pixel_png() {
    let f = Fixture::new().await;
    let response = f
        .put_avatar(&f.manager_cookie, avatar_envelope(&png(1, 1, false)))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let url = body_json(response).await["avatarUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(url.starts_with("/api/users/"), "{url}");
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&url)
                .header(header::COOKIE, &f.manager_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let avatar = image::load_from_memory(&body_bytes(response).await).unwrap();
    assert_eq!((avatar.width(), avatar.height()), (256, 256));
    let refused = f
        .put_avatar(&f.manager_cookie, avatar_envelope(b"not an image"))
        .await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn one_person_uploads_one_avatar_at_a_time() {
    let f = Fixture::new().await;
    let slot = f.files.avatar_slot(&f.manager).unwrap();
    let response = f
        .put_avatar(&f.manager_cookie, avatar_envelope(&png(1, 1, false)))
        .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    // Someone else's upload goes ahead meanwhile.
    let response = f
        .put_avatar(&f.outsider_cookie, avatar_envelope(&png(1, 1, false)))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    drop(slot);
    let response = f
        .put_avatar(&f.manager_cookie, avatar_envelope(&png(1, 1, false)))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_refused_avatar_upload_is_answered_after_its_body_is_read() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let f = Fixture::new().await;
    let manager = f.manager.clone();
    let people = ["a", "b", "c", "d"].map(|name| Actor {
        user_id: name.into(),
        ..manager.clone()
    });
    let _taken: Vec<_> = people
        .iter()
        .map(|person| f.files.avatar_slot(person).unwrap())
        .collect();
    // The closing boundary comes in the last chunk, so the flag shows that
    // the whole body was read.
    let read = Arc::new(AtomicBool::new(false));
    let envelope = file_envelope(&png(1, 1, false));
    let mut chunks = vec![
        envelope[..envelope.len() / 2].to_vec(),
        envelope[envelope.len() / 2..].to_vec(),
    ]
    .into_iter();
    let last = read.clone();
    let body = Body::from_stream(tokio_stream::iter(std::iter::from_fn(move || {
        let chunk = chunks.next()?;
        if chunks.len() == 0 {
            last.store(true, Ordering::SeqCst);
        }
        Some(Ok::<_, std::io::Error>(chunk))
    })));
    let response = f.put_avatar(&f.manager_cookie, body).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");
    assert!(read.load(Ordering::SeqCst), "the body was read");
}

fn avatar_envelope(bytes: &[u8]) -> Body {
    Body::from(file_envelope(bytes))
}

#[tokio::test]
async fn multipart_and_avatar_limits_return_json_413() {
    let f = Fixture::new().await;
    for (route, method, size, declared) in [
        (
            "/api/tasks/task/attachments",
            "POST",
            oneloop::files::MAX_ATTACHMENT_BYTES as usize + 1024 * 1024 + 1,
            oneloop::files::MAX_ATTACHMENT_BYTES,
        ),
        (
            "/api/auth/avatar",
            "PUT",
            oneloop::files::MAX_AVATAR_BYTES as usize + 1,
            0,
        ),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(route)
                    .header(header::ORIGIN, "https://tasks.example.test")
                    .header(header::COOKIE, &f.manager_cookie)
                    .header(
                        header::CONTENT_TYPE,
                        "multipart/form-data; boundary=oneloop-test-boundary",
                    )
                    .header("idempotency-key", "oversize-body")
                    .header("x-file-size", declared)
                    .body(Body::from(file_envelope(&vec![b'a'; size])))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE, "{route}");
        assert!(
            response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .contains("application/json")
        );
        let body: serde_json::Value = body_json(response).await;
        assert_eq!(body["error"]["code"], "request_too_large");
        assert_eq!(
            std::fs::read_dir(f.db.layout().staging()).unwrap().count(),
            0
        );
    }
}

#[tokio::test]
async fn temporary_patch_alias_retains_existing_response_names_and_values() {
    let f = Fixture::new().await;
    let (_, bytes) = f.upload("temporary-alias", "sample.txt", b"hello").await;
    let uploaded: AttachmentView = serde_json::from_slice(&bytes).unwrap();
    for (revision, payload, temporary) in [
        (
            1,
            serde_json::json!({"temporary":true,"expectedRevision":1}),
            true,
        ),
        (
            2,
            serde_json::json!({"isEphemeral":false,"expectedRevision":2}),
            false,
        ),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/attachments/{}", uploaded.id))
                    .header(header::ORIGIN, "https://tasks.example.test")
                    .header(header::COOKIE, &f.manager_cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = body_json(response).await;
        assert_eq!(body["isEphemeral"], temporary);
        assert_eq!(body["revision"], revision + 1);
        assert_eq!(body["state"], "available");
        assert_eq!(body["previewKind"], "text");
    }
}
