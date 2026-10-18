use std::{
    fs::{self, OpenOptions},
    io::Write,
};

use oneloop::{
    AppError, Db,
    db::{CURRENT_SCHEMA_VERSION, migrate, validate_backup},
};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use super::initialize;
use crate::support::{self, collaboration_command, command, query_one};

#[tokio::test]
async fn pending_deletion_provenance_survives_schema_upgrade_backup_and_restore() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    let connection = support::database_at_schema(&live, 2);
    connection.execute_batch("INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('u','owner','Original','hash',1,1,1);
        INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-01-01',0,1,1);
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('t','p','e',1,'PRJ-001','Task','planning',0,1,1);
        INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at) VALUES('g','u','client','Files app',1,1,2);").unwrap();
    let store = oneloop::files::FileStore::new(oneloop::db::DataLayout::new(&live));
    let key = store.new_storage_key().unwrap();
    connection.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at) VALUES('b',?1,?2,4,'text/plain','available',1)", params![key, "0".repeat(64)]).unwrap();
    connection.execute_batch("INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,is_ephemeral,position,created_at,last_accessed_at,updated_at) VALUES('a','p','t','b','original.txt','u',0,0,1,1,1);
        INSERT INTO idempotency_keys(id,actor_user_id,actor_mcp_grant_id,idempotency_key,operation,request_hash,state,resource_type,resource_id,created_at,updated_at,expires_at) VALUES('receipt','u','g','delete','attachment.delete','hash','failed','attachment','a',1,1,2);").unwrap();
    connection
        .execute("UPDATE file_blobs SET state='deleting' WHERE id='b'", [])
        .unwrap();
    connection.execute("INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at) VALUES('job','b',?1,'manual',1,1)", [key]).unwrap();
    drop(connection);

    assert!(
        migrate(&live, None).is_err(),
        "upgrading requires a verified backup"
    );
    fs::create_dir(root.path().join("before")).unwrap();
    let upgrade = migrate(&live, Some(root.path().join("before"))).unwrap();
    assert_eq!(
        upgrade.applied,
        (3..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
    );
    let upgraded = Connection::open(live.join("oneloop.sqlite3")).unwrap();
    let done_order_index: bool = upgraded
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='tasks_project_done_completed_idx')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        done_order_index,
        "schema 4 adds the newest-first Done index"
    );
    drop(upgraded);
    assert_eq!(
        validate_backup(upgrade.backup_path.unwrap())
            .unwrap()
            .schema_version,
        2
    );
    let backup = root.path().join("after");
    oneloop::db::create_backup(&live, &backup).unwrap();
    assert_eq!(
        validate_backup(&backup).unwrap().schema_version,
        CURRENT_SCHEMA_VERSION
    );
    let restored = root.path().join("restored");
    oneloop::db::restore_backup(&backup, &restored).unwrap();
    let db = Db::open(&restored).unwrap();
    db.run(|c| {
        c.execute("DELETE FROM idempotency_keys", [])?;
        c.execute("UPDATE users SET display_name='Renamed'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    oneloop::retention::prune_transient_state(&db, support::now())
        .await
        .unwrap();
    let files = oneloop::files::FileService::new(db.clone(), 100 * 1024 * 1024, 0);
    assert_eq!(files.reconcile().await.unwrap().deletion_jobs_completed, 1);
    assert_eq!(files.reconcile().await.unwrap().deletion_jobs_completed, 0);
    let attribution: (String,String,String) = query_one(&db, "SELECT actor_user_id,actor_mcp_grant_id,(SELECT actor_name_snapshot FROM activity_projection WHERE entity_id='a' AND event_type='attachment.deleted') FROM activity_events WHERE entity_id='a' AND event_type='attachment.deleted'", []).await;
    assert_eq!(attribution, ("u".into(), "g".into(), "Original".into()));
}

/// Writes `bytes` where the original with a new storage key belongs.
fn stored_original(store: &oneloop::files::FileStore, bytes: &[u8]) -> (String, String) {
    let key = store.new_storage_key().unwrap();
    let path = store.layout().files().join(&key);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    (key, hex::encode(Sha256::digest(bytes)))
}

#[tokio::test]
async fn a_main_branch_database_upgrades_to_undo_with_its_deletions_intact() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    let connection = support::database_at_schema(&live, 3);
    let now = support::now();
    connection.execute_batch(&format!("INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('u','owner','Owner','hash',1,1,1);
        INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at) VALUES('s','u','h',{now},{now},{now},{expiry},{expiry});
        INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);
        INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at) VALUES('p','u',1,1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-01-01',0,1,1);
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('t','p','e',1,'PRJ-001','Task','planning',0,1,1);
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('gone','p','e',2,'PRJ-002','Gone','planning',1024,1,1);", expiry = now + 3600)).unwrap();
    let store = oneloop::files::FileStore::new(oneloop::db::DataLayout::new(&live));
    for (attachment, task, blob, state, bytes) in [
        ("kept", "t", "kept-blob", "available", b"kept".as_slice()),
        (
            "leaving",
            "t",
            "leaving-blob",
            "deleting",
            b"leaving".as_slice(),
        ),
        (
            "orphaned",
            "gone",
            "orphaned-blob",
            "available",
            b"orphaned".as_slice(),
        ),
    ] {
        let (key, checksum) = stored_original(&store, bytes);
        connection.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at) VALUES(?1,?2,?3,?4,'text/plain','available',1)",
            params![blob, key, checksum, bytes.len() as i64]).unwrap();
        connection.execute("INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,is_ephemeral,position,created_at,last_accessed_at,updated_at) VALUES(?1,'p',?2,?3,?4,'u',0,?5,1,1,1)",
            params![attachment, task, blob, format!("{attachment}.txt"), attachment.len() as i64]).unwrap();
        if state == "deleting" {
            // A deletion that main started and couldn't finish yet.
            connection
                .execute("UPDATE file_blobs SET state='deleting' WHERE id=?1", [blob])
                .unwrap();
            connection.execute("INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at,actor_user_id,actor_name,project_id,task_id,attachment_id,attachment_name)
                VALUES('job',?1,?2,'manual',1,1,'u','Owner','p','t',?3,'leaving.txt')", params![blob, key, attachment]).unwrap();
        }
    }
    // Deleted on main, long before the upgrade.
    connection
        .execute(
            "UPDATE tasks SET deleted_at=1,revision=2 WHERE id='gone'",
            [],
        )
        .unwrap();
    // Deleted on main just before the upgrade: main emptied the text at once.
    connection
        .execute(
            "INSERT INTO comments(id,project_id,task_id,author_id,root_id,content,created_at,deleted_at,revision)
             VALUES('emptied','p','t','u','emptied','',1,?1,2)",
            [now],
        )
        .unwrap();
    drop(connection);

    assert!(
        migrate(&live, None)
            .unwrap_err()
            .to_string()
            .contains("--backup-dir")
    );
    fs::create_dir(root.path().join("before")).unwrap();
    let upgrade = migrate(&live, Some(root.path().join("before"))).unwrap();
    assert_eq!(
        (upgrade.previous_version, upgrade.applied.clone()),
        (3, (4..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>())
    );
    assert_eq!(
        validate_backup(upgrade.backup_path.unwrap())
            .unwrap()
            .schema_version,
        3
    );

    let db = Db::open(&live).unwrap();
    let files = oneloop::files::FileService::new(db.clone(), 100 * 1024 * 1024, 0);
    oneloop::runtime::prepare_files(&files).await.unwrap();
    // The interrupted deletion finishes as main would have finished it, and
    // the files of the long-deleted task go.
    let (deleted_by, attachments): (String, Vec<String>) = db
        .run(|c| {
            let deleted_by = c.query_row(
                "SELECT actor_user_id FROM activity_events WHERE entity_id='leaving' AND event_type='attachment.deleted'",
                [],
                |r| r.get(0),
            )?;
            let mut statement = c.prepare("SELECT id FROM task_attachments ORDER BY id")?;
            let attachments = statement
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok((deleted_by, attachments))
        })
        .await
        .unwrap();
    assert_eq!(deleted_by, "u");
    assert_eq!(attachments, ["kept"]);

    // Undo works on the upgraded database.
    let owner = support::browser_actor("u", "Owner", "s", now);
    files
        .delete_attachment(&owner, "kept", 1, "delete-kept")
        .await
        .unwrap();
    let restored = files
        .restore_attachment(
            &owner,
            "kept",
            oneloop::files::AttachmentRestore {
                expected_revision: 2,
                idempotency_key: "undo-kept".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(restored.revision, 3);
    let restore_gone = oneloop::domain::DomainService::new(db.clone(), support::utc())
        .execute(
            &owner,
            command(
                oneloop::domain::DomainOperation::RestoreTask,
                serde_json::json!({"id":"gone"}),
                "undo-gone",
                Some(2),
            ),
        )
        .await;
    assert!(
        matches!(restore_gone, Err(AppError::PreconditionFailed(_))),
        "{restore_gone:?}"
    );
    let restore_emptied = oneloop::collaboration::CollaborationService::new(db.clone())
        .execute(
            &owner,
            collaboration_command(
                "discussion.comment.restore",
                serde_json::json!({"commentId":"emptied"}),
                "undo-emptied",
                Some(2),
            ),
        )
        .await;
    assert!(
        matches!(&restore_emptied, Err(AppError::PreconditionFailed(message)) if message.contains("text is gone")),
        "{restore_emptied:?}"
    );
}

#[tokio::test]
async fn an_upgraded_done_column_keeps_its_order_and_puts_new_completions_first() {
    use oneloop::domain::{
        BoardQuery, DomainOperation, DomainService, DoneOrder, TaskFilter, TaskStatus,
    };
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    let connection = support::database_at_schema(&live, 3);
    let now = support::now();
    connection.execute_batch(&format!("INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('u','owner','Owner','hash',1,1,1);
        INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at) VALUES('s','u','h',{now},{now},{now},{expiry},{expiry});
        INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);
        INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at) VALUES('p','u',1,1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-01-01',0,1,1);
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at) VALUES
            ('a','p','e',1,'PRJ-001','A','done',0,1,1,100),('b','p','e',2,'PRJ-002','B','done',1,1,1,100),
            ('c','p','e',3,'PRJ-003','C','done',2,1,1,50),('open','p','e',4,'PRJ-004','Open','planning',0,1,1,NULL);", expiry = now + 3600)).unwrap();
    drop(connection);
    fs::create_dir(root.path().join("before")).unwrap();
    migrate(&live, Some(root.path().join("before"))).unwrap();

    let db = Db::open(&live).unwrap();
    let service = DomainService::new(db.clone(), support::utc());
    let owner = support::browser_actor("u", "Owner", "s", now);
    let newest = async || {
        let query = BoardQuery {
            project_id: "p".into(),
            status: TaskStatus::Done,
            cursor: None,
            limit: Some(50),
            filter: TaskFilter {
                done_order: DoneOrder::Completed,
                ..Default::default()
            },
        };
        let page = service.board_page(&owner, query).await.unwrap();
        page.items
            .into_iter()
            .map(|task| task.id)
            .collect::<Vec<_>>()
    };
    // Before the upgrade, a tie fell back to the ID; it still does.
    assert_eq!(newest().await, ["b", "a", "c"]);
    service
        .execute(
            &owner,
            command(
                DomainOperation::MoveTask,
                serde_json::json!({"taskId":"open","status":"done"}),
                "finish-open",
                Some(1),
            ),
        )
        .await
        .unwrap();
    db.run(|c| {
        c.execute("UPDATE tasks SET completed_at=100 WHERE id='open'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(newest().await, ["open", "b", "a", "c"]);
}

/// The names and SQL of a database's indexes and triggers.
fn indexes_and_triggers(connection: &Connection) -> std::collections::BTreeMap<String, String> {
    connection
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND sql IS NOT NULL")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn a_schema_eight_database_puts_every_task_on_its_epics_track() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    let connection = support::database_at_schema(&live, 8);
    // Tasks in every status, with and without history, on epics with and
    // without an end date, and deleted tasks, epics and tracks.
    connection.execute_batch(r#"
        INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('u','owner','Owner','hash',1,1,1);
        INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);
        INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at) VALUES('p','u',1,1,1);
        INSERT INTO tracks(id,project_id,name,description,position,created_at,updated_at) VALUES
            ('web','p','Web','Old notes',0,1,1),('api','p','API','',1,1,1),('gone','p','Gone','',2,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,end_date,position,created_at,updated_at) VALUES
            ('dated','p','web','Dated','2026-01-01','2026-02-01',0,1,1),('open','p','api','Open','2026-01-01',NULL,0,1,1),
            ('gone-epic','p','gone','Gone','2026-01-01',NULL,0,1,1);
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at,completion_order,deleted_at) VALUES
            ('planning','p','dated',1,'PRJ-001','Planned','planning',0,1,1,NULL,0,NULL),
            ('progress','p','open',2,'PRJ-002','Started','in_progress',0,1,1,NULL,0,NULL),
            ('review','p','open',3,'PRJ-003','In review','in_review',0,1,1,NULL,0,NULL),
            ('done','p','dated',4,'PRJ-004','Finished','done',0,1,1,320,1,NULL),
            ('restarted','p','dated',5,'PRJ-005','Started again','in_progress',1024,1,1,NULL,0,NULL),
            ('reset','p','open',6,'PRJ-006','Done without work','done',1024,1,1,520,2,NULL),
            ('untracked','p','open',7,'PRJ-007','No history','in_review',1024,1,1,NULL,0,NULL),
            ('deleted','p','dated',8,'PRJ-008','Deleted','in_progress',2048,1,1,NULL,0,5),
            ('reopened','p','dated',10,'PRJ-010','Reopened','in_review',3072,1,1,NULL,0,NULL),
            ('gone-task','p','gone-epic',9,'PRJ-009','Long gone','planning',1024,1,1,NULL,0,2);
        UPDATE epics SET deleted_at=3 WHERE id='gone-epic';
        UPDATE tracks SET deleted_at=3 WHERE id='gone';
        INSERT INTO task_assignees(task_id,user_id,assigned_at) VALUES('progress','u',1);
        INSERT INTO comments(id,project_id,task_id,author_id,root_id,content,created_at) VALUES('comment','p','done','u','comment','Shipped',1);
        INSERT INTO task_checklist_items(id,task_id,position,title,created_at,updated_at) VALUES('item','review',0,'Check',1,1);
        INSERT INTO activity_events(id,entity_type,entity_id,event_type,field_key,before_json,after_json,created_at) VALUES
            ('a-planning-1','task','planning','task.moved','status','"planning"','"in_progress"',600),
            ('a-planning-2','task','planning','task.moved','status','"in_progress"','"planning"',610),
            ('a-progress-1','task','progress','task.moved','status','"planning"','"in_progress"',100),
            ('a-review-1','task','review','task.moved','status','"planned"','"in_review"',200),
            ('a-done-1','task','done','task.moved','status','"planning"','"in_progress"',300),
            ('a-done-2','task','done','task.moved','status','"in_progress"','"in_review"',310),
            ('a-done-3','task','done','task.moved','status','"in_review"','"done"',320),
            ('a-restarted-1','task','restarted','task.moved','status','"planning"','"in_progress"',400),
            ('a-restarted-2','task','restarted','task.moved','status','"in_progress"','"planning"',410),
            ('a-restarted-3','task','restarted','task.moved','status','"planning"','"in_progress"',420),
            ('a-reset-1','task','reset','task.moved','status','"planning"','"in_progress"',500),
            ('a-reset-2','task','reset','task.moved','status','"in_progress"','"planning"',500),
            ('a-reset-3','task','reset','task.moved','status','"planning"','"done"',520),
            ('a-deleted-1','task','deleted','task.moved','status','"planning"','"in_progress"',4),
            ('a-reopened-1','task','reopened','task.moved','status','"planning"','"done"',700),
            ('a-reopened-2','task','reopened','task.moved','status','"done"','"in_progress"',710),
            ('a-reopened-3','task','reopened','task.moved','status','"in_progress"','"in_review"',720);
    "#).unwrap();
    let task_columns = "SELECT json_array(id,project_id,epic_id,task_number,task_key,title,description,status,position,deadline,
        created_by,created_at,updated_at,completed_at,completion_order,deleted_at,revision,search_title,checklist_version)
        FROM tasks ORDER BY id";
    let rows = |connection: &Connection, sql: &str| {
        connection
            .prepare(sql)
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let tasks_before = rows(&connection, task_columns);
    let tracks_before = rows(
        &connection,
        "SELECT json_array(id,project_id,name,position,deleted_at,revision) FROM tracks ORDER BY id",
    );
    let children = "SELECT json_array((SELECT COUNT(*) FROM task_assignees),(SELECT COUNT(*) FROM comments),(SELECT COUNT(*) FROM task_checklist_items))";
    let children_before = rows(&connection, children);
    let mut schema_before = indexes_and_triggers(&connection);
    drop(connection);

    fs::create_dir(root.path().join("before")).unwrap();
    let upgrade = migrate(&live, Some(root.path().join("before"))).unwrap();
    assert_eq!((upgrade.previous_version, upgrade.applied), (8, vec![9]));

    let connection = Connection::open(live.join("oneloop.sqlite3")).unwrap();
    // Every row is kept as it was, and each task is on its epic's track.
    assert_eq!(rows(&connection, task_columns), tasks_before);
    assert_eq!(
        rows(
            &connection,
            "SELECT json_array(id,project_id,name,position,deleted_at,revision) FROM tracks ORDER BY id"
        ),
        tracks_before
    );
    assert_eq!(rows(&connection, children), children_before);
    assert_eq!(
        rows(
            &connection,
            "SELECT json_array(id,track_id,started_at) FROM tasks ORDER BY id"
        ),
        [
            r#"["deleted","web",4]"#,
            r#"["done","web",300]"#,
            r#"["gone-task","gone",null]"#,
            r#"["planning","web",null]"#,
            r#"["progress","api",100]"#,
            r#"["reopened","web",710]"#,
            r#"["reset","api",null]"#,
            r#"["restarted","web",420]"#,
            r#"["review","api",200]"#,
            r#"["untracked","api",null]"#,
        ]
    );
    let description: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tracks') WHERE name='description')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!description, "tracks have no description");
    let violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    // Every index and trigger is back as it was; the rule that a task's epic
    // is in its project gives way to the rules of tracks.
    let mut schema_after = indexes_and_triggers(&connection);
    for replaced in [
        "tasks_require_epic_in_project_insert",
        "tasks_require_epic_in_project_update",
    ] {
        assert!(schema_before.remove(replaced).is_some());
    }
    for added in [
        "tasks_project_track_status_idx",
        "tasks_require_track_in_project_insert",
        "tasks_require_track_in_project_update",
        "tasks_require_epic_on_track_insert",
        "tasks_require_epic_on_track_update",
    ] {
        assert!(schema_after.remove(added).is_some(), "{added}");
    }
    assert_eq!(schema_after, schema_before);
}

#[tokio::test]
async fn a_task_stays_on_a_track_of_its_project_with_its_epic_on_that_track() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    let refusals = db
        .run(|connection| {
            connection.execute_batch("
                INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1),('q','Other','OTH',1,1);
                INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('a','p','A',0,1,1),('b','p','B',1,1,1),('elsewhere','q','Q',0,1,1);
                INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('on-a','p','a','On A','2026-01-01',0,1,1);
                INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES
                    ('in-epic','p','a','on-a',1,'PRJ-001','In an epic','planning',0,1,1),
                    ('no-epic','p','b',NULL,2,'PRJ-002','No epic','planning',1024,1,1);")?;
            let refused = |sql: &str| match connection.execute_batch(sql) {
                Err(rusqlite::Error::SqliteFailure(_, Some(message))) => message,
                other => panic!("{sql}: {other:?}"),
            };
            Ok([
                refused("INSERT INTO tasks(id,project_id,track_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('away','p','elsewhere',3,'PRJ-003','Away','planning',2048,1,1)"),
                refused("INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('apart','p','b','on-a',3,'PRJ-003','Apart','planning',2048,1,1)"),
                refused("UPDATE tasks SET track_id='b' WHERE id='in-epic'"),
                refused("UPDATE tasks SET epic_id='on-a' WHERE id='no-epic'"),
                // A deleted task may keep a deleted track, but can't come back on it.
                refused("UPDATE tasks SET deleted_at=1 WHERE id='no-epic'; UPDATE tracks SET deleted_at=1 WHERE id='b';
                    UPDATE tasks SET deleted_at=NULL WHERE id='no-epic'"),
            ])
        })
        .await
        .unwrap();
    let (track, epic) = (
        "task track must belong to the same project",
        "task epic must be on the task track",
    );
    assert_eq!(refusals, [track, epic, epic, epic, track]);
}

#[tokio::test]
async fn a_failed_transaction_rolls_back() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    let failure: Result<(), AppError> = db
        .transaction(|transaction| {
            transaction.execute(
                "INSERT INTO users
                 (id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                 VALUES ('user-1','person','Person','hash',1,1,1)",
                [],
            )?;
            Err(AppError::Conflict("force rollback".to_owned()))
        })
        .await;
    assert!(failure.is_err());
    let count: i64 = query_one(&db, "SELECT COUNT(*) FROM users", []).await;
    assert_eq!(count, 0);
}

#[test]
fn schema_versions_and_migration_checksums_are_locked() {
    let newer_root = support::scratch_dir();
    initialize(&newer_root);
    let connection = Connection::open(newer_root.path().join("oneloop.sqlite3")).unwrap();
    let newer = CURRENT_SCHEMA_VERSION + 1;
    connection
        .execute(
            "INSERT INTO schema_migrations(version,name,checksum,applied_at)
             VALUES (?1,'future','future',1)",
            [newer],
        )
        .unwrap();
    connection
        .pragma_update(None, "user_version", newer)
        .unwrap();
    drop(connection);
    let error = Db::open(newer_root.path())
        .err()
        .expect("newer schema rejected");
    assert!(error.to_string().contains("newer"));

    let changed_root = support::scratch_dir();
    initialize(&changed_root);
    let connection = Connection::open(changed_root.path().join("oneloop.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE schema_migrations SET checksum='changed' WHERE version=1",
            [],
        )
        .unwrap();
    drop(connection);
    let error = Db::open(changed_root.path())
        .err()
        .expect("changed migration rejected");
    assert!(error.to_string().contains("changed after it was applied"));
}

#[test]
fn upgrading_a_previous_schema_requires_and_validates_a_complete_backup() {
    let root = support::scratch_dir();
    let data = root.path().join("live");
    let backups = root.path().join("backups");
    fs::create_dir(&data).unwrap();
    fs::create_dir(&backups).unwrap();
    let sql = include_str!("../../../src/db/legacy/0001_initial.sql");
    let connection = Connection::open(data.join("oneloop.sqlite3")).unwrap();
    connection.execute_batch(sql).unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT;").unwrap();
    connection
        .execute(
            "INSERT INTO schema_migrations VALUES(1,'initial',?1,1)",
            [hex::encode(Sha256::digest(sql.as_bytes()))],
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    connection
        .execute(
            "INSERT INTO app_metadata VALUES('upgrade-test','preserved',1)",
            [],
        )
        .unwrap();
    connection.execute(
        "INSERT INTO activity_events(id,entity_type,entity_id,event_type,metadata_json,created_at)
         VALUES('private-audit','pool_item','pool','pool_item.created',?1,1)",
        [r#"{"visibility":"owner","ownerUserId":"alice"}"#],
    ).unwrap();
    drop(connection);

    assert!(
        migrate(&data, None)
            .unwrap_err()
            .to_string()
            .contains("--backup-dir")
    );
    let outcome = migrate(&data, Some(backups)).unwrap();
    assert_eq!(outcome.previous_version, 1);
    assert_eq!(outcome.current_version, CURRENT_SCHEMA_VERSION);
    let backup = outcome.backup_path.expect("pre-upgrade snapshot");
    assert_eq!(validate_backup(&backup).unwrap().schema_version, 1);
    let before = Connection::open(backup.join("data/oneloop.sqlite3")).unwrap();
    assert_eq!(
        before
            .pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        1
    );
    let after = Connection::open(data.join("oneloop.sqlite3")).unwrap();
    let marker: String = after
        .query_row(
            "SELECT value FROM app_metadata WHERE key='upgrade-test'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let raw = |connection: &Connection| {
        connection.query_row(
        "SELECT visibility,private_owner_user_id,metadata_json FROM activity_events WHERE id='private-audit'", [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?)),
    ).unwrap()
    };
    let original = raw(&before);
    let repaired = raw(&after);
    assert_eq!(original.0, "public");
    assert_eq!(original.1, None);
    assert_eq!(repaired.0, "owner");
    assert_eq!(repaired.1.as_deref(), Some("alice"));
    assert_eq!(original.2, repaired.2, "repair must preserve raw metadata");
    assert_eq!(marker, "preserved");
    assert!(Db::check(&data).is_ok());
}

#[test]
fn schema_four_repairs_only_historical_assignee_projections() {
    let root = support::scratch_dir();
    let data = root.path().join("live");
    let backups = root.path().join("backups");
    fs::create_dir(&data).unwrap();
    fs::create_dir(&backups).unwrap();
    let database = data.join("oneloop.sqlite3");
    let connection = Connection::open(&database).unwrap();
    let scripts = [
        (
            1_i64,
            "initial",
            include_str!("../../../src/db/legacy/0001_initial.sql"),
        ),
        (
            2,
            "mcp_authorization",
            include_str!("../../../src/db/legacy/0002_mcp_authorization.sql"),
        ),
        (
            3,
            "task_summary_index",
            include_str!("../../../src/db/legacy/0003_task_summary_index.sql"),
        ),
    ];
    connection.execute_batch(scripts[0].2).unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT;").unwrap();
    for (version, name, sql) in scripts {
        if version > 1 {
            connection.execute_batch(sql).unwrap();
        }
        connection
            .execute(
                "INSERT INTO schema_migrations VALUES(?1,?2,?3,1)",
                params![version, name, hex::encode(Sha256::digest(sql.as_bytes()))],
            )
            .unwrap();
    }
    connection.pragma_update(None, "user_version", 3).unwrap();
    connection
        .execute_batch(
            "INSERT INTO users
             (id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
             VALUES ('u1','manager','Manager','hash',1,1,1),
                    ('u2','member','Member','hash',1,1,1);
             INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at)
             VALUES ('p1','Project','ONE','u1',1,1);
             INSERT INTO project_prefixes(prefix,project_id,reserved_at) VALUES ('ONE','p1',1);
             INSERT INTO project_sequences(project_id,next_task_number) VALUES ('p1',2);
             INSERT INTO tracks(id,project_id,name,position,created_by,created_at,updated_at)
             VALUES ('tr1','p1','Track',0,'u1',1,1);
             INSERT INTO epics(id,project_id,track_id,title,start_date,state,position,created_by,created_at,updated_at)
             VALUES ('ep1','p1','tr1','Epic','2026-01-01','active',0,'u1',1,1);
             INSERT INTO tasks
             (id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
             VALUES ('task1','p1','ep1',1,'ONE-001','Task','planned',0,'u1',1,1);",
        )
        .unwrap();
    let raw = [
        (
            "e1",
            "task.assignee.added",
            Some("assignee:u2"),
            None,
            Some("\"u2\""),
            "u1",
            100_i64,
        ),
        (
            "e2",
            "task.assignee.removed",
            Some("assignee:u2"),
            Some("\"u2\""),
            None,
            "u1",
            101,
        ),
        ("e3", "task.lifecycle", None, None, None, "u1", 102),
        (
            "e4",
            "task.assignee.added",
            Some("assignee:u2"),
            None,
            Some("\"u2\""),
            "u1",
            103,
        ),
        (
            "e5",
            "task.assignee.removed",
            Some("assignee:u2"),
            Some("\"u2\""),
            None,
            "u2",
            104,
        ),
        // Unknown future vocabulary must survive this versioned repair.
        (
            "unknown",
            "task.assignee.transferred",
            Some("assignee:u3"),
            Some("\"u0\""),
            Some("\"u3\""),
            "u1",
            105,
        ),
        // Known vocabulary with a value that disagrees with the field key is
        // malformed, not canonical legacy data, and must also be preserved.
        (
            "mismatch",
            "task.assignee.added",
            Some("assignee:u4"),
            None,
            Some("\"u3\""),
            "u1",
            106,
        ),
        (
            "window-1",
            "task.assignee.added",
            Some("assignee:u5"),
            None,
            Some("\"u5\""),
            "u1",
            200,
        ),
        (
            "window-2",
            "task.assignee.removed",
            Some("assignee:u5"),
            Some("\"u5\""),
            None,
            "u1",
            500,
        ),
        (
            "window-3",
            "task.assignee.added",
            Some("assignee:u5"),
            None,
            Some("\"u5\""),
            "u1",
            501,
        ),
    ];
    for (id, event_type, field_key, before, after, actor, created_at) in raw {
        connection
            .execute(
                "INSERT INTO activity_events
                 (id,project_id,entity_type,entity_id,task_id,actor_user_id,event_type,
                  field_key,before_json,after_json,metadata_json,entity_revision,created_at)
                 VALUES (?1,'p1','task','task1','task1',?2,?3,?4,?5,?6,'{}',1,?7)",
                params![id, actor, event_type, field_key, before, after, created_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO activity_projection
                 (id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_name_snapshot,
                  event_type,field_key,before_json,after_json,metadata_json,visibility,
                  entity_revision,started_at,latest_at,is_open,is_hidden)
                 VALUES (?1,'p1','task','task1','task1',?2,?3,?4,?5,?6,?7,'{}','public',1,?8,?8,0,0)",
                params![
                    id,
                    actor,
                    if actor == "u1" { "Manager" } else { "Member" },
                    event_type,
                    field_key,
                    before,
                    after,
                    created_at,
                ],
            )
            .unwrap();
    }
    // Model a structured future event whose projection is still open. The
    // older lifecycle event in this history must not close it while replaying
    // only the canonical assignee field.
    connection
        .execute(
            "UPDATE activity_projection SET is_open=1 WHERE id='unknown'",
            [],
        )
        .unwrap();
    drop(connection);

    let outcome = migrate(&data, Some(backups)).unwrap();
    assert_eq!(outcome.previous_version, 3);
    assert_eq!(
        outcome.applied,
        (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
    );
    let connection = Connection::open(database).unwrap();
    let repaired = connection
        .prepare(
            "SELECT id,before_json,after_json,started_at,latest_at,is_open,is_hidden
             FROM activity_projection WHERE field_key='assignee:u2' ORDER BY started_at,id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        repaired,
        vec![
            (
                "e1".into(),
                Some("null".into()),
                Some("null".into()),
                100,
                101,
                false,
                true
            ),
            (
                "e4".into(),
                Some("null".into()),
                Some("\"u2\"".into()),
                103,
                103,
                false,
                false
            ),
            (
                "e5".into(),
                Some("\"u2\"".into()),
                Some("null".into()),
                104,
                104,
                true,
                false
            ),
        ]
    );
    let unchanged_raw: (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT before_json,after_json FROM activity_events WHERE id='e1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(unchanged_raw, (None, Some("\"u2\"".into())));
    let lifecycle_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM activity_projection WHERE id='e3' AND event_type='task.lifecycle'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(lifecycle_count, 1);
    let fixed_window = connection
        .prepare(
            "SELECT id,started_at,latest_at,is_open,is_hidden
             FROM activity_projection WHERE field_key='assignee:u5' ORDER BY started_at,id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        fixed_window,
        vec![
            ("window-1".into(), 200, 500, false, true),
            ("window-3".into(), 501, 501, true, false),
        ]
    );
    let preserved_noncanonical = connection
        .prepare(
            "SELECT id,event_type,field_key,before_json,after_json,started_at,latest_at,is_open,is_hidden
             FROM activity_projection WHERE id IN ('unknown','mismatch') ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, bool>(7)?,
                row.get::<_, bool>(8)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        preserved_noncanonical,
        vec![
            (
                "mismatch".into(),
                "task.assignee.added".into(),
                Some("assignee:u4".into()),
                None,
                Some("\"u3\"".into()),
                106,
                106,
                false,
                false,
            ),
            (
                "unknown".into(),
                "task.assignee.transferred".into(),
                Some("assignee:u3".into()),
                Some("\"u0\"".into()),
                Some("\"u3\"".into()),
                105,
                105,
                true,
                false,
            ),
        ]
    );
}

#[test]
fn migration_requires_exclusive_instance_access() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    let error = migrate(root.path(), None).unwrap_err().to_string();
    assert!(
        error.contains("another oneloop server or command is using"),
        "{error}"
    );
    drop(db);
    let outcome = migrate(root.path(), None).expect("exclusive access restored");
    assert!(outcome.applied.is_empty());
    assert!(outcome.backup_path.is_none());
}

#[test]
fn failed_upgrade_reports_verified_backup_and_last_committed_schema() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    let mut connection = Connection::open(live.join("oneloop.sqlite3")).unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,checksum TEXT,applied_at INTEGER)").unwrap();
    for (version, name, sql) in [
        (
            1,
            "initial",
            include_str!("../../../src/db/legacy/0001_initial.sql"),
        ),
        (
            2,
            "mcp_authorization",
            include_str!("../../../src/db/legacy/0002_mcp_authorization.sql"),
        ),
    ] {
        let tx = connection.transaction().unwrap();
        tx.execute_batch(sql).unwrap();
        tx.execute(
            "INSERT INTO schema_migrations VALUES(?1,?2,?3,1)",
            params![version, name, hex::encode(Sha256::digest(sql.as_bytes()))],
        )
        .unwrap();
        tx.pragma_update(None, "user_version", version).unwrap();
        tx.commit().unwrap();
    }
    // A valid extra index makes migration 3 fail without making the backup invalid.
    connection
        .execute_batch("CREATE INDEX tasks_project_summary_idx ON tasks(title)")
        .unwrap();
    drop(connection);
    let error = migrate(&live, Some(root.path().to_owned()))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("migration 3 (task_summary_index) failed"),
        "{error}"
    );
    assert!(error.contains("database left at schema 2"), "{error}");
    let backup = fs::read_dir(root.path())
        .unwrap()
        .map(|p| p.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("oneloop-pre-migration")
        })
        .unwrap();
    assert!(error.contains(&backup.display().to_string()));
    assert_eq!(validate_backup(backup).unwrap().schema_version, 2);
}

#[tokio::test]
async fn deletion_foreign_keys_use_indexes_or_documented_exceptions() {
    let root = support::scratch_dir();
    let db = initialize(&root);
    db.run(|connection| {
        // These scans occur once per project deletion, rather than once per task.
        let project_scans = ["project_prefixes", "comments", "task_blocks", "activity_projection",
            "mcp_grant_projects", "task_attachments", "upload_reservations"];
        // Users are deactivated, never hard-deleted; attribution is intentionally retained.
        let user_scans = [("projects","created_by"),("tracks","created_by"),("milestones","created_by"),
            ("epics","created_by"),("tasks","created_by"),("task_assignees","assigned_by"),
            ("pool_items","owner_user_id"),("activity_events","actor_user_id"),("activity_projection","actor_user_id"),
            ("security_events","actor_user_id"),("notification_events","actor_user_id"),
            ("upload_reservations","user_id"),("idempotency_keys","actor_user_id"),
            ("oauth_authorization_requests","user_id"),("oauth_authorization_codes","user_id"),
            ("knowledge_sources","created_by"),("knowledge_sources","updated_by")];
        // Short-lived reservations/transfers/authorization rows are bounded by expiry.
        let transient_scans = [("upload_reservations","task_id"),("mcp_file_transfers","task_id"),
            ("mcp_file_transfers","attachment_id"),("mcp_file_transfers","grant_id"),
            ("oauth_authorization_requests","client_id"),("oauth_authorization_codes","client_id"),
            ("mcp_tokens","rotated_to_id")];
        let tables = connection.prepare("SELECT name FROM sqlite_schema WHERE type='table'")?
            .query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>,_>>()?;
        for table in tables {
            let fks = connection.prepare("SELECT \"table\",\"from\" FROM pragma_foreign_key_list(?1) WHERE on_delete IN ('CASCADE','SET NULL')")?
                .query_map([&table], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            for (parent, column) in fks {
                let mut plan = connection.prepare(&format!("EXPLAIN QUERY PLAN SELECT rowid FROM \"{table}\" WHERE \"{column}\"=?1"))?;
                let plans = plan.query_map(["probe"],|r|r.get::<_,String>(3))?.collect::<Result<Vec<_>,_>>()?;
                if plans.iter().any(|plan| plan.contains("SEARCH")) { continue; }
                let allowed = (parent == "projects" && column == "project_id" && project_scans.contains(&table.as_str()))
                    || (parent == "users" && user_scans.contains(&(table.as_str(),column.as_str())))
                    || transient_scans.contains(&(table.as_str(),column.as_str()));
                assert!(allowed, "unindexed cascading FK {table}.{column} -> {parent}: {plans:?}");
            }
        }
        Ok(())
    }).await.unwrap();
}

#[test]
fn account_command_announces_wait_for_migration_lock() {
    use std::process::{Command, Stdio};
    let root = support::scratch_dir();
    let live = root.path().join("live");
    migrate(&live, None).unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(live.join(".oneloop-instance.lock"))
        .unwrap();
    lock.lock().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_oneloop"))
        .env("ONELOOP_DATA_DIR", &live)
        .args(["user", "passwd", "absent", "--password-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"abcde\n").unwrap();
    // The command announces the wait before blocking on the lock; end of file
    // would mean it exited without waiting.
    let mut stderr = std::io::BufReader::new(child.stderr.take().unwrap());
    let mut log = String::new();
    while !log.contains("waiting for exclusive maintenance (db migrate)") {
        assert!(
            std::io::BufRead::read_line(&mut stderr, &mut log).unwrap() > 0,
            "exited without announcing the wait: {log}"
        );
    }
    assert!(child.try_wait().unwrap().is_none(), "{log}");
    drop(lock);
    // The account does not exist, so the command exits after opening the DB.
    let status = child.wait().unwrap();
    assert!(!status.success());
}
