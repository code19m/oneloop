use crate::support::http::body_text;

// The paused clock passes the 5-second lease wait at once.
#[tokio::test(start_paused = true)]
async fn busy_data_lease_returns_a_safe_retryable_http_error() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let (root, db) = crate::support::database();
    let session = crate::support::add_user(&db, "person", false).await;
    let app = crate::support::app(root.path(), &db, "http://127.0.0.1:18710", &[]).router;
    let lock_path = root.path().join(".oneloop-data.lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    lock.lock().unwrap();
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        app.oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/auth/avatar")
                .header("origin", "http://127.0.0.1:18710")
                .header("cookie", format!("oneloop_session={}", session.token))
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("a busy data lease must not wait forever")
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
