use super::*;

#[tokio::test]
async fn bootstrap_and_task_reads_enforce_membership_and_accept_readable_keys() {
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Readable"}),
                "readable",
                None,
            ),
        )
        .await
        .unwrap();
    let key = created.entities[0]["taskKey"].as_str().unwrap().to_owned();
    let task = f.service.task(&f.member, key.clone()).await.unwrap();
    assert_eq!(task.task_key, key);
    assert!((1_000_000_000..100_000_000_000).contains(&task.created_at));
    assert_eq!(
        Some(task.created_at),
        created.entities[0]["createdAt"].as_i64()
    );
    let bootstrap = f
        .service
        .bootstrap(
            &f.member,
            BootstrapQuery {
                project_id: Some("p1".into()),
                task_id: Some(key),
                view: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(bootstrap.projects.len(), 1);
    assert_eq!(bootstrap.tasks.len(), 1);
    // Change authoritative membership, rather than forging an Actor flag for a
    // database administrator (whose live role correctly takes precedence).
    f.db.run(|connection| {
        connection.execute(
            "DELETE FROM project_memberships WHERE project_id='p1' AND user_id='u2'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(f.service.task(&f.member, task.id).await.is_err());
}

#[tokio::test]
async fn bootstrap_waits_for_delivery_and_redacts_deleted_task_context() {
    let f = fixture().await;
    let result = f.service.execute(&f.manager, command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Private historical title","assigneeIds":["u2"]}),
        "notification-lifecycle", None,
    )).await.unwrap();
    let task_id = result.entities[0]["id"].as_str().unwrap().to_owned();
    let query = || BootstrapQuery {
        project_id: Some("p1".into()),
        task_id: None,
        view: None,
    };
    let pending = f.service.bootstrap(&f.member, query()).await.unwrap();
    assert_eq!(pending.inbox_unread_count, 0);
    assert!(pending.notifications.is_empty());
    let worker = oneloop::collaboration::CollaborationRuntime::new(f.db.clone()).worker();
    while worker.run_once().await.unwrap() {}
    let delivered = f.service.bootstrap(&f.member, query()).await.unwrap();
    assert_ne!(
        pending.sync_cursor,
        f.service.sync_cursor(&f.member).await.unwrap()
    );
    assert_eq!(delivered.inbox_unread_count, 1);
    assert_eq!(delivered.notifications[0]["destinationAvailable"], true);
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::DeleteTask,
                json!({"id":task_id}),
                "delete-notified-task",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let removed = f.service.bootstrap(&f.member, query()).await.unwrap();
    assert_eq!(removed.notifications[0]["destinationAvailable"], false);
    for field in [
        "projectName",
        "taskKey",
        "taskTitle",
        "actorName",
        "excerpt",
    ] {
        assert!(
            removed.notifications[0][field].is_null(),
            "{field} must be redacted"
        );
    }
}

#[tokio::test]
async fn skipped_local_dates_do_not_break_roadmap_or_bootstrap() {
    let f = fixture().await;
    for (zone, date) in [
        ("Asia/Manila", "1844-12-31"),
        ("Pacific/Kiritimati", "1994-12-31"),
        ("Pacific/Apia", "2011-12-30"),
        ("America/Santiago", "2019-09-08"),
    ] {
        let date = date.to_owned();
        f.db.transaction(move |tx| {
            tx.execute("UPDATE epics SET start_date=?1 WHERE id='e1'", [date])?;
            Ok(())
        })
        .await
        .unwrap();
        let service = DomainService::new(f.db.clone(), zone.parse().unwrap());
        service.roadmap(&f.manager, "p1".into()).await.unwrap();
        service
            .bootstrap(&f.manager, BootstrapQuery::default())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn hidden_and_missing_resources_have_identical_http_errors() {
    let f = fixture().await;
    let task = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p2","epicId":"e2","title":"Hidden"}),
                "hidden-task",
                None,
            ),
        )
        .await
        .unwrap();
    let id = task.entities[0]["id"].as_str().unwrap();
    let config = support::config(f._root.path(), "http://127.0.0.1:8080", &[]);
    let app = oneloop::http::domain::read_router()
        .layer(Extension(f.member.clone()))
        .with_state(AppState::new(config, f.db.clone()));
    for (hidden, missing) in [
        ("/api/tasks/TWO-001".into(), "/api/tasks/TWO-999".into()),
        (
            format!("/api/bootstrap?taskId={id}"),
            "/api/bootstrap?taskId=missing".into(),
        ),
        (
            "/api/projects/p2/roadmap".into(),
            "/api/projects/missing/roadmap".into(),
        ),
    ] {
        let mut responses = Vec::new();
        for url in [hidden, missing] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(url)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 404);
            responses.push(body_bytes(response).await);
        }
        assert_eq!(responses[0], responses[1]);
    }
    let discussion = CollaborationService::new(f.db.clone());
    let files = oneloop::files::FileService::new(f.db.clone(), 1 << 30, 0);
    async fn response(error: AppError) -> (u16, Vec<u8>) {
        use axum::response::IntoResponse;
        let response = error.into_response();
        (
            response.status().as_u16(),
            body_bytes(response).await.to_vec(),
        )
    }
    for errors in [
        [
            discussion
                .comments(&f.member, id, None, None)
                .await
                .unwrap_err(),
            discussion
                .comments(&f.member, "missing", None, None)
                .await
                .unwrap_err(),
        ],
        [
            files.list_attachments(&f.member, id).await.unwrap_err(),
            files
                .list_attachments(&f.member, "missing")
                .await
                .unwrap_err(),
        ],
        [
            f.service
                .execute(
                    &f.member,
                    command(
                        DomainOperation::UpdateTask,
                        json!({"taskId":id,"title":"Hidden"}),
                        "hidden-write",
                        Some(1),
                    ),
                )
                .await
                .unwrap_err(),
            f.service
                .execute(
                    &f.member,
                    command(
                        DomainOperation::UpdateTask,
                        json!({"taskId":"missing","title":"Hidden"}),
                        "missing-write",
                        Some(1),
                    ),
                )
                .await
                .unwrap_err(),
        ],
    ] {
        let [a, b] = errors;
        assert_eq!(response(a).await, response(b).await);
    }
}

#[tokio::test]
async fn maintenance_queries_use_bounded_indexes() {
    let f = fixture().await;
    f.db.run(|c| {
        for (sql,index) in [
            ("SELECT EXISTS(SELECT 1 FROM notification_events WHERE project_id='p1' AND actor_user_id='u1' AND created_at>1 AND json_extract(payload_json,'$.broadcast')=1)","notification_broadcast_lookup_idx"),
            ("UPDATE notification_recipients SET excerpt_snapshot=NULL WHERE archived_at IS NOT NULL AND archived_at<=1 AND excerpt_snapshot IS NOT NULL","notification_archived_idx"),
            ("SELECT created_at,COUNT(*) FROM activity_events WHERE event_type='attachment.cleaned' GROUP BY created_at ORDER BY created_at DESC LIMIT 20","activity_cleanup_time_idx"),
        ] {
            let mut s=c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let plan=s.query_map([],|r|r.get::<_,String>(3))?.collect::<Result<Vec<_>,_>>()?.join("\n");
            assert!(plan.contains(index),"expected {index}: {plan}");
            assert!(!plan.contains("USE TEMP B-TREE"),"{plan}");
        }
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn legacy_bootstrap_batches_notification_availability_and_redacts_lost_access() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static READS: AtomicUsize = AtomicUsize::new(0);
    let f = fixture().await;
    seed_ordering_column(&f, 1).await;
    f.db.transaction(|tx| {
        for i in 0..50 {
            let id=format!("legacy-{i}");
            tx.execute("INSERT INTO notification_events(id,project_id,actor_user_id,event_type,task_id,created_at) VALUES(?1,'p1','u1','task.assigned','order-1',1)",[&id])?;
            tx.execute("INSERT INTO notification_recipients(notification_id,user_id,project_name_snapshot,task_key_snapshot,task_title_snapshot,actor_name_snapshot,excerpt_snapshot,delivered_at) VALUES(?1,'u2','Project One','ONE-1','Private title','Manager','Private excerpt',1)",[&id])?;
        }Ok(())
    }).await.unwrap();
    f.db.run(|c| {
        c.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(|_| {
                READS.fetch_add(1, Ordering::Relaxed);
            }),
        );
        Ok(())
    })
    .await
    .unwrap();
    let page = f
        .service
        .bootstrap(&f.member, Default::default())
        .await
        .unwrap();
    f.db.run(|c| {
        c.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(page.notifications.len(), 50);
    assert!(
        page.notifications
            .iter()
            .all(|n| n["destinationAvailable"] == true)
    );
    assert!(
        READS.load(Ordering::Relaxed) < 75,
        "availability must not query per notification"
    );
    f.db.transaction(|tx| {
        tx.execute(
            "DELETE FROM project_memberships WHERE project_id='p1' AND user_id='u2'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let page = f
        .service
        .bootstrap(&f.member, Default::default())
        .await
        .unwrap();
    assert_eq!(page.notifications.len(), 50);
    for notification in page.notifications {
        assert_eq!(notification["destinationAvailable"], false);
        for field in [
            "projectId",
            "projectName",
            "taskId",
            "taskTitle",
            "actorName",
            "excerpt",
        ] {
            assert!(notification[field].is_null(), "{field}");
        }
    }
}
