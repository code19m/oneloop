use std::{
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use oneloop::{
    Db,
    auth::Actor,
    collaboration::{ActivityInput, CollaborationRuntime, record_activity_tx},
    domain::DomainService,
};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde_json::json;
use tokio::time::{Duration, timeout};
use tower::ServiceExt;

use crate::support::{
    self, Role, SeededProject, command, drain, now, query_one, seeded_project, session_cookie,
};

async fn app() -> (tempfile::TempDir, Db, Actor, Router, CollaborationRuntime) {
    let SeededProject {
        root, db, alice, ..
    } = seeded_project().await;
    let application = support::app(root.path(), &db, "https://tasks.example.test", &[]);
    (
        root,
        db,
        alice,
        application.router,
        application.collaboration,
    )
}

async fn events(app: &Router, uri: &str) -> axum::response::Response {
    events_as(app, uri, &session_cookie("alice")).await
}

async fn events_as(app: &Router, uri: &str, cookie: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

/// Adds `count` members of project `p1` who are signed in, and returns their
/// session cookies.
async fn signed_in_members(db: &Db, count: usize) -> Vec<String> {
    let ids: Vec<String> = (0..count).map(|index| format!("member-{index}")).collect();
    let people: Vec<_> = ids.iter().map(|id| (id.as_str(), Role::Member)).collect();
    support::add_people(db, &people).await;
    ids.iter().map(|id| session_cookie(id)).collect()
}

async fn frame(body: &mut Body) -> String {
    let frame = timeout(Duration::from_secs(5), body.frame())
        .await
        .unwrap()
        .expect("stream ended")
        .unwrap();
    String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap()
}

/// Records `count` changes to task `task` by `actor`; each one becomes a hint
/// for the members of `p1`.
async fn hints(db: &Db, actor: &Actor, count: i64) {
    let actor = actor.clone();
    db.transaction(move |tx| {
        for index in 0..count {
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
}

/// Project checks that hints get before a stream sends them, one counter per
/// test, because tests run at the same time.
static CHECKS: [AtomicUsize; 2] = [const { AtomicUsize::new(0) }; 2];
const FULL_QUEUE: usize = 0;
const LAGGING: usize = 1;

/// Counts the checks by the text of `require_project`'s statement. If that
/// text changes, a test that waits for a count times out instead of passing.
fn count_checks<const TEST: usize>(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, sql) = event
        && sql.contains("FROM projects p JOIN users u")
    {
        CHECKS[TEST].fetch_add(1, Ordering::SeqCst);
    }
}

/// The application on a database with one connection, which counts its
/// project checks in `CHECKS[TEST]`.
async fn counting_app<const TEST: usize>(root: &Path) -> (Router, CollaborationRuntime) {
    let db = Db::open_with_pool_size(root, 1).unwrap();
    db.run(|connection| {
        connection.trace_v2(
            TraceEventCodes::SQLITE_TRACE_STMT,
            Some(count_checks::<TEST>),
        );
        Ok(())
    })
    .await
    .unwrap();
    let application = support::app(root, &db, "https://tasks.example.test", &[]);
    (application.router, application.collaboration)
}

/// Queues a change to the Inbox of `user_id`, which streams send as the hint
/// `id`.
async fn inbox_change(db: &Db, id: &str, user_id: &str) {
    let row = [id, user_id].map(str::to_owned);
    db.transaction(move |tx| {
        tx.execute(
            "INSERT INTO outbox_messages(id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
             VALUES(?1,'inbox.state_changed','inbox',?2,'{}',1,1)",
            row,
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
        .bootstrap(&alice, Default::default())
        .await
        .unwrap()
        .sync_cursor;
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
    hints(&db, &alice, 1).await;
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
                .header("cookie", &session_cookie("alice"))
                .header("last-event-id", "bad cursor")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_hint_says_that_its_change_re_spaced_a_column_only_when_it_did() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    let actor = alice.clone();
    db.transaction(move |tx| {
        for (revision, metadata) in [(2, json!({"respaced":true})), (3, json!({}))] {
            record_activity_tx(
                tx,
                &actor,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.moved",
                    field_key: Some("position"),
                    before: Some(json!(0)),
                    after: Some(json!(1)),
                    metadata,
                    entity_revision: Some(revision),
                },
                now(),
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let payloads: String = query_one(
        &db,
        "SELECT json_group_array(json(payload_json)) FROM (SELECT payload_json FROM outbox_messages
         WHERE json_extract(payload_json,'$.entityId')='task' ORDER BY json_extract(payload_json,'$.entityRevision'))",
        [],
    )
    .await;
    let payloads: serde_json::Value = serde_json::from_str(&payloads).unwrap();
    assert_eq!(payloads[0]["respaced"], json!(true));
    assert!(payloads[1].get("respaced").is_none(), "{payloads}");
    runtime.worker().run_once().await.unwrap();
    let respaced = frame(&mut body).await;
    assert!(respaced.contains(r#""respaced":true"#), "{respaced}");
    let other = frame(&mut body).await;
    assert!(other.contains("event: hint"), "{other}");
    assert!(!other.contains("respaced"), "{other}");
}

#[tokio::test]
async fn an_event_stream_names_the_person_it_is_for() {
    let (_root, _db, _alice, app, _runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    let first = frame(&mut body).await;
    assert!(first.contains("event: reconcile"), "{first}");
    assert!(first.contains(r#""userId":"alice""#), "{first}");
}

#[tokio::test]
async fn recipient_filter_and_delivery_authorization_drop_inaccessible_hints() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    // An owner-only event for Bob must never be emitted to Alice.
    inbox_change(&db, "bob-only", "bob").await;
    runtime.worker().run_once().await.unwrap();
    hints(&db, &alice, 1).await;
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
    // A stream sends in order, so Alice's own change arrives first only if
    // both hints before it were dropped.
    inbox_change(&db, "alice-own", "alice").await;
    runtime.worker().run_once().await.unwrap();
    let next = frame(&mut body).await;
    assert!(next.contains("id: alice-own\n"), "{next}");
    // Once Alice is a member again, her next hint arrives.
    db.transaction(|tx| {
        tx.execute("INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES('p1','alice',1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    hints(&db, &alice, 1).await;
    runtime.worker().run_once().await.unwrap();
    let delivered = frame(&mut body).await;
    assert!(delivered.contains("event: hint"), "{delivered}");
    assert!(
        delivered.contains(r#""kind":"activity.changed""#),
        "{delivered}"
    );
    drop(body);
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn lagging_streams_reconcile_and_shutdown_cancels_a_blocked_sender() {
    let (root, db, alice, _, _) = app().await;
    let (app, runtime) = counting_app::<LAGGING>(root.path()).await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    let left = runtime.authorization_permit().await;
    let right = runtime.authorization_permit().await;
    hints(&db, &alice, 600).await;
    drain(&runtime).await;
    drop((left, right));
    // At most the first hint arrives before the stream finds that it lagged.
    let mut sent = 0;
    while !frame(&mut body).await.contains("event: reconcile") {
        sent += 1;
        assert!(sent < 2, "the stream did not reconcile");
    }
    // Nobody reads on. The queue takes 63 hints, as its last place is kept
    // for `Replaced`, so the sender waits with the 64th.
    support::eventually("the sender waits on a full queue", async || {
        (CHECKS[LAGGING].load(Ordering::SeqCst) >= sent + 64).then_some(())
    })
    .await;
    runtime.shutdown();
    receivers(&runtime, 0).await;
}

#[tokio::test]
async fn three_hundred_streams_deliver_without_exhausting_database_admission() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut bodies = Vec::new();
    // Each person may keep sixteen streams open.
    for cookie in signed_in_members(&db, 20).await {
        for _ in 0..15 {
            let response = events_as(&app, "/api/events", &cookie).await;
            assert_eq!(response.status(), StatusCode::OK);
            let mut body = response.into_body();
            frame(&mut body).await;
            bodies.push(body);
        }
    }
    hints(&db, &alice, 1).await;
    let started = std::time::Instant::now();
    runtime.worker().run_once().await.unwrap();
    let mut reads = tokio::task::JoinSet::new();
    for _ in 0..60 {
        let app = app.clone();
        reads.spawn(async move {
            app.oneshot(
                Request::builder()
                    .uri("/api/inbox")
                    .header("cookie", &session_cookie("alice"))
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
    // The seventeenth closed the oldest, which says why first.
    let mut oldest = bodies.remove(0);
    assert!(frame(&mut oldest).await.contains("event: replaced"));
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
    hints(&db, &alice, 1).await;
    runtime.worker().run_once().await.unwrap();
    for body in &mut bodies {
        assert!(frame(body).await.contains("event: hint"));
    }
}

#[tokio::test]
async fn a_stream_with_a_full_queue_still_says_it_was_replaced() {
    let (root, db, alice, _, _) = app().await;
    let (app, runtime) = counting_app::<FULL_QUEUE>(root.path()).await;
    let mut oldest = events(&app, "/api/events").await.into_body();
    frame(&mut oldest).await;
    // More hints than the stream's queue holds, and nobody reads them.
    hints(&db, &alice, 80).await;
    drain(&runtime).await;
    support::eventually("the stream's queue is full", async || {
        (CHECKS[FULL_QUEUE].load(Ordering::SeqCst) >= 63).then_some(())
    })
    .await;
    let mut newer = Vec::new();
    for _ in 0..16 {
        let mut body = events(&app, "/api/events").await.into_body();
        frame(&mut body).await;
        newer.push(body);
    }
    let mut last = String::new();
    while let Some(next) = timeout(Duration::from_secs(5), oldest.frame())
        .await
        .unwrap()
    {
        last = String::from_utf8(next.unwrap().into_data().unwrap().to_vec()).unwrap();
    }
    assert!(last.contains("event: replaced"), "{last}");
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
    hints(&db, &alice, 1).await;
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
                    .header("cookie", &session_cookie("alice"))
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
    let mut admin = support::browser_actor("dave", "Dave", "s-dave", now());
    admin.is_admin = true;
    DomainService::new(db.clone(), crate::support::utc())
        .execute(
            &admin,
            command(
                oneloop::domain::DomainOperation::RemoveMembership,
                json!({"projectId":"p1","userId":"alice"}),
                "remove-http",
                Some(1),
            ),
        )
        .await
        .unwrap();
    drain(&runtime).await;
    let reconcile = frame(&mut body).await;
    assert!(reconcile.contains("event: reconcile"));
    assert!(!reconcile.contains("p1"));
    support::auth_service(&db).logout(&alice).await.unwrap();
    drain(&runtime).await;
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
    let before: i64 = query_one(
        &db,
        "SELECT last_activity_at FROM sessions WHERE id='s-alice'",
        [],
    )
    .await;
    db.transaction(|tx| {
        tx.execute("UPDATE sessions SET revoked_at=1 WHERE id='s-alice'", [])?;
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
    let after: i64 = query_one(
        &db,
        "SELECT last_activity_at FROM sessions WHERE id='s-alice'",
        [],
    )
    .await;
    assert_eq!(before, after);
}

#[tokio::test]
async fn operational_authorization_failure_closes_instead_of_dropping_a_hint() {
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    hints(&db, &alice, 1).await;
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
    let (_root, db, alice, app, runtime) = app().await;
    let mut body = events(&app, "/api/events").await.into_body();
    frame(&mut body).await;
    db.transaction(|tx| {tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p2','Remaining','TWO',1,1)",[])?;Ok(())}).await.unwrap();
    let mut admin = support::browser_actor("dave", "Dave", "s-dave", now());
    admin.is_admin = true;
    DomainService::new(db.clone(), crate::support::utc())
        .execute(
            &admin,
            command(
                oneloop::domain::DomainOperation::DeleteProject,
                json!({"projectId":"p1","confirmedName":"Project"}),
                "delete-http",
                Some(1),
            ),
        )
        .await
        .unwrap();
    drain(&runtime).await;
    let reconcile = frame(&mut body).await;
    assert!(reconcile.contains("event: reconcile"));
    assert!(!reconcile.contains("p1") && !reconcile.contains("Project"));
    // No hint about the deleted project follows before the stream ends.
    support::auth_service(&db).logout(&alice).await.unwrap();
    drain(&runtime).await;
    assert!(
        timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none()
    );
    receivers(&runtime, 0).await;
}
