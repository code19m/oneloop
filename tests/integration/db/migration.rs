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
use crate::support;

#[tokio::test]
async fn pending_deletion_provenance_survives_schema_upgrade_backup_and_restore() {
    let root = support::scratch_dir();
    let live = root.path().join("live");
    fs::create_dir(&live).unwrap();
    let connection = Connection::open(live.join("oneloop.sqlite3")).unwrap();
    // This predecessor database cannot be opened by the current Db yet, but
    // its stored triggers still need the server's Unicode lower-case function.
    connection
        .create_scalar_function(
            "oneloop_lower",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_UTF8
                | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
            |context| Ok(context.get::<String>(0)?.to_lowercase()),
        )
        .unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)").unwrap();
    for (version, name, sql) in [
        (
            1,
            "initial",
            include_str!("../../../migrations/0001_initial.sql"),
        ),
        (
            2,
            "knowledge",
            include_str!("../../../migrations/0002_knowledge.sql"),
        ),
    ] {
        connection.execute_batch(sql).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations VALUES(?1,?2,?3,1)",
                params![version, name, hex::encode(Sha256::digest(sql.as_bytes()))],
            )
            .unwrap();
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
    }
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
    assert_eq!(upgrade.applied, vec![3]);
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
    let attribution: (String,String,String) = db.run(|c| Ok(c.query_row(
        "SELECT actor_user_id,actor_mcp_grant_id,(SELECT actor_name_snapshot FROM activity_projection WHERE entity_id='a' AND event_type='attachment.deleted') FROM activity_events WHERE entity_id='a' AND event_type='attachment.deleted'",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?)).await.unwrap();
    assert_eq!(attribution, ("u".into(), "g".into(), "Original".into()));
}

#[tokio::test]
async fn migration_initializes_once_and_transactions_rollback() {
    let root = support::scratch_dir();
    let db = initialize(&root);

    let tables = db
        .run(|connection| {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")?;
            let names = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(names)
        })
        .await
        .unwrap();
    for expected in [
        "users",
        "projects",
        "tasks",
        "comments",
        "activity_events",
        "notification_recipients",
        "outbox_messages",
        "sessions",
        "mcp_grants",
        "oauth_registration_attempts",
        "file_blobs",
        "idempotency_keys",
    ] {
        assert!(
            tables.iter().any(|table| table == expected),
            "missing {expected}"
        );
    }

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
    let count: i64 = db
        .run(|connection| {
            connection
                .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
                .map_err(AppError::from)
        })
        .await
        .unwrap();
    assert_eq!(count, 0);

    drop(db);
    let second = migrate(root.path(), None).expect("already current");
    assert!(second.applied.is_empty());
    assert!(second.backup_path.is_none());
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
    let error = migrate(root.path(), None).unwrap_err();
    assert!(error.to_string().contains("stop the oneloop server"));
    drop(db);
    let outcome = migrate(root.path(), None).expect("exclusive access restored");
    assert!(outcome.applied.is_empty());
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
        for (table,column) in [("activity_projection","task_id"),("notification_events","task_id"),
            ("notification_events","comment_id"),("notification_events","block_id")] {
            let plans = connection.prepare(&format!("EXPLAIN QUERY PLAN UPDATE {table} SET {column}=NULL WHERE {column}=?1"))?
                .query_map(["probe"],|r|r.get::<_,String>(3))?.collect::<Result<Vec<_>,_>>()?;
            assert!(plans.iter().any(|plan| plan.contains("SEARCH") && plan.contains("_fk_idx")), "{table}.{column}: {plans:?}");
        }
        let plan:String=connection.query_row("EXPLAIN QUERY PLAN SELECT id FROM notification_events WHERE project_id=?1 AND actor_user_id=?2 AND created_at>?3",params!["project","actor",0],|r|r.get(3))?;
        assert!(plan.contains("notification_broadcast_lookup_idx"), "{plan}");
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
