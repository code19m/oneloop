use oneloop::{
    AppError, Db,
    auth::Actor,
    collaboration::{
        CollaborationCommand, CollaborationRuntime, CollaborationService, InboxFilter,
    },
};
use serde_json::json;
use tempfile::TempDir;

use crate::support::{browser_actor, now};

struct Fixture {
    _root: TempDir,
    db: Db,
    alice: Actor,
    bob: Actor,
}

impl Fixture {
    async fn new() -> Self {
        let (root, db) = crate::support::database();
        let now = now();
        db.run(move |connection| {
            connection.execute_batch(&format!(r#"
                INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                    VALUES ('alice','alice','Alice','x',{now},{now},{now}),
                           ('bob','bob','Bob','x',{now},{now},{now}),
                           ('carol','carol','Carol','x',{now},{now},{now});
                INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at)
                    VALUES ('p1','Secret Project','SEC','alice',{now},{now});
                INSERT INTO project_prefixes(prefix,project_id,reserved_at) VALUES ('SEC','p1',{now});
                INSERT INTO project_sequences(project_id,next_task_number) VALUES ('p1',2);
                INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at)
                    VALUES ('p1','alice',1,{now},{now}),('p1','bob',0,{now},{now}),('p1','carol',0,{now},{now});
                INSERT INTO tracks(id,project_id,name,position,created_by,created_at,updated_at)
                    VALUES ('track','p1','Track',0,'alice',{now},{now});
                INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_by,created_at,updated_at)
                    VALUES ('epic','p1','track','Epic','2026-01-01',0,'alice',{now},{now});
                INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                    VALUES ('task','p1','epic',1,'SEC-001','Task','planning',0,'alice',{now},{now});
                INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                    VALUES ('sa','alice','ha',{now},{now},{now},{expiry},{expiry}),
                           ('sb','bob','hb',{now},{now},{now},{expiry},{expiry});
            "#, expiry=now+86_400))?;
            Ok(())
        }).await.unwrap();
        Self {
            _root: root,
            db,
            alice: browser_actor("alice", "Alice", "sa", now),
            bob: browser_actor("bob", "Bob", "sb", now),
        }
    }

    fn service(&self) -> CollaborationService {
        CollaborationService::new(self.db.clone())
    }
}

fn command(
    operation: &str,
    payload: serde_json::Value,
    key: &str,
    revision: Option<i64>,
) -> CollaborationCommand {
    CollaborationCommand {
        operation: operation.into(),
        payload,
        idempotency_key: key.into(),
        expected_revision: revision,
    }
}

async fn drain(runtime: &CollaborationRuntime) {
    let worker = runtime.worker();
    while worker.run_once().await.unwrap() {}
}

#[tokio::test]
async fn comment_pages_and_exact_context_keep_content_mentions_and_counts_in_one_snapshot() {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;
    type Gate = (mpsc::Sender<()>, mpsc::Receiver<()>);
    static GATE: Mutex<Option<Gate>> = Mutex::new(None);
    fn trace(event: TraceEvent<'_>) {
        if let TraceEvent::Stmt(_, sql) = event
            && sql.contains("FROM comment_mentions")
            && let Some((entered, release)) = GATE.lock().unwrap().take()
        {
            entered.send(()).unwrap();
            release.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    }
    let mut pages = Vec::new();
    for exact in [false, true] {
        let f = Fixture::new().await;
        let service = f.service();
        let mentions =
            json!([{"kind":"user","userId":"bob","startOffset":0,"endOffset":4,"label":"@Bob"}]);
        let root = service
            .execute(
                &f.alice,
                command(
                    "discussion.comment.create",
                    json!({"taskId":"task","content":"@Bob old","mentions":mentions}),
                    "root",
                    None,
                ),
            )
            .await
            .unwrap()
            .entities[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let reply = service.execute(&f.alice, command("discussion.comment.create",
            json!({"taskId":"task","replyToId":root,"content":"@Bob old","mentions":mentions}), "reply", None,
        )).await.unwrap().entities[0]["id"].as_str().unwrap().to_owned();
        let reader = Db::open_with_pool_size(f._root.path(), 1).unwrap();
        reader
            .run(|conn| {
                conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(trace));
                Ok(())
            })
            .await
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *GATE.lock().unwrap() = Some((entered_tx, release_rx));
        let actor = f.alice.clone();
        let reply_id = reply.clone();
        let read = tokio::spawn(async move {
            let reader = CollaborationService::new(reader);
            if exact {
                reader.comment_context(&actor, "task", &reply_id).await
            } else {
                reader.comments(&actor, "task", None, Some(1)).await
            }
        });
        tokio::task::spawn_blocking(move || {
            entered_rx.recv_timeout(Duration::from_secs(10)).unwrap()
        })
        .await
        .unwrap();
        for id in [&root, &reply] {
            service.execute(&f.alice, command("discussion.comment.edit",
                json!({"commentId":id,"content":"prefix @Alice updated","mentions":[{
                    "kind":"user","userId":"alice","startOffset":7,"endOffset":13,"label":"@Alice"
                }]}), id, Some(1),
            )).await.unwrap();
        }
        service
            .execute(
                &f.alice,
                command(
                    "discussion.comment.create",
                    json!({"taskId":"task","replyToId":root,"content":"New reply"}),
                    "new-reply",
                    None,
                ),
            )
            .await
            .unwrap();
        release_tx.send(()).unwrap();
        pages.push((exact, root, read.await.unwrap().unwrap()));
    }
    for (exact, root, page) in pages {
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.context.len(), 1);
        for comment in page.items.iter().chain(&page.context) {
            assert_eq!(comment.content.as_deref(), Some("@Bob old"));
            assert_eq!(comment.revision, 1);
            assert_eq!(comment.mentions[0].label, "@Bob", "exact={exact}");
            assert_eq!(comment.mentions[0].end_offset, 4);
        }
        assert_eq!(page.reply_counts[&root], 1, "exact={exact}");
    }
}

#[tokio::test]
async fn comment_edits_retain_departed_mentions_but_reject_new_selections() {
    for deactivate in [false, true] {
        let f = Fixture::new().await;
        let service = f.service();
        let mentions =
            json!([{"kind":"user","userId":"bob","startOffset":0,"endOffset":4,"label":"@Bob"}]);
        let id = service
            .execute(
                &f.alice,
                command(
                    "discussion.comment.create",
                    json!({"taskId":"task","content":"@Bob old","mentions":mentions}),
                    "retained-create",
                    None,
                ),
            )
            .await
            .unwrap()
            .entities[0]["id"]
            .clone();
        f.db.transaction(move |tx| {
            if deactivate {
                tx.execute(
                    "UPDATE users SET is_active=0 WHERE id IN ('bob','carol')",
                    [],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM project_memberships WHERE user_id IN ('bob','carol')",
                    [],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let edited = service
            .execute(
                &f.alice,
                command(
                    "discussion.comment.edit",
                    json!({"commentId":id,"content":"@Bob corrected","mentions":mentions}),
                    "retained-edit",
                    Some(1),
                ),
            )
            .await
            .unwrap();
        assert_eq!(edited.entities[0]["mentions"], mentions);
        assert_eq!(edited.entities[0]["revision"], 2);
        let error = service.execute(&f.alice, command("discussion.comment.edit",
            json!({"commentId":id,"content":"@Carol new","mentions":[{
                "kind":"user","userId":"carol","startOffset":0,"endOffset":6,"label":"@Carol"
            }]}), "new-departed-mention", Some(2),
        )).await.unwrap_err();
        assert!(matches!(error, AppError::Validation { field, .. } if field == "mentions"));
        let runtime = CollaborationRuntime::new(f.db.clone());
        drain(&runtime).await;
        let delivered =
            f.db.run(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM notification_recipients WHERE delivered_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(delivered, 0);
    }
}

#[tokio::test]
async fn moderator_edits_notify_new_mentions_without_notifying_retained_self_mentions() {
    let f = Fixture::new().await;
    f.db.transaction(|tx| {
        tx.execute("UPDATE users SET is_admin=1 WHERE id='bob'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let service = f.service();
    let mut mentions =
        json!([{"kind":"user","userId":"alice","startOffset":0,"endOffset":6,"label":"@Alice"}]);
    let id = service
        .execute(
            &f.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"@Alice old","mentions":mentions}),
                "self-create",
                None,
            ),
        )
        .await
        .unwrap()
        .entities[0]["id"]
        .clone();
    mentions.as_array_mut().unwrap().push(
        json!({"kind":"user","userId":"carol","startOffset":7,"endOffset":13,"label":"@Carol"}),
    );
    service
        .execute(
            &f.bob,
            command(
                "discussion.comment.edit",
                json!({"commentId":id,"content":"@Alice @Carol corrected","mentions":mentions}),
                "moderator-edit",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let recipients =
        f.db.run(|conn| {
            Ok(conn
                .prepare("SELECT user_id FROM notification_recipients ORDER BY user_id")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(recipients, ["carol"]);
}

#[tokio::test]
async fn selected_utf16_mentions_notify_once_and_deleted_roots_preserve_replies() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let runtime = CollaborationRuntime::new(fixture.db.clone());
    let created = service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"🙂 @Bob","mentions":[{
                    "kind":"user","userId":"bob","startOffset":3,"endOffset":7,"label":"@Bob"
                }]}),
                "create-root",
                None,
            ),
        )
        .await
        .unwrap();
    let root_id = created.entities[0]["id"].as_str().unwrap().to_owned();
    drain(&runtime).await;

    let inbox = service
        .inbox(&fixture.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(inbox.items.len(), 1);
    assert_eq!(inbox.items[0].event_type, "discussion.mention");
    assert_eq!(inbox.items[0].excerpt.as_deref(), Some("🙂 @Bob"));

    let reply = service
        .execute(
            &fixture.bob,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"Reply","replyToId":root_id}),
                "create-reply",
                None,
            ),
        )
        .await
        .unwrap();
    let reply_id = reply.entities[0]["id"].as_str().unwrap().to_owned();
    service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.delete",
                json!({"commentId":root_id}),
                "delete-root",
                Some(1),
            ),
        )
        .await
        .unwrap();

    let comments = service
        .comments(&fixture.alice, "task", None, None)
        .await
        .unwrap()
        .items;
    assert_eq!(comments.len(), 2);
    let root = comments.iter().find(|item| item.id == root_id).unwrap();
    let reply = comments.iter().find(|item| item.id == reply_id).unwrap();
    assert!(root.content.is_none());
    assert_eq!(reply.root_id, root_id);
    assert_eq!(reply.reply_to_id.as_deref(), Some(root_id.as_str()));
    assert_eq!(reply.content.as_deref(), Some("Reply"));
}

#[tokio::test]
async fn comment_edit_activity_consolidates_reverts_and_never_resends_receipts() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let created = service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"Hello @Bob","mentions":[{
                    "kind":"user","userId":"bob","startOffset":6,"endOffset":10,"label":"@Bob"
                }]}),
                "edit-create",
                None,
            ),
        )
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap().to_owned();
    for (key, content, revision) in [
        ("edit-1", "Hello @Bob!", 1),
        ("edit-2", "Hello @Bob!!", 2),
        ("edit-3", "Hello @Bob", 3),
    ] {
        service
            .execute(
                &fixture.alice,
                command(
                    "discussion.comment.edit",
                    json!({"commentId":id,"content":content,"mentions":[{
                        "kind":"user","userId":"bob","startOffset":6,"endOffset":10,"label":"@Bob"
                    }]}),
                    key,
                    Some(revision),
                ),
            )
            .await
            .unwrap();
    }
    let activity = service
        .activity(&fixture.alice, "p1", Some("task"), None, None)
        .await
        .unwrap();
    assert_eq!(
        activity
            .items
            .iter()
            .filter(|item| item.event_type == "comment.edited")
            .count(),
        0
    );
    let recipients: i64 = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM notification_recipients WHERE user_id='bob'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(recipients, 1);
}

#[tokio::test]
async fn everyone_is_members_only_and_rate_limited_across_comments() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"@everyone first","mentions":[{
                    "kind":"everyone","startOffset":0,"endOffset":9,"label":"@everyone"
                }]}),
                "everyone-1",
                None,
            ),
        )
        .await
        .unwrap();
    let error = service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"@everyone second","mentions":[{
                    "kind":"everyone","startOffset":0,"endOffset":9,"label":"@everyone"
                }]}),
                "everyone-2",
                None,
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "broadcast_cooldown");
    assert_eq!(error.status(), 429);

    let recipients: Vec<String> = fixture
        .db
        .run(|connection| {
            let mut statement = connection
                .prepare("SELECT user_id FROM notification_recipients ORDER BY user_id")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(recipients, vec!["bob", "carol"]);
}

#[tokio::test]
async fn plain_comments_do_not_reserve_or_prevent_an_everyone_broadcast() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let plain = command(
        "discussion.comment.create",
        json!({"taskId":"task","content":"Plain comment"}),
        "plain-before-broadcast",
        None,
    );
    let created = service.execute(&fixture.alice, plain).await.unwrap();
    let id = created.entities[0]["id"].as_str().unwrap().to_owned();
    let broadcast = command(
        "discussion.comment.create",
        json!({"taskId":"task","content":"@everyone now","mentions":[{
            "kind":"everyone","startOffset":0,"endOffset":9,"label":"@everyone"
        }]}),
        "broadcast-after-plain",
        None,
    );
    service.execute(&fixture.alice, broadcast).await.unwrap();
    let false_receipts: i64 = fixture.db.run(move |connection| Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_events WHERE comment_id=?1 AND json_extract(payload_json,'$.broadcast')=1",
        [&id], |row| row.get(0),
    )?)).await.unwrap();
    assert_eq!(false_receipts, 0);

    let second = Fixture::new().await;
    let service = second.service();
    let created = service
        .execute(
            &second.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"Plain comment"}),
                "plain-then-edit",
                None,
            ),
        )
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap().to_owned();
    service
        .execute(
            &second.alice,
            command(
                "discussion.comment.edit",
                json!({"commentId":id,"content":"@everyone now","mentions":[{
                    "kind":"everyone","startOffset":0,"endOffset":9,"label":"@everyone"
                }]}),
                "edit-add-broadcast",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let recipients: i64 = second.db.run(move |connection| Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_recipients r JOIN notification_events n ON n.id=r.notification_id
         WHERE n.comment_id=?1 AND json_extract(n.payload_json,'$.broadcast')=1",
        [&id], |row| row.get(0),
    )?)).await.unwrap();
    assert_eq!(recipients, 2);
}

#[tokio::test]
async fn deletion_tombstones_create_and_edit_retry_receipts() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let create = command(
        "discussion.comment.create",
        json!({"taskId":"task","content":"Secret @Bob","mentions":[{
            "kind":"user","userId":"bob","startOffset":7,"endOffset":11,"label":"@Bob"
        }]}),
        "create-to-delete",
        None,
    );
    let created = service
        .execute(&fixture.alice, create.clone())
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap().to_owned();
    let edit = command(
        "discussion.comment.edit",
        json!({"commentId":id,"content":"Even more secret"}),
        "edit-to-delete",
        Some(1),
    );
    let edited = service.execute(&fixture.alice, edit.clone()).await.unwrap();
    let mut moderator = browser_actor("carol", "Carol", "sc", now());
    moderator.is_admin = true;
    fixture.db.run(|connection| {
        connection.execute("UPDATE users SET is_admin=1 WHERE id='carol'", [])?;
        connection.execute("INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
            VALUES('sc','carol','hc',1,1,1,9999999999,9999999999)", [])?;
        Ok(())
    }).await.unwrap();
    service
        .execute(
            &moderator,
            command(
                "discussion.comment.delete",
                json!({"commentId":id}),
                "moderator-delete",
                Some(2),
            ),
        )
        .await
        .unwrap();
    for original in [create, edit] {
        let replay = service.execute(&fixture.alice, original).await.unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.entities[0]["content"], serde_json::Value::Null);
        assert_eq!(replay.entities[0]["mentions"], json!([]));
        assert_eq!(replay.entities[0]["revision"], 3);
        assert!(replay.entities[0]["deletedAt"].as_i64().is_some());
    }
    // Recreate a pre-fix database whose deletion did not scrub either receipt.
    let stale_create = serde_json::to_string(&created).unwrap();
    let stale_edit = serde_json::to_string(&edited).unwrap();
    fixture.db.run(move |connection| {
        connection.execute("UPDATE idempotency_keys SET response_json=?1 WHERE idempotency_key='create-to-delete'", [stale_create])?;
        connection.execute("UPDATE idempotency_keys SET response_json=?1 WHERE idempotency_key='edit-to-delete'", [stale_edit])?;
        Ok(())
    }).await.unwrap();
    let legacy_create = command(
        "discussion.comment.create",
        json!({"taskId":"task","content":"Secret @Bob","mentions":[{
            "kind":"user","userId":"bob","startOffset":7,"endOffset":11,"label":"@Bob"
        }]}),
        "create-to-delete",
        None,
    );
    let replay = service
        .execute(&fixture.alice, legacy_create)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert!(replay.entities[0]["content"].is_null());
    assert_eq!(replay.entities[0]["mentions"], json!([]));
    assert_eq!(replay.entities[0]["revision"], 3);
    assert!(replay.entities[0]["deletedAt"].as_i64().is_some());
    let legacy_edit = command(
        "discussion.comment.edit",
        json!({"commentId":id,"content":"Even more secret"}),
        "edit-to-delete",
        Some(1),
    );
    let edit_replay = service.execute(&fixture.alice, legacy_edit).await.unwrap();
    assert!(edit_replay.replayed);
    assert!(edit_replay.entities[0]["content"].is_null());
    assert_eq!(edit_replay.entities[0]["mentions"], json!([]));
    assert_eq!(edit_replay.entities[0]["revision"], 3);
    let retained: Vec<String> = fixture.db.run(move |connection| {
        let mut statement = connection.prepare("SELECT response_json FROM idempotency_keys WHERE resource_type='comment' AND resource_id=?1")?;
        Ok(statement.query_map([&id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?)
    }).await.unwrap();
    assert!(
        retained
            .iter()
            .all(|text| !text.contains("Secret") && !text.contains("@Bob"))
    );
}

#[tokio::test]
async fn access_revocation_redacts_delivered_inbox_context_and_stops_pending_delivery() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let runtime = CollaborationRuntime::new(fixture.db.clone());
    service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"Hello @Bob","mentions":[{
                    "kind":"user","userId":"bob","startOffset":6,"endOffset":10,"label":"@Bob"
                }]}),
                "revoke-delivered",
                None,
            ),
        )
        .await
        .unwrap();
    drain(&runtime).await;
    fixture
        .db
        .run(|connection| {
            connection.execute(
                "DELETE FROM project_memberships WHERE project_id='p1' AND user_id='bob'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let retained = service
        .inbox(&fixture.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(retained.items.len(), 1);
    assert!(!retained.items[0].destination_available);
    assert!(retained.items[0].project_name.is_none());
    assert!(retained.items[0].task_key.is_none());
    assert!(retained.items[0].excerpt.is_none());

    fixture.db.run(|connection| {
        connection.execute(
            "INSERT INTO project_memberships(project_id,user_id,created_at,updated_at) VALUES('p1','bob',1,1)", [],
        )?;
        Ok(())
    }).await.unwrap();
    service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"Again @Bob","mentions":[{
                    "kind":"user","userId":"bob","startOffset":6,"endOffset":10,"label":"@Bob"
                }]}),
                "revoke-pending",
                None,
            ),
        )
        .await
        .unwrap();
    fixture
        .db
        .run(|connection| {
            connection.execute(
                "DELETE FROM project_memberships WHERE project_id='p1' AND user_id='bob'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    drain(&runtime).await;
    let delivered: i64 = fixture.db.run(|connection| Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_recipients WHERE user_id='bob' AND delivered_at IS NOT NULL", [], |row| row.get(0),
    )?)).await.unwrap();
    assert_eq!(delivered, 1);
}

#[tokio::test]
async fn idempotent_comment_replay_rechecks_current_project_access() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let original = command(
        "discussion.comment.create",
        json!({"taskId":"task","content":"Private context"}),
        "replay-after-revoke",
        None,
    );
    service
        .execute(&fixture.alice, original.clone())
        .await
        .unwrap();
    fixture
        .db
        .run(|connection| {
            connection.execute(
                "DELETE FROM project_memberships WHERE project_id='p1' AND user_id='alice'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        service.execute(&fixture.alice, original).await,
        Err(AppError::NotFound { .. })
    ));
}

#[tokio::test]
async fn comment_pages_walk_newest_to_oldest_with_bounded_thread_context() {
    let fixture = Fixture::new().await;
    fixture.db.transaction(|tx| {
        tx.execute("INSERT INTO comments(id,project_id,task_id,author_id,root_id,content,created_at,deleted_at) VALUES('c000','p1','task','alice','c000','',1,NULL)", [])?;
        for number in 1..=121 {
            let id = format!("c{number:03}");
            let reply = number <= 60 || number == 121;
            let root = if reply { "c000" } else { id.as_str() };
            let target = if number == 121 { Some("c001") } else if reply { Some("c000") } else { None };
            tx.execute("INSERT INTO comments(id,project_id,task_id,author_id,root_id,reply_to_id,content,created_at) VALUES(?1,'p1','task','alice',?2,?3,?1,1)", rusqlite::params![id,root,target])?;
        }
        tx.execute("UPDATE comments SET deleted_at=2 WHERE id='c000'", [])?;
        Ok(())
    }).await.unwrap();
    let service = fixture.service();
    let first = service
        .comments(&fixture.alice, "task", None, Some(50))
        .await
        .unwrap();
    assert_eq!(first.items.len(), 50);
    assert_eq!(first.items[0].id, "c121");
    assert_eq!(first.reply_counts["c000"], 61);
    assert_eq!(first.context.len(), 2);
    assert!(
        first
            .context
            .iter()
            .find(|item| item.id == "c000")
            .unwrap()
            .content
            .is_none()
    );
    assert_eq!(first.items[0].reply_to_id.as_deref(), Some("c001"));
    let mut ids = first
        .items
        .into_iter()
        .map(|item| item.id)
        .collect::<Vec<_>>();
    let mut cursor = first.next_cursor;
    while let Some(next) = cursor {
        let page = service
            .comments(&fixture.alice, "task", Some(&next), Some(50))
            .await
            .unwrap();
        assert!(page.items.len() <= 50);
        assert!(page.context.len() <= 100);
        ids.extend(page.items.into_iter().map(|item| item.id));
        cursor = page.next_cursor;
    }
    assert_eq!(
        ids,
        (0..=121)
            .rev()
            .map(|n| format!("c{n:03}"))
            .collect::<Vec<_>>()
    );
    let target = service
        .comment_context(&fixture.alice, "task", "c001")
        .await
        .unwrap();
    assert_eq!(target.items[0].id, "c001");
    assert_eq!(target.context[0].id, "c000");
    fixture
        .db
        .run(|connection| {
            connection.execute("DELETE FROM project_memberships WHERE user_id='bob'", [])?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        service
            .comment_context(&fixture.bob, "task", "c001")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn comment_limit_matches_browser_utf16_length() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let too_long = service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"🙂".repeat(1001)}),
                "too-many-units",
                None,
            ),
        )
        .await
        .unwrap_err();
    assert!(matches!(too_long, AppError::Validation { .. }));
    let valid = service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"🙂".repeat(1000)}),
                "at-unit-limit",
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(valid.entities[0]["content"], "🙂".repeat(1000));
}

#[tokio::test]
async fn comment_whitespace_preserves_selected_mention_offsets() {
    let fixture = Fixture::new().await;
    let content = "\r\n  @Bob\r\n";
    let created = fixture.service().execute(&fixture.alice, command("discussion.comment.create", json!({
        "taskId":"task","content":content,"mentions":[{"kind":"user","userId":"bob","startOffset":4,"endOffset":8,"label":"@Bob"}]
    }), "whitespace-mention", None)).await.unwrap();
    assert_eq!(created.entities[0]["content"], content);
    assert_eq!(created.entities[0]["mentions"][0]["startOffset"], 4);
    drain(&CollaborationRuntime::new(fixture.db.clone())).await;
    let inbox = fixture
        .service()
        .inbox(&fixture.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(inbox.items.len(), 1);
}

#[tokio::test]
async fn comment_edit_comparison_values_never_leave_activity_reads() {
    let f = Fixture::new().await;
    let service = f.service();
    let created = service
        .execute(
            &f.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":"draft"}),
                "fingerprint-create",
                None,
            ),
        )
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap();
    service
        .execute(
            &f.alice,
            command(
                "discussion.comment.edit",
                json!({"commentId":id,"content":"yes"}),
                "fingerprint-edit",
                Some(1),
            ),
        )
        .await
        .unwrap();
    for deleted in [false, true] {
        if deleted {
            service
                .execute(
                    &f.alice,
                    command(
                        "discussion.comment.delete",
                        json!({"commentId":id}),
                        "fingerprint-delete",
                        Some(2),
                    ),
                )
                .await
                .unwrap();
        }
        let page = service
            .activity(&f.bob, "p1", Some("task"), None, None)
            .await
            .unwrap();
        let edit = page
            .items
            .iter()
            .find(|row| row.event_type == "comment.edited")
            .unwrap();
        assert_eq!(edit.before, None);
        assert_eq!(edit.after, None);
    }
}

#[tokio::test]
async fn bulk_inbox_uses_displayed_filter_and_actor_identity_is_immutable() {
    use oneloop::collaboration::{NotificationInput, snapshot_notification_tx};
    let f = Fixture::new().await;
    let actor = f.alice.clone();
    f.db.transaction(move |tx| {
        tx.execute("UPDATE users SET display_name='Bob' WHERE id='alice'", [])?;
        tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
            SELECT 'deleted-task',project_id,epic_id,2,'SEC-002','Deleted','planning',1,created_at,updated_at FROM tasks WHERE id='task'", [])?;
        for task_id in ["task", "deleted-task"] {
            snapshot_notification_tx(tx,&actor, NotificationInput {
                project_id:"p1",event_type:"task.assigned",task_id:Some(task_id),comment_id:None,
                block_id:None,excerpt:None,payload:json!({})},vec!["bob".into()],now())?;
        }
        Ok(())
    }).await.unwrap();
    let runtime = CollaborationRuntime::new(f.db.clone());
    drain(&runtime).await;
    f.db.transaction(|tx| {
        tx.execute("UPDATE tasks SET deleted_at=1 WHERE id='deleted-task'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let service = f.service();
    let filter = InboxFilter {
        project_ids: ["p1".into()].into(),
        unread_only: true,
        archived: false,
    };
    let page = service
        .inbox(&f.bob, filter.clone(), None, None)
        .await
        .unwrap();
    assert_eq!(page.filtered_count, 1);
    assert_eq!(page.items[0].actor_user_id.as_deref(), Some("alice"));
    assert_eq!(page.items[0].actor_name.as_deref(), Some("Bob"));
    let result = service
        .execute(
            &f.bob,
            command(
                "inbox.bulkMarkRead",
                json!({"filter":{"projectIds":["p1"],"unreadOnly":true}}),
                "bulk-filter",
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.entities[0]["changed"], 1);
    let page = service
        .inbox(&f.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(page.unread_count, 1);
    let hidden = page
        .items
        .iter()
        .find(|row| !row.destination_available)
        .unwrap();
    assert_eq!(hidden.actor_user_id, None);
    assert_eq!(hidden.actor_name, None);
    assert_eq!(hidden.read_at, None);
}

#[tokio::test]
async fn inbox_comment_excerpts_are_bounded_current_and_cleared_on_delete() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let runtime = CollaborationRuntime::new(fixture.db.clone());
    let content = format!("@Bob {}", "é".repeat(1995));
    let mentions =
        json!([{"kind":"user","userId":"bob","startOffset":0,"endOffset":4,"label":"@Bob"}]);
    let created = service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.create",
                json!({"taskId":"task","content":content,"mentions":mentions}),
                "long-excerpt",
                None,
            ),
        )
        .await
        .unwrap();
    let id = created.entities[0]["id"].as_str().unwrap();
    drain(&runtime).await;
    let page = service
        .inbox(&fixture.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    let excerpt = page.items[0].excerpt.as_deref().unwrap();
    assert_eq!(excerpt.chars().count(), 241);
    assert_eq!(
        excerpt,
        format!("{}…", content.chars().take(240).collect::<String>())
    );
    service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.edit",
                json!({"commentId":id,"content":"@Bob revised","mentions":mentions}),
                "edit-excerpt",
                Some(1),
            ),
        )
        .await
        .unwrap();
    let page = service
        .inbox(&fixture.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert_eq!(page.items[0].excerpt.as_deref(), Some("@Bob revised"));
    service
        .execute(
            &fixture.alice,
            command(
                "discussion.comment.delete",
                json!({"commentId":id}),
                "delete-excerpt",
                Some(2),
            ),
        )
        .await
        .unwrap();
    let page = service
        .inbox(&fixture.bob, InboxFilter::default(), None, None)
        .await
        .unwrap();
    assert!(page.items[0].excerpt.is_none());
}

#[tokio::test]
async fn comment_edits_and_deletes_invalidate_original_recipients_privately() {
    let fixture = Fixture::new().await;
    let service = fixture.service();
    let runtime = CollaborationRuntime::new(fixture.db.clone());
    let created = service.execute(&fixture.alice, command(
        "discussion.comment.create",
        json!({"taskId":"task","content":"Secret @Bob","mentions":[{"kind":"user","userId":"bob","startOffset":7,"endOffset":11,"label":"@Bob"}]}),
        "excerpt-create", None,
    )).await.unwrap();
    let id = created.entities[0]["id"].as_str().unwrap();
    drain(&runtime).await;
    let mut events = runtime.subscribe();
    for (operation, payload, revision, expected) in [
        (
            "discussion.comment.edit",
            json!({"commentId":id,"content":"Updated","mentions":[]}),
            1,
            Some("Updated"),
        ),
        (
            "discussion.comment.delete",
            json!({"commentId":id}),
            2,
            None,
        ),
    ] {
        service
            .execute(
                &fixture.alice,
                command(operation, payload, operation, Some(revision)),
            )
            .await
            .unwrap();
        drain(&runtime).await;
        let mut inbox_hints = Vec::new();
        while let Ok(hint) = events.try_recv() {
            if hint.kind == "inbox.changed" {
                inbox_hints.push(hint);
            }
        }
        assert_eq!(inbox_hints.len(), 1);
        assert_eq!(
            inbox_hints[0].recipient_ids,
            ["bob".to_owned()].into_iter().collect()
        );
        assert!(inbox_hints[0].project_id.is_none());
        let inbox = service
            .inbox(&fixture.bob, InboxFilter::default(), None, None)
            .await
            .unwrap();
        assert_eq!(inbox.items[0].excerpt.as_deref(), expected);
    }
}

#[tokio::test]
async fn legacy_status_history_reads_and_consolidates_without_rewriting_raw_values() {
    use oneloop::collaboration::{ActivityInput, record_activity_tx};
    let f = Fixture::new().await;
    let actor = f.alice.clone();
    let time = now();
    let id =
        f.db.transaction(move |tx| {
            let event = record_activity_tx(
                tx,
                &actor,
                ActivityInput {
                    project_id: Some("p1"),
                    entity_type: "task",
                    entity_id: "task",
                    task_id: Some("task"),
                    event_type: "task.moved",
                    field_key: Some("status"),
                    before: Some(json!("planned")),
                    after: Some(json!("in_progress")),
                    metadata: json!({}),
                    entity_revision: Some(2),
                },
                time,
            )?;
            Ok(event.id)
        })
        .await
        .unwrap();
    let page = f
        .service()
        .activity(&f.alice, "p1", Some("task"), None, None)
        .await
        .unwrap();
    let entry = page.items.iter().find(|e| e.id == id).unwrap();
    assert_eq!(entry.before, Some(json!("planning")));
    assert_eq!(entry.after, Some(json!("in_progress")));
    let actor = f.alice.clone();
    let raw_id = id.clone();
    f.db.transaction(move |tx| {
        record_activity_tx(
            tx,
            &actor,
            ActivityInput {
                project_id: Some("p1"),
                entity_type: "task",
                entity_id: "task",
                task_id: Some("task"),
                event_type: "task.moved",
                field_key: Some("status"),
                before: Some(json!("in_progress")),
                after: Some(json!("planning")),
                metadata: json!({}),
                entity_revision: Some(3),
            },
            time + 1,
        )?;
        let raw: String = tx.query_row(
            "SELECT before_json FROM activity_events WHERE id=?1",
            [raw_id],
            |r| r.get(0),
        )?;
        assert_eq!(raw, "\"planned\"");
        Ok(())
    })
    .await
    .unwrap();
    let page = f
        .service()
        .activity(&f.alice, "p1", Some("task"), None, None)
        .await
        .unwrap();
    assert!(
        !page.items.iter().any(|e| e.id == id),
        "return to original status remains hidden"
    );
}
