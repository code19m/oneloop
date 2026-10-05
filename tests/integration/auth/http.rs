use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use oneloop::{
    AppState, Db,
    auth::{NewUser, create_user},
};
use tower::ServiceExt;

use crate::support::http::{body_bytes, body_json};

fn application() -> (tempfile::TempDir, Db, Router) {
    application_at("https://tasks.example.test")
}

fn application_at(public_url: &str) -> (tempfile::TempDir, Db, Router) {
    let (directory, db) = crate::support::database();
    let config = crate::support::config(directory.path(), public_url, &[]);
    let state = AppState::new(config, db.clone());
    let app = oneloop::application(state).router;
    (directory, db, app)
}

async fn seed_user(db: &Db) {
    db.transaction(|tx| {
        create_user(
            tx,
            NewUser {
                username: "person".into(),
                display_name: "Person".into(),
                password: "correct horse battery staple".into(),
                is_admin: false,
                must_change_password: false,
            },
            1_700_000_000,
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

fn login_request(origin: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    builder
        .body(Body::from(
            r#"{"username":"person","password":"correct horse battery staple"}"#,
        ))
        .unwrap()
}

#[tokio::test]
async fn login_rejects_missing_or_cross_origin_and_issues_a_secure_cookie() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    assert_eq!(
        app.clone()
            .oneshot(login_request(None))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(login_request(Some("https://evil.example")))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    let response = app
        .clone()
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.starts_with("__Host-oneloop_session="));
    assert!(cookie.contains("; Secure"));
    let session_cookie = cookie.split(';').next().unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header(header::COOKIE, session_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json: serde_json::Value = body_json(response).await;
    assert_eq!(json["user"]["username"], "person");
    assert_eq!(json["mustChangePassword"], false);
}

#[tokio::test]
async fn duplicate_session_cookies_fail_closed() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    let response = app
        .clone()
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let duplicate = format!("{cookie}; {cookie}");
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header(header::COOKIE, duplicate)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rejected_login_origins_report_the_configured_address_without_creating_sessions() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    for origin in [
        None,
        Some("null"),
        Some("http://localhost:8080"),
        Some("https://evil.example"),
        Some("https://tasks.example.test/path"),
    ] {
        let response = app.clone().oneshot(login_request(origin)).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let body = body_bytes(response).await;
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "invalid_origin");
        assert_eq!(
            value["error"]["details"]["canonicalUrl"],
            "https://tasks.example.test/"
        );
        assert_eq!(
            value["error"]["message"],
            "Open oneloop at https://tasks.example.test/ and try again."
        );
    }
    let sessions: i64 = db
        .run(|connection| {
            Ok(connection.query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}

fn password_request(path: &str, cookie: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::ORIGIN, "https://tasks.example.test")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie)
        .body(Body::from(body.to_owned()))
        .unwrap()
}

#[tokio::test]
async fn maximum_escaped_passwords_can_be_changed_and_used_to_sign_in() {
    let (_root, db, app) = application();
    let username = "a".repeat(32);
    let name = username.clone();
    db.transaction(move |tx| {
        create_user(
            tx,
            NewUser {
                username: name,
                display_name: "Person".into(),
                password: "\0".repeat(8192),
                is_admin: false,
                must_change_password: false,
            },
            oneloop::auth::unix_now()?,
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let mut current = "\\u0000".repeat(8192);
    let mut cookie = String::new();
    for next in [
        Some("\\u0001".repeat(16384)),
        Some("\\u0002".repeat(16384)),
        Some("\\ud83d\\ude00".repeat(4096)),
        None,
    ] {
        let body = format!(r#"{{"username":"{username}","password":"{current}"}}"#);
        let response = app
            .clone()
            .oneshot(password_request("/api/auth/login", "", &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        if let Some(next) = next {
            let body = format!(r#"{{"currentPassword":"{current}","newPassword":"{next}"}}"#);
            let response = app
                .clone()
                .oneshot(password_request(
                    "/api/auth/change-password",
                    &cookie,
                    &body,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            current = next;
        }
    }
    for path in ["/api/auth/login", "/api/auth/change-password"] {
        let oversized = format!("{}x", "😀".repeat(4096));
        let body = if path.ends_with("login") {
            serde_json::json!({"username":username,"password":oversized})
        } else {
            serde_json::json!({"currentPassword":"😀".repeat(4096),"newPassword":oversized})
        }
        .to_string();
        let response = app
            .clone()
            .oneshot(password_request(path, &cookie, &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(response).await["error"]["code"],
            "validation_failed"
        );
    }
}

#[tokio::test]
async fn incorrect_password_is_correctable_but_revoked_credentials_still_expire() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    let response = app
        .clone()
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    for (path, body, field) in [
        (
            "/api/auth/recent-auth",
            r#"{"password":"wrong"}"#,
            "password",
        ),
        (
            "/api/auth/change-password",
            r#"{"currentPassword":"wrong","newPassword":"new password"}"#,
            "currentPassword",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(password_request(path, &cookie, body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        let json: serde_json::Value = body_json(response).await;
        assert_eq!(json["error"]["code"], "incorrect_password");
        assert_eq!(json["error"]["details"]["field"], field);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    db.run(|connection| {
        connection.execute("UPDATE sessions SET revoked_at=1", [])?;
        Ok(())
    })
    .await
    .unwrap();
    for (path, body) in [
        ("/api/auth/recent-auth", r#"{"password":"wrong"}"#),
        (
            "/api/auth/change-password",
            r#"{"currentPassword":"wrong","newPassword":"new password"}"#,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(password_request(path, &cookie, body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let json: serde_json::Value = body_json(response).await;
        assert_eq!(json["error"]["code"], "unauthorized");
    }
}

#[tokio::test]
async fn password_gate_delay_has_retry_after_and_preserves_session() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    let response = app
        .clone()
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    for _ in 0..5 {
        assert_eq!(
            app.clone()
                .oneshot(password_request(
                    "/api/auth/recent-auth",
                    &cookie,
                    r#"{"password":"wrong"}"#
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let response = app
        .clone()
        .oneshot(password_request(
            "/api/auth/change-password",
            &cookie,
            r#"{"currentPassword":"wrong","newPassword":"new password"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(
        response.headers()[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_eq!(
        app.oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap()
        )
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn invalid_login_has_neutral_copy_for_unknown_inactive_and_wrong_password_accounts() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    for username in ["person", "missing", "!"] {
        let body = serde_json::json!({"username":username,"password":"wrong"}).to_string();
        let response = app
            .clone()
            .oneshot(password_request("/api/auth/login", "", &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let json: serde_json::Value = body_json(response).await;
        assert_eq!(json["error"]["code"], "invalid_credentials");
        assert_eq!(json["error"]["message"], "Incorrect username or password.");
    }
    db.run(|connection| {
        connection.execute("UPDATE users SET is_active=0", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let response = app
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    let json: serde_json::Value = body_json(response).await;
    assert_eq!(json["error"]["code"], "invalid_credentials");
}

fn logout_request(cookie: Option<&str>, origin: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().method("POST").uri("/api/auth/logout");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    request.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn logout_is_idempotent_and_clears_dead_cookies_but_enforces_origin() {
    for public_url in ["https://tasks.example.test", "http://localhost:8080"] {
        let (_directory, db, app) = application_at(public_url);
        seed_user(&db).await;
        let response = app
            .clone()
            .oneshot(login_request(Some(public_url)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let name = cookie.split('=').next().unwrap();
        let clearing = format!(
            "{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
            if public_url.starts_with("https:") {
                "; Secure"
            } else {
                ""
            }
        );
        for origin in [None, Some("null"), Some("https://evil.example")] {
            let response = app
                .clone()
                .oneshot(logout_request(Some(&cookie), origin))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(!response.headers().contains_key(header::SET_COOKIE));
        }
        let malformed = format!("{name}=invalid!");
        let unknown = format!("{name}={}", "x".repeat(43));
        for stale in [
            Some(cookie.as_str()),
            Some(cookie.as_str()),
            None,
            Some("unrelated=1"),
            Some(malformed.as_str()),
            Some(unknown.as_str()),
        ] {
            let response = app
                .clone()
                .oneshot(logout_request(stale, Some(public_url)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert_eq!(response.headers()[header::SET_COOKIE], clearing);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/auth/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        for expiry in ["idle_expires_at", "absolute_expires_at", "revoked_at"] {
            let response = app
                .clone()
                .oneshot(login_request(Some(public_url)))
                .await
                .unwrap();
            let cookie = response.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_owned();
            db.run(move |connection| {
                let assignment = match expiry {
                    "absolute_expires_at" => "absolute_expires_at=1,idle_expires_at=1",
                    "idle_expires_at" => "idle_expires_at=1",
                    _ => "revoked_at=1",
                };
                connection.execute(&format!("UPDATE sessions SET {assignment}"), [])?;
                Ok(())
            })
            .await
            .unwrap();
            let response = app
                .clone()
                .oneshot(logout_request(Some(&cookie), Some(public_url)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert_eq!(response.headers()[header::SET_COOKIE], clearing);
        }
    }
}

#[tokio::test]
async fn rotated_cookies_keep_the_original_absolute_deadline() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    let response = app
        .clone()
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    let mut cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let deadline = oneloop::auth::unix_now().unwrap() + 3600;
    db.run(move |connection| {
        connection.execute(
            "UPDATE sessions SET created_at=?1,absolute_expires_at=?2,idle_expires_at=?2",
            rusqlite::params![deadline - oneloop::auth::SESSION_ABSOLUTE_SECONDS, deadline],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    for (path, body) in [
        (
            "/api/auth/recent-auth",
            r#"{"password":"correct horse battery staple"}"#,
        ),
        (
            "/api/auth/change-password",
            r#"{"currentPassword":"correct horse battery staple","newPassword":"new password"}"#,
        ),
    ] {
        let before = oneloop::auth::unix_now().unwrap();
        let response = app
            .clone()
            .oneshot(password_request(path, &cookie, body))
            .await
            .unwrap();
        let after = oneloop::auth::unix_now().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let issued = response.headers()[header::SET_COOKIE].to_str().unwrap();
        let max_age: i64 = issued
            .split("; ")
            .find_map(|part| part.strip_prefix("Max-Age="))
            .unwrap()
            .parse()
            .unwrap();
        assert!((deadline - after..=deadline - before).contains(&max_age));
        let rotated = issued.split(';').next().unwrap().to_owned();
        assert_ne!(cookie, rotated);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/auth/me")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        cookie = rotated;
    }
    let saved: i64 = db
        .run(|connection| {
            Ok(
                connection.query_row("SELECT absolute_expires_at FROM sessions", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(saved, deadline);
}

#[tokio::test]
async fn hsts_uses_public_url_and_covers_success_and_error_responses() {
    for public_url in ["https://tasks.example.test", "http://localhost:8080"] {
        let (_directory, _db, app) = application_at(public_url);
        for (method, path, status) in [
            ("GET", "/healthz", StatusCode::OK),
            ("GET", "/", StatusCode::OK),
            ("GET", "/api/auth/me", StatusCode::UNAUTHORIZED),
            ("POST", "/api/auth/logout", StatusCode::FORBIDDEN),
            ("GET", "/api/unknown", StatusCode::NOT_FOUND),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header(
                            "x-forwarded-proto",
                            if public_url.starts_with("https:") {
                                "http"
                            } else {
                                "https"
                            },
                        )
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            assert_eq!(
                response
                    .headers()
                    .get(header::STRICT_TRANSPORT_SECURITY)
                    .map(|value| value.to_str().unwrap()),
                public_url
                    .starts_with("https:")
                    .then_some("max-age=31536000")
            );
        }
    }
}

#[tokio::test]
async fn failed_logout_revocation_remains_retryable() {
    let (_directory, db, app) = application();
    seed_user(&db).await;
    let response = app
        .clone()
        .oneshot(login_request(Some("https://tasks.example.test")))
        .await
        .unwrap();
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    db.run(|connection| {
        connection.execute_batch(
            "CREATE TRIGGER fail_logout BEFORE UPDATE OF revoked_at ON sessions
            BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END;",
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let response = app
        .clone()
        .oneshot(logout_request(
            Some(&cookie),
            Some("https://tasks.example.test"),
        ))
        .await
        .unwrap();
    assert!(response.status().is_server_error());
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    db.run(|connection| {
        connection.execute_batch("DROP TRIGGER fail_logout;")?;
        Ok(())
    })
    .await
    .unwrap();
    let response = app
        .oneshot(logout_request(
            Some(&cookie),
            Some("https://tasks.example.test"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}
