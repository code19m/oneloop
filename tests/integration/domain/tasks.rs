use super::*;

#[tokio::test]
async fn block_reason_edits_invalidate_existing_inboxes_even_after_mentions_are_removed() {
    let f = fixture().await;
    let task = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Blocked"}),
                "hint-task",
                None,
            ),
        )
        .await
        .unwrap();
    let mentions =
        json!([{"kind":"user","userId":"u2","startOffset":0,"endOffset":7,"label":"@Member"}]);
    let block = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":task.entities[0]["id"],"reason":"@Member old","mentions":mentions}),
                "hint-block",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let runtime = oneloop::collaboration::CollaborationRuntime::new(f.db.clone());
    while runtime.worker().run_once().await.unwrap() {}
    let mut events = runtime.subscribe();
    for (revision, reason, mentions) in [
        (1, "@Member corrected", mentions),
        (2, "Corrected again", json!([])),
    ] {
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::UpdateBlockReason,
                    json!({"blockId":block.entities[1]["id"],"reason":reason,"mentions":mentions}),
                    &format!("hint-edit-{revision}"),
                    Some(revision),
                ),
            )
            .await
            .unwrap();
        while runtime.worker().run_once().await.unwrap() {}
        let mut hints = Vec::new();
        while let Ok(hint) = events.try_recv() {
            if hint.kind == "inbox.changed" {
                hints.push(hint);
            }
        }
        assert_eq!(hints.len(), 1);
        assert!(hints[0].project_id.is_none());
        assert_eq!(
            hints[0].recipient_ids,
            ["u2".to_owned()].into_iter().collect()
        );
        let inbox = CollaborationService::new(f.db.clone())
            .inbox(&f.member, Default::default(), None, None)
            .await
            .unwrap();
        assert_eq!(inbox.items.len(), 1);
        assert_eq!(inbox.items[0].excerpt.as_deref(), Some(reason));
    }
}

#[tokio::test]
async fn block_reason_of_a_deleted_task_can_no_longer_change() {
    let f = fixture().await;
    let task = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Blocked"}),
                "deleted-blocked-task",
                None,
            ),
        )
        .await
        .unwrap();
    let block = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":task.entities[0]["id"],"reason":"Waiting"}),
                "deleted-task-block",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::DeleteTask,
                json!({"id":task.entities[0]["id"]}),
                "delete-blocked-task",
                block.entities[0]["revision"].as_i64(),
            ),
        )
        .await
        .unwrap();
    let edit = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateBlockReason,
                json!({"blockId":block.entities[1]["id"],"reason":"Still waiting"}),
                "edit-deleted-task-block",
                Some(1),
            ),
        )
        .await;
    assert!(matches!(edit, Err(AppError::NotFound { .. })), "{edit:?}");
}

#[tokio::test]
async fn block_edits_notify_new_mentions_without_notifying_retained_self_mentions() {
    let f = fixture().await;
    let task = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Blocked"}),
                "self-task",
                None,
            ),
        )
        .await
        .unwrap();
    let mut mentions =
        json!([{"kind":"user","userId":"u1","startOffset":0,"endOffset":8,"label":"@Manager"}]);
    let block = f.service.execute(&f.manager, command(DomainOperation::BlockTask,
        json!({"taskId":task.entities[0]["id"],"reason":"@Manager old","mentions":mentions}), "self-block", Some(1),
    )).await.unwrap();
    mentions.as_array_mut().unwrap().push(
        json!({"kind":"user","userId":"u2","startOffset":9,"endOffset":16,"label":"@Member"}),
    );
    f.service.execute(&f.admin, command(DomainOperation::UpdateBlockReason,
        json!({"blockId":block.entities[1]["id"],"reason":"@Manager @Member corrected","mentions":mentions}), "self-edit", Some(1),
    )).await.unwrap();
    let recipients =
        f.db.run(|conn| {
            Ok(conn
                .prepare("SELECT user_id FROM notification_recipients ORDER BY user_id")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(recipients, ["u2"]);
}

#[tokio::test]
async fn permissions_relationships_past_deadlines_and_idempotency_are_enforced() {
    let f = fixture().await;
    let create = command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Past deadline","deadline":"2020-01-01"}),
        "create-one",
        None,
    );
    assert!(matches!(
        f.service.execute(&f.member, create.clone()).await,
        Err(AppError::Forbidden)
    ));
    let first = f.service.execute(&f.manager, create.clone()).await.unwrap();
    assert!(!first.replayed);
    assert_eq!(first.entities[0]["deadline"], "2020-01-01");
    let id = first.entities[0]["id"].as_str().unwrap().to_owned();
    f.db.transaction(|tx| {
        let project: String = tx.query_row(
            "SELECT project_id FROM idempotency_keys WHERE idempotency_key='create-one'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(project, "p1");
        // Simulate a pre-migration receipt, whose project must use the JSON fallback.
        tx.execute(
            "UPDATE idempotency_keys SET project_id=NULL WHERE idempotency_key='create-one'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let replay = f.service.execute(&f.manager, create).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.entities[0]["id"], id);
    let reused = command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Different"}),
        "create-one",
        None,
    );
    assert!(matches!(
        f.service.execute(&f.manager, reused).await,
        Err(AppError::Rule {
            kind: oneloop::error::RuleKind::IdempotencyKeyReused,
            ..
        })
    ));
    let cross = command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e2","title":"Cross project"}),
        "cross",
        None,
    );
    assert!(matches!(
        f.service.execute(&f.manager, cross).await,
        Err(AppError::Validation { .. })
    ));
    let immutable = command(
        DomainOperation::UpdateTask,
        json!({"taskId":id,"createdAt":1}),
        "immutable",
        Some(1),
    );
    assert!(matches!(
        f.service.execute(&f.manager, immutable).await,
        Err(AppError::Validation { .. })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_task_allocation_is_unique_monotonic_and_revision_checked() {
    let f = fixture().await;
    let mut jobs = Vec::new();
    for index in 0..16 {
        let service = f.service.clone();
        let actor = f.manager.clone();
        jobs.push(tokio::spawn(async move {
            let create = || {
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":format!("Task {index}")}),
                    &format!("task-{index}"),
                    None,
                )
            };
            // A loaded machine can keep the queued writers past the admission
            // timeout. Clients retry that 503 with the same idempotency key.
            loop {
                match service.execute(&actor, create()).await {
                    Ok(result) => break result.entities[0].clone(),
                    Err(AppError::Unavailable(_)) => tokio::task::yield_now().await,
                    Err(error) => panic!("{error}"),
                }
            }
        }));
    }
    let mut keys = HashSet::new();
    let mut entities = Vec::new();
    for job in jobs {
        let entity = job.await.unwrap();
        keys.insert(entity["taskKey"].as_str().unwrap().to_owned());
        entities.push(entity);
    }
    assert_eq!(keys.len(), 16);
    let first = &entities[0];
    let stale = command(
        DomainOperation::UpdateTask,
        json!({"taskId":first["id"],"title":"Stale"}),
        "stale",
        Some(2),
    );
    assert!(matches!(
        f.service.execute(&f.manager, stale).await,
        Err(AppError::RevisionConflict {
            expected: 2,
            current: 1
        })
    ));
    let highest = keys
        .iter()
        .map(|key| key.rsplit('-').next().unwrap().parse::<u32>().unwrap())
        .max()
        .unwrap();
    let next = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Next"}),
                "next",
                None,
            ),
        )
        .await
        .unwrap();
    let next_number = next.entities[0]["taskKey"]
        .as_str()
        .unwrap()
        .rsplit('-')
        .next()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert_eq!(next_number, highest + 1);
}

#[tokio::test]
async fn pool_promotion_is_atomic_and_preserves_item_on_validation_failure() {
    let f = fixture().await;
    let pool=f.service.execute(&f.manager,command(DomainOperation::CreatePoolItem,json!({"projectId":"p1","scope":"personal","title":"Captured","description":"Details"}),"pool",None)).await.unwrap();
    let pool_id = pool.entities[0]["id"].as_str().unwrap().to_owned();
    let invalid = command(
        DomainOperation::PromotePoolItem,
        json!({"poolItemId":pool_id,"epicId":"edone"}),
        "bad-promotion",
        Some(1),
    );
    assert!(matches!(
        f.service.execute(&f.manager, invalid).await,
        Err(AppError::PreconditionFailed(_))
    ));
    let count: i64 =
        f.db.run({
            let id = pool_id.clone();
            move |c| {
                Ok(
                    c.query_row("SELECT COUNT(*) FROM pool_items WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?,
                )
            }
        })
        .await
        .unwrap();
    assert_eq!(count, 1);
    let promoted=f.service.execute(&f.manager,command(DomainOperation::PromotePoolItem,json!({"poolItemId":pool_id,"epicId":"e1","deadline":"2020-01-01","assigneeIds":["u3"]}),"promotion",Some(1))).await.unwrap();
    assert!(
        promoted
            .entities
            .iter()
            .any(|e| e["entityType"] == "task" && e["title"] == "Captured")
    );
    assert!(
        promoted
            .entities
            .iter()
            .any(|e| e["entityType"] == "poolItem" && e["deleted"] == true)
    );
    let counts: (i64, i64) =
        f.db.run(move |c| {
            Ok((
                c.query_row("SELECT COUNT(*) FROM pool_items", [], |r| r.get(0))?,
                c.query_row(
                    "SELECT COUNT(*) FROM tasks WHERE title='Captured' AND description='Details'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(counts, (0, 1));
}

#[tokio::test]
async fn pool_promotion_accepts_edited_task_text_atomically() {
    let f = fixture().await;
    for scope in ["personal", "team"] {
        let pool = f.service.execute(&f.manager, command(DomainOperation::CreatePoolItem,
            json!({"projectId":"p1","scope":scope,"title":"Captured","description":"Original"}), &format!("pool-{scope}"), None)).await.unwrap();
        let id = pool.entities[0]["id"].as_str().unwrap();
        let invalid = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::PromotePoolItem,
                    json!({"poolItemId":id,"epicId":"e1","title":""}),
                    &format!("invalid-{scope}"),
                    Some(1),
                ),
            )
            .await;
        assert!(matches!(invalid, Err(AppError::Validation { .. })));
        let request = command(
            DomainOperation::PromotePoolItem,
            json!({"poolItemId":id,"epicId":"e1","title":"Edited task","description":""}),
            &format!("promote-{scope}"),
            Some(1),
        );
        let promoted = f
            .service
            .execute(&f.manager, request.clone())
            .await
            .unwrap();
        let task = promoted
            .entities
            .iter()
            .find(|e| e["entityType"] == "task")
            .unwrap();
        assert_eq!(task["title"], "Edited task");
        assert_eq!(task["description"], "");
        assert!(
            f.service
                .execute(&f.manager, request)
                .await
                .unwrap()
                .replayed
        );
    }
}

#[tokio::test]
async fn blocking_notifies_only_mentions_and_unblocking_notifies_assignees() {
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Blocked task","assigneeIds":["u3"]}),
                "blocked-task",
                None,
            ),
        )
        .await
        .unwrap();
    let task_id = created.entities[0]["id"].as_str().unwrap().to_owned();
    f.db.run(|c| {
        c.execute("DELETE FROM notification_events", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let blocked = f.service.execute(&f.manager,command(DomainOperation::BlockTask,json!({"taskId":task_id,"reason":"🧭 Ask @member","mentions":[{"kind":"user","userId":"u2","startOffset":7,"endOffset":14,"label":"@member"}]}),"block",Some(1))).await.unwrap();
    let task_entity = blocked
        .entities
        .iter()
        .find(|entity| entity["entityType"] == "task")
        .unwrap();
    assert_eq!(task_entity["activeBlock"]["mentions"][0]["startOffset"], 7);
    let reloaded = f.service.task(&f.manager, task_id.clone()).await.unwrap();
    let mentions = reloaded.active_block.unwrap().mentions;
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0].user_id.as_deref(), Some("u2"));
    assert_eq!((mentions[0].start_offset, mentions[0].end_offset), (7, 14));
    let recipients:Vec<String>=f.db.run(|c|{let mut s=c.prepare("SELECT r.user_id FROM notification_recipients r JOIN notification_events e ON e.id=r.notification_id WHERE e.event_type='task.block.mentioned'")?;Ok(s.query_map([],|r|r.get(0))?.collect::<Result<Vec<_>,_>>()?)}).await.unwrap();
    assert_eq!(recipients, vec!["u2"]);
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UnblockTask,
                json!({"taskId":task_id,"resolution":"Resolved"}),
                "unblock",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let recipients:Vec<String>=f.db.run(|c|{let mut s=c.prepare("SELECT r.user_id FROM notification_recipients r JOIN notification_events e ON e.id=r.notification_id WHERE e.event_type='task.unblocked'")?;Ok(s.query_map([],|r|r.get(0))?.collect::<Result<Vec<_>,_>>()?)}).await.unwrap();
    assert_eq!(recipients, vec!["u3"]);
    let excerpt: String =
        f.db.run(|c| {
            Ok(c.query_row(
                "SELECT r.excerpt_snapshot FROM notification_recipients r
         JOIN notification_events e ON e.id=r.notification_id
         WHERE e.event_type='task.unblocked'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(excerpt, "🧭 Ask @member");
}

#[tokio::test]
async fn personal_pool_audit_keeps_owner_visibility_after_update_delete_and_promotion() {
    let f = fixture().await;
    let first = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreatePoolItem,
                json!({"projectId":"p1","scope":"personal","title":"Private one"}),
                "private-one",
                None,
            ),
        )
        .await
        .unwrap();
    let first_id = first.entities[0]["id"].as_str().unwrap().to_owned();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdatePoolItem,
                json!({"poolItemId":first_id,"description":"Secret"}),
                "private-update",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::DeletePoolItem,
                json!({"id":first_id}),
                "private-delete",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let second = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreatePoolItem,
                json!({"projectId":"p1","scope":"personal","title":"Private promotion"}),
                "private-two",
                None,
            ),
        )
        .await
        .unwrap();
    let second_id = second.entities[0]["id"].as_str().unwrap().to_owned();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::PromotePoolItem,
                json!({"poolItemId":second_id,"epicId":"e1"}),
                "private-promote",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let metadata:Vec<String> = f.db.run(|connection| {
        let mut statement=connection.prepare("SELECT metadata_json FROM activity_events WHERE entity_type='pool_item' ORDER BY created_at,id")?;
        Ok(statement.query_map([],|row|row.get(0))?.collect::<Result<Vec<_>,_>>()?)
    }).await.unwrap();
    assert_eq!(metadata.len(), 5);
    for value in metadata {
        let value: Value = serde_json::from_str(&value).unwrap();
        assert_eq!(value["visibility"], "owner");
        assert_eq!(value["ownerUserId"], "u1");
    }
    let collaboration = CollaborationService::new(f.db.clone());
    let owner = collaboration
        .activity(&f.manager, "p1", None, None, Some(50))
        .await
        .unwrap();
    let member = collaboration
        .activity(&f.member, "p1", None, None, Some(50))
        .await
        .unwrap();
    let admin = collaboration
        .activity(&f.admin, "p1", None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(
        owner
            .items
            .iter()
            .filter(|event| event.entity_type == "pool_item")
            .count(),
        5
    );
    assert!(
        member
            .items
            .iter()
            .all(|event| event.entity_type != "pool_item")
    );
    assert!(
        admin
            .items
            .iter()
            .all(|event| event.entity_type != "pool_item")
    );
}

#[tokio::test]
async fn browser_field_limits_are_enforced_by_shared_commands_without_partial_writes() {
    let fixture = fixture().await;
    let cases = [
        (
            DomainOperation::CreateProject,
            json!({"name":"x".repeat(61),"taskPrefix":"NEW"}),
        ),
        (
            DomainOperation::CreateTrack,
            json!({"projectId":"p1","name":"x".repeat(61)}),
        ),
        (
            DomainOperation::CreateEpic,
            json!({"projectId":"p1","trackId":"tr1","title":"x".repeat(121),"startDate":"2026-09-20"}),
        ),
        (
            DomainOperation::CreateEpic,
            json!({"projectId":"p1","trackId":"tr1","title":"Epic","description":"x".repeat(2001),"startDate":"2026-09-20"}),
        ),
        (
            DomainOperation::CreateMilestone,
            json!({"projectId":"p1","title":"x".repeat(61),"milestoneDate":"2026-09-20"}),
        ),
        (
            DomainOperation::CreateMilestone,
            json!({"projectId":"p1","title":"Milestone","description":"x".repeat(501),"milestoneDate":"2026-09-20"}),
        ),
        (
            DomainOperation::CreateTask,
            json!({"projectId":"p1","epicId":"e1","title":"x".repeat(141)}),
        ),
        (
            DomainOperation::CreateTask,
            json!({"projectId":"p1","epicId":"e1","title":"Task","description":"x".repeat(4001)}),
        ),
        (
            DomainOperation::CreateTask,
            json!({"projectId":"p1","epicId":"e1","title":"🙂".repeat(71)}),
        ),
        (
            DomainOperation::CreatePoolItem,
            json!({"projectId":"p1","scope":"personal","title":"x".repeat(141)}),
        ),
    ];
    for (index, (operation, payload)) in cases.into_iter().enumerate() {
        let error = fixture
            .service
            .execute(
                &fixture.admin,
                command(operation, payload, &format!("limit-{index}"), None),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                AppError::Validation {
                    ref field, ..
                } if matches!(field.as_str(), "name" | "title" | "description")
            ),
            "{error:?}"
        );
    }
    let task = fixture.service.execute(&fixture.manager, command(DomainOperation::CreateTask, json!({"projectId":"p1","epicId":"e1","title":"🙂".repeat(70),"description":"x".repeat(4000)}), "at-browser-limit", None)).await.unwrap();
    assert_eq!(task.entities[0]["taskKey"], "ONE-001");
    let task_id = task.entities[0]["id"].as_str().unwrap();
    assert!(
        fixture
            .service
            .execute(
                &fixture.manager,
                command(
                    DomainOperation::UpdateTask,
                    json!({"taskId":task_id,"description":"x".repeat(4001)}),
                    "over-update-limit",
                    Some(1)
                )
            )
            .await
            .is_err()
    );
    assert_eq!(
        fixture
            .service
            .task(&fixture.manager, task_id.to_owned())
            .await
            .unwrap()
            .description,
        Some("x".repeat(4000))
    );
}

#[tokio::test]
async fn inbox_block_context_preserves_resolved_reason_and_rechecks_access() {
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Context"}),
                "context-task",
                None,
            ),
        )
        .await
        .unwrap();
    let task_id = created.entities[0]["id"].as_str().unwrap();
    let blocked = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":task_id,"reason":"Awaiting decision"}),
                "context-block",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let block_id = blocked
        .entities
        .iter()
        .find(|item| item["entityType"] == "taskBlock")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UnblockTask,
                json!({"taskId":task_id,"resolution":"Approved"}),
                "context-resolve",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let service = CollaborationService::new(f.db.clone());
    let page = service
        .block_context(&f.member, task_id, block_id)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.items.iter().any(
        |item| item.after.as_ref().and_then(|value| value.get("reason"))
            == Some(&json!("Awaiting decision"))
    ));
    assert!(page.items.iter().any(|item| {
        item.after
            .as_ref()
            .and_then(|value| value.get("resolution"))
            == Some(&json!("Approved"))
    }));
    assert!(
        service
            .block_context(&f.member, "another-task", block_id)
            .await
            .is_err()
    );
    f.db.run(|connection| {
        connection.execute("DELETE FROM project_memberships WHERE user_id='u2'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        service
            .block_context(&f.member, task_id, block_id)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn optional_date_patches_distinguish_omitted_from_explicit_null() {
    let f = fixture().await;
    let created = f.service.execute(&f.manager, command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Date patch","deadline":"2026-12-01"}),
        "date-create", None,
    )).await.unwrap();
    let id = created.entities[0]["id"].as_str().unwrap();
    let renamed = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":id,"title":"Keep deadline"}),
                "date-keep",
                Some(1),
            ),
        )
        .await
        .unwrap();
    assert_eq!(renamed.entities[0]["deadline"], "2026-12-01");
    let cleared = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":id,"deadline":null}),
                "date-clear",
                Some(2),
            ),
        )
        .await
        .unwrap();
    assert!(cleared.entities[0]["deadline"].is_null());
    assert_eq!(cleared.entities[0]["revision"], 3);
    let replay = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":id,"deadline":null}),
                "date-clear",
                Some(2),
            ),
        )
        .await
        .unwrap();
    assert!(replay.replayed);
    assert!(replay.entities[0]["deadline"].is_null());

    let bounded = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","endDate":"2026-12-01"}),
                "epic-date-set",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let revision = bounded.entities[0]["revision"].as_i64().unwrap();
    let renamed = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","title":"Keep end date"}),
                "epic-date-keep",
                Some(revision),
            ),
        )
        .await
        .unwrap();
    assert_eq!(renamed.entities[0]["endDate"], "2026-12-01");
    let cleared = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","endDate":null}),
                "epic-date-clear",
                Some(revision + 1),
            ),
        )
        .await
        .unwrap();
    assert!(cleared.entities[0]["endDate"].is_null());
    assert_eq!(cleared.entities[0]["revision"], revision + 2);
}

#[tokio::test]
async fn retained_assignees_and_block_mentions_survive_account_and_membership_changes() {
    for former_member in [false, true] {
        let f = fixture().await;
        let task = f.service.execute(&f.manager, command(DomainOperation::CreateTask,
            json!({"projectId":"p1","epicId":"e1","title":"Retained assignee","assigneeIds":["u3"]}), "retained-task", None)).await.unwrap();
        let id = task.entities[0]["id"].as_str().unwrap().to_owned();
        let block = f.service.execute(&f.manager, command(DomainOperation::BlockTask,
            json!({"taskId":id,"reason":"  @Assignee waiting","mentions":[{"kind":"user","userId":"u3","startOffset":2,"endOffset":11,"label":"@Assignee"}]}), "retained-block", Some(1))).await.unwrap();
        let block_id = block.entities[1]["id"].as_str().unwrap().to_owned();
        if former_member {
            f.service
                .execute(
                    &f.manager,
                    command(
                        DomainOperation::UnblockAndCompleteTask,
                        json!({"taskId":id}),
                        "finish-retained",
                        Some(2),
                    ),
                )
                .await
                .unwrap();
            f.service
                .execute(
                    &f.admin,
                    command(
                        DomainOperation::RemoveMembership,
                        json!({"projectId":"p1","userId":"u3"}),
                        "remove-retained",
                        Some(1),
                    ),
                )
                .await
                .unwrap();
            f.service
                .execute(
                    &f.manager,
                    command(
                        DomainOperation::MoveTask,
                        json!({"taskId":id,"status":"planning"}),
                        "reopen-retained",
                        Some(3),
                    ),
                )
                .await
                .unwrap();
        } else {
            f.db.transaction(|tx| {
                tx.execute("UPDATE users SET is_active=0 WHERE id='u3'", [])?;
                Ok(())
            })
            .await
            .unwrap();
            f.service.execute(&f.manager, command(DomainOperation::UpdateBlockReason,
                json!({"blockId":block_id,"reason":"  @Assignee still waiting","mentions":[{"kind":"user","userId":"u3","startOffset":2,"endOffset":11,"label":"@Assignee"}]}), "edit-retained-block", Some(1))).await.unwrap();
        }
        for (index, assignees) in [json!(["u2", "u3"]), json!(["u3"]), json!([])]
            .into_iter()
            .enumerate()
        {
            let revision = f
                .service
                .task(&f.manager, id.clone())
                .await
                .unwrap()
                .revision;
            f.service
                .execute(
                    &f.manager,
                    command(
                        DomainOperation::UpdateTask,
                        json!({"taskId":id,"assigneeIds":assignees}),
                        &format!("retained-{index}"),
                        Some(revision),
                    ),
                )
                .await
                .unwrap();
        }
        let revision = f
            .service
            .task(&f.manager, id.clone())
            .await
            .unwrap()
            .revision;
        assert!(matches!(
            f.service
                .execute(
                    &f.manager,
                    command(
                        DomainOperation::UpdateTask,
                        json!({"taskId":id,"assigneeIds":["u3"]}),
                        "cannot-readd",
                        Some(revision)
                    )
                )
                .await,
            Err(AppError::Validation { .. })
        ));
    }
}

#[tokio::test]
async fn date_fields_require_canonical_calendar_values_for_browser_and_mcp_actors() {
    let f = fixture().await;
    let now = now();
    f.db.transaction(move |tx| {
        tx.execute("INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at,last_used_at) VALUES('date-grant','u1','client','Client',?1,?1,?2,?1)", params![now,now+3600])?;
        tx.execute("INSERT INTO mcp_grant_projects VALUES('date-grant','p1')", [])?;
        for scope in ["project_read","board_manage","roadmap_manage"] { tx.execute("INSERT INTO mcp_grant_scopes VALUES('date-grant',?1)",[scope])?; }
        Ok(())
    }).await.unwrap();
    let mut mcp = f.manager.clone();
    mcp.source = ActorSource::McpGrant {
        grant_id: "date-grant".into(),
    };
    for (actor_index, actor) in [&f.manager, &mcp].into_iter().enumerate() {
        for (field, operation, payload) in [
            (
                "startDate",
                DomainOperation::CreateEpic,
                json!({"projectId":"p1","trackId":"tr1","title":"Date"}),
            ),
            (
                "endDate",
                DomainOperation::CreateEpic,
                json!({"projectId":"p1","trackId":"tr1","title":"Date","startDate":"0000-01-01"}),
            ),
            (
                "deadline",
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Date"}),
            ),
            (
                "milestoneDate",
                DomainOperation::CreateMilestone,
                json!({"projectId":"p1","title":"Date"}),
            ),
        ] {
            for (index, date) in [
                " 2026-01-01",
                "2026-2-3",
                "2026-02-29",
                "2026-01-01 ",
                "+2026-01-01",
                "10000-01-01",
            ]
            .into_iter()
            .enumerate()
            {
                let mut payload = payload.clone();
                payload[field] = json!(date);
                assert!(
                    matches!(
                        f.service
                            .execute(
                                actor,
                                command(
                                    operation,
                                    payload,
                                    &format!("date-{actor_index}-{field}-{index}"),
                                    None
                                )
                            )
                            .await,
                        Err(AppError::Validation { .. })
                    ),
                    "{field} {date}"
                );
            }
            for (index, date) in ["0000-01-01", "0226-01-01", "2000-02-29", "9999-12-31"]
                .into_iter()
                .enumerate()
            {
                let mut payload = payload.clone();
                payload[field] = json!(date);
                f.service
                    .execute(
                        actor,
                        command(
                            operation,
                            payload,
                            &format!("valid-{actor_index}-{field}-{index}"),
                            None,
                        ),
                    )
                    .await
                    .unwrap();
            }
        }
    }
}

#[tokio::test]
async fn mention_validation_is_identical_for_comments_blocks_and_block_edits() {
    use oneloop::collaboration::CollaborationCommand;
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Mention parity"}),
                "mention-parity-task",
                None,
            ),
        )
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap();
    let invalid = json!([{"kind":"everyone","startOffset":7,"endOffset":13,"label":"review"}]);
    let discussion = CollaborationService::new(f.db.clone());
    let comment_error = discussion
        .execute(
            &f.manager,
            CollaborationCommand {
                operation: "discussion.comment.create".into(),
                payload: json!({"taskId":id,"content":"please review","mentions":invalid}),
                idempotency_key: "invalid-comment".into(),
                expected_revision: None,
            },
        )
        .await
        .unwrap_err();
    let block_error = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":id,"reason":"please review","mentions":invalid}),
                "invalid-block",
                Some(1),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(comment_error.to_string(), block_error.to_string());
    let block = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":id,"reason":"Waiting"}),
                "parity-block",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let edit_error=f.service.execute(&f.manager,command(DomainOperation::UpdateBlockReason,
        json!({"blockId":block.entities[1]["id"],"reason":"please review","mentions":invalid}),"invalid-edit",Some(1))).await.unwrap_err();
    assert_eq!(comment_error.to_string(), edit_error.to_string());
    let mentions = json!([
        {"kind":"user","userId":"u3","startOffset":12,"endOffset":17,"label":"@Team"},
        {"kind":"user","userId":"u2","startOffset":4,"endOffset":11,"label":"@Member"}
    ]);
    let updated=f.service.execute(&f.manager,command(DomainOperation::UpdateBlockReason,
        json!({"blockId":block.entities[1]["id"],"reason":" 🦀 @Member @Team ","mentions":mentions}),"valid-edit",Some(1))).await.unwrap();
    assert_eq!(updated.entities[0]["reason"], " 🦀 @Member @Team ");
    assert_eq!(updated.entities[0]["mentions"][0]["startOffset"], 4);
    let read = f.service.task(&f.manager, id.into()).await.unwrap();
    assert_eq!(read.active_block.unwrap().reason, " 🦀 @Member @Team ");
    let updated = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":id,"description":"Projection parity"}),
                "projection-parity",
                Some(read.revision),
            ),
        )
        .await
        .unwrap();
    let read = serde_json::to_value(f.service.task(&f.manager, id.into()).await.unwrap()).unwrap();
    let mut write = updated.entities[0].clone();
    write.as_object_mut().unwrap().remove("entityType");
    assert_eq!(read, write, "typed task projections must match");
}

#[tokio::test]
async fn display_text_rejects_spoofing_without_changing_multiline_unicode() {
    let f = fixture().await;
    for (index, title) in ["a\0b", "a\u{85}b", "a\u{202e}b", "\u{200b}\u{200d}", "a\nb"]
        .iter()
        .enumerate()
    {
        let error = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":title}),
                    &format!("bad-text-{index}"),
                    None,
                ),
            )
            .await
            .unwrap_err();
        assert!(matches!(error,AppError::Validation{ref field,..} if field=="title"));
    }
    let task=f.service.execute(&f.manager,command(DomainOperation::CreateTask,json!({"projectId":"p1","epicId":"e1","title":"می‌خواهم 👩‍💻","description":"Line one\r\n\tLine two"}),"valid-unicode",None)).await.unwrap();
    assert_eq!(task.entities[0]["description"], "Line one\r\n\tLine two");
    assert_eq!(task.entities[0]["title"], "می‌خواهم 👩‍💻");
    let files = oneloop::files::FileService::new(f.db.clone(), 1 << 30, 0);
    let error = files
        .begin_attachment_upload(
            &f.manager,
            task.entities[0]["id"].as_str().unwrap(),
            "invoice\u{202e}fdp.exe",
            1,
            false,
            "bidi-file",
        )
        .await;
    assert!(matches!(error,Err(AppError::Validation{ref field,..}) if field=="fileName"));
    let auth = AuthService::new(f.db.clone());
    assert!(matches!(
        auth.update_profile(&f.member, "\u{200b}").await,
        Err(AppError::Validation { .. })
    ));
}

#[tokio::test]
async fn block_mentions_distinguish_direct_and_broadcast_recipients_on_create_and_edit() {
    for edit in [false, true] {
        let f = fixture().await;
        let created = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":"Mention precedence"}),
                    "mention-task",
                    None,
                ),
            )
            .await
            .unwrap();
        let task_id = created.entities[0]["id"].as_str().unwrap();
        let reason = "@everyone @Member waiting";
        let mentions = json!([
            {"kind":"everyone","startOffset":0,"endOffset":9,"label":"@everyone"},
            {"kind":"user","userId":"u2","startOffset":10,"endOffset":17,"label":"@Member"}
        ]);
        let block = f.service.execute(&f.manager, command(DomainOperation::BlockTask,
            json!({"taskId":task_id,"reason":if edit {"Waiting"} else {reason},"mentions":if edit {json!([])} else {mentions.clone()}}), "mention-block", Some(1))).await.unwrap();
        if edit {
            f.service.execute(&f.manager, command(DomainOperation::UpdateBlockReason,
                json!({"blockId":block.entities[1]["id"],"reason":reason,"mentions":mentions}), "mention-edit", Some(1))).await.unwrap();
        }
        let collaboration = CollaborationService::new(f.db.clone());
        let worker = oneloop::collaboration::CollaborationRuntime::new(f.db.clone()).worker();
        while worker.run_once().await.unwrap() {}
        let inbox = collaboration
            .inbox(&f.member, Default::default(), None, None)
            .await
            .unwrap();
        assert_eq!(inbox.items.len(), 1);
        assert_eq!(inbox.items[0].event_type, "task.block.mentioned");
        let recipients = f.db.run(|c| {
            let mut s=c.prepare("SELECT r.user_id,n.event_type FROM notification_recipients r JOIN notification_events n ON n.id=r.notification_id ORDER BY r.user_id")?;
            Ok(s.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?)
        }).await.unwrap();
        assert_eq!(
            recipients,
            vec![
                ("u2".into(), "task.block.mentioned".into()),
                ("u3".into(), "task.block.everyone".into())
            ]
        );
        let block_id = block.entities[1]["id"].as_str().unwrap();
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::UpdateBlockReason,
                    json!({"blockId":block_id,"reason":format!("{reason}!"),"mentions":mentions}),
                    "mention-repeat",
                    Some(if edit { 2 } else { 1 }),
                ),
            )
            .await
            .unwrap();
        let count: i64 =
            f.db.run(|c| {
                Ok(
                    c.query_row("SELECT COUNT(*) FROM notification_recipients", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(count, 2);
    }
}

#[tokio::test]
async fn task_update_returns_and_replays_the_activated_epic() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        tx.execute("UPDATE epics SET state='active' WHERE id='e1'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Working"}),
                "working-task",
                None,
            ),
        )
        .await
        .unwrap();
    let task_id = created.entities[0]["id"].as_str().unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":task_id,"status":"in_progress"}),
                "working-start",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let epic=f.service.execute(&f.manager,command(DomainOperation::CreateEpic,json!({"projectId":"p1","trackId":"tr1","title":"Next epic","startDate":"2026-01-01"}),"next-epic",None)).await.unwrap();
    let epic_id = epic.entities[0]["id"].as_str().unwrap();
    let update = command(
        DomainOperation::UpdateTask,
        json!({"taskId":task_id,"epicId":epic_id}),
        "working-transfer",
        Some(2),
    );
    let result = f.service.execute(&f.manager, update.clone()).await.unwrap();
    let activated = result
        .entities
        .iter()
        .find(|e| e["entityType"] == "epic")
        .unwrap();
    assert_eq!(activated["id"], epic_id);
    assert_eq!(activated["state"], "active");
    assert_eq!(activated["revision"], 2);
    assert!(
        result
            .events
            .iter()
            .any(|e| e.event_type == "epic.activated")
    );
    let replay = f.service.execute(&f.manager, update).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(result.entities, replay.entities);
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":epic_id,"title":"Fresh revision"}),
                "edit-activated",
                Some(2),
            ),
        )
        .await
        .unwrap();
}

async fn planning_tasks(f: &Fixture, titles: &[&str]) -> Vec<String> {
    let mut ids = Vec::new();
    for title in titles {
        let created = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":title}),
                    &format!("create-{title}"),
                    None,
                ),
            )
            .await
            .unwrap();
        ids.push(created.entities[0]["id"].as_str().unwrap().to_owned());
    }
    ids
}

async fn planning_order(f: &Fixture) -> Vec<String> {
    f.service
        .board_page(&f.manager, board_query("planning", None))
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|task| task.title)
        .collect()
}

#[tokio::test]
async fn undo_brings_a_deleted_task_back_to_its_place() {
    let f = fixture().await;
    let ids = planning_tasks(&f, &["First", "Second", "Third"]).await;
    let delete = command(
        DomainOperation::DeleteTask,
        json!({"id":ids[1]}),
        "delete-second",
        Some(1),
    );
    let deleted = f.service.execute(&f.manager, delete).await.unwrap();
    assert_eq!(deleted.entities[0]["revision"], 2);
    assert_eq!(planning_order(&f).await, ["First", "Third"]);

    let restore = command(
        DomainOperation::RestoreTask,
        json!({"id":ids[1]}),
        "restore-second",
        Some(2),
    );
    let restored = f
        .service
        .execute(&f.manager, restore.clone())
        .await
        .unwrap();
    assert_eq!(restored.entities[0]["id"], ids[1].as_str());
    assert_eq!(restored.entities[0]["revision"], 3);
    assert_eq!(restored.events[0].event_type, "task.restored");
    assert_eq!(planning_order(&f).await, ["First", "Second", "Third"]);
    let replay = f.service.execute(&f.manager, restore).await.unwrap();
    assert!(replay.replayed);

    // History keeps the deletion next to the restore.
    let id = ids[1].clone();
    let history: Vec<String> =
        f.db.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT event_type FROM activity_events WHERE entity_id=?1 ORDER BY created_at,id",
            )?;
            Ok(statement
                .query_map([id], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(history, ["task.created", "task.deleted", "task.restored"]);
}

#[tokio::test]
async fn only_people_who_could_delete_a_task_restore_it_in_time() {
    let f = fixture().await;
    let ids = planning_tasks(&f, &["Kept"]).await;
    let restore = |key: &str, revision| {
        command(
            DomainOperation::RestoreTask,
            json!({"id":ids[0]}),
            key,
            Some(revision),
        )
    };
    assert!(matches!(
        f.service.execute(&f.manager, restore("live", 1)).await,
        Err(AppError::Conflict(_))
    ));
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::DeleteTask,
                json!({"id":ids[0]}),
                "delete-kept",
                Some(1),
            ),
        )
        .await
        .unwrap();
    // The member can read the project but not change the Board.
    assert!(matches!(
        f.service.execute(&f.member, restore("member", 2)).await,
        Err(AppError::Forbidden)
    ));
    assert!(matches!(
        f.service.execute(&f.manager, restore("stale", 1)).await,
        Err(AppError::RevisionConflict { .. })
    ));
    let id = ids[0].clone();
    f.db.transaction(move |tx| {
        tx.execute(
            "UPDATE tasks SET deleted_at=deleted_at-?1 WHERE id=?2",
            params![oneloop::domain::UNDO_WINDOW_SECONDS, id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let late = f.service.execute(&f.manager, restore("late", 2)).await;
    assert!(
        matches!(&late, Err(AppError::PreconditionFailed(message)) if message.contains("5 minutes")),
        "{late:?}"
    );
}

#[tokio::test]
async fn a_restored_task_goes_last_when_its_place_was_taken() {
    let f = fixture().await;
    let ids = planning_tasks(&f, &["First", "Second", "Third"]).await;
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::DeleteTask,
                json!({"id":ids[0]}),
                "delete-first",
                Some(1),
            ),
        )
        .await
        .unwrap();
    // Moving a card to the top takes the deleted card's exact position.
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":ids[2],"status":"planning","position":0}),
                "third-first",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let positions: Vec<i64> =
        f.db.run(|connection| {
            let mut statement = connection
                .prepare("SELECT position FROM tasks WHERE title IN ('First','Third')")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(positions[0], positions[1]);
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::RestoreTask,
                json!({"id":ids[0]}),
                "restore-first",
                Some(2),
            ),
        )
        .await
        .unwrap();
    assert_eq!(planning_order(&f).await, ["Third", "Second", "First"]);
}

#[tokio::test]
async fn a_restored_task_drops_assignees_who_left_the_project() {
    let f = fixture().await;
    let mut ids = Vec::new();
    for (title, key) in [
        ("Open work", "open-assigned"),
        ("Finished work", "done-assigned"),
    ] {
        let task = f
            .service
            .execute(
                &f.manager,
                command(
                    DomainOperation::CreateTask,
                    json!({"projectId":"p1","epicId":"e1","title":title,"assigneeIds":["u3"]}),
                    key,
                    None,
                ),
            )
            .await
            .unwrap();
        ids.push(task.entities[0]["id"].as_str().unwrap().to_owned());
    }
    for (operation, payload, key, revision) in [
        (
            DomainOperation::MoveTask,
            json!({"taskId":ids[1],"status":"done"}),
            "finish-assigned",
            1,
        ),
        (
            DomainOperation::DeleteTask,
            json!({"id":ids[0]}),
            "delete-open",
            1,
        ),
        (
            DomainOperation::DeleteTask,
            json!({"id":ids[1]}),
            "delete-done",
            2,
        ),
    ] {
        f.service
            .execute(&f.manager, command(operation, payload, key, Some(revision)))
            .await
            .unwrap();
    }
    // The check for unfinished tasks skips deleted ones, so the person can
    // leave the project during the Undo window.
    f.service
        .execute(
            &f.admin,
            command(
                DomainOperation::RemoveMembership,
                json!({"projectId":"p1","userId":"u3"}),
                "remove-assignee",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let open = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::RestoreTask,
                json!({"id":ids[0]}),
                "restore-open",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let events: Vec<_> = open
        .events
        .iter()
        .map(|event| (event.event_type.as_str(), event.before.clone()))
        .collect();
    assert_eq!(
        events,
        [
            ("task.restored", None),
            ("task.assignee.removed", Some(json!("u3")))
        ]
    );
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::RestoreTask,
                json!({"id":ids[1]}),
                "restore-done",
                Some(3),
            ),
        )
        .await
        .unwrap();
    let assignees: Vec<(String, String)> =
        f.db.run(|connection| {
            let mut statement = connection.prepare(
                "SELECT t.title,a.user_id FROM task_assignees a JOIN tasks t ON t.id=a.task_id
                 WHERE t.title IN ('Open work','Finished work')",
            )?;
            Ok(statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    // A Done task keeps them, as it does when someone leaves.
    assert_eq!(assignees, [("Finished work".to_owned(), "u3".to_owned())]);
}

#[tokio::test]
async fn a_task_whose_epic_was_deleted_cannot_be_restored() {
    let f = fixture().await;
    let epic = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateEpic,
                json!({"projectId":"p1","trackId":"tr1","title":"Short","startDate":"2026-01-01"}),
                "short-epic",
                None,
            ),
        )
        .await
        .unwrap();
    let epic_id = epic.entities[0]["id"].as_str().unwrap();
    let task = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":epic_id,"title":"Orphan"}),
                "orphan-task",
                None,
            ),
        )
        .await
        .unwrap();
    let task_id = task.entities[0]["id"].as_str().unwrap();
    for (operation, payload, key) in [
        (
            DomainOperation::DeleteTask,
            json!({"id":task_id}),
            "delete-orphan",
        ),
        (
            DomainOperation::DeleteEpic,
            json!({"id":epic_id}),
            "delete-short",
        ),
    ] {
        f.service
            .execute(&f.manager, command(operation, payload, key, Some(1)))
            .await
            .unwrap();
    }
    let restore = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::RestoreTask,
                json!({"id":task_id}),
                "restore-orphan",
                Some(2),
            ),
        )
        .await;
    assert!(
        matches!(&restore, Err(AppError::PreconditionFailed(message)) if message.contains("epic")),
        "{restore:?}"
    );
}
