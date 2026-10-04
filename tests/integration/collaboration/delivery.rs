use std::time::Instant;

use oneloop::{
    auth::ActorSource,
    collaboration::{
        ActivityInput, CollaborationCommand, CollaborationRuntime, CollaborationService,
        InboxFilter, NotificationInput, record_activity_tx, snapshot_notification_tx,
    },
};
use serde_json::json;

use crate::support::{SeededProject, browser_actor, now, seeded_project};

#[tokio::test]
async fn backward_clock_steps_split_activity_chains_without_blocking_domain_edits() {
    let SeededProject {
        root: _root,
        db,
        alice,
        ..
    } = seeded_project().await;
    let actor = alice.clone();
    db.transaction(move |tx| {
        tx.execute(
            "UPDATE project_memberships SET manage_board=1 WHERE user_id='alice'",
            [],
        )?;
        tx.execute(
            "UPDATE tasks SET title='Before correction',revision=2 WHERE id='task'",
            [],
        )?;
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
                before: Some(json!("Task")),
                after: Some(json!("Before correction")),
                metadata: json!({}),
                entity_revision: Some(2),
            },
            i64::MAX / 2,
        )?;
        // A smaller correction can stay after started_at while preceding latest_at.
        for (before, after, time) in [("a", "b", 1000), ("b", "c", 1200), ("c", "d", 1100)] {
            record_activity_tx(
                tx,
                &actor,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("description"),
                    before: Some(json!(before)),
                    after: Some(json!(after)),
                    metadata: json!({}),
                    entity_revision: None,
                },
                time,
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let domain = oneloop::domain::DomainService::new(db.clone(), chrono_tz::UTC);
    let updated = domain
        .execute(
            &alice,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::UpdateTask,
                payload: json!({"taskId":"task","title":"After correction"}),
                idempotency_key: "clock-corrected-edit".into(),
                expected_revision: Some(2),
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.entities[0]["title"], "After correction");
    let (raw, projections) = db.run(|conn| {
        let raw = conn.query_row("SELECT count(*) FROM activity_events", [], |row| row.get::<_, i64>(0))?;
        let projections = conn.prepare("SELECT field_key,started_at,latest_at FROM activity_projection ORDER BY field_key,started_at")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((raw, projections))
    }).await.unwrap();
    assert_eq!(raw, 5);
    assert_eq!(projections.len(), 4);
    assert_eq!(projections[0], ("description".into(), 1000, 1200));
    assert_eq!(projections[1], ("description".into(), 1100, 1100));
    assert_eq!(projections[3], ("title".into(), i64::MAX / 2, i64::MAX / 2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn competing_workers_claim_an_outbox_message_once() {
    let SeededProject {
        root: _root,
        db,
        alice,
        ..
    } = seeded_project().await;
    let available = now();
    db.transaction(move |tx| {
        snapshot_notification_tx(
            tx,
            &alice,
            NotificationInput {
                project_id: "p1",
                event_type: "test",
                task_id: None,
                comment_id: None,
                block_id: None,
                excerpt: Some("concurrent"),
                payload: json!({}),
            },
            vec!["bob".into()],
            available,
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let runtime = CollaborationRuntime::new(db.clone());
    let left = runtime.worker();
    let right = runtime.worker();
    let (a, b) = tokio::join!(left.run_once(), right.run_once());
    assert_eq!(
        [a.unwrap(), b.unwrap()]
            .into_iter()
            .filter(|value| *value)
            .count(),
        1
    );
    let delivered: i64 = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM notification_recipients
                 WHERE user_id='bob' AND delivered_at IS NOT NULL",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(delivered, 1);
}

#[tokio::test]
async fn activity_hints_include_task_scope_and_revision_for_targeted_reconciliation() {
    let SeededProject {
        root: _root,
        db,
        alice,
        ..
    } = seeded_project().await;
    let event_time = now();
    db.transaction(move |tx| {
        record_activity_tx(
            tx,
            &alice,
            ActivityInput {
                project_id: Some("p1"),
                entity_type: "task",
                entity_id: "task",
                task_id: Some("task"),
                event_type: "task.updated",
                field_key: Some("title"),
                before: Some(json!("Old")),
                after: Some(json!("New")),
                metadata: json!({}),
                entity_revision: Some(2),
            },
            event_time,
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let runtime = CollaborationRuntime::new(db);
    let mut hints = runtime.subscribe();
    assert!(runtime.worker().run_once().await.unwrap());
    let hint = hints.recv().await.unwrap();
    assert_eq!(hint.project_id.as_deref(), Some("p1"));
    assert_eq!(hint.task_id.as_deref(), Some("task"));
    assert_eq!(hint.entity_id.as_deref(), Some("task"));
    assert_eq!(hint.entity_revision, Some(2));
}

#[tokio::test]
async fn worker_failures_release_the_lease_and_schedule_a_retry() {
    let SeededProject {
        root: _root, db, ..
    } = seeded_project().await;
    let available = now();
    db.run(move|connection| {
        connection.execute(
            r#"INSERT INTO outbox_messages(id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
             VALUES('bad','domain.activity','task','one','{"projectId":123}',?1,?1)"#,[available])?;
        Ok(())
    }).await.unwrap();
    let runtime = CollaborationRuntime::new(db.clone());
    assert!(runtime.worker().run_once().await.is_err());
    let state:(i64,Option<i64>,Option<String>,Option<i64>)=db.run(|connection|Ok(connection.query_row(
        "SELECT attempt_count,locked_at,last_error,delivered_at FROM outbox_messages WHERE id='bad'",[],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?)).await.unwrap();
    assert_eq!(state.0, 1);
    assert!(state.1.is_none());
    assert!(state.2.is_some());
    assert!(state.3.is_none());
}

#[tokio::test]
async fn inbox_state_changes_emit_one_private_hint_and_noops_stay_quiet() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let event_time = now();
    let notification_id = db
        .transaction(move |tx| {
            snapshot_notification_tx(
                tx,
                &alice,
                NotificationInput {
                    project_id: "p1",
                    event_type: "test",
                    task_id: None,
                    comment_id: None,
                    block_id: None,
                    excerpt: Some("private"),
                    payload: json!({}),
                },
                vec!["bob".into()],
                event_time,
            )
        })
        .await
        .unwrap()
        .unwrap();
    let runtime = CollaborationRuntime::new(db.clone());
    let worker = runtime.worker();
    let mut first_tab = runtime.subscribe();
    let mut second_tab = runtime.subscribe();
    assert!(worker.run_once().await.unwrap());
    first_tab.recv().await.unwrap();
    second_tab.recv().await.unwrap();
    let service = CollaborationService::new(db);
    for (index, operation, expected) in [
        (0, "inbox.markRead", true),
        (1, "inbox.markRead", false),
        (2, "inbox.markUnread", true),
        (3, "inbox.markUnread", false),
        (4, "inbox.archive", true),
        (5, "inbox.archive", false),
        (6, "inbox.restore", true),
        (7, "inbox.restore", false),
        (8, "inbox.markUnread", true),
        (9, "inbox.bulkMarkRead", true),
        (10, "inbox.bulkMarkRead", false),
        (11, "inbox.bulkArchive", true),
        (12, "inbox.bulkArchive", false),
    ] {
        let payload = if operation.starts_with("inbox.bulk") {
            json!({"filter":{"projectIds":[],"unreadOnly":false,"archived":false}})
        } else {
            json!({"notificationId": notification_id})
        };
        service
            .execute(
                &bob,
                CollaborationCommand {
                    operation: operation.into(),
                    payload,
                    idempotency_key: format!("inbox-state-{index}"),
                    expected_revision: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(worker.run_once().await.unwrap(), expected, "{operation}");
        if expected {
            let left = first_tab.recv().await.unwrap();
            let right = second_tab.recv().await.unwrap();
            assert_eq!(left, right);
            assert_eq!(left.kind, "inbox.changed");
            assert_eq!(
                left.recipient_ids
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                vec!["bob"]
            );
            assert!(left.project_id.is_none());
            assert!(left.notification_id.is_none());
        }
    }
}

/// Run with `cargo test --test integration large_inbox_service_latency -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "manual 50,000-item Inbox latency measurement"]
async fn large_inbox_service_latency() {
    let SeededProject {
        root: _root,
        db,
        bob,
        ..
    } = seeded_project().await;
    let base = now();
    db.transaction(move |tx| {
        let mut events = tx.prepare_cached(
            "INSERT INTO notification_events(id,project_id,actor_user_id,event_type,payload_json,created_at)
             VALUES (?1,'p1','alice','test','{}',?2)",
        )?;
        let mut recipients = tx.prepare_cached(
            "INSERT INTO notification_recipients(notification_id,user_id,project_name_snapshot,actor_name_snapshot,delivered_at)
             VALUES (?1,'bob','Project','Alice',?2)",
        )?;
        for index in 0..50_000 {
            let id = format!("event-{index:05}");
            events.execute(rusqlite::params![id, base - index])?;
            recipients.execute(rusqlite::params![id, base])?;
        }
        Ok(())
    }).await.unwrap();
    let service = CollaborationService::new(db);
    let mut samples = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        let page = service
            .inbox(&bob, InboxFilter::default(), None, None)
            .await
            .unwrap();
        samples.push(started.elapsed().as_millis());
        assert_eq!(page.items.len(), 50);
        assert_eq!(page.filtered_count, 50_000);
        assert!(page.next_cursor.is_some());
    }
    println!("50k Inbox items, first 50 actual service ms: {samples:?}");
}

#[tokio::test]
async fn inbox_uses_cursor_pages_of_fifty_and_bulk_changes_only_the_filter() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let base = now() - 100;
    db.transaction(move |tx| {
        for index in 0..55 {
            snapshot_notification_tx(
                tx,
                &alice,
                NotificationInput {
                    project_id: "p1",
                    event_type: "test",
                    task_id: None,
                    comment_id: None,
                    block_id: None,
                    excerpt: Some("event"),
                    payload: json!({}),
                },
                vec!["bob".into()],
                base + index,
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let runtime = CollaborationRuntime::new(db.clone());
    let worker = runtime.worker();
    while worker.run_once().await.unwrap() {}
    let service = CollaborationService::new(db.clone());
    let first = service
        .inbox(&bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(first.items.len(), 50);
    assert!(first.next_cursor.is_some());
    assert_eq!(first.unread_count, 55);
    let second = service
        .inbox(
            &bob,
            InboxFilter::default(),
            first.next_cursor.as_deref(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(second.items.len(), 5);

    service
        .execute(
            &bob,
            CollaborationCommand {
                operation: "inbox.bulkMarkRead".into(),
                payload: json!({"filter":{"projectIds":[],"unreadOnly":true,"archived":false}}),
                idempotency_key: "bulk-read".into(),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let read = service
        .inbox(&bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(read.unread_count, 0);
    assert_eq!(read.filtered_count, 55);

    let alice_for_new = browser_actor("alice", "Alice", "sa", now());
    db.transaction(move |tx| {
        snapshot_notification_tx(
            tx,
            &alice_for_new,
            NotificationInput {
                project_id: "p1",
                event_type: "test",
                task_id: None,
                comment_id: None,
                block_id: None,
                excerpt: Some("new"),
                payload: json!({}),
            },
            vec!["bob".into()],
            now(),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    while worker.run_once().await.unwrap() {}
    service
        .execute(
            &bob,
            CollaborationCommand {
                operation: "inbox.bulkArchive".into(),
                payload: json!({"filter":{"projectIds":[],"unreadOnly":true,"archived":false}}),
                idempotency_key: "bulk-archive".into(),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let archived = service
        .inbox(
            &bob,
            InboxFilter {
                project_ids: Default::default(),
                unread_only: false,
                archived: true,
            },
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(archived.filtered_count, 1);
}

#[tokio::test]
async fn inbox_sql_filter_preserves_redaction_counts_and_archive_retention() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let event_time = now();
    db.transaction(move |tx| {
        for task_id in [Some("task"), None] {
            snapshot_notification_tx(
                tx,
                &alice,
                NotificationInput {
                    project_id: "p1",
                    event_type: "test",
                    task_id,
                    comment_id: None,
                    block_id: None,
                    excerpt: Some("event"),
                    payload: json!({}),
                },
                vec!["bob".into()],
                event_time,
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let worker = CollaborationRuntime::new(db.clone()).worker();
    while worker.run_once().await.unwrap() {}
    db.run(|connection| {
        connection.execute("UPDATE tasks SET deleted_at=1 WHERE id='task'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let service = CollaborationService::new(db.clone());
    let all = service
        .inbox(&bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(all.filtered_count, 2);
    assert_eq!(all.items.len(), 2);
    assert_eq!(
        all.items
            .iter()
            .filter(|item| !item.destination_available)
            .count(),
        1
    );
    let project_filter = InboxFilter {
        project_ids: ["p1".to_owned()].into(),
        unread_only: true,
        archived: false,
    };
    let visible = service
        .inbox(&bob, project_filter.clone(), None, None)
        .await
        .unwrap();
    assert_eq!(visible.filtered_count, 1);
    assert_eq!(visible.items.len(), 1);
    assert!(visible.items[0].destination_available);
    let notification_id = visible.items[0].id.clone();
    service
        .execute(
            &bob,
            CollaborationCommand {
                operation: "inbox.archive".into(),
                payload: json!({"notificationId": notification_id}),
                idempotency_key: "archive-retention".into(),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let unread = service
        .inbox(&bob, project_filter, None, None)
        .await
        .unwrap();
    assert_eq!(unread.filtered_count, 0);
    assert_eq!(unread.unread_count, 1);
    let archived = service
        .inbox(
            &bob,
            InboxFilter {
                archived: true,
                ..InboxFilter::default()
            },
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(archived.filtered_count, 1);
    for operation in ["inbox.restore", "inbox.archive"] {
        service
            .execute(
                &bob,
                CollaborationCommand {
                    operation: operation.into(),
                    payload: json!({"notificationId":notification_id}),
                    idempotency_key: format!("before-expiry-{operation}"),
                    expected_revision: None,
                },
            )
            .await
            .unwrap();
    }
    let expired_id = notification_id.clone();
    db.run(move |connection| {
        connection.execute("UPDATE notification_recipients SET archived_at=?1 WHERE notification_id=?2 AND user_id='bob'",
            rusqlite::params![now() - 91 * 86_400, notification_id])?;
        Ok(())
    }).await.unwrap();
    let expired = service
        .inbox(
            &bob,
            InboxFilter {
                archived: true,
                ..InboxFilter::default()
            },
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(expired.filtered_count, 0);
    for purge in [false, true] {
        if purge {
            assert_eq!(service.purge_archived(now()).await.unwrap(), 1);
        }
        let bootstrap = oneloop::domain::DomainService::new(db.clone(), chrono_tz::UTC)
            .bootstrap(&bob, Default::default())
            .await
            .unwrap();
        assert_eq!(bootstrap.notifications.len(), 1, "purge={purge}");
        assert!(
            bootstrap
                .notifications
                .iter()
                .all(|item| item["id"] != expired_id)
        );
        for operation in [
            "inbox.restore",
            "inbox.archive",
            "inbox.markRead",
            "inbox.markUnread",
        ] {
            let error = service
                .execute(
                    &bob,
                    CollaborationCommand {
                        operation: operation.into(),
                        payload: json!({"notificationId":expired_id}),
                        idempotency_key: format!("expired-{purge}-{operation}"),
                        expected_revision: None,
                    },
                )
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                oneloop::AppError::NotFound {
                    resource: "notification"
                }
            ));
        }
    }
}

#[tokio::test]
async fn activity_uses_a_fixed_window_and_projects_before_cursor_pagination() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let base = now() - 1_000;
    let bob_for_events = bob.clone();
    let first_id = db
        .transaction(move |tx| {
            let first = record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("a")),
                    after: Some(json!("b")),
                    metadata: json!({}),
                    entity_revision: Some(1),
                },
                base,
            )?;
            record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("b")),
                    after: Some(json!("c")),
                    metadata: json!({}),
                    entity_revision: Some(2),
                },
                base + 200,
            )?;
            record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("c")),
                    after: Some(json!("d")),
                    metadata: json!({}),
                    entity_revision: Some(3),
                },
                base + 301,
            )?;
            record_activity_tx(
                tx,
                &bob_for_events,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("d")),
                    after: Some(json!("e")),
                    metadata: json!({}),
                    entity_revision: Some(4),
                },
                base + 302,
            )?;
            Ok(first.id)
        })
        .await
        .unwrap();
    let service = CollaborationService::new(db);
    let page = service
        .activity(&bob, "p1", Some("task"), None, Some(2))
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.next_cursor.is_some());
    let older = service
        .activity(
            &bob,
            "p1",
            Some("task"),
            page.next_cursor.as_deref(),
            Some(2),
        )
        .await
        .unwrap();
    assert_eq!(older.items.len(), 1);
    assert_eq!(older.items[0].id, first_id);
    assert_eq!(older.items[0].before, Some(json!("a")));
    assert_eq!(older.items[0].after, Some(json!("c")));
    assert_eq!(older.items[0].created_at, base + 200);
    let counts: (i64, i64) = service
        .db()
        .run(|connection| {
            Ok((
                connection
                    .query_row("SELECT COUNT(*) FROM activity_events", [], |row| row.get(0))?,
                connection.query_row("SELECT COUNT(*) FROM activity_projection", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(counts, (4, 3));
}

#[tokio::test]
async fn activity_snapshots_authenticated_app_provenance_without_browser_forgery() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let created = now() - 10;
    db.run(move |connection| {
        connection.execute(
            "INSERT INTO mcp_grants
             (id,user_id,client_id,client_name,created_at,updated_at,expires_at)
             VALUES ('grant-1','alice','client-1','Planning Assistant',?1,?1,?2)",
            rusqlite::params![created, created + 86_400],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let mut mcp_alice = alice.clone();
    mcp_alice.source = ActorSource::McpGrant {
        grant_id: "grant-1".into(),
    };
    db.transaction({
        let alice = alice.clone();
        move |tx| {
            let via_app = record_activity_tx(
                tx,
                &mcp_alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("Old")),
                    after: Some(json!("New")),
                    metadata: json!({}),
                    entity_revision: Some(2),
                },
                created,
            )?;
            assert_eq!(via_app.actor_mcp_grant_id.as_deref(), Some("grant-1"));
            assert_eq!(
                via_app.actor_app_name.as_deref(),
                Some("Planning Assistant")
            );
            let browser = record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("description"),
                    before: Some(json!("Before")),
                    after: Some(json!("After")),
                    metadata: json!({
                        "actorMcpGrantId":"forged-grant",
                        "actorAppName":"Forged App"
                    }),
                    entity_revision: Some(3),
                },
                created + 1,
            )?;
            assert!(browser.actor_mcp_grant_id.is_none());
            assert!(browser.actor_app_name.is_none());
            assert!(browser.metadata.get("actorMcpGrantId").is_none());
            assert!(browser.metadata.get("actorAppName").is_none());
            tx.execute(
                "UPDATE mcp_grants SET revoked_at=?1,revision=revision+1 WHERE id='grant-1'",
                [created + 2],
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();

    let page = CollaborationService::new(db.clone())
        .activity(&bob, "p1", Some("task"), None, None)
        .await
        .unwrap();
    let via_app = page
        .items
        .iter()
        .find(|item| item.field_key.as_deref() == Some("title"))
        .unwrap();
    assert_eq!(via_app.actor_mcp_grant_id.as_deref(), Some("grant-1"));
    assert_eq!(
        via_app.actor_app_name.as_deref(),
        Some("Planning Assistant")
    );
    let wire = serde_json::to_value(via_app).unwrap();
    assert_eq!(wire["actorMcpGrantId"], "grant-1");
    assert_eq!(wire["actorAppName"], "Planning Assistant");
    let browser = page
        .items
        .iter()
        .find(|item| item.field_key.as_deref() == Some("description"))
        .unwrap();
    assert!(browser.actor_mcp_grant_id.is_none());
    assert!(browser.actor_app_name.is_none());

    let raw: (Option<String>, String) = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT actor_mcp_grant_id,metadata_json FROM activity_events
                 WHERE field_key='title'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(raw.0.as_deref(), Some("grant-1"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw.1).unwrap()["actorAppName"],
        "Planning Assistant"
    );
}

#[tokio::test]
async fn consolidated_activity_uses_the_latest_web_or_app_source() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let base = now() - 10;
    db.run(move |connection| {
        connection.execute(
            "INSERT INTO mcp_grants
             (id,user_id,client_id,client_name,created_at,updated_at,expires_at)
             VALUES ('grant-2','alice','client-2','Roadmap Helper',?1,?1,?2)",
            rusqlite::params![base, base + 86_400],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let mut mcp_alice = alice.clone();
    mcp_alice.source = ActorSource::McpGrant {
        grant_id: "grant-2".into(),
    };
    db.transaction({
        let alice = alice.clone();
        move |tx| {
            record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("a")),
                    after: Some(json!("b")),
                    metadata: json!({}),
                    entity_revision: Some(1),
                },
                base,
            )?;
            record_activity_tx(
                tx,
                &mcp_alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("title"),
                    before: Some(json!("b")),
                    after: Some(json!("c")),
                    metadata: json!({}),
                    entity_revision: Some(2),
                },
                base + 1,
            )?;
            record_activity_tx(
                tx,
                &mcp_alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("description"),
                    before: Some(json!("a")),
                    after: Some(json!("b")),
                    metadata: json!({}),
                    entity_revision: Some(3),
                },
                base + 2,
            )?;
            record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.updated",
                    field_key: Some("description"),
                    before: Some(json!("b")),
                    after: Some(json!("c")),
                    metadata: json!({}),
                    entity_revision: Some(4),
                },
                base + 3,
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();
    let page = CollaborationService::new(db)
        .activity(&bob, "p1", Some("task"), None, None)
        .await
        .unwrap();
    let title = page
        .items
        .iter()
        .find(|item| item.field_key.as_deref() == Some("title"))
        .unwrap();
    assert_eq!(title.before, Some(json!("a")));
    assert_eq!(title.after, Some(json!("c")));
    assert_eq!(title.actor_app_name.as_deref(), Some("Roadmap Helper"));
    let description = page
        .items
        .iter()
        .find(|item| item.field_key.as_deref() == Some("description"))
        .unwrap();
    assert_eq!(description.before, Some(json!("a")));
    assert_eq!(description.after, Some(json!("c")));
    assert!(description.actor_mcp_grant_id.is_none());
    assert!(description.actor_app_name.is_none());
}

#[tokio::test]
async fn runtime_shutdown_notifies_long_lived_streams_immediately() {
    let SeededProject {
        root: _root, db, ..
    } = seeded_project().await;
    let runtime = CollaborationRuntime::new(db);
    let mut shutdown = runtime.shutdown_receiver();
    runtime.shutdown();
    shutdown.changed().await.unwrap();
    assert!(*shutdown.borrow());
}

#[tokio::test]
async fn activity_pages_use_bounded_project_and_task_feed_indexes() {
    let SeededProject {
        root: _root, db, ..
    } = seeded_project().await;
    let plans = db
        .run(|connection| {
            let mut result = Vec::new();
            for sql in [
                "EXPLAIN QUERY PLAN SELECT id FROM activity_projection
                 WHERE project_id='p1' AND is_hidden=0 AND visibility='public'
                 ORDER BY latest_at DESC,id DESC LIMIT 51",
                "EXPLAIN QUERY PLAN SELECT id FROM activity_projection
                 WHERE project_id='p1' AND task_id='task' AND is_hidden=0 AND visibility='public'
                 ORDER BY latest_at DESC,id DESC LIMIT 51",
                "EXPLAIN QUERY PLAN SELECT id FROM activity_projection
                 WHERE project_id='p1' AND private_owner_user_id='alice'
                   AND is_hidden=0 AND visibility='owner'
                 ORDER BY latest_at DESC,id DESC LIMIT 51",
                "EXPLAIN QUERY PLAN SELECT id FROM activity_projection
                 WHERE project_id='p1' AND task_id='task' AND private_owner_user_id='alice'
                   AND is_hidden=0 AND visibility='owner'
                 ORDER BY latest_at DESC,id DESC LIMIT 51",
            ] {
                let mut statement = connection.prepare(sql)?;
                let lines = statement
                    .query_map([], |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()?;
                result.push(lines.join(" "));
            }
            Ok(result)
        })
        .await
        .unwrap();
    assert!(
        plans[0].contains("activity_projection_project_public_feed_idx"),
        "{}",
        plans[0]
    );
    assert!(
        plans[1].contains("activity_projection_task_public_feed_idx"),
        "{}",
        plans[1]
    );
    assert!(
        plans[2].contains("activity_projection_project_owner_feed_idx"),
        "{}",
        plans[2]
    );
    assert!(
        plans[3].contains("activity_projection_task_owner_feed_idx"),
        "{}",
        plans[3]
    );
}

#[tokio::test]
async fn personal_pool_activity_is_owner_private_even_from_members_and_admins() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let mut dave = browser_actor("dave", "Dave", "sd", now());
    dave.is_admin = true;
    let event_time = now() - 2;
    db.transaction({
        let alice = alice.clone();
        move |tx| {
            record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "pool_item",
                    entity_id: "private",
                    task_id: None,
                    event_type: "pool_item.created",
                    field_key: None,
                    before: None,
                    after: Some(json!({"title":"private title"})),
                    metadata: json!({"visibility":"owner","ownerUserId":"alice"}),
                    entity_revision: Some(1),
                },
                event_time,
            )?;
            record_activity_tx(
                tx,
                &alice,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "pool_item",
                    entity_id: "team",
                    task_id: None,
                    event_type: "pool_item.created",
                    field_key: None,
                    before: None,
                    after: Some(json!({"title":"team title"})),
                    metadata: json!({}),
                    entity_revision: Some(1),
                },
                event_time + 1,
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();
    let service = CollaborationService::new(db.clone());
    db.run(|connection| {
        for (entity_id, expected_visibility, expected_owner) in [
            ("private", "owner", Some("alice")),
            ("team", "public", None),
        ] {
            let (visibility, owner): (String, Option<String>) = connection.query_row(
                "SELECT visibility,private_owner_user_id FROM activity_events WHERE entity_id=?1",
                [entity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(visibility, expected_visibility);
            assert_eq!(owner.as_deref(), expected_owner);
        }
        Ok(())
    })
    .await
    .unwrap();
    let owner = service
        .activity(&alice, "p1", None, None, None)
        .await
        .unwrap();
    assert_eq!(owner.items.len(), 2);
    for viewer in [&bob, &dave] {
        let page = service
            .activity(viewer, "p1", None, None, None)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].entity_id, "team");
        assert_ne!(
            page.items[0]
                .after
                .as_ref()
                .and_then(|v| v.get("title"))
                .and_then(|v| v.as_str()),
            Some("private title")
        );
    }

    let runtime = CollaborationRuntime::new(db);
    let mut hints = runtime.subscribe();
    let worker = runtime.worker();
    let mut seen = std::collections::BTreeMap::new();
    for _ in 0..2 {
        assert!(worker.run_once().await.unwrap());
        let hint = hints.recv().await.unwrap();
        seen.insert(hint.entity_id.clone().unwrap(), hint.recipient_ids.clone());
    }
    assert_eq!(
        seen["private"],
        std::collections::BTreeSet::from(["alice".into()])
    );
    assert!(seen["team"].contains("alice"));
    assert!(seen["team"].contains("bob"));
    assert!(seen["team"].contains("dave"));
}

/// Paused Tokio time lets the five-second writer admission timeout elapse
/// without waiting for it in real time.
#[tokio::test(start_paused = true)]
async fn writer_timeouts_during_maintenance_do_not_stop_notification_delivery() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    db.transaction(move |tx| {
        snapshot_notification_tx(
            tx,
            &alice,
            NotificationInput {
                project_id: "p1",
                event_type: "test",
                task_id: Some("task"),
                comment_id: None,
                block_id: None,
                excerpt: Some("after the timeout"),
                payload: json!({}),
            },
            vec!["bob".into()],
            now(),
        )?;
        Ok(())
    })
    .await
    .unwrap();
    // Hold the single writer so the worker's first maintenance step times out.
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let writer_db = db.clone();
    let writer = tokio::spawn(async move {
        writer_db
            .transaction(move |_| {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok(())
            })
            .await
            .unwrap();
    });
    started.await.unwrap();
    let runtime = CollaborationRuntime::new(db.clone());
    let (stop, signal) = tokio::sync::watch::channel(false);
    let worker = runtime.spawn_worker(signal);
    // The worker starts waiting for the writer on its first poll. Tokio does
    // not auto-advance paused time while the blocking writer runs, so advance
    // past the admission timeout explicitly, then let the worker observe the
    // timeout before the writer is released.
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_millis(5250)).await;
    tokio::task::yield_now().await;
    release.send(()).unwrap();
    writer.await.unwrap();
    let service = CollaborationService::new(db);
    loop {
        assert!(
            !worker.is_finished(),
            "a writer timeout stopped notification delivery"
        );
        let inbox = service
            .inbox(&bob, InboxFilter::default(), None, None)
            .await
            .unwrap();
        if inbox
            .items
            .iter()
            .any(|item| item.excerpt.as_deref() == Some("after the timeout"))
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    stop.send(true).unwrap();
    worker.await.unwrap().unwrap();
}

#[tokio::test]
async fn worker_survives_failed_archive_purge_and_delivers_new_notifications() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let actor = alice.clone();
    db.transaction(move |tx| {
        snapshot_notification_tx(tx,&actor,NotificationInput {
            project_id:"p1",event_type:"test",task_id:Some("task"),comment_id:None,
            block_id:None,excerpt:Some("purge me"),payload:json!({})},vec!["bob".into()],now())?;
        tx.execute("UPDATE notification_recipients SET archived_at=1,read_at=1,delivered_at=1",[])?;
        tx.execute_batch("CREATE TRIGGER fail_purge BEFORE UPDATE OF project_name_snapshot ON notification_recipients
            BEGIN SELECT RAISE(FAIL,'injected purge failure'); END;")?;
        snapshot_notification_tx(tx,&actor,NotificationInput {
            project_id:"p1",event_type:"test",task_id:Some("task"),comment_id:None,
            block_id:None,excerpt:Some("new delivery"),payload:json!({})},vec!["bob".into()],now())?;
        Ok(())
    }).await.unwrap();
    let service = CollaborationService::new(db.clone());
    assert!(service.purge_archived(now()).await.is_err());
    let runtime = CollaborationRuntime::new(db.clone());
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let worker = runtime.spawn_worker(stopped);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let inbox = service
                .inbox(&bob, InboxFilter::default(), None, None)
                .await
                .unwrap();
            if inbox
                .items
                .iter()
                .any(|item| item.excerpt.as_deref() == Some("new delivery"))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!worker.is_finished());
    db.transaction(|tx| {
        tx.execute_batch("DROP TRIGGER fail_purge")?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(service.purge_archived(now()).await.unwrap(), 1);
    stop.send(true).unwrap();
    worker.await.unwrap().unwrap();
}

#[tokio::test]
async fn supervisor_stops_other_workers_on_unexpected_exit_or_panic() {
    for panic in [false, true] {
        let SeededProject {
            root: _root, db, ..
        } = seeded_project().await;
        let runtime = CollaborationRuntime::new(db);
        let mut closed = runtime.shutdown_receiver();
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let outbox = tokio::spawn(async move {
            assert!(!panic, "injected worker panic");
            Ok(())
        });
        let waiter = |mut stopped: tokio::sync::watch::Receiver<bool>| async move {
            while !*stopped.borrow_and_update() {
                if stopped.changed().await.is_err() {
                    break;
                }
            }
        };
        let files = tokio::spawn(waiter(stopped.clone()));
        let knowledge = tokio::spawn(waiter(stopped));
        assert!(
            oneloop::runtime::supervise_workers(outbox, files, knowledge, stop, runtime)
                .await
                .is_err()
        );
        closed.changed().await.unwrap();
        assert!(*closed.borrow());
    }
}

#[tokio::test]
async fn task_child_lifecycle_events_break_task_edit_chains_but_comments_do_not() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let base_time = now();
    for (index, entity_type, event_type, field, before, after) in [
        (
            0,
            "task_block",
            "task.blocked",
            "title",
            json!("A"),
            json!("B"),
        ),
        (
            1,
            "task_block",
            "task.unblocked",
            "status",
            json!("planning"),
            json!("in_progress"),
        ),
        (
            2,
            "attachment",
            "attachment.created",
            "attachment_order",
            json!(["a", "b"]),
            json!(["b", "a"]),
        ),
        (
            3,
            "attachment",
            "attachment.deleted",
            "title",
            json!("A"),
            json!("B"),
        ),
        (
            4,
            "attachment",
            "attachment.cleaned",
            "title",
            json!("A"),
            json!("B"),
        ),
        (
            5,
            "comment",
            "comment.created",
            "title",
            json!("A"),
            json!("B"),
        ),
    ] {
        let actor = alice.clone();
        db.transaction(move |tx| {
            let time = base_time + index * 1000;
            for (offset, previous, next) in [(0, before.clone(), after.clone()), (2, after, before)]
            {
                if offset == 2 {
                    record_activity_tx(
                        tx,
                        &actor,
                        ActivityInput {
                            project_id: Some("p1"),
                            entity_type,
                            entity_id: "child",
                            task_id: Some("task"),
                            event_type,
                            field_key: None,
                            before: None,
                            after: None,
                            metadata: json!({}),
                            entity_revision: None,
                        },
                        time + 1,
                    )?;
                }
                record_activity_tx(
                    tx,
                    &actor,
                    ActivityInput {
                        project_id: Some("p1"),
                        entity_type: "task",
                        entity_id: "task",
                        task_id: Some("task"),
                        event_type: "task.updated",
                        field_key: Some(field),
                        before: Some(previous),
                        after: Some(next),
                        metadata: json!({}),
                        entity_revision: None,
                    },
                    time + offset,
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let page = CollaborationService::new(db.clone())
            .activity(&bob, "p1", Some("task"), None, Some(100))
            .await
            .unwrap();
        let changes = page
            .items
            .iter()
            .filter(|item| {
                item.entity_type == "task" && item.created_at >= base_time + index * 1000
            })
            .count();
        assert_eq!(
            changes,
            if entity_type == "comment" { 0 } else { 2 },
            "{event_type}"
        );
    }
}

#[tokio::test]
async fn activity_merge_moves_to_first_page_and_requires_reconciliation() {
    let SeededProject {
        root: _root,
        db,
        alice,
        bob,
    } = seeded_project().await;
    let base = now() - 100;
    let input = |field| ActivityInput {
        project_id: Some("p1"),
        entity_type: "task",
        entity_id: "task",
        task_id: Some("task"),
        event_type: "task.updated",
        field_key: Some(field),
        before: Some(json!("a")),
        after: Some(json!("b")),
        metadata: json!({}),
        entity_revision: Some(1),
    };
    let alice_copy = alice.clone();
    let first_id = db
        .transaction(move |tx| {
            let first = record_activity_tx(tx, &alice_copy, input("deadline"), base)?;
            record_activity_tx(tx, &alice_copy, input("title"), base + 1)?;
            record_activity_tx(tx, &alice_copy, input("description"), base + 2)?;
            Ok(first.id)
        })
        .await
        .unwrap();
    let service = CollaborationService::new(db.clone());
    // Project, task and epic feeds share latest-change ordering.
    let first = service
        .activity(&bob, "p1", Some("task"), None, Some(2))
        .await
        .unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.items.iter().all(|item| item.id != first_id));
    db.transaction(move |tx| {
        let mut change = input("deadline");
        change.before = Some(json!("b"));
        change.after = Some(json!("c"));
        record_activity_tx(tx, &alice, change, base + 3)?;
        Ok(())
    })
    .await
    .unwrap();
    let older = service
        .activity(
            &bob,
            "p1",
            Some("task"),
            first.next_cursor.as_deref(),
            Some(2),
        )
        .await
        .unwrap();
    assert!(older.items.is_empty());
    let refreshed = service
        .activity(&bob, "p1", Some("task"), None, Some(2))
        .await
        .unwrap();
    assert_eq!(refreshed.items[0].id, first_id);
    assert_eq!(refreshed.items[0].after, Some(json!("c")));
    assert_eq!(refreshed.items[0].created_at, base + 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_outbox_read_does_not_wait_for_the_writer() {
    let SeededProject {
        root: _root, db, ..
    } = seeded_project().await;
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let writer_db = db.clone();
    let writer = tokio::spawn(async move {
        writer_db
            .transaction(move |_| {
                entered.send(()).unwrap();
                released
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                Ok(())
            })
            .await
            .unwrap();
    });
    started.await.unwrap();
    let runtime = CollaborationRuntime::new(db);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        runtime.worker().run_once(),
    )
    .await;
    release.send(()).unwrap();
    writer.await.unwrap();
    assert!(
        !result
            .expect("idle worker waited for the write lock")
            .unwrap()
    );
}

#[tokio::test]
async fn ineligible_recipients_skip_events_but_preserve_broadcast_receipts() {
    let SeededProject {
        root: _root,
        db,
        alice,
        ..
    } = seeded_project().await;
    db.transaction(move |tx| {
        tx.execute("UPDATE users SET is_active=0 WHERE id='bob'", [])?;
        for broadcast in [false, true] {
            let event = snapshot_notification_tx(
                tx,
                &alice,
                NotificationInput {
                    project_id: "p1",
                    event_type: "discussion.reply",
                    task_id: Some("task"),
                    comment_id: None,
                    block_id: None,
                    excerpt: None,
                    payload: json!({"broadcast":broadcast}),
                },
                vec!["bob".into()],
                now(),
            )?;
            assert_eq!(event.is_some(), broadcast);
        }
        let counts: (i64, i64, i64) = tx.query_row(
            "SELECT (SELECT COUNT(*) FROM notification_events),
                    (SELECT COUNT(*) FROM notification_recipients),
                    (SELECT COUNT(*) FROM outbox_messages)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(counts, (1, 0, 0));
        Ok(())
    })
    .await
    .unwrap();
}
