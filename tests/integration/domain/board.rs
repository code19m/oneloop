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
                    search: Some(term.into()),
                    track_ids: vec![],
                    epic_ids: vec![],
                    assignee_ids: vec![],
                    no_assignee: false,
                    blocked: false,
                    done_order: Default::default(),
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
                     (id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                     VALUES (?1,'p1','e1',?2,?3,?4,?5,?6,'u1',?7,?7)",
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
                search: None,
                track_ids: vec![],
                epic_ids: vec![],
                assignee_ids: vec![],
                no_assignee: false,
                blocked: false,
                done_order: Default::default(),
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
                search: Some("needle".into()),
                track_ids: vec![],
                epic_ids: vec![],
                assignee_ids: vec![],
                no_assignee: false,
                blocked: true,
                done_order: Default::default(),
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
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Filtered","assigneeIds":["u3"]}),
                "http-task",
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
                DomainOperation::BlockTask,
                json!({"taskId":task_id,"reason":"Waiting"}),
                "http-block",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let config = support::config(f._root.path(), "http://127.0.0.1:8080", &[]);
    let app = oneloop::http::domain::read_router()
        .layer(Extension(f.manager.clone()))
        .with_state(AppState::new(config, f.db.clone()));
    let response = app.oneshot(axum::http::Request::builder()
        .uri("/api/projects/p1/board?status=planning&trackIds=tr1,missing&epicIds=e1&assigneeIds=u2,u3&blocked=true&limit=50")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = body_bytes(response).await;
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["total"], 1);
    assert_eq!(value["items"][0]["id"], task_id);
    assert!(value["nextCursor"].is_null());
}

#[tokio::test]
async fn filtered_board_moves_use_server_validated_visible_anchors() {
    let f = fixture().await;
    let mut ids = Vec::new();
    for (index, title) in ["Visible Alpha", "Hidden Beta", "Visible Gamma"]
        .into_iter()
        .enumerate()
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
                search: Some("Visible".into()),
                track_ids: vec![],
                epic_ids: vec![],
                assignee_ids: vec![],
                no_assignee: false,
                blocked: false,
                done_order: Default::default(),
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

/// Real shared-command service and current SQLite schema. Run explicitly; timings
/// have generous regression budgets, not a production capacity guarantee.
#[tokio::test]
#[ignore = "manual ordering workload measurement"]
async fn ordering_workload_reports_moves_with_an_unrelated_write() {
    use std::time::{Duration, Instant};
    for count in [1_000_i64, 10_000] {
        let f = fixture().await;
        seed_ordering_column(&f, count).await;
        let mut task_revision = 1;
        let mut project_revision = 1;
        for (round, (kind, status, position)) in [
            ("same-adjacent", "planning", count / 2 + 1),
            ("same-long", "planning", 0),
            ("cross-middle", "in_review", count / 2),
            ("cross-back", "planning", count / 2),
        ]
        .into_iter()
        .enumerate()
        {
            let task_id = format!("order-{}", count / 2 + 1);
            let move_command = command(
                DomainOperation::MoveTask,
                json!({"taskId":task_id,"status":status,"position":position}),
                &format!("measure-move-{round}"),
                Some(task_revision),
            );
            let update_command = command(
                DomainOperation::UpdateProject,
                json!({"projectId":"p2","name":format!("Unrelated {round}")}),
                &format!("measure-unrelated-{round}"),
                Some(project_revision),
            );
            let move_start = Instant::now();
            let move_future = async {
                f.service.execute(&f.manager, move_command).await.unwrap();
                move_start.elapsed().as_secs_f64() * 1000.0
            };
            let unrelated_future = async {
                tokio::time::sleep(Duration::from_millis(1)).await;
                let started = Instant::now();
                f.service.execute(&f.admin, update_command).await.unwrap();
                started.elapsed().as_secs_f64() * 1000.0
            };
            let (move_ms, unrelated_ms) = tokio::join!(move_future, unrelated_future);
            println!(
                "ordering-workload column={count} kind={kind} move_ms={move_ms:.3} unrelated_ms={unrelated_ms:.3}"
            );
            assert!(move_ms < 5_000.0, "ordering regression: {move_ms} ms");
            assert!(
                unrelated_ms < 5_000.0,
                "writer starvation: {unrelated_ms} ms"
            );
            task_revision += 1;
            project_revision += 1;
        }
    }
}

#[tokio::test]
async fn ordering_writes_only_displaced_cards_and_preserves_retry_revision_and_anchor_rules() {
    let f = fixture().await;
    seed_ordering_column(&f, 6).await;
    f.db.run(|connection| {
        connection.execute_batch(
            "CREATE TABLE test_position_writes(task_id TEXT PRIMARY KEY, writes INTEGER);
            CREATE TRIGGER test_count_positions AFTER UPDATE OF position ON tasks BEGIN
                INSERT INTO test_position_writes VALUES(NEW.id,1)
                ON CONFLICT(task_id) DO UPDATE SET writes=writes+1;
            END;",
        )?;
        Ok(())
    })
    .await
    .unwrap();
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
    let writes: i64 =
        f.db.run(|connection| {
            Ok(
                connection.query_row(
                    "SELECT SUM(writes) FROM test_position_writes",
                    [],
                    |row| row.get(0),
                )?,
            )
        })
        .await
        .unwrap();
    assert_eq!(
        writes, 13,
        "dense legacy column is spaced once, then only the moved card is written"
    );
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
    f.db.run(|connection| {
        connection.execute("DELETE FROM test_position_writes", [])?;
        Ok(())
    })
    .await
    .unwrap();
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
    let (rows, writes) =
        f.db.run(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,status,position,revision,updated_at FROM tasks ORDER BY status,position",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let writes: i64 = connection.query_row(
                "SELECT SUM(writes) FROM test_position_writes",
                [],
                |row| row.get(0),
            )?;
            Ok((rows, writes))
        })
        .await
        .unwrap();
    assert_eq!(
        writes, 13,
        "only the dense destination is spaced; source cards keep their positions"
    );
    for (status, expected) in [
        (
            "planning",
            vec!["order-1", "order-2", "order-3", "order-5", "order-6"],
        ),
        (
            "in_review",
            vec![
                "order-7", "order-8", "order-4", "order-9", "order-10", "order-11", "order-12",
            ],
        ),
    ] {
        let actual = rows
            .iter()
            .filter(|row| row.1 == status)
            .collect::<Vec<_>>();
        assert_eq!(
            actual.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            expected
        );
        assert!(actual.windows(2).all(|pair| pair[0].2 < pair[1].2));
    }
    for row in &rows {
        assert_eq!(row.3, if row.0 == "order-4" { 3 } else { 1 });
        if ["order-1", "order-2", "order-3", "order-7", "order-8"].contains(&row.0.as_str()) {
            assert_eq!(row.4, 1, "unaffected card {} keeps its timestamp", row.0);
        }
    }
}

#[tokio::test]
async fn completing_blocked_task_appends_without_compacting_done_column() {
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
    let rows =
        f.db.run(|connection| {
            let mut statement = connection
                .prepare("SELECT id,position FROM tasks WHERE status='done' ORDER BY position")?;
            Ok(statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(
        rows,
        vec![("order-4".into(), 1024), ("order-1".into(), 2048)]
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
            tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,description,status,position,created_by,created_at,updated_at) VALUES(?1,'p1','e1',?2,?3,'Привет task','Detail only',?4,?5,'u1',?6,?6)",params![format!("batch-{index}"),index+1000,format!("ONE-{}",index+1000),["planning","in_progress","in_review","done"][index as usize%4],index,timestamp])?;
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
                done_order: Default::default(),
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
    assert!(snapshot.browser_sessions.is_empty());
    assert!(snapshot.pool.is_empty());
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
                search: Some("РИВ".into()),
                track_ids: vec![],
                epic_ids: vec![],
                assignee_ids: vec![],
                no_assignee: false,
                blocked: false,
                done_order: Default::default(),
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
    assert_ne!(
        snapshot.sync_cursor,
        f.service.sync_cursor(&f.member).await.unwrap()
    );
    let unused: i64=f.db.run(|connection|Ok(connection.query_row("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'task_search%' OR name LIKE 'tasks_search%'",[],|row|row.get(0))?)).await.unwrap();
    assert_eq!(unused, 0);
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
                model[0].push(created.entities[0]["id"].as_str().unwrap().to_owned());
            }
            let ids = model[0].clone();
            for (step, (moving, target, requested)) in moves.iter().copied().enumerate() {
                let id = &ids[moving];
                let source = model.iter().position(|column| column.contains(id)).unwrap();
                let old = model[source].iter().position(|item| item == id).unwrap();
                let target_len = model[target].len() - usize::from(source == target);
                let position = requested % (target_len + 1);
                let task = id.clone();
                let revision: i64 = f.db.run(move |c| Ok(c.query_row("SELECT revision FROM tasks WHERE id=?1", [task], |row| row.get(0))?)).await.unwrap();
                let result = f.service.execute(&f.manager, command(DomainOperation::MoveTask,
                    json!({"taskId":id,"status":statuses[target],"position":position}), &format!("model-move-{step}"), Some(revision))).await;
                if source == target && old == position { assert_eq!(result.unwrap_err().code(), "validation_failed"); }
                else { result.unwrap(); model[source].remove(old); model[target].insert(position, id.clone()); }
                for (column, status) in statuses.iter().enumerate() {
                    let page = f.service.board_page(&f.manager, BoardQuery {
                        project_id:"p1".into(), status:serde_json::from_value(json!(status)).unwrap(), limit:Some(50), cursor:None,
                        search:None, track_ids:vec![], epic_ids:vec![], assignee_ids:vec![], no_assignee:false, blocked:false,
                        done_order: Default::default(),
                    }).await.unwrap();
                    assert_eq!(page.items.iter().map(|task|task.id.clone()).collect::<Vec<_>>(), model[column]);
                    assert!(page.items.windows(2).all(|pair| pair[0].position < pair[1].position));
                }
            }
            for payload in [
                json!({"taskId":ids[0],"status":"planning","position":0,"beforeTaskId":ids[1]}),
                json!({"taskId":ids[0],"status":"planning","beforeTaskId":"missing-anchor"}),
                json!({"taskId":ids[0],"status":"planning","afterTaskId":"missing-anchor"}),
            ] {
                let task = ids[0].clone();
                let revision: i64 = f.db.run(move |c| Ok(c.query_row("SELECT revision FROM tasks WHERE id=?1", [task], |r|r.get(0))?)).await.unwrap();
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
            tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES(?1,'p1','e1',?2,?1,'Numeric order','planning',?2,1,1)",params![key,number])?;
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
async fn large_done_column_removal_and_anchored_move_do_not_rewrite_other_cards() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        let mut insert=tx.prepare("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at) VALUES(?1,'p1','e1',?2,?1,'Large done column','done',?3,1,1,1)")?;
        for n in 1..=50_000_i64 {insert.execute(params![format!("bulk-{n}"),n,n*1024])?;}
        tx.execute_batch("CREATE TABLE position_writes(id TEXT); CREATE TRIGGER count_position_writes AFTER UPDATE OF position ON tasks BEGIN INSERT INTO position_writes VALUES(NEW.id); END;")?;
        Ok(())
    }).await.unwrap();
    let start = std::time::Instant::now();
    for (operation, payload, key) in [
        (
            DomainOperation::MoveTask,
            json!({"taskId":"bulk-1","status":"done","afterTaskId":"bulk-25000"}),
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
        f.service
            .execute(&f.manager, command(operation, payload, key, Some(1)))
            .await
            .unwrap();
    }
    let writes: i64 =
        f.db.run(|c| Ok(c.query_row("SELECT COUNT(*) FROM position_writes", [], |r| r.get(0))?))
            .await
            .unwrap();
    assert_eq!(writes, 2, "only the two moved cards write their positions");
    assert!(start.elapsed() < std::time::Duration::from_secs(10));
    eprintln!(
        "50k Done column: three commands {:?}, {writes} position writes",
        start.elapsed()
    );
    let completion_times =
        f.db.run(|c| {
            Ok((
                c.query_row(
                    "SELECT completed_at FROM tasks WHERE id='bulk-1'",
                    [],
                    |r| r.get::<_, Option<i64>>(0),
                )?,
                c.query_row(
                    "SELECT completed_at FROM tasks WHERE id='bulk-2'",
                    [],
                    |r| r.get::<_, Option<i64>>(0),
                )?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(
        completion_times,
        (Some(1), None),
        "reordering Done preserves completion history; reopening clears it"
    );
    let page = f
        .service
        .board_page(&f.member, board_query("done", None))
        .await
        .unwrap();
    assert_eq!(page.total, 49_998);
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
        search: Some("ORDERING".into()),
        cursor,
        limit: Some(2),
        track_ids: vec![],
        epic_ids: vec!["e1".into()],
        assignee_ids: vec![],
        no_assignee: true,
        blocked: false,
        done_order: Default::default(),
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
    // Completion times with a tie, and one task without a completion time,
    // which only data from before completion times were kept can have.
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
                "INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at)
                 VALUES(?1,'p1','e1',?2,?3,'Finished work','done',?2,1,1,?4)",
                params![id, number, format!("ONE-{number}"), completed],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
}

fn newest_done_query(cursor: Option<String>, search: Option<&str>) -> BoardQuery {
    BoardQuery {
        limit: Some(2),
        search: search.map(str::to_owned),
        done_order: DoneOrder::Completed,
        ..board_query("done", cursor)
    }
}

#[tokio::test]
async fn newest_first_done_pages_follow_completion_time() {
    let f = fixture().await;
    seed_done_column(&f).await;
    // The unfiltered read uses the index; a search reads the filtered matches.
    for search in [None, Some("finished")] {
        let mut cursor = None;
        let mut seen = Vec::new();
        loop {
            let page = f
                .service
                .board_page(&f.member, newest_done_query(cursor, search))
                .await
                .unwrap();
            assert_eq!(page.total, 6, "{search:?}");
            seen.extend(page.items.iter().map(|task| task.id.clone()));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(
            seen,
            ["done-d", "done-b", "done-c", "done-a", "done-f", "done-e"],
            "{search:?}"
        );
    }
    let first = f
        .service
        .board_page(&f.member, newest_done_query(None, None))
        .await
        .unwrap();
    assert_eq!(first.items[0].completed_at, Some(300));
    let manual = f
        .service
        .board_page(&f.member, board_query("done", None))
        .await
        .unwrap();
    assert_eq!(
        manual.items[0].id, "done-a",
        "Manual order stays the default"
    );
}

#[tokio::test]
async fn a_task_moved_to_done_comes_first_only_in_newest_first_order() {
    let f = fixture().await;
    seed_done_column(&f).await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Just finished"}),
                "newest-create",
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
                "newest-move",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let completed_at = moved.entities[0]["completedAt"].as_i64().unwrap();
    assert!((before..=now()).contains(&completed_at));
    let newest = f
        .service
        .board_page(&f.member, newest_done_query(None, None))
        .await
        .unwrap();
    assert_eq!(newest.items[0].id, id);
    let mut manual = board_query("done", None);
    manual.limit = Some(50);
    let manual = f.service.board_page(&f.member, manual).await.unwrap();
    assert_eq!(manual.items.last().unwrap().id, id);
    let reopened = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":id,"status":"in_review"}),
                "newest-reopen",
                Some(2),
            ),
        )
        .await
        .unwrap();
    assert!(reopened.entities[0]["completedAt"].is_null());
}

#[tokio::test]
async fn newest_first_lists_tasks_completed_in_one_second_by_completion() {
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
    // ...within one second, as quick keyboard moves or an assistant's batch do.
    f.db.run(|connection| {
        connection.execute("UPDATE tasks SET completed_at=1000 WHERE status='done'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let expected = [1, 2, 0, 3].map(|index| ids[index].clone());
    // The unfiltered read uses the index; a search reads the filtered matches.
    for search in [None, Some("quick")] {
        let mut cursor = None;
        let mut seen = Vec::new();
        loop {
            let page = f
                .service
                .board_page(&f.member, newest_done_query(cursor, search))
                .await
                .unwrap();
            seen.extend(page.items.into_iter().map(|task| task.id));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(seen, expected, "{search:?}");
    }
}

#[tokio::test]
async fn done_order_cursors_and_parameters_belong_to_their_order() {
    let f = fixture().await;
    seed_done_column(&f).await;
    let newest = f
        .service
        .board_page(&f.member, newest_done_query(None, None))
        .await
        .unwrap();
    let mut manual = board_query("done", None);
    manual.limit = Some(2);
    let manual = f.service.board_page(&f.member, manual).await.unwrap();
    let mut mixed = board_query("done", newest.next_cursor.clone());
    mixed.limit = Some(2);
    assert!(f.service.board_page(&f.member, mixed).await.is_err());
    assert!(
        f.service
            .board_page(&f.member, newest_done_query(manual.next_cursor, None))
            .await
            .is_err()
    );
    // Other columns keep their manual order whatever the Done order is.
    seed_ordering_column(&f, 3).await;
    let mut planning = board_query("planning", None);
    planning.done_order = DoneOrder::Completed;
    let planning = f.service.board_page(&f.member, planning).await.unwrap();
    assert_eq!(
        planning
            .items
            .iter()
            .map(|task| task.position)
            .collect::<Vec<_>>(),
        [0, 1, 2]
    );

    let config = support::config(f._root.path(), "http://127.0.0.1:8080", &[]);
    let app = oneloop::http::domain::read_router()
        .layer(Extension(f.member.clone()))
        .with_state(AppState::new(config, f.db.clone()));
    let get = |uri: &str| {
        app.clone().oneshot(
            axum::http::Request::builder()
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
    };
    let response = get("/api/projects/p1/board?status=done&doneOrder=completed&limit=2")
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let page: Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
    assert_eq!(page["items"][0]["id"], "done-d");
    let response = get("/api/projects/p1/board-view?doneOrder=completed&limit=2")
        .await
        .unwrap();
    let view: Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
    assert_eq!(view["done"]["items"][1]["id"], "done-b");
    let response = get("/api/bootstrap?projectId=p1&view=board&doneOrder=completed")
        .await
        .unwrap();
    let bootstrap: Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
    assert_eq!(bootstrap["doneOrder"], "completed");
    let done = bootstrap["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| task["status"] == "done")
        .map(|task| task["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(done[..2], ["done-d", "done-b"]);
    let response = get("/api/projects/p1/board?status=done&doneOrder=newest")
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
}

/// Compare real Board read latency before and after search changes, without CI
/// timing thresholds. The seeded project has 100,000 tasks and two full columns.
#[tokio::test]
#[ignore = "manual Board search workload measurement"]
async fn board_search_workload_reports_first_pages() {
    let f = fixture().await;
    seed_ordering_column(&f, 50_000).await;
    for search in [None, Some("no-match"), Some("Ordering"), Some("ONE-12")] {
        let mut samples = Vec::new();
        for _ in 0..5 {
            let started = std::time::Instant::now();
            let view = f
                .service
                .board_view(
                    &f.member,
                    BoardViewQuery {
                        project_id: "p1".into(),
                        limit: Some(50),
                        search: search.map(str::to_owned),
                        track_ids: vec![],
                        epic_ids: vec![],
                        assignee_ids: vec![],
                        no_assignee: false,
                        blocked: false,
                        done_order: Default::default(),
                    },
                )
                .await
                .unwrap();
            assert_eq!(view.counts.planning, 50_000);
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        println!("board-search search={search:?} median_ms={:.3}", samples[2]);
    }
}
