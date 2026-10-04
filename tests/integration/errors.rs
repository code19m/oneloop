use std::{
    io::Write,
    sync::{Arc, Mutex},
};

use axum::{body::to_bytes, response::IntoResponse};
use oneloop::AppError;

use crate::support::http::{body_bytes, body_text};

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}

#[tokio::test]
async fn internal_cause_and_reference_are_logged_but_only_reference_reaches_client() {
    let capture = Capture(Arc::default());
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(capture.clone())
        .finish();
    let responses = tracing::subscriber::with_default(subscriber, || {
        let span = tracing::info_span!(
            "request",
            method = "POST",
            route = "/api/test",
            request_id = "request-check"
        );
        let _entered = span.enter();
        [
            (
                AppError::Io("Permission denied while storing a file".into()).into_response(),
                "Permission denied",
            ),
            (
                AppError::Unavailable(
                    "data lease is busy at /private/data/.oneloop-data.lock".into(),
                )
                .into_response(),
                "/private/data/.oneloop-data.lock",
            ),
        ]
    });
    let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("/api/test") && log.contains("request-check"));
    for (response, private) in responses {
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(log.contains(private), "{log}");
        assert!(log.contains(body["error"]["reference"].as_str().unwrap()));
        assert!(!String::from_utf8_lossy(&bytes).contains(private));
    }
}

#[tokio::test]
async fn busy_data_lease_returns_a_safe_retryable_http_error() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let (root, db) = crate::support::database();
    let session = crate::support::add_user(&db, "person", false).await;
    let config = crate::support::config(root.path(), "http://127.0.0.1:18710", &[]);
    let app = oneloop::application(oneloop::AppState::new(config, db)).router;
    let lock_path = root.path().join(".oneloop-data.lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    lock.lock().unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/auth/avatar")
                .header("origin", "http://127.0.0.1:18710")
                .header("cookie", format!("oneloop_session={}", session.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    drop(lock);
    assert_eq!(response.status(), 503);
    assert_eq!(response.headers()["retry-after"], "1");
    let body = body_text(response).await;
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"]["code"], "unavailable");
    assert!(!body.contains(root.path().to_str().unwrap()), "{body}");
    assert!(!body.contains(".oneloop-data.lock"), "{body}");
    let reference = json["error"]["reference"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(reference).is_ok());
}

#[test]
fn sqlite_contention_has_retryable_http_status() {
    for code in [rusqlite::ffi::SQLITE_BUSY, rusqlite::ffi::SQLITE_LOCKED] {
        let error = AppError::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            None,
        ));
        let response = error.into_response();
        assert_eq!(response.status(), 503);
        assert_eq!(response.headers()["retry-after"], "1");
    }
    assert!(
        rusqlite::version_number() >= 3_051_003,
        "SQLite {} lacks WAL reset fix",
        rusqlite::version()
    );
}

#[tokio::test]
async fn revision_errors_expose_both_revisions() {
    let response = AppError::revision(3, 7).into_response();
    assert_eq!(response.status(), 409);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "revision_conflict");
    assert_eq!(
        body["error"]["details"],
        serde_json::json!({"expectedRevision":3,"currentRevision":7})
    );
}

#[tokio::test]
async fn application_errors_have_stable_json_and_hide_internal_details() {
    let response = AppError::RateLimited { retry_after: 42 }.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "42");

    let response = AppError::Database("secret database path".to_owned()).into_response();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    );
    let bytes = body_bytes(response).await;
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(body.contains("internal_error"));
    assert!(!body.contains("secret database path"));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let reference = json["error"]["reference"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(reference).is_ok());
    assert!(
        json["error"]["message"]
            .as_str()
            .unwrap()
            .contains(reference)
    );
}

#[tokio::test]
async fn storage_exhaustion_has_safe_distinct_http_errors() {
    for error in [
        AppError::from(std::io::Error::new(
            std::io::ErrorKind::StorageFull,
            "private path",
        )),
        AppError::from(std::io::Error::new(
            std::io::ErrorKind::QuotaExceeded,
            "private quota",
        )),
        AppError::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
            Some("private database".into()),
        )),
    ] {
        assert_eq!(error.code(), "storage_full");
        let response = error.into_response();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INSUFFICIENT_STORAGE
        );
        assert!(!response.headers().contains_key("retry-after"));
        let body = body_text(response).await;
        assert!(body.contains("ask an administrator to free space"));
        assert!(!body.contains("private"));
    }
}
