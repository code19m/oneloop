use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use oneloop::{
    AppState, Db,
    auth::{Actor, token_hash},
    collaboration::{ActivityInput, CollaborationRuntime, record_activity_tx},
    domain::DomainService,
};
use serde_json::json;
use tokio::time::{Duration, timeout};
use tower::ServiceExt;

use crate::support::{self, SeededProject, now, seeded_project};

async fn app() -> (tempfile::TempDir, Db, Actor, Router, CollaborationRuntime) {
    let SeededProject {
        root, db, alice, ..
    } = seeded_project().await;
    db.transaction(|tx| {
        tx.execute(
            "UPDATE sessions SET token_hash=?1 WHERE id='sa'",
            [token_hash("alice-token-at-least-thirty-two-characters")],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let config = support::config(root.path(), "https://tasks.example.test", &[]);
    let application = oneloop::application(AppState::new(config, db.clone()));
    (
        root,
        db,
        alice,
        application.router,
        application.collaboration,
    )
}

async fn events(app: &Router, uri: &str) -> axum::response::Response {
    events_as(app, uri, "alice-token-at-least-thirty-two-characters").await
}

async fn events_as(app: &Router, uri: &str, token: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", format!("__Host-oneloop_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

/// Adds `count` members of project `p1` who are signed in, and returns their
/// session tokens.
async fn signed_in_members(db: &Db, count: usize) -> Vec<String> {
    let tokens: Vec<String> = (0..count)
        .map(|index| format!("member-{index}-token-at-least-thirty-two-characters"))
        .collect();
    let rows = tokens.clone();
    db.transaction(move |tx| {
        let now = now();
        for (index, token) in rows.iter().enumerate() {
            let id = format!("member-{index}");
            tx.execute(
                "INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                 VALUES(?1,?1,?1,'x',?2,?2,?2)",
                rusqlite::params![id, now],
            )?;
            tx.execute(
                "INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES('p1',?1,?2,?2)",
                rusqlite::params![id, now],
            )?;
            tx.execute(
                "INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                 VALUES(?1,?1,?2,?3,?3,?3,?4,?4)",
                rusqlite::params![id, token_hash(token), now, now + 86_400],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    tokens
}

async fn frame(body: &mut Body) -> String {
    let frame = timeout(Duration::from_secs(5), body.frame())
        .await
        .unwrap()
        .expect("stream ended")
        .unwrap();
    String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap()
}

async fn hint(db: &Db, actor: &Actor) {
    let actor = actor.clone();
    db.transaction(move |tx| {
        record_activity_tx(
            tx,
            &actor,
            ActivityInput {
                project_id: Some("p1"),
                entity_type: "task",
                entity_id: "task",
                task_id: Some("task"),
                event_type: "task.updated",
                field_key: Some("title"),
                before: Some(json!("before")),
                after: Some(json!("after")),
                metadata: json!({}),
                entity_revision: Some(2),
            },
            now(),
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn receivers(runtime: &CollaborationRuntime, expected: usize) {
    timeout(Duration::from_secs(1), async {
        while runtime.receiver_count() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn event_streams_announce_readiness_reconcile_stale_cursors_and_end_on_shutdown() {
    let (_root, db, alice, app, runtime) = app().await;
    let cursor = DomainService::new(db.clone(), crate::support::utc())
        .sync_cursor(&alice)
        .await
        .unwrap();
    let response = events(&app, &format!("/api/events?cursor={cursor}")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    assert_eq!(
        response.headers()["cache-control"],
        "no-cache, no-transform"
    );
    let mut body = response.into_body();
    assert!(frame(&mut body).await.contains("event: ready"));
    assert_eq!(runtime.receiver_count(), 1);
    drop(body);
    receivers(&runtime, 0).await;
    hint(&db, &alice).await;
    let mut body = events(&app, &format!("/api/events?cursor={cursor}"))
        .await
        .into_body();
    assert!(frame(&mut body).await.contains("event: reconcile"));
    runtime.shutdown();
    assert!(
        timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none()
    );
    receivers(&runtime, 0).await;
    let invalid = app
        .oneshot(
            Request::builder()
                .uri("/api/events")
                .header(
                    "cookie",
                    "__Host-oneloop_session=alice-token-at-least-thirty-two-characters",
                )
                .header("last-event-id", "bad cursor")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn recipient_filter_and_delivery_authorization_drop_inaccessible_hints() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    // An owner-only event for Bob must never be emitted to Alice.
    db.transaction(|tx| {tx.execute("INSERT INTO outbox_messages(id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
        VALUES('bob-only','inbox.state_changed','inbox','bob','{}',1,1)",[])?;Ok(())}).await.unwrap();
    runtime.worker().run_once().await.unwrap();
    assert!(
        timeout(Duration::from_millis(50), body.frame())
            .await
            .is_err()
    );
    hint(&db, &alice).await;
    // Hold both delivery checks so membership is removed after recipient capture.
    let left = runtime.authorization_permit().await;
    let right = runtime.authorization_permit().await;
    runtime.worker().run_once().await.unwrap();
    db.transaction(|tx| {
        tx.execute("DELETE FROM project_memberships WHERE user_id='alice'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    drop((left, right));
    assert!(
        timeout(Duration::from_millis(100), body.frame())
            .await
            .is_err()
    );
    drop(body);
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn lagging_streams_reconcile_and_shutdown_cancels_a_blocked_sender() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    let left = runtime.authorization_permit().await;
    let right = runtime.authorization_permit().await;
    let actor = alice.clone();
    db.transaction(move |tx| {
        for index in 0..600 {
            record_activity_tx(
                tx,
                &actor,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!(index)),
                    after: Some(json!(index + 1)),
                    metadata: json!({}),
                    entity_revision: Some(index + 2),
                },
                now(),
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    while runtime.worker().run_once().await.unwrap() {}
    drop((left, right));
    let mut reconciled = false;
    for _ in 0..3 {
        if frame(&mut body).await.contains("event: reconcile") {
            reconciled = true;
            break;
        }
    }
    assert!(reconciled);
    // Leave the body unread while remaining hints fill its bounded queue.
    tokio::time::sleep(Duration::from_millis(100)).await;
    runtime.shutdown();
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn three_hundred_streams_deliver_without_exhausting_database_admission() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut bodies = Vec::new();
    // Each person may keep sixteen streams open.
    for token in signed_in_members(&db, 20).await {
        for _ in 0..15 {
            let response = events_as(&app, "/api/events", &token).await;
            assert_eq!(response.status(), StatusCode::OK);
            let mut body = response.into_body();
            frame(&mut body).await;
            bodies.push(body);
        }
    }
    hint(&db, &alice).await;
    let started = std::time::Instant::now();
    runtime.worker().run_once().await.unwrap();
    let mut reads = tokio::task::JoinSet::new();
    for _ in 0..60 {
        let app = app.clone();
        reads.spawn(async move {
            app.oneshot(
                Request::builder()
                    .uri("/api/inbox")
                    .header(
                        "cookie",
                        "__Host-oneloop_session=alice-token-at-least-thirty-two-characters",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
        });
    }
    while let Some(status) = reads.join_next().await {
        assert_eq!(status.unwrap(), StatusCode::OK);
    }
    for body in &mut bodies {
        assert!(frame(body).await.contains("event: hint"));
    }
    eprintln!("300 streams plus 60 Inbox reads: {:?}", started.elapsed());
    drop(bodies);
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn a_person_keeps_sixteen_streams_and_a_new_one_closes_the_oldest() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut bodies = Vec::new();
    for _ in 0..16 {
        let mut body = events(&app, "/api/events").await.into_body();
        frame(&mut body).await;
        bodies.push(body);
    }
    // A closed stream frees its place, so the next one closes nothing.
    drop(bodies.pop());
    receivers(&runtime, 15).await;
    for _ in 0..2 {
        let mut body = events(&app, "/api/events").await.into_body();
        frame(&mut body).await;
        bodies.push(body);
    }
    // The seventeenth closed the oldest.
    let mut oldest = bodies.remove(0);
    assert!(
        timeout(Duration::from_secs(5), oldest.frame())
            .await
            .unwrap()
            .is_none()
    );
    receivers(&runtime, 16).await;
    // Someone else still connects, and every open stream gets new hints.
    let member = signed_in_members(&db, 1).await.remove(0);
    let mut other = events_as(&app, "/api/events", &member).await.into_body();
    frame(&mut other).await;
    bodies.push(other);
    hint(&db, &alice).await;
    runtime.worker().run_once().await.unwrap();
    for body in &mut bodies {
        assert!(frame(body).await.contains("event: hint"));
    }
}

#[tokio::test]
async fn a_request_that_fails_closes_none_of_the_persons_streams() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut bodies = Vec::new();
    for _ in 0..16 {
        let mut body = events(&app, "/api/events").await.into_body();
        frame(&mut body).await;
        bodies.push(body);
    }
    // The snapshot check of a seventeenth stream fails.
    let rename = async |from: &'static str, to: &'static str| {
        db.run(move |connection| {
            connection.execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}"))?;
            Ok(())
        })
        .await
        .unwrap();
    };
    rename("security_events", "security_events_away").await;
    let failed = events(&app, "/api/events?cursor=snapshot").await;
    rename("security_events_away", "security_events").await;
    assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    receivers(&runtime, 16).await;
    hint(&db, &alice).await;
    runtime.worker().run_once().await.unwrap();
    for body in &mut bodies {
        assert!(frame(body).await.contains("event: hint"));
    }
}

#[tokio::test]
async fn pages_of_other_sites_cannot_open_streams() {
    let (_root, _db, _alice, app, _runtime) = app().await;
    for (site, status) in [
        ("same-origin", StatusCode::OK),
        ("none", StatusCode::OK),
        ("same-site", StatusCode::FORBIDDEN),
        ("cross-site", StatusCode::FORBIDDEN),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/events")
                    .header(
                        "cookie",
                        "__Host-oneloop_session=alice-token-at-least-thirty-two-characters",
                    )
                    .header("sec-fetch-site", site)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{site}");
    }
}

#[tokio::test]
async fn membership_removal_reconciles_and_session_revocation_closes_stream() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    let mut admin = support::browser_actor("dave", "Dave", "sd", now());
    admin.is_admin = true;
    DomainService::new(db.clone(), crate::support::utc())
        .execute(
            &admin,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::RemoveMembership,
                payload: json!({"projectId":"p1","userId":"alice"}),
                idempotency_key: "remove-http".into(),
                expected_revision: Some(1),
            },
        )
        .await
        .unwrap();
    while runtime.worker().run_once().await.unwrap() {}
    let reconcile = frame(&mut body).await;
    assert!(reconcile.contains("event: reconcile"));
    assert!(!reconcile.contains("p1"));
    oneloop::auth::AuthService::new(db)
        .logout(&alice)
        .await
        .unwrap();
    while runtime.worker().run_once().await.unwrap() {}
    assert!(
        timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none()
    );
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn periodic_revalidation_closes_idle_revoked_session_without_extending_it() {
    let (_root, db, _alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    let before: i64 = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT last_activity_at FROM sessions WHERE id='sa'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    db.transaction(|tx| {
        tx.execute("UPDATE sessions SET revoked_at=1 WHERE id='sa'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let closed = async {
        while let Some(frame) = body.frame().await {
            let bytes = frame.unwrap().into_data().unwrap();
            assert!(
                String::from_utf8_lossy(&bytes).starts_with(':'),
                "only keepalives may precede closure"
            );
        }
    };
    tokio::pin!(closed);
    // The stream task creates its 30-second revalidation interval after the
    // first frame, possibly after this point. Step virtual time so the check
    // fires however late the interval was registered.
    tokio::time::pause();
    let mut finished = false;
    for _ in 0..70 {
        tokio::select! {
            biased;
            _ = &mut closed => {
                finished = true;
                break;
            }
            _ = tokio::time::advance(Duration::from_secs(1)) => {}
        }
    }
    tokio::time::resume();
    if !finished {
        timeout(Duration::from_secs(5), closed).await.unwrap();
    }
    receivers(&runtime, 0).await;
    let after: i64 = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT last_activity_at FROM sessions WHERE id='sa'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn operational_authorization_failure_closes_instead_of_dropping_a_hint() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    hint(&db, &alice).await;
    db.transaction(|tx| {
        tx.execute_batch("ALTER TABLE sessions RENAME TO unavailable_sessions")?;
        Ok(())
    })
    .await
    .unwrap();
    runtime.worker().run_once().await.unwrap();
    assert!(
        timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none()
    );
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn project_deletion_reconciles_former_members_without_disclosing_context() {
    let (_root, db, _alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    db.transaction(|tx| {tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p2','Remaining','TWO',1,1)",[])?;Ok(())}).await.unwrap();
    let mut admin = support::browser_actor("dave", "Dave", "sd", now());
    admin.is_admin = true;
    DomainService::new(db.clone(), crate::support::utc())
        .execute(
            &admin,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::DeleteProject,
                payload: json!({"projectId":"p1","confirmedName":"Project"}),
                idempotency_key: "delete-http".into(),
                expected_revision: Some(1),
            },
        )
        .await
        .unwrap();
    while runtime.worker().run_once().await.unwrap() {}
    let reconcile = frame(&mut body).await;
    assert!(reconcile.contains("event: reconcile"));
    assert!(!reconcile.contains("p1") && !reconcile.contains("Project"));
    drop(body);
    receivers(&runtime, 0).await;
}
