use crate::support::{
    self,
    http::{body_bytes, body_json},
};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use oneloop::{
    AppState, Db, application,
    auth::unix_now,
    files::{AttachmentView, FileService},
};
use rusqlite::params;
use tempfile::TempDir;
use tower::ServiceExt;

pub(super) struct Fixture {
    pub(super) _directory: TempDir,
    pub(super) app: Router,
    pub(super) files: FileService,
    pub(super) db: Db,
    pub(super) manager_cookie: String,
    outsider_cookie: String,
}

impl Fixture {
    pub(super) async fn new() -> Self {
        let (directory, db) = crate::support::database();
        let manager = support::add_user(&db, "manager", false).await;
        let outsider = support::add_user(&db, "outsider", false).await;
        let manager_id = manager.actor.user_id.clone();
        db.run(move |connection| {
            let now = unix_now()?;
            connection.execute(
                "INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at)
                 VALUES('p1','Project','PRJ',?1,?2,?2)",
                params![manager_id, now],
            )?;
            connection.execute(
                "INSERT INTO project_prefixes(prefix,project_id,reserved_at) VALUES('PRJ','p1',?1)",
                [now],
            )?;
            connection.execute(
                "INSERT INTO project_sequences(project_id,next_task_number) VALUES('p1',2)",
                [],
            )?;
            connection.execute(
                "INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at)
                 VALUES('p1',?1,1,?2,?2)",
                params![manager_id, now],
            )?;
            connection.execute(
                "INSERT INTO tracks(id,project_id,name,position,created_by,created_at,updated_at)
                 VALUES('track','p1','Track',0,?1,?2,?2)",
                params![manager_id, now],
            )?;
            connection.execute(
                "INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_by,created_at,updated_at)
                 VALUES('epic','p1','track','Epic','2026-01-01',0,?1,?2,?2)",
                params![manager_id, now],
            )?;
            connection.execute(
                "INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                 VALUES('task','p1','epic',1,'PRJ-001','Task','planning',0,?1,?2,?2)",
                params![manager_id, now],
            )?;
            Ok(())
        })
        .await
        .unwrap();

        let mut config = support::config(directory.path(), "https://tasks.example.test", &[]);
        config.storage_limit_bytes = 100 * 1024 * 1024;
        config.disk_min_free_bytes = 0;
        let application = application(AppState::new(config, db.clone()));
        Self {
            _directory: directory,
            app: application.router,
            files: application.files,
            db,
            manager_cookie: format!("__Host-oneloop_session={}", manager.token),
            outsider_cookie: format!("__Host-oneloop_session={}", outsider.token),
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
    let send = |method: &str, uri: String, origin: bool, body: Body| {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, &fixture.manager_cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .header("idempotency-key", "undo-delete");
        if origin {
            request = request.header(header::ORIGIN, "https://tasks.example.test");
        }
        fixture.app.clone().oneshot(request.body(body).unwrap())
    };
    let deleted = send(
        "DELETE",
        format!(
            "/api/attachments/{}?expectedRevision={}",
            attachment.id, attachment.revision
        ),
        true,
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
    let cross_site = send("POST", uri.clone(), false, Body::from(restore.clone()))
        .await
        .unwrap();
    assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);
    let restored = send("POST", uri, true, Body::from(restore)).await.unwrap();
    assert_eq!(restored.status(), StatusCode::OK);
    let restored: AttachmentView = serde_json::from_value(body_json(restored).await).unwrap();
    assert_eq!(restored.id, attachment.id);
    assert_eq!(restored.revision, attachment.revision + 2);
    assert!(restored.download_url.is_some());
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
    use image::ImageEncoder;
    let f = Fixture::new().await;
    let manager = oneloop::auth::AuthService::new(f.db.clone())
        .authenticate_session(f.manager_cookie.split_once('=').unwrap().1, false)
        .await
        .unwrap();
    let service = oneloop::files::FileService::new(f.db.clone(), 1000000, 0);
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let url = service.upload_avatar(&manager, png).await.unwrap();
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
        let reservations: i64 = f
            .db
            .run(|c| Ok(c.query_row("SELECT count(*) FROM upload_reservations", [], |r| r.get(0))?))
            .await
            .unwrap();
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
async fn unsupported_ranges_deliver_full_file_and_unsatisfiable_ranges_return_416() {
    let f = Fixture::new().await;
    let (_, body) = f.upload("range-fallback", "range.bin", b"0123456789").await;
    let attachment: AttachmentView = serde_json::from_slice(&body).unwrap();
    for range in [
        "items=0-1",
        "bytes=0-1,4-5",
        "bytes=9-3",
        "bytes=invalid",
        "bytes=10-",
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(attachment.download_url.as_ref().unwrap())
                    .header(header::COOKIE, &f.manager_cookie)
                    .header(header::RANGE, range)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        if range == "bytes=10-" {
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        } else {
            assert_eq!(response.status(), StatusCode::OK, "{range}");
            assert_eq!(body_bytes(response).await.as_ref(), b"0123456789");
        }
    }
}

#[tokio::test]
async fn embedded_katex_keeps_woff2_and_licenses_without_unused_formats() {
    let f = Fixture::new().await;
    for (path, status) in [
        ("/vendor/katex/LICENSE", StatusCode::NOT_FOUND),
        (
            "/vendor/katex/fonts/KaTeX_Main-Regular.woff2",
            StatusCode::OK,
        ),
        (
            "/vendor/katex/fonts/KaTeX_Main-Regular.woff",
            StatusCode::NOT_FOUND,
        ),
        (
            "/vendor/katex/fonts/KaTeX_Main-Regular.ttf",
            StatusCode::NOT_FOUND,
        ),
        (
            "/vendor/github-markdown-css/dark.css",
            StatusCode::NOT_FOUND,
        ),
        ("/vendor/cdn-assets/dark.css", StatusCode::NOT_FOUND),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
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
