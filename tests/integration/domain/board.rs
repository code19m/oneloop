use super::*;

#[tokio::test]
async fn board_search_preserves_unicode_case_and_literal_punctuation() {
    let f = fixture().await;
    for (index, title) in ["ПРИВЕТ 100%_ready", "Other task"].iter().enumerate() {
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":title}),
                    &format!("unicode-search-{index}"),
                    None,
                ),
            )
            .await
            .unwrap();
    }
    for term in ["привет", "%", "_", "100%_ready"] {
        let page = f
            .service
            .board_page(
                &f.member,
                BoardQuery {
                    project_id: "p1".into(),
                    status: oneloop::domain::TaskStatus::Planning,
                    cursor: None,
                    limit: Some(50),
                    filter: TaskFilter {
                        search: Some(term.into()),
                        ..Default::default()
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(page.total, 1, "literal search {term}");
        assert_eq!(page.items[0].title, "ПРИВЕТ 100%_ready");
    }
}

#[tokio::test]
async fn composite_board_read_keeps_pages_filters_and_global_counts_consistent() {
    let f = fixture().await;
    let now = now();
    f.db
        .transaction(move |tx| {
            for index in 0..55_i64 {
                let status = if index < 52 {
                    "planning"
                } else if index < 54 {
                    "in_progress"
                } else {
                    "done"
                };
                let id = format!("board-view-{index:03}");
                tx.execute(
                    "INSERT INTO tasks
                     (id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                     VALUES (?1,'p1','tr1','e1',?2,?3,?4,?5,?6,'u1',?7,?7)",
                    params![
                        id,
                        index + 200,
                        format!("ONE-{:03}", index + 200),
                        if index == 0 { "Blocked needle" } else { "Board item" },
                        status,
                        index,
                        now,
                    ],
                )?;
                if index == 0 {
                    tx.execute(
                        "INSERT INTO task_blocks
                         (id,project_id,task_id,reason,created_by,created_at)
                         VALUES ('board-view-block','p1',?1,'Waiting','u1',?2)",
                        params![format!("board-view-{index:03}"), now],
                    )?;
                }
            }
            Ok(())
        })
        .await
        .unwrap();

    let first = f
        .service
        .board_view(
            &f.member,
            BoardViewQuery {
                project_id: "p1".into(),
                limit: Some(50),
                filter: TaskFilter::default(),
            },
        )
        .await
        .unwrap();
    assert_eq!(first.planning.items.len(), 50);
    assert_eq!(first.planning.total, 52);
    assert!(first.planning.next_cursor.is_some());
    assert_eq!(first.in_progress.total, 2);
    assert_eq!(first.done.total, 1);
    assert_eq!(first.counts.planning, 52);
    assert_eq!(first.counts.blocked, 1);

    let filtered = f
        .service
        .board_view(
            &f.member,
            BoardViewQuery {
                project_id: "p1".into(),
                limit: Some(50),
                filter: TaskFilter {
                    search: Some("needle".into()),
                    blocked: true,
                    ..Default::default()
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(filtered.planning.total, 1);
    assert_eq!(filtered.planning.items[0].title, "Blocked needle");
    assert_eq!(filtered.in_progress.total, 0);
    assert_eq!(filtered.counts.planning, 52);
    assert_eq!(filtered.counts.blocked, 1);
}

#[tokio::test]
async fn http_board_read_parses_multi_filters_and_blocked_across_the_dataset() {
    let f = fixture().await;
    // The first task matches; each other one is left out by one filter only.
    let mut ids = Vec::new();
    for (key, assignees, blocked) in [
        ("http-task", json!(["u3"]), true),
        ("http-unblocked", json!(["u3"]), false),
        ("http-unassigned", json!([]), true),
    ] {
        let created = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":key,"assigneeIds":assignees}),
                    key,
                    None,
                ),
            )
            .await
            .unwrap();
        let id = created.entities[0]["id"].as_str().unwrap().to_owned();
        if blocked {
            f.service
                .execute(
                    &f.manager,
                    command(
                        DomainOperation::BlockTask,
                        json!({"taskId":id,"reason":"Waiting"}),
                        &format!("{key}-block"),
                        Some(1),
                    ),
                )
                .await
                .unwrap();
        }
        ids.push(id);
    }
    let response = router(&f)
        .oneshot(signed_in_get(
            "u1",
            "/api/projects/p1/board?status=planning&trackIds=tr1,missing&epicIds=e1&assigneeIds=u2,u3&blocked=true&limit=50",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = body_bytes(response).await;
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["total"], 1);
    assert_eq!(value["items"][0]["id"], ids[0]);
    assert!(value["nextCursor"].is_null());
}

#[tokio::test]
async fn the_board_filters_by_each_tasks_own_track_and_finds_tasks_without_an_epic() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        tx.execute_batch("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('side','p1','Side',1,1,1);
            INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES
                ('in-epic','p1','tr1','e1',1,'ONE-001','In an epic','planning',0,1,1),
                ('loose','p1','side',NULL,2,'ONE-002','No epic','planning',1024,1,1);")?;
        Ok(())
    })
    .await
    .unwrap();
    let planning = async |track_ids: &[&str], epic_ids: &[&str]| {
        let mut query = board_query("planning", None);
        query.filter.track_ids = track_ids.iter().map(|id| id.to_string()).collect();
        query.filter.epic_ids = epic_ids.iter().map(|id| id.to_string()).collect();
        let page = f.service.board_page(&f.member, query).await.unwrap();
        let ids = page
            .items
            .iter()
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        (ids, page.total)
    };
    assert_eq!(
        planning(&["side"], &[]).await,
        (vec!["loose".to_owned()], 1)
    );
    assert_eq!(
        planning(&[], &["none"]).await,
        (vec!["loose".to_owned()], 1)
    );
    assert_eq!(
        planning(&[], &["e1", "none"]).await,
        (vec!["in-epic".to_owned(), "loose".to_owned()], 2)
    );
    assert_eq!(planning(&["tr1"], &["none"]).await, (Vec::new(), 0));
    let loose = f.service.task(&f.member, "loose".into()).await.unwrap();
    assert_eq!(
        (loose.track_id.as_str(), loose.epic_id, loose.started_at),
        ("side", None, None)
    );
}

#[tokio::test]
async fn a_bootstrap_with_board_filters_has_the_pages_that_the_board_read_has_for_them() {
    let f = fixture().await;
    let now = now();
    // More matching Planning tasks than fit on a page, and others that each
    // filter leaves out.
    f.db.transaction(move |tx| {
        for index in 0..60_i64 {
            let (title, status) = match index {
                0..55 => ("Needle", "planning"),
                55..57 => ("Needle", "in_progress"),
                57..59 => ("Haystack", "planning"),
                _ => ("Needle", "done"),
            };
            tx.execute(
                "INSERT INTO tasks
                 (id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at,completed_at)
                 VALUES (?1,'p1','tr1','e1',?2,?3,?4,?5,?2,'u1',?6,?6,?6)",
                params![format!("filtered-{index:03}"), index + 300, format!("ONE-{}", index + 300), title, status, now],
            )?;
        }
        tx.execute(
            "INSERT INTO task_assignees (task_id,user_id,assigned_by,assigned_at) VALUES ('filtered-001','u2','u1',?1)",
            [now],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let app = router(&f);
    let read = async |uri: String| -> Value {
        let response = app
            .clone()
            .oneshot(signed_in_get("u2", &uri))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{uri}");
        serde_json::from_slice(&body_bytes(response).await).unwrap()
    };
    let filter = "search=needle&trackIds=tr1&epicIds=e1&assigneeIds=u3&noAssignee=true";
    let board = read(format!("/api/projects/p1/board-view?{filter}&limit=50")).await;
    let bootstrap = read(format!("/api/bootstrap?projectId=p1&view=board&{filter}")).await;
    let ids = |items: &Value| -> Vec<String> {
        items
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let cards = |status: &str| -> Vec<String> {
        let tasks = bootstrap["tasks"].as_array().unwrap();
        ids(&Value::Array(
            tasks
                .iter()
                .filter(|task| task["status"] == status)
                .cloned()
                .collect(),
        ))
    };
    for (column, status) in [
        ("planning", "planning"),
        ("inProgress", "in_progress"),
        ("inReview", "in_review"),
        ("done", "done"),
    ] {
        assert_eq!(cards(status), ids(&board[column]["items"]), "{status}");
        let page = &bootstrap["boardPages"][status];
        assert_eq!(
            (&page["total"], &page["nextCursor"]),
            (&board[column]["total"], &board[column]["nextCursor"]),
            "{status}"
        );
    }
    // Planning has 54 matches, the task with an assignee being left out.
    assert_eq!(bootstrap["boardPages"]["planning"]["total"], 54);
    assert!(bootstrap["boardPages"]["planning"]["nextCursor"].is_string());
    assert_eq!(bootstrap["boardCounts"], board["counts"]);
    assert_eq!(
        bootstrap["boardFilter"],
        json!({"search":"needle","trackIds":["tr1"],"epicIds":["e1"],"assigneeIds":["u3"],
               "noAssignee":true,"blocked":false})
    );
}

#[tokio::test]
async fn filtered_board_moves_use_server_validated_visible_anchors() {
    let f = fixture().await;
    let mut ids = Vec::new();
    // A new task goes to the top, so the column reads Alpha, Beta, Gamma.
    for (index, title) in ["Visible Alpha", "Hidden Beta", "Visible Gamma"]
        .into_iter()
        .enumerate()
        .rev()
    {
        let result = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":title}),
                    &format!("anchor-{index}"),
                    None,
                ),
            )
            .await
            .unwrap();
        ids.push(result.entities[0]["id"].as_str().unwrap().to_owned());
    }
    ids.reverse();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":ids[2],"status":"planning","beforeTaskId":ids[0]}),
                "anchor-move",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let page = f
        .service
        .board_page(
            &f.manager,
            BoardQuery {
                project_id: "p1".into(),
                status: oneloop::domain::TaskStatus::Planning,
                cursor: None,
                limit: Some(50),
                filter: TaskFilter {
                    search: Some("Visible".into()),
                    ..Default::default()
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        page.items
            .into_iter()
            .map(|task| task.title)
            .collect::<Vec<_>>(),
        vec!["Visible Gamma", "Visible Alpha"]
    );
}

/// Records which tasks have their position written from now on.
async fn count_position_writes(f: &Fixture) {
    f.db.run(|connection| {
        connection.execute_batch(
            "CREATE TABLE test_position_writes(task_id TEXT);
            CREATE TRIGGER test_record_positions AFTER UPDATE OF position ON tasks BEGIN
                INSERT INTO test_position_writes VALUES(NEW.id);
            END;",
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

/// The tasks whose position was written since the last call.
async fn position_writes(f: &Fixture) -> HashSet<String> {
    f.db.run(|connection| {
        let written = connection
            .prepare("SELECT task_id FROM test_position_writes")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        connection.execute("DELETE FROM test_position_writes", [])?;
        Ok(written)
    })
    .await
    .unwrap()
}

async fn column(f: &Fixture, status: &str) -> Vec<oneloop::domain::TaskView> {
    let query = board_query(status, None);
    f.service.board_page(&f.manager, query).await.unwrap().items
}

#[tokio::test]
async fn ordering_writes_only_displaced_cards_and_preserves_retry_revision_and_anchor_rules() {
    let f = fixture().await;
    seed_ordering_column(&f, 6).await;
    count_position_writes(&f).await;
    let planning: HashSet<String> = (1..=6).map(|n| format!("order-{n}")).collect();
    let in_review: HashSet<String> = (7..=12).map(|n| format!("order-{n}")).collect();
    let adjacent = command(
        DomainOperation::MoveTask,
        json!({"taskId":"order-4","status":"planning","afterTaskId":"order-5"}),
        "adjacent-position",
        Some(1),
    );
    let first = f
        .service
        .execute(&f.manager, adjacent.clone())
        .await
        .unwrap();
    assert_eq!(first.entities[0]["revision"], 2);
    let replay = f.service.execute(&f.manager, adjacent).await.unwrap();
    assert_eq!(replay.entities, first.entities);
    assert!(position_writes(&f).await.is_subset(&planning));
    assert!(matches!(
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":"order-4","status":"planning","position":4}),
                    "noop-position",
                    Some(2)
                )
            )
            .await,
        Err(AppError::Validation {
            ref field, ..
        }) if field == "position"
    ));
    assert!(matches!(
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":"order-4","status":"planning","position":0}),
                    "stale-position",
                    Some(1)
                )
            )
            .await,
        Err(AppError::RevisionConflict { .. })
    ));
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":"order-4","status":"in_review","beforeTaskId":"order-9"}),
                "cross-position",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let mut destination = in_review.clone();
    destination.insert("order-4".into());
    assert!(
        position_writes(&f).await.is_subset(&destination),
        "source cards keep their positions"
    );
    // The destination now has room, so a move into it writes only the card.
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":"order-12","status":"in_review","beforeTaskId":"order-9"}),
                "spaced-position",
                Some(1),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        position_writes(&f).await,
        HashSet::from(["order-12".into()])
    );

    for (status, expected) in [
        (
            "planning",
            vec!["order-1", "order-2", "order-3", "order-5", "order-6"],
        ),
        (
            "in_review",
            vec![
                "order-7", "order-8", "order-4", "order-12", "order-9", "order-10", "order-11",
            ],
        ),
    ] {
        let cards = column(&f, status).await;
        assert_eq!(
            cards
                .iter()
                .map(|card| card.id.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(
            cards
                .windows(2)
                .all(|pair| pair[0].position < pair[1].position)
        );
        for card in &cards {
            let moves = match card.id.as_str() {
                "order-4" => 2,
                "order-12" => 1,
                _ => 0,
            };
            assert_eq!(card.revision, 1 + moves, "{}", card.id);
            if ["order-1", "order-2", "order-3", "order-7", "order-8"].contains(&card.id.as_str()) {
                assert_eq!(
                    card.updated_at, 1,
                    "unaffected card {} keeps its timestamp",
                    card.id
                );
            }
        }
    }
}

#[tokio::test]
async fn completing_blocked_task_goes_first_without_moving_done_cards() {
    let f = fixture().await;
    seed_ordering_column(&f, 3).await;
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":"order-4","status":"done"}),
                "existing-done",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let existing = column(&f, "done").await[0].position;
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":"order-1","reason":"Waiting"}),
                "block-order",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UnblockAndCompleteTask,
                json!({"taskId":"order-1"}),
                "complete-order",
                Some(2),
            ),
        )
        .await
        .unwrap();
    // The new card goes first and the existing one keeps its place. Both count
    // as completed, in the order they reached Done.
    let done = column(&f, "done").await;
    assert_eq!(
        done.iter()
            .map(|card| (
                card.id.as_str(),
                card.completed_at.is_some(),
                card.completion_order
            ))
            .collect::<Vec<_>>(),
        [("order-1", true, Some(2)), ("order-4", true, Some(1))]
    );
    assert_eq!(done[1].position, existing);
}

#[tokio::test]
async fn a_move_without_a_place_goes_to_the_top_of_its_new_column() {
    let f = fixture().await;
    seed_ordering_column(&f, 3).await;
    let move_to = async |id: &str, status: &str, revision| {
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":id,"status":status}),
                    &format!("{id}-{status}"),
                    Some(revision),
                ),
            )
            .await
            .unwrap()
    };
    let ids = async |status| {
        column(&f, status)
            .await
            .into_iter()
            .map(|card| card.id)
            .collect::<Vec<_>>()
    };
    move_to("order-3", "in_review", 1).await;
    assert_eq!(
        ids("in_review").await,
        ["order-3", "order-4", "order-5", "order-6"]
    );
    move_to("order-5", "done", 1).await;
    move_to("order-6", "done", 1).await;
    assert_eq!(ids("done").await, ["order-6", "order-5"]);
    // Leaving Done clears the completion, and the task goes to the top too.
    let reopened = move_to("order-5", "planning", 2).await;
    assert!(reopened.entities[0]["completedAt"].is_null());
    assert!(reopened.entities[0]["completionOrder"].is_null());
    assert_eq!(ids("planning").await, ["order-5", "order-1", "order-2"]);
}

#[tokio::test]
async fn new_and_promoted_tasks_start_at_the_top_of_planning() {
    let f = fixture().await;
    seed_ordering_column(&f, 2).await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"New task"}),
                "top-create",
                None,
            ),
        )
        .await
        .unwrap();
    let item = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreatePoolItem,
                json!({"projectId":"p1","scope":"team","title":"Idea"}),
                "top-idea",
                None,
            ),
        )
        .await
        .unwrap();
    let promoted = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::PromotePoolItem,
                json!({"poolItemId":item.entities[0]["id"],"epicId":"e1"}),
                "top-promote",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let planning = column(&f, "planning").await;
    assert_eq!(
        planning
            .iter()
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        [
            promoted.entities[0]["id"].as_str().unwrap(),
            created.entities[0]["id"].as_str().unwrap(),
            "order-1",
            "order-2"
        ]
    );
}

#[tokio::test]
async fn a_hundred_top_inserts_in_a_row_move_no_other_card() {
    let f = fixture().await;
    seed_ordering_column(&f, 100).await;
    count_position_writes(&f).await;
    // A move without a place goes a full gap above the first card, so every
    // other card keeps the position that open Boards know.
    for number in 101..=200 {
        let id = format!("order-{number}");
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":id,"status":"done"}),
                    &format!("top-{number}"),
                    Some(1),
                ),
            )
            .await
            .unwrap();
        assert_eq!(position_writes(&f).await, HashSet::from([id]));
    }
    let done = column(&f, "done").await;
    assert_eq!(
        done.iter()
            .take(3)
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        ["order-200", "order-199", "order-198"]
    );
}

#[tokio::test]
async fn re_spacing_a_column_with_negative_positions_keeps_its_order() {
    let f = fixture().await;
    seed_ordering_column(&f, 3).await;
    // Top inserts leave positions below zero; no gap is left between the first two.
    f.db.run(|connection| {
        connection.execute_batch(
            "UPDATE tasks SET position=-1025 WHERE id='order-1';
             UPDATE tasks SET position=-1024 WHERE id='order-2';
             UPDATE tasks SET position=1024 WHERE id='order-3';",
        )?;
        Ok(())
    })
    .await
    .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":"order-4","status":"planning","position":1}),
                "re-space",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let planning = column(&f, "planning").await;
    assert_eq!(
        planning
            .iter()
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
        ["order-1", "order-4", "order-2", "order-3"]
    );
    assert!(
        planning
            .windows(2)
            .all(|pair| pair[0].position < pair[1].position)
    );
}

#[tokio::test]
async fn a_change_that_re_spaces_its_column_says_so_in_its_activity_and_hint() {
    let f = fixture().await;
    seed_ordering_column(&f, 3).await;
    let runtime = oneloop::collaboration::CollaborationRuntime::new(f.db.clone());
    let mut hints = runtime.subscribe();
    // Whether each change's activity and live hint say that it re-spaced its column.
    let mut signals = Vec::new();
    let mut run = async |operation, payload: Value, key: &str, revision| {
        let result = f
            .service
            .execute(&f.manager, command(operation, payload, key, revision))
            .await
            .unwrap();
        drain(&runtime).await;
        let hint = hints.try_recv().unwrap();
        signals.push((
            key.to_owned(),
            result.events[0].metadata.get("respaced").cloned(),
            hint.respaced,
        ));
    };
    let top = json!({"taskId":"order-4","status":"planning"});
    run(DomainOperation::MoveTask, top, "top", Some(1)).await;
    // Planning holds positions -1024, 0, 1 and 2: no room between 0 and 1.
    let full_gap = json!({"taskId":"order-5","status":"planning","position":2});
    run(DomainOperation::MoveTask, full_gap, "full-gap", Some(1)).await;
    let task = json!({"projectId":"p1","epicId":"e1","title":"New task"});
    run(DomainOperation::CreateTask, task.clone(), "create", None).await;
    // The top card sits too close to the lowest position for a gap above it.
    f.db.run(|connection| {
        connection.execute(
            "UPDATE tasks SET position=?1 WHERE id=(SELECT id FROM tasks
             WHERE status='planning' ORDER BY position LIMIT 1)",
            [i64::MIN + 10],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    run(
        DomainOperation::CreateTask,
        task,
        "create-at-the-edge",
        None,
    )
    .await;
    let marked = Some(json!(true));
    assert_eq!(
        signals,
        [
            ("top".to_owned(), None, false),
            ("full-gap".to_owned(), marked.clone(), true),
            ("create".to_owned(), None, false),
            ("create-at-the-edge".to_owned(), marked, true),
        ]
    );
}

#[tokio::test]
async fn board_snapshot_batches_cards_and_omits_detail_text_without_changing_search() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static READS: AtomicUsize = AtomicUsize::new(0);
    let f = fixture().await;
    let timestamp = now();
    f.db.transaction(move|tx|{
        for index in 0..200_i64 {
            tx.execute("INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,description,status,position,created_by,created_at,updated_at) VALUES(?1,'p1','tr1','e1',?2,?3,'Привет task','Detail only',?4,?5,'u1',?6,?6)",params![format!("batch-{index}"),index+1000,format!("ONE-{}",index+1000),["planning","in_progress","in_review","done"][index as usize%4],index,timestamp])?;
        }Ok(())
    }).await.unwrap();
    f.db.run(|connection| {
        connection.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(|_| {
                READS.fetch_add(1, Ordering::Relaxed);
            }),
        );
        Ok(())
    })
    .await
    .unwrap();
    READS.store(0, Ordering::Relaxed);
    let snapshot = f
        .service
        .bootstrap(
            &f.member,
            BootstrapQuery {
                project_id: Some("p1".into()),
                task_id: None,
                view: Some("board".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    f.db.run(|connection| {
        connection.trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(snapshot.tasks.len(), 200);
    assert!(
        READS.load(Ordering::Relaxed) < 100,
        "card page must not issue queries per task"
    );
    assert!(snapshot.tasks.iter().all(|task| task.description.is_none()));
    assert!(
        serde_json::to_value(&snapshot.tasks[0])
            .unwrap()
            .get("description")
            .is_none()
    );
    let detail = f.service.task(&f.member, "batch-0".into()).await.unwrap();
    assert_eq!(detail.description.as_deref(), Some("Detail only"));
    let page = f
        .service
        .board_page(
            &f.member,
            BoardQuery {
                project_id: "p1".into(),
                status: oneloop::domain::TaskStatus::Planning,
                cursor: None,
                limit: Some(50),
                filter: TaskFilter {
                    search: Some("РИВ".into()),
                    ..Default::default()
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(page.total, 50);
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":"batch-0","title":"Changed"}),
                "batch-write",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let changed = f
        .service
        .bootstrap(&f.member, Default::default())
        .await
        .unwrap();
    assert_ne!(snapshot.sync_cursor, changed.sync_cursor);
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config { cases: 12, failure_persistence: None, ..proptest::test_runner::Config::default() })]
    #[test]
    fn generated_board_moves_match_a_vector_model(moves in proptest::collection::vec((0usize..6, 0usize..4, 0usize..8), 1..30)) {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let f = fixture().await;
            let statuses = ["planning", "in_progress", "in_review", "done"];
            let mut model = [Vec::<String>::new(), Vec::new(), Vec::new(), Vec::new()];
            for index in 0..6 {
                let created = f.service.execute(&f.manager, command(DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":format!("Model {index}")}), &format!("model-create-{index}"), None)).await.unwrap();
                model[0].insert(0, created.entities[0]["id"].as_str().unwrap().to_owned());
            }
            let ids = model[0].clone();
            for (step, (moving, target, requested)) in moves.iter().copied().enumerate() {
                let id = &ids[moving];
                let source = model.iter().position(|column| column.contains(id)).unwrap();
                let old = model[source].iter().position(|item| item == id).unwrap();
                let target_len = model[target].len() - usize::from(source == target);
                let position = requested % (target_len + 1);
                let task = id.clone();
                let revision: i64 = query_one(&f.db, "SELECT revision FROM tasks WHERE id=?1", [task]).await;
                let result = f.service.execute(&f.manager, command(DomainOperation::MoveTask,
                    json!({"taskId":id,"status":statuses[target],"position":position}), &format!("model-move-{step}"), Some(revision))).await;
                if source == target && old == position { assert_eq!(result.unwrap_err().code(), "validation_failed"); }
                else { result.unwrap(); model[source].remove(old); model[target].insert(position, id.clone()); }
                for (column, status) in statuses.iter().enumerate() {
                    let page = f.service.board_page(&f.manager, BoardQuery { project_id:"p1".into(), status:serde_json::from_value(json!(status)).unwrap(), limit:Some(50), cursor:None, filter: TaskFilter::default() }).await.unwrap();
                    assert_eq!(page.items.iter().map(|task|task.id.clone()).collect::<Vec<_>>(), model[column]);
                    assert!(page.items.windows(2).all(|pair| pair[0].position < pair[1].position));
                }
            }
            for payload in [
                json!({"taskId":ids[0],"status":"planning","position":0,"beforeTaskId":ids[1]}),
                json!({"taskId":ids[0],"status":"planning","beforeTaskId":"missing-anchor"}),
                json!({"taskId":ids[0],"status":"planning","afterTaskId":"missing-anchor"}),
                // Past the end of any column of the six tasks.
                json!({"taskId":ids[0],"status":"planning","position":6}),
            ] {
                let task = ids[0].clone();
                let revision: i64 = query_one(&f.db, "SELECT revision FROM tasks WHERE id=?1", [task]).await;
                let error = f.service.execute(&f.manager, command(DomainOperation::MoveTask, payload, &uuid::Uuid::now_v7().to_string(), Some(revision))).await.unwrap_err();
                assert_eq!(error.code(), "validation_failed");
            }
        });
    }
}

#[tokio::test]
async fn task_pages_detect_concurrent_moves_and_sort_epic_numbers_across_prefixes() {
    let f = fixture().await;
    seed_ordering_column(&f, 61).await;
    let first = f
        .service
        .board_page(&f.member, board_query("planning", None))
        .await
        .unwrap();
    let epic_first = f
        .service
        .epic_tasks(
            &f.member,
            "e1".into(),
            oneloop::domain::PageQuery::default(),
        )
        .await
        .unwrap();
    for i in 1..=2 {
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":format!("order-{i}"),"status":"in_progress"}),
                    &format!("paged-move-{i}"),
                    Some(1),
                ),
            )
            .await
            .unwrap();
    }
    let error = f
        .service
        .board_page(&f.member, board_query("planning", first.next_cursor))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "cursor_stale");
    let error = f
        .service
        .epic_tasks(
            &f.member,
            "e1".into(),
            oneloop::domain::PageQuery {
                cursor: epic_first.next_cursor,
                limit: Some(50),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "cursor_stale");
    f.db.transaction(|tx| {
        tx.execute("DELETE FROM tasks",[])?;
        for (number,key) in [(1000,"AAA-1000"),(101,"OLD-101"),(5000,"NEW-5000")] {
            tx.execute("INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES(?1,'p1','tr1','e1',?2,?1,'Numeric order','planning',?2,1,1)",params![key,number])?;
        }
        Ok(())
    }).await.unwrap();
    let mut cursor = None;
    let mut keys = Vec::new();
    loop {
        let page = f
            .service
            .epic_tasks(
                &f.member,
                "e1".into(),
                oneloop::domain::PageQuery {
                    cursor,
                    limit: Some(1),
                },
            )
            .await
            .unwrap();
        keys.extend(page.items.into_iter().map(|t| t.task_key));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(keys, ["OLD-101", "AAA-1000", "NEW-5000"]);
}

#[tokio::test]
async fn done_column_removal_and_anchored_move_do_not_rewrite_other_cards() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        // Position writes are recorded, so a few cards show what a large
        // column does. The weekly workload times moves into and deletions
        // from a Done column of about 50,000 cards.
        let mut insert=tx.prepare("INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at) VALUES(?1,'p1','tr1','e1',?2,?1,'Done column','done',?3,1,1,1)")?;
        for n in 1..=6_i64 {insert.execute(params![format!("bulk-{n}"),n,n*1024])?;}
        Ok(())
    }).await.unwrap();
    count_position_writes(&f).await;
    let mut completed_at = Vec::new();
    for (operation, payload, key) in [
        (
            DomainOperation::MoveTask,
            json!({"taskId":"bulk-1","status":"done","afterTaskId":"bulk-4"}),
            "bulk-anchor",
        ),
        (
            DomainOperation::MoveTask,
            json!({"taskId":"bulk-2","status":"planning"}),
            "bulk-out",
        ),
        (
            DomainOperation::DeleteTask,
            json!({"id":"bulk-3"}),
            "bulk-delete",
        ),
    ] {
        let result = f
            .service
            .execute(&f.manager, command(operation, payload, key, Some(1)))
            .await
            .unwrap();
        completed_at.push(result.entities[0]["completedAt"].clone());
    }
    assert_eq!(
        position_writes(&f).await,
        HashSet::from(["bulk-1".to_owned(), "bulk-2".to_owned()]),
        "only the two moved cards write their positions"
    );
    assert_eq!(
        completed_at[..2],
        [json!(1), Value::Null],
        "reordering Done preserves completion history; reopening clears it"
    );
    let page = f
        .service
        .board_page(&f.member, board_query("done", None))
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    assert_eq!(page.items[0].id, "bulk-4");
}

#[tokio::test]
async fn page_read_keeps_its_snapshot_when_deletion_commits_between_statements() {
    use std::sync::Mutex;
    static DELETE_AT_IDS: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
    static WRITE_RESULT: Mutex<Option<Result<usize, String>>> = Mutex::new(None);
    let f = fixture().await;
    seed_ordering_column(&f, 6).await;
    let path = f.db.layout().database();
    *DELETE_AT_IDS.lock().unwrap() = Some(path);
    f.db.run(|c| {
        c.trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(|event| {
                if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
                    && sql.starts_with("SELECT t.id FROM tasks t WHERE")
                    && let Some(path) = DELETE_AT_IDS.lock().unwrap().take()
                {
                    let result = rusqlite::Connection::open(path)
                        .and_then(|writer| {
                            writer.execute(
                                "UPDATE tasks SET deleted_at=1 WHERE status='planning'",
                                [],
                            )
                        })
                        .map_err(|e| e.to_string());
                    *WRITE_RESULT.lock().unwrap() = Some(result);
                }
            }),
        );
        Ok(())
    })
    .await
    .unwrap();
    let page = f
        .service
        .board_page(&f.member, board_query("planning", None))
        .await
        .unwrap();
    assert_eq!(WRITE_RESULT.lock().unwrap().take().unwrap().unwrap(), 6);
    assert_eq!(page.total, 6);
    assert_eq!(
        page.items.len(),
        6,
        "the ID and hydration reads share the earlier count snapshot"
    );
    assert!(
        f.service
            .board_page(&f.member, board_query("planning", None))
            .await
            .unwrap()
            .items
            .is_empty()
    );
}

#[tokio::test]
async fn filtered_board_counts_survive_empty_cursor_pages_and_search_edits() {
    let f = fixture().await;
    seed_ordering_column(&f, 4).await;
    let query = |cursor| BoardQuery {
        project_id: "p1".into(),
        status: oneloop::domain::TaskStatus::Planning,
        cursor,
        limit: Some(2),
        filter: TaskFilter {
            search: Some("ORDERING".into()),
            epic_ids: vec!["e1".into()],
            no_assignee: true,
            ..Default::default()
        },
    };
    let first = f.service.board_page(&f.member, query(None)).await.unwrap();
    assert_eq!(first.total, 4);
    assert_eq!(first.items.len(), 2);
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut past_end: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(first.next_cursor.as_ref().unwrap())
            .unwrap(),
    )
    .unwrap();
    past_end["position"] = json!(999999);
    past_end["id"] = json!("absent");
    let past_end = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&past_end).unwrap());
    let second = f
        .service
        .board_page(&f.member, query(first.next_cursor))
        .await
        .unwrap();
    assert_eq!(second.total, 4);
    assert_eq!(second.items.len(), 2);
    assert!(second.next_cursor.is_none());
    let empty = f
        .service
        .board_page(&f.member, query(Some(past_end)))
        .await
        .unwrap();
    assert_eq!(empty.total, 4);
    assert!(empty.items.is_empty());
    assert!(empty.next_cursor.is_none());
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":"order-1","title":"Unmatched"}),
                "search-title",
                Some(1),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        f.service
            .board_page(&f.member, query(None))
            .await
            .unwrap()
            .total,
        3
    );
}

async fn seed_done_column(f: &Fixture) {
    // Completion times out of the column's order, with a tie, and one task
    // without a completion time, which only data from before completion
    // times were kept can have.
    f.db.transaction(|tx| {
        for (number, id, completed) in [
            (501, "done-a", Some(100)),
            (502, "done-b", Some(300)),
            (503, "done-c", Some(200)),
            (504, "done-d", Some(300)),
            (505, "done-e", None),
            (506, "done-f", Some(50)),
        ] {
            tx.execute(
                "INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at)
                 VALUES(?1,'p1','tr1','e1',?2,?3,'Finished work','done',?2,1,1,?4)",
                params![id, number, format!("ONE-{number}"), completed],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
}

/// Every Done task of the project, page by page: from the index without a
/// search, or from the filtered matches with one.
async fn done_pages(f: &Fixture, search: Option<&str>) -> Vec<String> {
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let query = BoardQuery {
            limit: Some(2),
            filter: TaskFilter {
                search: search.map(str::to_owned),
                ..Default::default()
            },
            ..board_query("done", cursor)
        };
        let page = f.service.board_page(&f.member, query).await.unwrap();
        seen.extend(page.items.into_iter().map(|task| task.id));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    seen
}

#[tokio::test]
async fn done_pages_follow_the_columns_own_order_whatever_the_completion_times() {
    let f = fixture().await;
    seed_done_column(&f).await;
    for search in [None, Some("finished")] {
        assert_eq!(
            done_pages(&f, search).await,
            ["done-a", "done-b", "done-c", "done-d", "done-e", "done-f"],
            "{search:?}"
        );
    }
}

#[tokio::test]
async fn a_task_moved_to_done_comes_first_in_done() {
    let f = fixture().await;
    seed_done_column(&f).await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Just finished"}),
                "finish-create",
                None,
            ),
        )
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap().to_owned();
    assert!(created.entities[0]["completedAt"].is_null());
    let before = now();
    let moved = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":id,"status":"done"}),
                "finish-move",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let completed_at = moved.entities[0]["completedAt"].as_i64().unwrap();
    assert!((before..=now()).contains(&completed_at));
    let done = f
        .service
        .board_page(&f.member, board_query("done", None))
        .await
        .unwrap();
    assert_eq!(done.items[0].id, id);
    let reopened = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":id,"status":"in_review"}),
                "finish-reopen",
                Some(2),
            ),
        )
        .await
        .unwrap();
    assert!(reopened.entities[0]["completedAt"].is_null());
}

#[tokio::test]
async fn done_lists_tasks_finished_in_one_second_the_last_finished_first() {
    let f = fixture().await;
    let mut ids = Vec::new();
    for number in 1..=4 {
        let created = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":format!("Quick {number}")}),
                    &format!("quick-create-{number}"),
                    None,
                ),
            )
            .await
            .unwrap();
        ids.push(created.entities[0]["id"].as_str().unwrap().to_owned());
    }
    // ONE-004, ONE-001, ONE-003 and ONE-002 move to Done in that order...
    for index in [3, 0, 2, 1] {
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":ids[index],"status":"done"}),
                    &format!("quick-done-{index}"),
                    Some(1),
                ),
            )
            .await
            .unwrap();
    }
    // ...within one second, as quick keyboard moves or an assistant's batch
    // do. Each went to the top of Done, so the last one finished is first.
    f.db.run(|connection| {
        connection.execute("UPDATE tasks SET completed_at=1000 WHERE status='done'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let expected = [1, 2, 0, 3].map(|index| ids[index].clone());
    for search in [None, Some("quick")] {
        assert_eq!(done_pages(&f, search).await, expected, "{search:?}");
    }
}

#[tokio::test]
async fn a_done_order_from_an_older_page_gets_done_in_its_own_order() {
    // A page from 0.1.0-rc.8 or older may still ask for its Done order
    // until it reloads; it gets the normal answer.
    let f = fixture().await;
    seed_done_column(&f).await;
    let app = router(&f);
    let read = async |uri: &str| -> Value {
        let response = app.clone().oneshot(signed_in_get("u2", uri)).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{uri}");
        serde_json::from_slice(&body_bytes(response).await).unwrap()
    };
    for order in ["completed", "manual", "newest"] {
        let page = read(&format!(
            "/api/projects/p1/board?status=done&doneOrder={order}&limit=2"
        ))
        .await;
        assert_eq!(page["items"][0]["id"], "done-a", "{order}");
        let view = read(&format!(
            "/api/projects/p1/board-view?doneOrder={order}&limit=2"
        ))
        .await;
        assert_eq!(view["done"]["items"][1]["id"], "done-b", "{order}");
        let bootstrap = read(&format!(
            "/api/bootstrap?projectId=p1&view=board&doneOrder={order}"
        ))
        .await;
        assert!(bootstrap["boardFilter"].get("doneOrder").is_none());
        let done = bootstrap["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["status"] == "done")
            .map(|task| task["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(done[..2], ["done-a", "done-b"], "{order}");
    }
}
