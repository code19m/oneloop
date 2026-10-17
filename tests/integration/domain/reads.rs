use super::*;

#[tokio::test]
async fn bootstrap_and_task_reads_accept_readable_keys() {
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
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(bootstrap.projects.len(), 1);
    assert_eq!(bootstrap.tasks.len(), 1);
}

#[tokio::test]
async fn notifications_wait_for_delivery_and_lose_deleted_task_context() {
    let f = fixture().await;
    let result = f.service.execute(&f.manager, command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Private historical title","assigneeIds":["u2"]}),
        "notification-lifecycle", None,
    )).await.unwrap();
    let task_id = result.entities[0]["id"].as_str().unwrap().to_owned();
    let query = || BootstrapQuery {
        project_id: Some("p1".into()),
        ..Default::default()
    };
    let inbox = CollaborationService::new(f.db.clone());
    let read_inbox = || inbox.inbox(&f.member, Default::default(), None, None);
    let pending = f.service.bootstrap(&f.member, query()).await.unwrap();
    assert_eq!(pending.inbox_unread_count, 0);
    assert!(read_inbox().await.unwrap().items.is_empty());
    drain(&oneloop::collaboration::CollaborationRuntime::new(
        f.db.clone(),
    ))
    .await;
    let delivered = f.service.bootstrap(&f.member, query()).await.unwrap();
    assert_ne!(pending.sync_cursor, delivered.sync_cursor);
    assert_eq!(delivered.inbox_unread_count, 1);
    assert!(read_inbox().await.unwrap().items[0].destination_available);
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
    let removed = read_inbox().await.unwrap().items.remove(0);
    assert!(!removed.destination_available);
    assert_eq!(
        [
            removed.project_name,
            removed.task_key,
            removed.task_title,
            removed.actor_name,
            removed.excerpt,
        ],
        [None, None, None, None, None]
    );
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
        let zone = oneloop::timezone::TimeZone::built_in(zone).unwrap();
        let service = DomainService::new(f.db.clone(), zone);
        service.roadmap(&f.manager, "p1".into()).await.unwrap();
        service
            .bootstrap(
                &f.manager,
                BootstrapQuery {
                    view: Some("roadmap".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn pool_pages_continue_from_their_cursor() {
    let f = fixture().await;
    // One item more than a page, all from the same second, so IDs order them.
    f.db.transaction(|tx| {
        for index in 0..51 {
            tx.execute(
                "INSERT INTO pool_items(id,project_id,scope,title,created_by,created_at,updated_at)
                 VALUES(?1,'p1','team','Idea','u1',1,1)",
                [format!("pool-{index:02}")],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let page = |cursor| {
        let query = PoolQuery {
            project_id: "p1".into(),
            scope: PoolScope::Team,
            cursor,
            limit: None,
        };
        f.service.pool_page(&f.member, query)
    };
    let first = page(None).await.unwrap();
    let second = page(first.next_cursor.clone()).await.unwrap();
    assert_eq!((first.items.len(), first.total), (50, 51));
    assert_eq!((second.items.len(), second.next_cursor), (1, None));
    let ids: Vec<_> = first
        .items
        .iter()
        .chain(&second.items)
        .map(|item| &item.id)
        .collect();
    let expected: Vec<_> = (0..51).map(|index| format!("pool-{index:02}")).collect();
    assert_eq!(ids, expected.iter().collect::<Vec<_>>());
}

#[tokio::test]
async fn epic_task_counts_come_only_with_the_roadmap() {
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Finished"}),
                "counted",
                None,
            ),
        )
        .await
        .unwrap();
    let task_id = created.entities[0]["id"].as_str().unwrap().to_owned();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":task_id,"status":"done"}),
                "counted-done",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let epic = |epics: &Value| {
        epics
            .as_array()
            .unwrap()
            .iter()
            .find(|epic| epic["id"] == "e1")
            .unwrap()
            .clone()
    };
    for (view, task) in [
        (Some("roadmap"), None),
        (None, None),
        (Some("board"), None),
        (Some("task"), Some(task_id.clone())),
        (Some("metadata"), None),
    ] {
        let bootstrap = f
            .service
            .bootstrap(
                &f.member,
                BootstrapQuery {
                    project_id: Some("p1".into()),
                    task_id: task,
                    view: view.map(str::to_owned),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let epic = epic(&serde_json::to_value(bootstrap).unwrap()["epics"]);
        let counted = view == Some("roadmap");
        for field in [
            "taskTotal",
            "taskDone",
            "taskOpen",
            "completedThisWeek",
            "completedSinceStart",
            "weeklyCompletions",
        ] {
            assert_eq!(epic.get(field).is_some(), counted, "{view:?} {field}");
        }
        if counted {
            assert_eq!(
                (&epic["taskTotal"], &epic["taskDone"]),
                (&json!(1), &json!(1))
            );
        }
        assert_eq!(epic["title"], "Open epic");
    }
    let roadmap = f.service.roadmap(&f.member, "p1".into()).await.unwrap();
    let epic = epic(&roadmap["epics"]);
    assert_eq!(epic["completedThisWeek"], 1);
    assert_eq!(epic["weeklyCompletions"][6], 1);
}

#[tokio::test]
async fn a_new_epic_comes_with_empty_task_counts() {
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateEpic,
                json!({"projectId":"p1","trackId":"tr1","title":"Fresh","startDate":"2026-10-01"}),
                "fresh-epic",
                None,
            ),
        )
        .await
        .unwrap();
    // The Roadmap that created it can show 0/0 without reading counts.
    let epic = &created.entities[0];
    for field in [
        "taskTotal",
        "taskDone",
        "taskOpen",
        "completedThisWeek",
        "completedSinceStart",
    ] {
        assert_eq!(epic[field], 0, "{field}");
    }
    assert_eq!(epic["weeklyCompletions"], json!([0, 0, 0, 0, 0, 0, 0]));
    // The activity keeps a record of the epic, not of its counts.
    let after = &created.events[0].after;
    assert!(
        after
            .as_ref()
            .is_some_and(|after| after.get("taskTotal").is_none()),
        "{after:?}"
    );
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
    let app = router(&f);
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
                .oneshot(signed_in_get("u2", &url))
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
async fn a_bootstrap_opens_the_project_of_a_switch_only_for_its_person_while_they_can_open_it() {
    let f = fixture().await;
    let app = router(&f);
    let selected = async |user: &str, query: &str| -> (u16, Value) {
        let response = app
            .clone()
            .oneshot(signed_in_get(
                user,
                &format!("/api/bootstrap?view=board&{query}"),
            ))
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body: Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
        (status, body["selectedProjectId"].clone())
    };
    // The manager can open both projects; the member only the first.
    for (user, query, answer) in [
        ("u1", "switchedTo=p2&switchedBy=u1", json!("p2")),
        ("u2", "switchedTo=p2&switchedBy=u2", json!("p1")),
        ("u1", "switchedTo=p2&switchedBy=u2", json!("p1")),
    ] {
        assert_eq!(
            selected(user, query).await,
            (200, answer),
            "{user}: {query}"
        );
    }
    // A project that the address names keeps its rule.
    let (status, _) = selected("u2", "projectId=p2&switchedTo=p1&switchedBy=u2").await;
    assert_eq!(status, 404);
}
