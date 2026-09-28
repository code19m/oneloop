use super::*;

#[tokio::test]
async fn epic_panel_reads_every_task_and_real_activity_in_bounded_pages() {
    let fixture = fixture().await;
    let now = now();
    fixture
        .db
        .transaction(move |tx| {
            for index in 0..61_i64 {
                let status = ["in_progress", "in_review", "planning", "done"]
                    [(index as usize) % 4];
                tx.execute(
                    "INSERT INTO tasks
                     (id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                     VALUES (?1,'p1','e1',?2,?3,?4,?5,?6,'u1',?7,?7)",
                    params![
                        format!("epic-task-{index:03}"),
                        index + 100,
                        format!("ONE-{:03}", index + 100),
                        format!("Epic task {index}"),
                        status,
                        index / 4,
                        now,
                    ],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();

    fixture
        .service
        .execute(
            &fixture.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","title":"Renamed epic"}),
                "epic-audit-title",
                Some(1),
            ),
        )
        .await
        .unwrap();
    fixture
        .service
        .execute(
            &fixture.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","description":"Audited description"}),
                "epic-audit-description",
                Some(2),
            ),
        )
        .await
        .unwrap();

    let first = fixture
        .service
        .epic_tasks(
            &fixture.member,
            "e1".into(),
            oneloop::domain::PageQuery::default(),
        )
        .await
        .unwrap();
    assert_eq!(first.items.len(), 50);
    assert_eq!(first.total, 61);
    let second = fixture
        .service
        .epic_tasks(
            &fixture.member,
            "e1".into(),
            oneloop::domain::PageQuery {
                cursor: first.next_cursor.clone(),
                limit: Some(50),
            },
        )
        .await
        .unwrap();
    assert_eq!(second.items.len(), 11);
    assert_eq!(second.total, 61);
    assert!(second.next_cursor.is_none());
    let ids = first
        .items
        .iter()
        .chain(&second.items)
        .map(|task| &task.id)
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), 61);

    let activity = fixture
        .service
        .epic_activity(
            &fixture.member,
            "e1".into(),
            oneloop::domain::PageQuery {
                cursor: None,
                limit: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(activity.items.len(), 1);
    assert!(activity.next_cursor.is_some());
    assert_eq!(activity.items[0].entity_type, "epic");
    assert_eq!(activity.items[0].entity_id, "e1");
    let older = fixture
        .service
        .epic_activity(
            &fixture.member,
            "e1".into(),
            oneloop::domain::PageQuery {
                cursor: activity.next_cursor,
                limit: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(older.items.len(), 1);
    assert_ne!(older.items[0].id, activity.items[0].id);
    assert!(older.items[0].event_type.starts_with("epic."));
}

#[tokio::test]
async fn admin_accounts_return_an_explicit_fifty_row_cursor() {
    let fixture = fixture().await;
    let now = now();
    fixture
        .db
        .transaction(move |tx| {
            for index in 0..60 {
                tx.execute(
                    "INSERT INTO users
                     (id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                     VALUES (?1,?2,?3,'hash',?4,?4,?4)",
                    params![
                        format!("paged-user-{index:03}"),
                        format!("paged-{index:03}"),
                        format!("Paged User {index}"),
                        now,
                    ],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let service = AuthService::new(fixture.db.clone());
    let (first, cursor) = service.list_accounts(&fixture.admin, None).await.unwrap();
    assert_eq!(first.len(), 50);
    let cursor = cursor.expect("more than fifty users must expose a cursor");
    assert_eq!(cursor, first.last().unwrap().username);
    let (second, next) = service
        .list_accounts(&fixture.admin, Some(&cursor))
        .await
        .unwrap();
    assert_eq!(first.len() + second.len(), 64);
    assert!(next.is_none());
}

#[tokio::test]
async fn epic_lifecycle_auto_activates_and_only_explicit_reopen_accepts_new_tasks() {
    let f = fixture().await;
    let created = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Work"}),
                "lifecycle-task",
                None,
            ),
        )
        .await
        .unwrap();
    let task_id = created.entities[0]["id"].as_str().unwrap().to_owned();
    let moved = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::MoveTask,
                json!({"taskId":task_id,"status":"in_progress","position":0}),
                "start-work",
                Some(1),
            ),
        )
        .await
        .unwrap();
    assert!(
        moved
            .events
            .iter()
            .any(|event| event.event_type == "epic.activated")
    );
    assert!(moved.entities.iter().any(|entity| {
        entity["entityType"] == "epic"
            && entity["id"] == "e1"
            && entity["state"] == "active"
            && entity["revision"] == 2
    }));
    let completed = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CompleteEpic,
                json!({"id":"e1"}),
                "complete-epic",
                Some(2),
            ),
        )
        .await
        .unwrap();
    assert_eq!(completed.entities[0]["state"], "done");
    let rejected = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Rejected"}),
                "done-epic-task",
                None,
            ),
        )
        .await;
    assert!(matches!(rejected, Err(AppError::PreconditionFailed(_))));
    let reopened = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::ReopenEpic,
                json!({"id":"e1"}),
                "reopen-epic",
                Some(3),
            ),
        )
        .await
        .unwrap();
    assert_eq!(reopened.entities[0]["state"], "active");
}

#[tokio::test]
async fn membership_removal_and_unblock_complete_preserve_invariants_atomically() {
    let f = fixture().await;
    let created = f.service.execute(&f.manager, command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Assigned block","assigneeIds":["u3"]}),
        "invariant-task", None,
    )).await.unwrap();
    let task_id = created.entities[0]["id"].as_str().unwrap().to_owned();
    let removal = f
        .service
        .execute(
            &f.admin,
            command(
                DomainOperation::RemoveMembership,
                json!({"projectId":"p1","userId":"u3"}),
                "remove-assigned",
                Some(1),
            ),
        )
        .await;
    assert_eq!(removal.unwrap_err().code(), "member_has_open_tasks");
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::BlockTask,
                json!({"taskId":task_id,"reason":"Blocked"}),
                "invariant-block",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let completed = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UnblockAndCompleteTask,
                json!({"taskId":task_id,"resolution":"Done together"}),
                "complete-blocked",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let task = completed
        .entities
        .iter()
        .find(|entity| entity["entityType"] == "task")
        .unwrap();
    let block = completed
        .entities
        .iter()
        .find(|entity| entity["entityType"] == "taskBlock")
        .unwrap();
    assert_eq!(task["status"], "done");
    assert_eq!(block["resolved"], true);
    let roadmap = f.service.roadmap(&f.manager, "p1".into()).await.unwrap();
    assert_eq!(roadmap["projectId"], "p1");
    let epic = roadmap["epics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|epic| epic["id"] == "e1")
        .unwrap();
    assert_eq!(epic["taskTotal"], 1);
    assert_eq!(epic["taskDone"], 1);
    assert_eq!(epic["taskOpen"], 0);
    assert_eq!(epic["completedSinceStart"], 1);
    assert_eq!(epic["weeklyCompletions"].as_array().unwrap().len(), 7);
    f.service
        .execute(
            &f.admin,
            command(
                DomainOperation::RemoveMembership,
                json!({"projectId":"p1","userId":"u3"}),
                "remove-completed",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let count: i64 =
        f.db.run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM project_memberships WHERE project_id='p1' AND user_id='u3'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn epic_edits_consolidate_per_field_and_reverts_keep_other_changes() {
    let f = fixture().await;
    let changed = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","title":"Renamed","description":"Useful details"}),
                "epic-field-edit",
                Some(1),
            ),
        )
        .await
        .unwrap();
    assert_eq!(changed.events.len(), 2);
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateEpic,
                json!({"epicId":"e1","title":"Open epic"}),
                "epic-title-revert",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let page = f
        .service
        .epic_activity(
            &f.manager,
            "e1".into(),
            oneloop::domain::PageQuery::default(),
        )
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].field_key.as_deref(), Some("description"));
    assert_eq!(page.items[0].after, Some(json!("Useful details")));
    let raw_count =
        f.db.run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM activity_events WHERE entity_type='epic' AND entity_id='e1'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(raw_count, 3);
}

#[tokio::test]
async fn assignee_activity_consolidates_both_membership_directions_without_rewriting_audit() {
    let f = fixture().await;
    let absent = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Initially unassigned"}),
                "assignee-absent-create",
                None,
            ),
        )
        .await
        .unwrap();
    let absent_id = absent.entities[0]["id"].as_str().unwrap().to_owned();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":absent_id,"assigneeIds":["u3"]}),
                "assignee-add",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":absent_id,"assigneeIds":[]}),
                "assignee-add-revert",
                Some(2),
            ),
        )
        .await
        .unwrap();

    let present = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTask,
                json!({"projectId":"p1","epicId":"e1","title":"Initially assigned","assigneeIds":["u3"]}),
                "assignee-present-create",
                None,
            ),
        )
        .await
        .unwrap();
    let present_id = present.entities[0]["id"].as_str().unwrap().to_owned();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":present_id,"assigneeIds":[]}),
                "assignee-remove",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::UpdateTask,
                json!({"taskId":present_id,"assigneeIds":["u3"]}),
                "assignee-remove-revert",
                Some(2),
            ),
        )
        .await
        .unwrap();

    let activity = CollaborationService::new(f.db.clone());
    for task_id in [&absent_id, &present_id] {
        let visible = activity
            .activity(&f.member, "p1", Some(task_id), None, None)
            .await
            .unwrap();
        assert!(
            visible
                .items
                .iter()
                .all(|event| !event.event_type.starts_with("task.assignee."))
        );
    }
    let (raw, projected, hidden): (i64, i64, i64) = f
        .db
        .run(|connection| {
            Ok((
                connection.query_row(
                    "SELECT count(*) FROM activity_events WHERE field_key='assignee:u3'",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    "SELECT count(*) FROM activity_projection WHERE field_key='assignee:u3'",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    "SELECT count(*) FROM activity_projection WHERE field_key='assignee:u3' AND is_hidden=1",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .await
        .unwrap();
    assert_eq!((raw, projected, hidden), (4, 2, 2));
}

#[tokio::test]
async fn membership_management_needs_admin_access_but_not_a_fresh_password() {
    let f = fixture().await;
    let mut admin = f.admin.clone();
    admin.authenticated_at = now() - 3600;
    let add = command(
        DomainOperation::AddMembership,
        json!({"projectId":"p2","userId":"u2","manageBoard":false,"manageRoadmap":false}),
        "routine-member-add",
        None,
    );
    assert!(matches!(
        f.service.execute(&f.manager, add.clone()).await,
        Err(AppError::Forbidden)
    ));
    f.service.execute(&admin, add.clone()).await.unwrap();
    assert!(f.service.execute(&admin, add).await.unwrap().replayed);
    f.service
        .execute(
            &admin,
            command(
                DomainOperation::UpdateMembership,
                json!({"projectId":"p2","userId":"u2","manageBoard":true,"manageRoadmap":true}),
                "routine-member-permissions",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &admin,
            command(
                DomainOperation::RemoveMembership,
                json!({"projectId":"p2","userId":"u2"}),
                "routine-member-remove",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let delete = command(
        DomainOperation::DeleteProject,
        json!({"projectId":"p2","confirmedName":"Project Two"}),
        "sensitive-delete",
        Some(1),
    );
    assert!(matches!(
        f.service.execute(&admin, delete.clone()).await,
        Err(AppError::Rule {
            kind: oneloop::error::RuleKind::RecentAuthRequired,
            ..
        })
    ));
    admin.authenticated_at = now() - 20 * 60;
    f.service.execute(&admin, delete).await.unwrap();
}

#[tokio::test]
async fn populated_project_deletion_preserves_other_projects_and_foreign_keys() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        tx.execute_batch("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('pop-task','p2','e2',1,'TWO-001','Work','planning',0,1,1);
            INSERT INTO task_assignees VALUES('pop-task','u1','u1',1);
            INSERT INTO task_blocks(id,project_id,task_id,reason,created_by,created_at) VALUES('pop-block','p2','pop-task','@Manager waiting','u1',1);
            INSERT INTO block_mentions VALUES('pop-mention','pop-block','user','u1',0,8,'@Manager');
            INSERT INTO comments(id,project_id,task_id,author_id,root_id,content,created_at) VALUES('pop-comment','p2','pop-task','u1','pop-comment','Discussion',1);
            INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at) VALUES('pop-blob','pop-blob',printf('%064d',0),1,'text/plain','available',1);
            INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,position,created_at,last_accessed_at,updated_at) VALUES('pop-attachment','p2','pop-task','pop-blob','test.txt','u1',0,1,1,1);
            INSERT INTO pool_items(id,project_id,scope,owner_user_id,title,created_by,created_at,updated_at) VALUES('pop-personal','p2','personal','u1','Mine','u1',1,1),('pop-team','p2','team',NULL,'Team','u1',1,1);
            INSERT INTO milestones(id,project_id,title,milestone_date,created_at,updated_at) VALUES('pop-milestone','p2','Goal','2026-01-01',1,1);
            INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at) VALUES('pop-grant','u1','c','Client',1,1,9999999999);
            INSERT INTO mcp_grant_projects VALUES('pop-grant','p2');
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at,deleted_at) VALUES('pop-deleted-epic','p2','tr2','Deleted','2026-01-01',1,1,1,NULL);
            INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,deleted_at) VALUES('pop-deleted-task','p2','pop-deleted-epic',2,'TWO-002','Deleted','planning',1,1,1,2);
            UPDATE epics SET deleted_at=2 WHERE id='pop-deleted-epic';
            -- Enforce the intended order independently of SQLite sibling cascade order.
            CREATE TRIGGER test_project_dependency_order BEFORE DELETE ON projects BEGIN
                SELECT CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE project_id=OLD.id)
                    OR EXISTS(SELECT 1 FROM epics WHERE project_id=OLD.id)
                    OR EXISTS(SELECT 1 FROM tracks WHERE project_id=OLD.id)
                    THEN RAISE(ABORT,'project dependencies must be removed first') END;
            END;")?;
        Ok(())
    }).await.unwrap();
    f.service
        .execute(
            &f.admin,
            command(
                DomainOperation::DeleteProject,
                json!({"projectId":"p2","confirmedName":"Project Two"}),
                "pop-delete",
                Some(1),
            ),
        )
        .await
        .unwrap();
    f.db.run(|conn| {
        for table in [
            "tasks",
            "epics",
            "tracks",
            "comments",
            "task_blocks",
            "task_attachments",
            "pool_items",
            "milestones",
            "mcp_grant_projects",
            "project_memberships",
        ] {
            let count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id='p2'"),
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 0, "{table}");
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM projects WHERE id='p1'", [], |r| r
                .get::<_, i64>(0))?,
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM project_prefixes WHERE prefix='TWO'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        assert!(
            conn.prepare("PRAGMA foreign_key_check")?
                .query([])?
                .next()?
                .is_none()
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn admin_read_access_does_not_make_a_nonmember_assignable() {
    let f = fixture().await;
    let error = f.service.execute(&f.manager, command(
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Membership required","assigneeIds":["admin"]}),
        "nonmember-admin-assignment", None,
    )).await.unwrap_err();
    assert!(matches!(error, AppError::Validation { .. }));
}

#[tokio::test]
async fn reserved_prefix_of_deleted_project_returns_conflict() {
    let f = fixture().await;
    f.service
        .execute(
            &f.admin,
            command(
                DomainOperation::DeleteProject,
                json!({"projectId":"p2","confirmedName":"Project Two"}),
                "delete-prefix-owner",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let error = f
        .service
        .execute(
            &f.admin,
            command(
                DomainOperation::UpdateProject,
                json!({"projectId":"p1","taskPrefix":"two"}),
                "reuse-prefix",
                Some(1),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "prefix_reserved");
    assert_eq!(error.status().as_u16(), 409);
}

#[tokio::test]
async fn structural_commands_enforce_permissions_revisions_replay_and_audit() {
    use DomainOperation::*;
    let cases = [
        (
            ReorderTrack,
            json!({"trackId":"empty-track","position":0}),
            "track.reordered",
        ),
        (DeleteTrack, json!({"id":"empty-track"}), "track.deleted"),
        (DeleteEpic, json!({"id":"edone"}), "epic.deleted"),
        (
            UpdateMilestone,
            json!({"milestoneId":"ms","title":"Updated"}),
            "milestone.updated",
        ),
        (DeleteMilestone, json!({"id":"ms"}), "milestone.deleted"),
        (
            UpdateBlockReason,
            json!({"blockId":"block","reason":" \r\nRevised reason 👩‍💻\t"}),
            "task.block.reason.updated",
        ),
    ];
    for (operation, payload, event_type) in cases {
        let f = fixture().await;
        f.db.transaction(|tx| {
            tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('empty-track','p1','Empty',1,1,1)", [])?;
            tx.execute("INSERT INTO milestones(id,project_id,title,milestone_date,created_at,updated_at) VALUES('ms','p1','Milestone','2026-01-01',1,1)", [])?;
            tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('blocked','p1','e1',1,'ONE-001','Blocked','planning',0,1,1)", [])?;
            tx.execute("INSERT INTO task_blocks(id,project_id,task_id,reason,created_by,created_at) VALUES('block','p1','blocked','Initial','u1',1)", [])?;
            Ok(())
        }).await.unwrap();
        let request = command(operation, payload.clone(), "structural-case", Some(1));
        assert!(
            matches!(
                f.service.execute(&f.member, request.clone()).await,
                Err(AppError::Forbidden)
            ),
            "{operation:?}"
        );
        assert!(
            matches!(
                f.service
                    .execute(
                        &f.manager,
                        command(operation, payload, "stale-case", Some(9))
                    )
                    .await,
                Err(AppError::RevisionConflict { .. })
            ),
            "{operation:?}"
        );
        let result = f
            .service
            .execute(&f.manager, request.clone())
            .await
            .unwrap();
        let event = result
            .events
            .iter()
            .find(|e| e.event_type == event_type)
            .expect(event_type);
        assert_eq!(event.entity_revision, Some(2));
        assert!(result.entities.iter().any(|e| e["revision"] == 2));
        let replay = f.service.execute(&f.manager, request).await.unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.entities, result.entities);
        assert_eq!(
            serde_json::to_value(replay.events).unwrap(),
            serde_json::to_value(result.events).unwrap()
        );
        if operation == UpdateBlockReason {
            let task = f.service.task(&f.member, "blocked".into()).await.unwrap();
            assert_eq!(
                task.active_block.unwrap().reason,
                " \r\nRevised reason 👩‍💻\t"
            );
        }
        let table = match operation {
            DeleteTrack => Some("tracks"),
            DeleteEpic => Some("epics"),
            _ => None,
        };
        if let Some(table) = table {
            let positions = f.db.run(move |c| {
                let mut stmt=c.prepare(&format!("SELECT position FROM {table} WHERE project_id='p1' AND deleted_at IS NULL ORDER BY position"))?;
                Ok(stmt.query_map([],|r|r.get::<_,i64>(0))?.collect::<Result<Vec<_>,_>>()?)
            }).await.unwrap();
            assert_eq!(positions, (0..positions.len() as i64).collect::<Vec<_>>());
        }
    }
}

#[tokio::test]
async fn structural_deletion_requires_empty_parents() {
    let f = fixture().await;
    seed_ordering_column(&f, 1).await;
    for (operation, id) in [
        (DomainOperation::DeleteTrack, "tr1"),
        (DomainOperation::DeleteEpic, "e1"),
    ] {
        let error = f
            .service
            .execute(
                &f.manager,
                command(operation, json!({"id":id}), id, Some(1)),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::PreconditionFailed(_)));
    }
}

#[tokio::test]
async fn track_noop_is_rejected_and_reorders_stay_only_in_raw_audit() {
    let f = fixture().await;
    let error = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::ReorderTrack,
                json!({"trackId":"tr1","position":0}),
                "track-noop",
                Some(1),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "validation_failed");
    let counts: (i64, i64) =
        f.db.run(|c| {
            Ok((
                c.query_row("SELECT revision FROM tracks WHERE id='tr1'", [], |r| {
                    r.get(0)
                })?,
                c.query_row("SELECT COUNT(*) FROM activity_events", [], |r| r.get(0))?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(counts, (1, 0));
    let track = f
        .service
        .execute(
            &f.manager,
            command(
                DomainOperation::CreateTrack,
                json!({"projectId":"p1","name":"Second"}),
                "second-track",
                None,
            ),
        )
        .await
        .unwrap();
    f.service
        .execute(
            &f.manager,
            command(
                DomainOperation::ReorderTrack,
                json!({"trackId":track.entities[0]["id"],"position":0}),
                "track-move",
                Some(1),
            ),
        )
        .await
        .unwrap();
    seed_ordering_column(&f, 3).await;
    for (i, status, position) in [(0, "planning", 2), (1, "in_review", 0), (2, "in_review", 2)] {
        f.service
            .execute(
                &f.manager,
                command(
                    DomainOperation::MoveTask,
                    json!({"taskId":"order-1","status":status,"position":position}),
                    &format!("reorder-{i}"),
                    Some(i + 1),
                ),
            )
            .await
            .unwrap();
    }
    let (raw,visible,open):(i64,i64,i64)=f.db.run(|c|Ok((
        c.query_row("SELECT COUNT(*) FROM activity_events WHERE field_key='position'",[],|r|r.get(0))?,
        c.query_row("SELECT COUNT(*) FROM activity_projection WHERE field_key='position' AND is_hidden=0",[],|r|r.get(0))?,
        c.query_row("SELECT COUNT(*) FROM activity_projection WHERE field_key='position' AND is_open=1",[],|r|r.get(0))?
    ))).await.unwrap();
    assert_eq!((raw, visible, open), (3, 0, 0));
    let feed = CollaborationService::new(f.db.clone())
        .activity(&f.member, "p1", Some("order-1"), None, Some(100))
        .await
        .unwrap();
    assert!(
        feed.items
            .iter()
            .all(|e| e.field_key.as_deref() != Some("position"))
    );
}
