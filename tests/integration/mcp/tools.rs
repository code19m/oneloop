use super::*;

#[tokio::test]
async fn transfer_tickets_revoke_the_whole_grant_after_another_project_is_lost() {
    for direction in ["upload", "download"] {
        let (_dir, db, app, session, user) = fixture().await;
        db.run(move |c| {
            c.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('project-2','Other','OTH',1,1)", [])?;
            c.execute("INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES('project-2',?1,1,1)", [user])?;
            Ok(())
        }).await.unwrap();
        let client = register(&app).await;
        let (code, verifier) = authorize_with(
            &app,
            &session,
            &client,
            &[
                "project_read",
                "board_manage",
                "roadmap_manage",
                "attachments",
            ],
            &["project-1", "project-2"],
        )
        .await;
        let tokens = issue(&app, &client, &code, &verifier).await;
        let mut mcp = McpClient::connect(&app, tokens["access_token"].as_str().unwrap()).await;
        let task = create_protocol_task(&mut mcp, "project-1", direction).await;
        let upload = tool_value(&mcp.call("create_attachment_upload", json!({"taskId":task, "fileName":"data.txt", "sizeBytes":4,"idempotencyKey":"transfer"})).await);
        let ticket = if direction == "download" {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/mcp/files/upload")
                        .header(
                            header::AUTHORIZATION,
                            upload["authorization"].as_str().unwrap(),
                        )
                        .body(Body::from("data"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let attachment = body_json(response).await["value"]["id"].clone();
            tool_value(
                &mcp.call(
                    "create_attachment_download",
                    json!({"attachmentId":attachment}),
                )
                .await,
            )
        } else {
            upload
        };
        db.run(|c| {
            c.execute(
                "DELETE FROM project_memberships WHERE project_id='project-2'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(if direction == "upload" { "PUT" } else { "GET" })
                    .uri(format!("/mcp/files/{direction}"))
                    .header(
                        header::AUTHORIZATION,
                        ticket["authorization"].as_str().unwrap(),
                    )
                    .body(Body::from("data"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{direction}");
        let counts: (i64, i64, i64, i64) = db
            .run(|c| {
                Ok((
                    c.query_row(
                        "SELECT count(*) FROM mcp_grants WHERE revoked_at IS NULL",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row(
                        "SELECT count(*) FROM mcp_tokens WHERE revoked_at IS NULL",
                        [],
                        |r| r.get(0),
                    )?,
                    c.query_row("SELECT count(*) FROM task_attachments", [], |r| r.get(0))?,
                    c.query_row("SELECT count(*) FROM upload_reservations", [], |r| r.get(0))?,
                ))
            })
            .await
            .unwrap();
        assert_eq!(counts, (0, 0, i64::from(direction == "download"), 0));
    }
}

#[tokio::test]
async fn an_upload_ticket_for_a_task_key_attaches_the_file_to_that_task() {
    let (_dir, db, app, session, _user) = fixture().await;
    let mut mcp = scoped_mcp(
        &app,
        &session,
        &[
            "project_read",
            "board_manage",
            "roadmap_manage",
            "attachments",
        ],
        &["project-1"],
    )
    .await;
    let task = create_protocol_task(&mut mcp, "project-1", "keyed").await;
    let id = task.clone();
    let key: String = db
        .run(
            move |c| Ok(c.query_row("SELECT task_key FROM tasks WHERE id=?1", [id], |r| r.get(0))?),
        )
        .await
        .unwrap();
    let ticket = tool_value(
        &mcp.call(
            "create_attachment_upload",
            json!({"taskId": key, "fileName": "notes.txt", "sizeBytes": 5, "idempotencyKey": "by-key"}),
        )
        .await,
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp/files/upload")
                .header(
                    header::AUTHORIZATION,
                    ticket["authorization"].as_str().unwrap(),
                )
                .body(Body::from("notes"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["value"]["taskId"], task);
}

#[tokio::test]
async fn protocol_tools_cover_ordinary_work_pagination_privacy_and_exclusions() {
    let (_dir, db, app, session, _user) = fixture().await;
    let member_id = db
        .transaction(|transaction| {
            let member = create_user(
                transaction,
                NewUser {
                    username: "member".into(),
                    display_name: "Member".into(),
                    password: "member-test-password-012345".into(),
                    is_admin: false,
                    must_change_password: false,
                },
                unix_now()?,
            )?;
            transaction.execute(
                "INSERT INTO project_memberships(project_id,user_id,manage_board,manage_roadmap,created_at,updated_at) VALUES('project-1',?1,0,0,1,1)",
                [&member.id],
            )?;
            Ok(member.id)
        })
        .await
        .unwrap();
    db.run(|connection| {
        connection.execute(
            "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('project-2','Other','OTH',1,1)",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let read_client = register(&app).await;
    let (code, verifier) = authorize_with(
        &app,
        &session,
        &read_client,
        &["project_read"],
        &["project-1"],
    )
    .await;
    let read_tokens = issue(&app, &read_client, &code, &verifier).await;
    let mut read_mcp = McpClient::connect(
        &app,
        read_tokens["access_token"].as_str().unwrap().to_owned(),
    )
    .await;
    let read_projects = tool_value(&read_mcp.call("list_projects", json!({})).await);
    assert_eq!(read_projects["projects"].as_array().unwrap().len(), 1);
    assert_eq!(read_projects["projects"][0]["id"], "project-1");
    assert_eq!(read_projects["projects"][0]["manageBoard"], false);
    assert_eq!(read_projects["projects"][0]["manageRoadmap"], false);
    assert_eq!(read_projects["scopes"], json!(["project_read"]));
    let read_identity = tool_value(&read_mcp.call("get_identity", json!({})).await);
    assert_eq!(read_identity["projectIds"], json!(["project-1"]));
    assert!(read_identity.get("grantId").is_none());
    let read_members = tool_value(
        &read_mcp
            .call("list_project_members", json!({"projectId":"project-1"}))
            .await,
    );
    assert_eq!(read_members["memberships"].as_array().unwrap().len(), 2);
    assert_eq!(read_members["project"]["manageBoard"], false);
    assert_tool_error(
        &read_mcp
            .call(
                "read_pool",
                json!({"projectId":"project-1","scope":"personal"}),
            )
            .await,
        "forbidden",
    );
    assert_tool_error(&read_mcp.call("read_inbox", json!({})).await, "forbidden");
    assert_tool_error(
        &read_mcp
            .call(
                "execute_work_command",
                json!({"operation":"track.create","payload":{"projectId":"project-1","name":"Denied"},"idempotencyKey":"read-only-write"}),
            )
            .await,
        "forbidden",
    );
    assert_tool_error(
        &read_mcp
            .call("read_roadmap", json!({"projectId":"project-2"}))
            .await,
        "not_found",
    );

    let client = register(&app).await;
    let (code, verifier) = authorize(&app, &session, &client).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;

    let listed = mcp.request("tools/list", json!({})).await;
    let names = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    for expected in [
        "get_identity",
        "list_projects",
        "list_project_members",
        "read_roadmap",
        "search_tasks",
        "read_task",
        "read_epic",
        "read_pool",
        "execute_work_command",
        "execute_discussion_command",
        "execute_destructive_command",
        "read_comments",
        "read_activity",
        "read_inbox",
        "list_attachments",
        "set_attachment_temporary",
        "reorder_attachment",
        "delete_attachment",
        "create_attachment_upload",
        "create_attachment_download",
    ] {
        assert!(
            names.contains(&expected),
            "missing tool {expected}: {names:?}"
        );
    }
    assert!(!names.iter().any(|name| {
        name.contains("account") || name.contains("membership") || name.contains("storage")
    }));

    let members = tool_value(
        &mcp.call("list_project_members", json!({"projectId":"project-1"}))
            .await,
    );
    assert_eq!(members["project"]["id"], "project-1");
    assert_eq!(members["memberships"].as_array().unwrap().len(), 2);

    let track = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"track.create","payload":{"projectId":"project-1","name":"Delivery"},"idempotencyKey":"mcp-track-create"}),
        )
        .await,
    );
    let track_id = track["entities"][0]["id"].as_str().unwrap().to_owned();
    let replay = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"track.create","payload":{"projectId":"project-1","name":"Delivery"},"idempotencyKey":"mcp-track-create"}),
        )
        .await,
    );
    assert_eq!(replay["replayed"], true);

    let epic = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"epic.create","payload":{"projectId":"project-1","trackId":track_id,"title":"Launch","startDate":"2026-09-20"},"idempotencyKey":"mcp-epic-create"}),
        )
        .await,
    );
    let epic_id = epic["entities"][0]["id"].as_str().unwrap().to_owned();
    let mut task_ids = Vec::new();
    for index in 0..3 {
        let task = tool_value(
            &mcp.call(
                "execute_work_command",
                json!({"operation":"task.create","payload":{"projectId":"project-1","epicId":epic_id,"title":format!("MCP task {index}")},"idempotencyKey":format!("mcp-task-{index}")}),
            )
            .await,
        );
        task_ids.push(task["entities"][0]["id"].as_str().unwrap().to_owned());
    }
    tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"epic.update","payload":{"epicId":epic_id,"title":"Launch updated"},"idempotencyKey":"mcp-epic-update","expectedRevision":1}),
        )
        .await,
    );
    let first_epic_page = tool_value(
        &mcp.call("read_epic", json!({"epicId":epic_id,"limit":1}))
            .await,
    );
    assert_eq!(first_epic_page["epicId"], epic_id);
    assert_eq!(first_epic_page["tasks"]["total"], 3);
    assert_eq!(
        first_epic_page["tasks"]["items"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        first_epic_page["activity"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let second_epic_page = tool_value(
        &mcp.call(
            "read_epic",
            json!({
                "epicId": epic_id,
                "taskCursor": first_epic_page["tasks"]["nextCursor"],
                "activityCursor": first_epic_page["activity"]["nextCursor"],
                "limit": 1,
            }),
        )
        .await,
    );
    assert_ne!(
        first_epic_page["tasks"]["items"][0]["id"],
        second_epic_page["tasks"]["items"][0]["id"]
    );
    assert_ne!(
        first_epic_page["activity"]["items"][0]["id"],
        second_epic_page["activity"]["items"][0]["id"]
    );
    let blocked = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"task.block","payload":{"taskId":task_ids[1],"reason":"Ask @member","mentions":[{"kind":"user","userId":member_id.clone(),"startOffset":4,"endOffset":11,"label":"@member"}]},"idempotencyKey":"mcp-task-block","expectedRevision":1}),
        )
        .await,
    );
    assert_eq!(
        blocked["entities"][0]["activeBlock"]["reason"],
        "Ask @member"
    );
    let expected_member = member_id.clone();
    let block_recipients: Vec<String> = db
        .run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT r.user_id FROM notification_recipients r JOIN notification_events e ON e.id=r.notification_id WHERE e.event_type='task.block.mentioned' ORDER BY r.user_id",
            )?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(block_recipients, vec![expected_member]);

    let first = tool_value(
        &mcp.call(
            "search_tasks",
            json!({"projectId":"project-1","status":"planning","limit":1,"search":"MCP task"}),
        )
        .await,
    );
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["total"], 3);
    let cursor = first["nextCursor"].as_str().unwrap();
    let second = tool_value(
        &mcp.call(
            "search_tasks",
            json!({"projectId":"project-1","status":"planning","limit":1,"search":"MCP task","cursor":cursor}),
        )
        .await,
    );
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    assert_eq!(
        tool_value(&mcp.call("read_task", json!({"taskId":task_ids[0]})).await)["title"],
        "MCP task 0"
    );
    assert_tool_error(
        &mcp.call("read_task", json!({"taskId":task_ids[0],"unexpected":true}))
            .await,
        "unexpected",
    );

    let pool = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"pool.create","payload":{"projectId":"project-1","scope":"personal","title":"Private capture"},"idempotencyKey":"mcp-private-pool"}),
        )
        .await,
    );
    assert_eq!(pool["entities"][0]["scope"], "personal");
    let private_pool = tool_value(
        &mcp.call(
            "read_pool",
            json!({"projectId":"project-1","scope":"personal"}),
        )
        .await,
    );
    assert_eq!(private_pool["items"].as_array().unwrap().len(), 1);

    let private_activity = tool_value(
        &mcp.call("read_activity", json!({"projectId":"project-1"}))
            .await,
    );
    assert!(private_activity.to_string().contains("Private capture"));
    let public_activity = tool_value(
        &read_mcp
            .call("read_activity", json!({"projectId":"project-1"}))
            .await,
    );
    assert!(!public_activity.to_string().contains("Private capture"));
    assert!(
        public_activity["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["entityType"] != "pool_item")
    );

    let comment = tool_value(
        &mcp.call(
            "execute_discussion_command",
            json!({"operation":"discussion.comment.create","payload":{"taskId":task_ids[0],"content":"Protocol comment"},"idempotencyKey":"mcp-comment-create"}),
        )
        .await,
    );
    assert_eq!(comment["entities"][0]["content"], "Protocol comment");
    let comment_id = comment["entities"][0]["id"].as_str().unwrap().to_owned();
    let comments = tool_value(
        &mcp.call("read_comments", json!({"taskId":task_ids[0]}))
            .await,
    );
    assert_eq!(comments["items"].as_array().unwrap().len(), 1);
    let reply = tool_value(
        &mcp.call(
            "execute_discussion_command",
            json!({"operation":"discussion.comment.create","payload":{"taskId":task_ids[0],"content":"Protocol reply","replyToId":comment_id},"idempotencyKey":"mcp-reply-create"}),
        )
        .await,
    );
    let reply_id = reply["entities"][0]["id"].as_str().unwrap().to_owned();
    let reply_context = tool_value(
        &mcp.call(
            "read_comments",
            json!({"taskId":task_ids[0],"commentId":reply_id}),
        )
        .await,
    );
    assert_eq!(reply_context["items"][0]["id"], reply_id);
    assert_eq!(reply_context["context"][0]["id"], comment_id);
    assert_tool_error(
        &mcp.call(
            "read_comments",
            json!({"taskId":task_ids[0],"commentId":reply_id,"limit":1}),
        )
        .await,
        "cannot be combined",
    );
    let activity = tool_value(
        &mcp.call(
            "read_activity",
            json!({"projectId":"project-1","taskId":task_ids[0]}),
        )
        .await,
    );
    assert!(!activity["items"].as_array().unwrap().is_empty());
    let attributed_events: i64 = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM activity_events WHERE actor_mcp_grant_id IS NOT NULL",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(attributed_events > 0);
    let inbox = tool_value(&mcp.call("read_inbox", json!({})).await);
    assert_eq!(inbox["filteredCount"], 0);

    let safe_client = register(&app).await;
    let (safe_code, safe_verifier) = authorize_with(
        &app,
        &session,
        &safe_client,
        &[
            "project_read",
            "discussion",
            "board_manage",
            "roadmap_manage",
        ],
        &["project-1"],
    )
    .await;
    let safe_tokens = issue(&app, &safe_client, &safe_code, &safe_verifier).await;
    let mut safe_mcp = McpClient::connect(
        &app,
        safe_tokens["access_token"].as_str().unwrap().to_owned(),
    )
    .await;
    let updated = tool_value(
        &safe_mcp
            .call(
                "execute_work_command",
                json!({"operation":"task.update","payload":{"taskId":task_ids[0],"title":"Safe update"},"idempotencyKey":"safe-task-update","expectedRevision":1}),
            )
            .await,
    );
    assert_eq!(updated["entities"][0]["title"], "Safe update");
    assert_tool_error(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"task.update","payload":{"taskId":task_ids[0],"title":"Stale overwrite"},"idempotencyKey":"stale-task-update","expectedRevision":1}),
        )
        .await,
        "revision_conflict",
    );
    assert_tool_error(
        &safe_mcp
            .call(
                "execute_work_command",
                json!({"operation":"task.delete","payload":{"id":task_ids[0]},"idempotencyKey":"unsafe-task-delete","expectedRevision":2}),
            )
            .await,
        "execute_destructive_command",
    );
    assert_tool_error(
        &safe_mcp
            .call(
                "execute_discussion_command",
                json!({"operation":"discussion.comment.delete","payload":{"commentId":comment_id},"idempotencyKey":"unsafe-comment-delete","expectedRevision":1}),
            )
            .await,
        "execute_destructive_command",
    );
    assert_tool_error(
        &safe_mcp
            .call(
                "execute_destructive_command",
                json!({"operation":"task.delete","payload":{"id":task_ids[0]},"idempotencyKey":"unsafe-explicit-task-delete","expectedRevision":2}),
            )
            .await,
        "forbidden",
    );

    let delete_candidate = tool_value(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"task.create","payload":{"projectId":"project-1","epicId":epic_id,"title":"Delete through destructive tool"},"idempotencyKey":"mcp-delete-candidate"}),
        )
        .await,
    );
    let delete_candidate_id = delete_candidate["entities"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_tool_error(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"task.delete","payload":{"id":delete_candidate_id},"idempotencyKey":"mcp-wrong-delete-route","expectedRevision":1}),
        )
        .await,
        "execute_destructive_command",
    );
    let deleted_task = tool_value(
        &mcp.call(
            "execute_destructive_command",
            json!({"operation":"task.delete","payload":{"id":delete_candidate_id},"idempotencyKey":"mcp-delete-task","expectedRevision":1}),
        )
        .await,
    );
    assert_eq!(deleted_task["entities"][0]["deleted"], true);
    let deleted_task_replay = tool_value(
        &mcp.call(
            "execute_destructive_command",
            json!({"operation":"task.delete","payload":{"id":delete_candidate_id},"idempotencyKey":"mcp-delete-task","expectedRevision":1}),
        )
        .await,
    );
    assert_eq!(deleted_task_replay["replayed"], true);
    assert_tool_error(
        &mcp.call("read_task", json!({"taskId":delete_candidate_id}))
            .await,
        "not_found",
    );

    let deleted_comment = tool_value(
        &mcp.call(
            "execute_destructive_command",
            json!({"operation":"discussion.comment.delete","payload":{"commentId":comment_id},"idempotencyKey":"mcp-delete-comment","expectedRevision":1}),
        )
        .await,
    );
    assert!(
        deleted_comment["entities"][0]["deletedAt"]
            .as_i64()
            .is_some()
    );
    let deleted_comment_replay = tool_value(
        &mcp.call(
            "execute_destructive_command",
            json!({"operation":"discussion.comment.delete","payload":{"commentId":comment_id},"idempotencyKey":"mcp-delete-comment","expectedRevision":1}),
        )
        .await,
    );
    assert_eq!(deleted_comment_replay["replayed"], true);

    let mut discussion_mcp = scoped_mcp(
        &app,
        &session,
        &["project_read", "discussion"],
        &["project-1"],
    )
    .await;
    let discussion_comment = tool_value(
        &discussion_mcp
            .call(
                "execute_discussion_command",
                json!({"operation":"discussion.comment.create","payload":{"taskId":task_ids[2],"content":"Discussion-only comment"},"idempotencyKey":"discussion-only-comment"}),
            )
            .await,
    );
    assert_eq!(
        discussion_comment["entities"][0]["content"],
        "Discussion-only comment"
    );
    assert_tool_error(
        &discussion_mcp
            .call(
                "execute_work_command",
                json!({"operation":"task.update","payload":{"taskId":task_ids[0],"title":"Forbidden discussion update"},"idempotencyKey":"discussion-task-update","expectedRevision":2}),
            )
            .await,
        "forbidden",
    );

    let mut board_mcp = scoped_mcp(
        &app,
        &session,
        &["project_read", "board_manage"],
        &["project-1"],
    )
    .await;
    let board_update = tool_value(
        &board_mcp
            .call(
                "execute_work_command",
                json!({"operation":"task.update","payload":{"taskId":task_ids[0],"title":"Board update"},"idempotencyKey":"board-task-update","expectedRevision":2}),
            )
            .await,
    );
    assert_eq!(board_update["entities"][0]["title"], "Board update");
    assert_tool_error(
        &board_mcp
            .call(
                "execute_work_command",
                json!({"operation":"track.update","payload":{"trackId":track_id,"name":"Forbidden Board roadmap"},"idempotencyKey":"board-track-update","expectedRevision":1}),
            )
            .await,
        "forbidden",
    );

    let mut roadmap_mcp = scoped_mcp(
        &app,
        &session,
        &["project_read", "roadmap_manage"],
        &["project-1"],
    )
    .await;
    let roadmap_update = tool_value(
        &roadmap_mcp
            .call(
                "execute_work_command",
                json!({"operation":"track.update","payload":{"trackId":track_id,"name":"Roadmap update"},"idempotencyKey":"roadmap-track-update","expectedRevision":1}),
            )
            .await,
    );
    assert_eq!(roadmap_update["entities"][0]["name"], "Roadmap update");
    assert_tool_error(
        &roadmap_mcp
            .call(
                "execute_work_command",
                json!({"operation":"task.update","payload":{"taskId":task_ids[0],"title":"Forbidden Roadmap board"},"idempotencyKey":"roadmap-task-update","expectedRevision":3}),
            )
            .await,
        "forbidden",
    );

    db.run(|connection| {
        connection.execute("UPDATE users SET is_admin=1 WHERE username='owner'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert_tool_error(
        &mcp.call(
            "execute_work_command",
            json!({"operation":"project.create","payload":{"name":"Forbidden admin surface","taskPrefix":"BAD"},"idempotencyKey":"mcp-admin-excluded"}),
        )
        .await,
        "administrative operations",
    );
}

#[tokio::test]
async fn an_upload_body_that_breaks_off_is_a_client_error() {
    let (_dir, _db, app, session, _user) = fixture().await;
    let client = register(&app).await;
    let (code, verifier) = authorize(&app, &session, &client).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;
    let task_id = create_protocol_task(&mut mcp, "project-1", "broken-body").await;
    let ticket = tool_value(
        &mcp.call(
            "create_attachment_upload",
            json!({"taskId":task_id,"fileName":"data.txt","sizeBytes":4,"idempotencyKey":"broken-body"}),
        )
        .await,
    );
    // The client's connection ends after two of the four bytes.
    let chunks: [Result<axum::body::Bytes, std::io::Error>; 2] = [
        Ok(axum::body::Bytes::from_static(b"da")),
        Err(std::io::Error::other("connection reset by peer")),
    ];
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp/files/upload")
                .header(
                    header::AUTHORIZATION,
                    ticket["authorization"].as_str().unwrap(),
                )
                .body(Body::from_stream(tokio_stream::iter(chunks)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error = body_json(response).await;
    assert_eq!(error["error"]["code"], "validation_failed", "{error}");
    assert!(error["error"].get("reference").is_none(), "{error}");
}

#[tokio::test]
async fn protocol_file_tickets_transfer_real_bytes_and_enforce_limits() {
    let (_dir, db, app, session, user) = fixture().await;
    let client = register(&app).await;
    let (code, verifier) = authorize(&app, &session, &client).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;
    let task_id = create_protocol_task(&mut mcp, "project-1", "files").await;

    assert_tool_error(
        &mcp.call(
            "create_attachment_upload",
            json!({"taskId":task_id,"fileName":"too-large.bin","sizeBytes":26 * 1024 * 1024_u64,"idempotencyKey":"too-large-upload"}),
        )
        .await,
        "sizeBytes",
    );

    for (name, key, field) in [
        ("../x".to_owned(), "valid".to_owned(), "fileName"),
        ("".to_owned(), "valid".to_owned(), "fileName"),
        ("x".repeat(256), "valid".to_owned(), "fileName"),
        ("ok.txt".to_owned(), "".to_owned(), "idempotencyKey"),
        ("ok.txt".to_owned(), "x".repeat(129), "idempotencyKey"),
    ] {
        assert_tool_error(
            &mcp.call(
                "create_attachment_upload",
                json!({"taskId":task_id,"fileName":name,"sizeBytes":1,"idempotencyKey":key}),
            )
            .await,
            field,
        );
    }
    let tickets: i64 = db
        .run(|c| Ok(c.query_row("SELECT COUNT(*) FROM mcp_file_transfers", [], |r| r.get(0))?))
        .await
        .unwrap();
    assert_eq!(tickets, 0, "invalid uploads must not allocate tickets");

    let bytes = vec![b'x'; 300_000];
    let upload_ticket = tool_value(
        &mcp.call(
            "create_attachment_upload",
            json!({"taskId":task_id,"fileName":"large.txt","sizeBytes":bytes.len(),"temporary":false,"idempotencyKey":"large-file-upload"}),
        )
        .await,
    );
    assert_eq!(upload_ticket["method"], "PUT");
    assert_eq!(upload_ticket["contentLength"], bytes.len());
    let upload_auth = upload_ticket["authorization"].as_str().unwrap();
    let upload = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp/files/upload")
                .header(header::AUTHORIZATION, upload_auth)
                .header(header::CONTENT_LENGTH, bytes.len())
                .body(Body::from(bytes.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(upload.status(), StatusCode::OK);
    let uploaded = body_json(upload).await;
    let attachment_id = uploaded["value"]["id"].as_str().unwrap().to_owned();
    assert_eq!(uploaded["value"]["size"], bytes.len());
    for (replay_bytes, expected) in [
        (bytes.clone(), StatusCode::OK),
        (vec![b'y'; bytes.len()], StatusCode::CONFLICT),
        (vec![], StatusCode::BAD_REQUEST),
    ] {
        let ticket = tool_value(&mcp.call("create_attachment_upload",
            json!({"taskId":task_id,"fileName":"large.txt","sizeBytes":bytes.len(),"temporary":false,"idempotencyKey":"large-file-upload"})).await);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp/files/upload")
                    .header(
                        header::AUTHORIZATION,
                        ticket["authorization"].as_str().unwrap(),
                    )
                    .body(Body::from(replay_bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }

    let reuse = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp/files/upload")
                .header(header::AUTHORIZATION, upload_auth)
                .header(header::CONTENT_LENGTH, bytes.len())
                .body(Body::from(bytes.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(reuse.status(), StatusCode::UNAUTHORIZED);

    let attachments = tool_value(
        &mcp.call("list_attachments", json!({"taskId":task_id}))
            .await,
    );
    assert_eq!(attachments["items"].as_array().unwrap().len(), 1);
    assert_eq!(attachments["items"][0]["id"], attachment_id);

    let retained = tool_value(
        &mcp.call(
            "set_attachment_temporary",
            json!({"attachmentId":attachment_id,"temporary":true,"expectedRevision":1}),
        )
        .await,
    );
    assert_eq!(retained["isEphemeral"], true);

    let second_bytes = b"second attachment".to_vec();
    let second_ticket = tool_value(
        &mcp.call(
            "create_attachment_upload",
            json!({"taskId":task_id,"fileName":"second.txt","sizeBytes":second_bytes.len(),"idempotencyKey":"second-file-upload"}),
        )
        .await,
    );
    let second_upload = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp/files/upload")
                .header(
                    header::AUTHORIZATION,
                    second_ticket["authorization"].as_str().unwrap(),
                )
                .header(header::CONTENT_LENGTH, second_bytes.len())
                .body(Body::from(second_bytes))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second_upload.status(), StatusCode::OK);
    let second_id = body_json(second_upload).await["value"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let reordered = tool_value(
        &mcp.call(
            "reorder_attachment",
            json!({"taskId":task_id,"attachmentId":second_id,"targetId":attachment_id,"after":false,"expectedRevision":1,"idempotencyKey":"reorder-files"}),
        )
        .await,
    );
    assert_eq!(reordered["items"][0]["id"], second_id);

    let download_ticket = tool_value(
        &mcp.call(
            "create_attachment_download",
            json!({"attachmentId":attachment_id}),
        )
        .await,
    );
    assert_eq!(download_ticket["contentLength"], bytes.len());
    let download = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/mcp/files/download")
                .header(
                    header::AUTHORIZATION,
                    download_ticket["authorization"].as_str().unwrap(),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(body_bytes(download).await, bytes.as_slice());

    let deleted = tool_value(
        &mcp.call(
            "delete_attachment",
            json!({"attachmentId":second_id,"expectedRevision":2,"idempotencyKey":"delete-second-file"}),
        )
        .await,
    );
    assert_eq!(deleted["deleted"], true);

    db.run(move |connection| {
        connection.execute(
            "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('project-2','Private project','PVT',1,1)",
            [],
        )?;
        connection.execute(
            "INSERT INTO project_sequences(project_id,next_task_number) VALUES('project-2',1)",
            [],
        )?;
        connection.execute(
            "INSERT INTO project_memberships(project_id,user_id,manage_board,manage_roadmap,created_at,updated_at) VALUES('project-2',?1,1,1,1,1)",
            [user],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let private_client = register(&app).await;
    let (private_code, private_verifier) = authorize_with(
        &app,
        &session,
        &private_client,
        &[
            "project_read",
            "board_manage",
            "roadmap_manage",
            "attachments",
            "destructive",
        ],
        &["project-2"],
    )
    .await;
    let private_tokens = issue(&app, &private_client, &private_code, &private_verifier).await;
    let mut private_mcp = McpClient::connect(
        &app,
        private_tokens["access_token"].as_str().unwrap().to_owned(),
    )
    .await;
    let private_task = create_protocol_task(&mut private_mcp, "project-2", "private-files").await;
    let private_bytes = b"selected project only";
    let private_ticket = tool_value(
        &private_mcp
            .call(
                "create_attachment_upload",
                json!({"taskId":private_task,"fileName":"private.txt","sizeBytes":private_bytes.len(),"idempotencyKey":"private-file-upload"}),
            )
            .await,
    );
    let private_upload = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp/files/upload")
                .header(
                    header::AUTHORIZATION,
                    private_ticket["authorization"].as_str().unwrap(),
                )
                .header(header::CONTENT_LENGTH, private_bytes.len())
                .body(Body::from(private_bytes.as_slice()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(private_upload.status(), StatusCode::OK);
    let private_attachment = body_json(private_upload).await["value"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_tool_error(
        &mcp.call(
            "create_attachment_download",
            json!({"attachmentId":private_attachment}),
        )
        .await,
        "not_found",
    );

    let stale_ticket = tool_value(
        &private_mcp
            .call(
                "create_attachment_download",
                json!({"attachmentId":private_attachment}),
            )
            .await,
    );
    let deleted_task = private_task.clone();
    db.transaction(move |tx| {
        tx.execute(
            "UPDATE tasks SET deleted_at=unixepoch() WHERE id=?1",
            [deleted_task],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/mcp/files/download")
                .header(
                    header::AUTHORIZATION,
                    stale_ticket["authorization"].as_str().unwrap(),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_tool_error(
        &private_mcp
            .call(
                "create_attachment_download",
                json!({"attachmentId":private_attachment}),
            )
            .await,
        "not_found",
    );

    let client_for_revoke = client.clone();
    db.run(move |connection| {
        connection.execute(
            "DELETE FROM mcp_grant_projects WHERE grant_id=(SELECT id FROM mcp_grants WHERE client_id=?1 ORDER BY created_at DESC LIMIT 1)",
            [client_for_revoke],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let denied = app
        .clone()
        .oneshot(mcp_request(
            &mcp.access,
            mcp.session_id.as_ref(),
            json!({"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"create_attachment_download","arguments":{"attachmentId":attachment_id}}}),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let revoked: bool = db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT revoked_at IS NOT NULL FROM mcp_grants WHERE client_id=?1",
                [client],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(revoked);
}

/// Issued OAuth tokens while an external SQLite connection holds the write lock.
struct ContendedGrant {
    _dir: tempfile::TempDir,
    db: Db,
    app: Router,
    client: String,
    verifier: String,
    access: String,
    refresh: String,
    writer: rusqlite::Connection,
}

async fn contended_grant() -> ContendedGrant {
    let (dir, db, app, session, _) = fixture().await;
    let client = register(&app).await;
    let (code, verifier) = authorize(&app, &session, &client).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let writer = rusqlite::Connection::open(db.layout().database()).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    ContendedGrant {
        _dir: dir,
        db,
        app,
        client,
        verifier,
        access: tokens["access_token"].as_str().unwrap().to_owned(),
        refresh: tokens["refresh_token"].as_str().unwrap().to_owned(),
        writer,
    }
}

#[tokio::test]
async fn mcp_reads_and_unknown_oauth_tokens_do_not_wait_for_the_writer() {
    let grant = contended_grant().await;
    let (app, client, access) = (&grant.app, grant.client.as_str(), grant.access.as_str());
    let mut mcp = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        McpClient::connect(app, access),
    )
    .await
    .unwrap();
    assert!(mcp.session_id.is_none());
    assert!(tool_value(&mcp.call("get_identity", json!({})).await).is_object());
    for method in ["GET", "DELETE"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/mcp")
                    .header(header::HOST, "127.0.0.1:8080")
                    .header(header::AUTHORIZATION, format!("Bearer {access}"))
                    .header(header::ACCEPT, "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
    for (path, fields, expected) in [
        ("/oauth/revoke", vec![("token", "unknown")], StatusCode::OK),
        (
            "/oauth/token",
            vec![
                ("grant_type", "refresh_token"),
                ("client_id", client),
                ("refresh_token", "unknown"),
                ("resource", "http://127.0.0.1:8080/mcp"),
            ],
            StatusCode::BAD_REQUEST,
        ),
        (
            "/oauth/token",
            vec![
                ("grant_type", "authorization_code"),
                ("client_id", client),
                ("code", "unknown"),
                ("redirect_uri", "http://127.0.0.1:49152/callback"),
                ("code_verifier", &grant.verifier),
                ("resource", "http://127.0.0.1:8080/mcp"),
            ],
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            app.clone().oneshot(form(path, &fields)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), expected);
    }
}

#[tokio::test]
async fn refresh_token_revocation_during_writer_contention_is_retryable() {
    let grant = contended_grant().await;
    let (db, app, writer) = (&grant.db, &grant.app, &grant.writer);
    let (access, refresh) = (grant.access.as_str(), grant.refresh.as_str());
    // Waits for SQLite's five-second busy timeout.
    let response = app
        .clone()
        .oneshot(form("/oauth/revoke", &[("token", refresh)]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");
    assert_eq!(
        body_json(response).await["error"],
        "temporarily_unavailable"
    );
    assert!(
        AuthService::new(db.clone())
            .authenticate_mcp_access_token(access)
            .await
            .is_ok()
    );
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        app.clone()
            .oneshot(form("/oauth/revoke", &[("token", refresh)]))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(
        AuthService::new(db.clone())
            .authenticate_mcp_access_token(access)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn lost_membership_during_writer_contention_is_retryable_not_a_new_login() {
    let grant = contended_grant().await;
    let (db, app, writer, access) = (&grant.db, &grant.app, &grant.writer, &grant.access);
    writer.execute_batch("ROLLBACK").unwrap();
    db.transaction(|tx| {
        tx.execute("DELETE FROM project_memberships", [])?;
        Ok(())
    })
    .await
    .unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    // Waits for SQLite's five-second busy timeout.
    let response = app
        .clone()
        .oneshot(mcp_request(
            access,
            None,
            json!({"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");
    assert!(!response.headers().contains_key(header::WWW_AUTHENTICATE));
}

#[tokio::test]
async fn stale_mcp_write_is_a_structured_conflict_with_current_revision() {
    let (_dir, _, app, session, _) = fixture().await;
    let mut mcp = scoped_mcp(
        &app,
        &session,
        &["project_read", "board_manage", "roadmap_manage"],
        &["project-1"],
    )
    .await;
    let task = create_protocol_task(&mut mcp, "project-1", "conflict").await;
    let result = mcp.call("execute_work_command",json!({"operation":"task.update","payload":{"taskId":task,"title":"Stale"},"idempotencyKey":"stale-update","expectedRevision":99})).await;
    assert!(result.get("error").is_none());
    assert_eq!(result["result"]["isError"], true);
    assert_eq!(
        result["result"]["structuredContent"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        result["result"]["structuredContent"]["details"],
        json!({"expectedRevision":99,"currentRevision":1})
    );
}

#[tokio::test]
async fn inbox_grants_limit_reads_counts_and_all_mutations_to_selected_projects() {
    use oneloop::auth::{Actor, ActorSource};
    use oneloop::collaboration::{
        CollaborationCommand, CollaborationRuntime, CollaborationService,
    };
    let (_dir, db, app, session, user) = fixture().await;
    let owner = user.clone();
    db.transaction(move |tx| {
        let now=unix_now()?;
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('project-2','Beta Secret','BET',1,1)",[])?;
        tx.execute("INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES('project-2',?1,1,1)",[owner])?;
        tx.execute("INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('sender','sender','Sender','x',1,1,1)",[])?;
        tx.execute("INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at) VALUES('sender-session','sender','sender-hash',?1,?1,?1,?2,?2)",rusqlite::params![now,now+86400])?;
        for project in ["project-1","project-2"] {
            tx.execute("INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES(?1,'sender',1,1)",[project])?;
            tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES(?1,?1,'Track',0,1,1)",[project])?;
            tx.execute("INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES(?1,?1,?1,'Epic','2026-01-01',0,1,1)",[project])?;
            tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES(?1,?1,?1,1,?1,?2,'planning',0,1,1)",rusqlite::params![project,if project=="project-2" {"Confidential acquisition"} else {"Alpha"}])?;
        } Ok(())
    }).await.unwrap();
    let sender = Actor {
        user_id: "sender".into(),
        username: "sender".into(),
        display_name: "Sender".into(),
        is_admin: false,
        must_change_password: false,
        authenticated_at: unix_now().unwrap(),
        source: ActorSource::BrowserSession {
            session_id: "sender-session".into(),
        },
    };
    let service = CollaborationService::new(db.clone());
    for (project, content) in [
        ("project-1", "@Owner Alpha mention"),
        ("project-2", "@Owner secret budget 4.2M"),
    ] {
        service.execute(&sender,CollaborationCommand {operation:"discussion.comment.create".into(),
            payload:json!({"taskId":project,"content":content,"mentions":[{"kind":"user","userId":user,"startOffset":0,"endOffset":6,"label":"@Owner"}]}),
            idempotency_key:format!("mention-{project}"),expected_revision:None}).await.unwrap();
    }
    let runtime = CollaborationRuntime::new(db.clone());
    while runtime.worker().run_once().await.unwrap() {}
    let excluded_id: String = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT id FROM notification_events WHERE project_id='project-2'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    let client = register(&app).await;
    let (code, verifier) = authorize_with(
        &app,
        &session,
        &client,
        &["project_read", "inbox_private"],
        &["project-1"],
    )
    .await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;
    let inbox = tool_value(&mcp.call("read_inbox", json!({})).await);
    assert_eq!(inbox["filteredCount"], 1);
    assert_eq!(inbox["unreadCount"], 1);
    assert_eq!(inbox["items"].as_array().unwrap().len(), 1);
    for secret in [
        "Beta Secret",
        "Confidential acquisition",
        "4.2M",
        "project-2",
    ] {
        assert!(!inbox.to_string().contains(secret));
    }
    for operation in [
        "inbox.markRead",
        "inbox.markUnread",
        "inbox.archive",
        "inbox.restore",
    ] {
        assert_tool_error(
            &mcp.call(
                "execute_discussion_command",
                json!({"operation":operation,
            "payload":{"notificationId":excluded_id},"idempotencyKey":operation}),
            )
            .await,
            "not_found",
        );
    }
    for operation in ["inbox.bulkMarkRead", "inbox.bulkArchive"] {
        let result = tool_value(
            &mcp.call(
                "execute_discussion_command",
                json!({"operation":operation,
            "payload":{"filter":{}},"idempotencyKey":operation}),
            )
            .await,
        );
        assert_eq!(result["entities"][0]["changed"], 1);
    }
    let untouched:bool=db.run(move |connection|Ok(connection.query_row("SELECT read_at IS NULL AND archived_at IS NULL FROM notification_recipients WHERE notification_id=?1 AND user_id=?2",rusqlite::params![excluded_id,user],|row|row.get(0))?)).await.unwrap();
    assert!(untouched);
}

#[tokio::test]
async fn dates_and_hidden_resources_have_matching_browser_and_mcp_contracts() {
    let (_dir, db, app, session, _) = fixture().await;
    let mut mcp = scoped_mcp(
        &app,
        &session,
        &["project_read", "board_manage", "roadmap_manage"],
        &["project-1"],
    )
    .await;
    let task = create_protocol_task(&mut mcp, "project-1", "date-wire").await;
    let view = tool_value(&mcp.call("read_task", json!({"taskId":task})).await);
    let epic = view["epicId"].as_str().unwrap();
    for (field, operation, payload, revision) in [
        ("startDate", "epic.update", json!({"epicId":epic}), Some(1)),
        ("endDate", "epic.update", json!({"epicId":epic}), Some(1)),
        ("deadline", "task.update", json!({"taskId":task}), Some(1)),
        (
            "milestoneDate",
            "milestone.create",
            json!({"projectId":"project-1","title":"Date"}),
            None,
        ),
    ] {
        for (index, date) in [" 2026-01-01", "2026-2-3", "2026-02-30", "10000-01-01"]
            .into_iter()
            .enumerate()
        {
            let mut payload = payload.clone();
            payload[field] = json!(date);
            let command = json!({"operation":operation,"payload":payload,"expectedRevision":revision,"idempotencyKey":format!("date-wire-{field}-{index}")});
            let result = mcp.call("execute_work_command", command.clone()).await;
            assert_eq!(
                result["result"]["structuredContent"]["code"], "validation_failed",
                "{result}"
            );
            assert_eq!(
                result["result"]["structuredContent"]["details"]["field"],
                field
            );
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/commands")
                        .header(header::CONTENT_TYPE, "application/json")
                        .header(header::ORIGIN, "http://127.0.0.1:8080")
                        .header(header::COOKIE, format!("oneloop_session={session}"))
                        .body(Body::from(command.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(
                body_json(response).await["error"]["details"]["field"],
                field
            );
        }
    }
    db.transaction(|tx| {
        tx.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('hidden-project','Hidden','HID',1,1);
            INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('hidden-track','hidden-project','Track',0,1,1);
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('hidden-epic','hidden-project','hidden-track','Epic','2026-01-01',0,1,1);
            INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('hidden-task','hidden-project','hidden-epic',1,'HID-001','Hidden','planning',0,1,1);")?;
        Ok(())
    })
    .await
    .unwrap();
    let hidden = mcp.call("read_task", json!({"taskId":"HID-001"})).await;
    let missing = mcp.call("read_task", json!({"taskId":"missing"})).await;
    assert_eq!(hidden["result"], missing["result"]);
    assert_eq!(hidden["result"]["structuredContent"]["code"], "not_found");
}

#[tokio::test]
async fn comment_service_requires_destructive_scope_for_delete_and_replay() {
    use oneloop::collaboration::{CollaborationCommand, CollaborationService};
    let (_dir, db, app, session, _) = fixture().await;
    let client = register(&app).await;
    let (code, verifier) = authorize(&app, &session, &client).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let access = tokens["access_token"].as_str().unwrap();
    let mut mcp = McpClient::connect(&app, access).await;
    let task = create_protocol_task(&mut mcp, "project-1", "service-destructive").await;
    let actor = AuthService::new(db.clone())
        .authenticate_mcp_access_token(access)
        .await
        .unwrap();
    let svc = CollaborationService::new(db.clone());
    db.run(|c| {
        c.execute("DELETE FROM mcp_grant_scopes WHERE scope='destructive'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let created = svc
        .execute(
            &actor,
            CollaborationCommand {
                operation: "discussion.comment.create".into(),
                payload: json!({"taskId":task,"content":"comment"}),
                idempotency_key: "service-create".into(),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let comment_id = created.entities[0]["id"].as_str().unwrap();
    let edited = svc
        .execute(
            &actor,
            CollaborationCommand {
                operation: "discussion.comment.edit".into(),
                payload: json!({"commentId":comment_id,"content":"edited"}),
                idempotency_key: "service-edit".into(),
                expected_revision: Some(1),
            },
        )
        .await
        .unwrap();
    assert!(
        !edited.replayed,
        "editing must still work without destructive access"
    );
    let deletion = CollaborationCommand {
        operation: "discussion.comment.delete".into(),
        payload: json!({"commentId":comment_id}),
        idempotency_key: "service-delete".into(),
        expected_revision: Some(2),
    };
    assert!(matches!(
        svc.execute(&actor, deletion.clone()).await,
        Err(oneloop::AppError::Forbidden)
    ));
    let grant = actor.mcp_grant_id().unwrap().to_owned();
    db.run(move |c| {
        c.execute(
            "INSERT INTO mcp_grant_scopes(grant_id,scope) VALUES(?1,'destructive')",
            [grant],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        !svc.execute(&actor, deletion.clone())
            .await
            .unwrap()
            .replayed
    );
    assert!(
        svc.execute(&actor, deletion.clone())
            .await
            .unwrap()
            .replayed
    );
    db.run(|c| {
        c.execute("DELETE FROM mcp_grant_scopes WHERE scope='destructive'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(matches!(
        svc.execute(&actor, deletion).await,
        Err(oneloop::AppError::Forbidden)
    ));
}

#[tokio::test]
async fn knowledge_tools_read_the_overview_files_and_search() {
    let (_dir, db, app, session, _user) = fixture().await;
    db.run(|connection| {
        connection.execute_batch(
            "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('project-2','Other','OTH',1,1);
             INSERT INTO knowledge_sources(project_id,url,branch,folder,state,commit_id,checked_at,created_at,updated_at,generation)
             VALUES('project-1','https://git.example.test/team/docs.git','main','docs','ready',
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,1,1,'g1');",
        )?;
        for (path, kind, media, content) in [
            (
                "README.md",
                Some("markdown"),
                "text/plain",
                &b"# Handbook\n\nWelcome aboard.\n\n## Setup\n\nInstall the tools.\n\n### Details\n\nUse the script.\n\n## Setup\n\nInstall the second kit.\n\n### Details\n\nSecond instructions.\n\n## Releases\n\nShip weekly.\n"[..],
            ),
            ("guides/onboarding.md", Some("markdown"), "text/plain", &b"# Joining\n\n## First day\n\nMeet the team.\n"[..]),
            ("diagram.png", Some("image"), "image/png", &b"\x89PNG\r\n\x1a\n"[..]),
        ] {
            connection.execute(
                "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                 VALUES('project-1',?1,?2,?3,?4,?5,50,?6)",
                rusqlite::params![path, content.len() as i64, media, kind, format!("checksum-{path}"), content],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let client = register(&app).await;
    let (code, verifier) =
        authorize_with(&app, &session, &client, &["project_read"], &["project-1"]).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;

    let overview = tool_value(
        &mcp.call("read_knowledge_overview", json!({"projectId": "project-1"}))
            .await,
    );
    assert_eq!(overview["state"], "ready");
    assert_eq!(overview["readme"]["path"], "README.md");
    assert!(
        overview["readme"]["content"]
            .as_str()
            .unwrap()
            .contains("Welcome aboard.")
    );
    assert_eq!(overview["fileCount"], 3);
    let readme = &overview["files"][0];
    assert_eq!(readme["path"], "README.md");
    assert_eq!(readme["title"], "Handbook");
    assert_eq!(readme["sections"], json!(["Setup", "Setup", "Releases"]));
    let image = &overview["files"][1];
    assert_eq!(image["path"], "diagram.png");
    assert!(image.get("title").is_none() && image.get("sections").is_none());

    let guides = tool_value(
        &mcp.call(
            "read_knowledge_overview",
            json!({"projectId": "project-1", "folder": "guides"}),
        )
        .await,
    );
    assert!(guides.get("readme").is_none());
    assert_eq!(guides["files"][0]["path"], "guides/onboarding.md");
    assert_tool_error(
        &mcp.call(
            "read_knowledge_overview",
            json!({"projectId": "project-1", "folder": "missing"}),
        )
        .await,
        "not_found",
    );

    let section = tool_value(
        &mcp.call(
            "read_knowledge_file",
            json!({"projectId": "project-1", "path": "README.md", "section": "setup"}),
        )
        .await,
    );
    let content = section["content"].as_str().unwrap();
    assert!(content.starts_with("## Setup") && content.contains("### Details"));
    assert!(!content.contains("Releases"));
    assert_eq!(
        section["headings"],
        json!([
            "# Handbook",
            "## Setup",
            "### Details",
            "## Setup",
            "### Details",
            "## Releases"
        ])
    );
    for anchor in ["setup-1", "#md-setup-1"] {
        let second = tool_value(
            &mcp.call(
                "read_knowledge_file",
                json!({"projectId":"project-1", "path":"README.md", "section":anchor}),
            )
            .await,
        );
        assert_eq!(
            second["content"],
            "## Setup\n\nInstall the second kit.\n\n### Details\n\nSecond instructions.\n\n"
        );
    }
    let second_hit = tool_value(
        &mcp.call(
            "search_knowledge",
            json!({"projectId":"project-1", "query":"second kit"}),
        )
        .await,
    );
    assert_eq!(second_hit["documents"][0]["hits"][0]["section"], "setup-1");
    let binary = tool_value(
        &mcp.call(
            "read_knowledge_file",
            json!({"projectId": "project-1", "path": "diagram.png"}),
        )
        .await,
    );
    assert!(binary.get("content").is_none());
    assert!(binary["note"].as_str().unwrap().contains("not text"));
    assert_tool_error(
        &mcp.call(
            "read_knowledge_file",
            json!({"projectId": "project-1", "path": "../secret.md"}),
        )
        .await,
        "not_found",
    );

    let search = tool_value(
        &mcp.call(
            "search_knowledge",
            json!({"projectId": "project-1", "query": "install tools"}),
        )
        .await,
    );
    assert_eq!(search["documents"][0]["path"], "README.md");
    assert_eq!(search["documents"][0]["hits"][0]["heading"], "Setup");
    assert_tool_error(
        &mcp.call(
            "search_knowledge",
            json!({"projectId": "project-2", "query": "install"}),
        )
        .await,
        "not_found",
    );
}

#[tokio::test]
async fn knowledge_file_reads_take_headings_and_sections_from_the_first_mebibyte() {
    const MIB: usize = 1024 * 1024;
    let (_dir, db, app, session, _user) = fixture().await;
    let filler = |bytes: usize| "Words that fill the page.\n".repeat(bytes / 26);
    // The Edge section crosses the end of the first mebibyte; Late is beyond it.
    let mut guide = format!("# Guide\n\n## Early\n\n{}", filler(MIB - 40_000));
    guide.push_str(&format!("## Edge\n\n{}", filler(60_000)));
    guide.push_str(&format!("## Late\n\n{}", filler(MIB)));
    let line = "word ".repeat(2 * MIB);
    db.run(move |connection| {
        connection.execute_batch(
            "INSERT INTO knowledge_sources(project_id,url,branch,folder,state,commit_id,checked_at,created_at,updated_at,generation)
             VALUES('project-1','https://git.example.test/team/docs.git','main','docs','ready',
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,1,1,'g1');",
        )?;
        for (path, kind, content) in [("guide.md", "markdown", guide), ("line.txt", "text", line)] {
            connection.execute(
                "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                 VALUES('project-1',?1,?2,'text/plain',?3,?4,50,?5)",
                rusqlite::params![path, content.len() as i64, kind, format!("checksum-{path}"), content.into_bytes()],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let client = register(&app).await;
    let (code, verifier) =
        authorize_with(&app, &session, &client, &["project_read"], &["project-1"]).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;
    let mut read = async |path: &str, section: Option<&str>| {
        let mut input = json!({"projectId": "project-1", "path": path});
        if let Some(section) = section {
            input["section"] = json!(section);
        }
        mcp.call("read_knowledge_file", input).await
    };

    let whole = tool_value(&read("guide.md", None).await);
    assert_eq!(whole["title"], "Guide");
    assert_eq!(whole["headings"], json!(["# Guide", "## Early", "## Edge"]));
    assert_eq!(whole["truncated"], true);
    assert!(whole["content"].as_str().unwrap().chars().count() <= 100_000);
    // The section ends where reading stopped, so it says that more follows.
    let edge = tool_value(&read("guide.md", Some("edge")).await);
    let content = edge["content"].as_str().unwrap();
    assert!(content.starts_with("## Edge\n\nWords"));
    assert!(content.len() < 40_000, "{}", content.len());
    assert_eq!(edge["truncated"], true);
    assert_tool_error(&read("guide.md", Some("late")).await, "not_found");
    let line = tool_value(&read("line.txt", None).await);
    assert_eq!(line["content"].as_str().unwrap().len(), 100_000);
    assert_eq!(line["truncated"], true);
}

#[tokio::test]
async fn undo_for_deletions_stays_in_the_browser() {
    let (_dir, _db, app, session, _user) = fixture().await;
    let mut mcp = scoped_mcp(
        &app,
        &session,
        &[
            "project_read",
            "board_manage",
            "roadmap_manage",
            "discussion",
            "destructive",
        ],
        &["project-1"],
    )
    .await;
    let listed = mcp.request("tools/list", json!({})).await;
    let offered = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|tool| {
            tool["inputSchema"]["oneOf"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|variant| {
            variant["properties"]["operation"]["const"]
                .as_str()
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    assert!(!offered.iter().any(|operation| {
        operation == "task.restore" || operation == "discussion.comment.restore"
    }));

    let task_id = create_protocol_task(&mut mcp, "project-1", "undo").await;
    let comment = tool_value(
        &mcp.call(
            "execute_discussion_command",
            json!({"operation":"discussion.comment.create","payload":{"taskId":task_id,"content":"Kept"},"idempotencyKey":"undo-comment"}),
        )
        .await,
    );
    let comment_id = comment["entities"][0]["id"].as_str().unwrap();
    for (operation, payload) in [
        ("discussion.comment.delete", json!({"commentId":comment_id})),
        ("task.delete", json!({"id":task_id})),
    ] {
        tool_value(
            &mcp.call(
                "execute_destructive_command",
                json!({"operation":operation,"payload":payload,"idempotencyKey":operation,"expectedRevision":1}),
            )
            .await,
        );
    }
    for (tool, operation, payload) in [
        (
            "execute_work_command",
            "task.restore",
            json!({"id":task_id}),
        ),
        (
            "execute_discussion_command",
            "discussion.comment.restore",
            json!({"commentId":comment_id}),
        ),
    ] {
        assert_tool_error(
            &mcp.call(
                tool,
                json!({"operation":operation,"payload":payload,"idempotencyKey":format!("{tool}-undo"),"expectedRevision":2}),
            )
            .await,
            "only in the browser",
        );
        assert_tool_error(
            &mcp.call(
                "execute_destructive_command",
                json!({"operation":operation,"payload":payload,"idempotencyKey":format!("{operation}-undo"),"expectedRevision":2}),
            )
            .await,
            "unsupported destructive operation",
        );
    }
}
