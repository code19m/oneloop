use super::*;
use serde_json::Value;

#[test]
fn parent_rebuild_preserves_children_and_failed_rebuild_rolls_back() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE parent(id INTEGER PRIMARY KEY);
        CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
        INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);").unwrap();
    ensure_migration_table(&connection).unwrap();
    let mut migration = Migration {
        version: 1,
        name: "rebuild",
        foreign_keys_off: true,
        hook_revision: "",
        hook: None,
        sql: "CREATE TABLE parent_new(id INTEGER PRIMARY KEY, extra TEXT);
              INSERT INTO parent_new(id) SELECT id FROM parent;
              DROP TABLE parent; ALTER TABLE parent_new RENAME TO parent;",
    };
    apply_migration(&mut connection, &migration).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM child", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    migration.version = 2;
    migration.name = "bad_rebuild";
    migration.sql = "DELETE FROM parent;";
    assert!(
        apply_migration(&mut connection, &migration)
            .unwrap_err()
            .to_string()
            .contains("foreign-key check failed")
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM parent", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(inspect_schema_version(&connection).unwrap(), 1);
    assert!(
        connection
            .pragma_query_value::<bool, _>(None, "foreign_keys", |r| r.get(0))
            .unwrap()
    );
    migration.sql = "invalid sql";
    assert!(apply_migration(&mut connection, &migration).is_err());
    assert!(
        connection
            .pragma_query_value::<bool, _>(None, "foreign_keys", |r| r.get(0))
            .unwrap()
    );
}

#[test]
fn reorder_projection_migration_preserves_raw_events_and_other_field_chains() {
    let mut c = Connection::open_in_memory().unwrap();
    crate::db::configure_connection(&c).unwrap();
    ensure_migration_table(&c).unwrap();
    for migration in legacy::MIGRATIONS.iter().filter(|m| m.version < 15) {
        apply_migration(&mut c, migration).unwrap();
    }
    for (id, entity, event, field) in [
        ("task-position", "task", "task.moved", "position"),
        ("track-position", "track", "track.reordered", "position"),
        ("task-status", "task", "task.moved", "status"),
        ("file-order", "task", "attachment.reordered", "attachments"),
    ] {
        c.execute("INSERT INTO activity_events(id,entity_type,entity_id,event_type,field_key,before_json,after_json,created_at) VALUES(?1,?2,'entity',?3,?4,'0','1',1)",params![id,entity,event,field]).unwrap();
        c.execute("INSERT INTO activity_projection(id,entity_type,entity_id,actor_name_snapshot,event_type,field_key,before_json,after_json,started_at,latest_at,is_open) VALUES(?1,?2,'entity','Actor',?3,?4,'0','1',1,1,1)",params![id,entity,event,field]).unwrap();
    }
    c.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-01-01',0,1,1);
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('t','p','e',1,'ONE-001','ПРИВЕТ İSTANBUL','planned',0,1,1);").unwrap();
    apply_migration(
        &mut c,
        legacy::MIGRATIONS.iter().find(|m| m.version == 15).unwrap(),
    )
    .unwrap();
    assert_eq!(
        c.query_row("SELECT search_title FROM tasks WHERE id='t'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "ПРИВЕТ İSTANBUL".to_lowercase()
    );
    c.execute("UPDATE tasks SET title='Renamed 🦀' WHERE id='t'", [])
        .unwrap();
    assert_eq!(
        c.query_row("SELECT search_title FROM tasks WHERE id='t'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "renamed 🦀"
    );
    for (id, hidden, open) in [
        ("task-position", true, false),
        ("track-position", true, false),
        ("task-status", false, true),
        ("file-order", false, true),
    ] {
        assert_eq!(
            c.query_row(
                "SELECT is_hidden,is_open FROM activity_projection WHERE id=?1",
                [id],
                |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?))
            )
            .unwrap(),
            (hidden, open)
        );
        assert_eq!(
            c.query_row(
                "SELECT before_json,after_json FROM activity_events WHERE id=?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("0".into(), "1".into())
        );
    }
}

#[test]
fn hook_revisions_change_new_checksums_without_rewriting_history() {
    for migration in legacy::MIGRATIONS
        .iter()
        .filter(|migration| migration.version <= 11)
    {
        assert_eq!(
            checksum(migration),
            hex::encode(Sha256::digest(migration.sql.as_bytes()))
        );
    }
    let mut migration = Migration {
        version: 13,
        name: "hook",
        sql: "SELECT 1;",
        hook_revision: "v1",
        hook: Some(legacy::backfill_assignee_activity_projection_v4),
        foreign_keys_off: false,
    };
    let original = checksum(&migration);
    migration.hook_revision = "v2";
    assert_ne!(original, checksum(&migration));
}

#[test]
fn schema_four_hook_has_golden_projection_rows() {
    let mut c = Connection::open_in_memory().unwrap();
    crate::db::configure_connection(&c).unwrap();
    ensure_migration_table(&c).unwrap();
    for migration in legacy::MIGRATIONS.iter().filter(|m| m.version < 4) {
        apply_migration(&mut c, migration).unwrap();
    }
    c.execute_batch(r#"
        INSERT INTO activity_events(id,entity_type,entity_id,event_type,field_key,before_json,after_json,created_at)
        VALUES('a','task','task','task.assignee.added','assignee:u',NULL,'"u"',100),
              ('b','task','task','task.assignee.removed','assignee:u','"u"',NULL,101),
              ('other','epic','epic','epic.updated','title','"Before"','"After"',90);
        INSERT INTO activity_projection(id,entity_type,entity_id,actor_name_snapshot,event_type,field_key,before_json,after_json,started_at,latest_at,is_open)
        VALUES('a','task','task','Historical actor','task.assignee.added','assignee:u',NULL,'"u"',100,100,0),
              ('b','task','task','Historical actor','task.assignee.removed','assignee:u','"u"',NULL,101,101,0),
              ('other','epic','epic','Other actor','epic.updated','title','"Before"','"After"',90,90,0);
    "#).unwrap();
    apply_migration(&mut c, &legacy::MIGRATIONS[3]).unwrap();
    let rows = c.prepare("SELECT json_array(id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_name_snapshot,event_type,field_key,before_json,after_json,metadata_json,visibility,private_owner_user_id,entity_revision,started_at,latest_at,is_open,is_hidden) FROM activity_projection ORDER BY id").unwrap()
        .query_map([], |row| row.get::<_,String>(0)).unwrap().map(|r| serde_json::from_str::<Value>(&r.unwrap()).unwrap()).collect::<Vec<_>>();
    assert_eq!(
        rows,
        vec![
            serde_json::json!([
                "a",
                null,
                "task",
                "task",
                null,
                null,
                "Historical actor",
                "task.assignee.removed",
                "assignee:u",
                "null",
                "null",
                "{}",
                "public",
                null,
                null,
                100,
                101,
                1,
                1
            ]),
            serde_json::json!([
                "other",
                null,
                "epic",
                "epic",
                null,
                null,
                "Other actor",
                "epic.updated",
                "title",
                "\"Before\"",
                "\"After\"",
                "{}",
                "public",
                null,
                null,
                90,
                90,
                0,
                0
            ]),
        ]
    );
}

fn schema_snapshot(c: &Connection) -> Vec<String> {
    let mut result = Vec::new();
    let mut statement = c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").unwrap();
    let objects = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for (kind, name, table, sql) in objects {
        let normalized = sql
            .unwrap_or_default()
            .replace('"', "")
            .split_whitespace()
            .collect::<String>();
        result.push(format!("{kind}:{name}:{table}:{normalized}"));
        if kind == "table" {
            for pragma in ["table_xinfo", "foreign_key_list", "index_list"] {
                let mut statement = c.prepare(&format!("PRAGMA {pragma}('{name}')")).unwrap();
                let count = statement.column_count();
                let mut rows = statement
                    .query_map([], |row| {
                        let start = usize::from(pragma == "index_list");
                        Ok((start..count)
                            .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                            .collect::<Vec<_>>()
                            .join("|"))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                rows.sort();
                result.push(format!("{name}:{pragma}:{rows:?}"));
            }
        } else if kind == "index" {
            let mut statement = c.prepare(&format!("PRAGMA index_xinfo('{name}')")).unwrap();
            let count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    Ok((0..count)
                        .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                        .collect::<Vec<_>>())
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            result.push(format!("{name}:index_xinfo:{rows:?}"));
        }
    }
    result
}

#[test]
fn every_legacy_prefix_converts_atomically_to_equivalent_baseline() {
    let mut fresh = Connection::open_in_memory().unwrap();
    crate::db::configure_connection(&fresh).unwrap();
    ensure_migration_table(&fresh).unwrap();
    apply_migration(&mut fresh, &MIGRATIONS[0]).unwrap();
    let expected = schema_snapshot(&fresh);
    for version in 1..=legacy::MIGRATIONS.len() {
        let mut old = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&old).unwrap();
        ensure_migration_table(&old).unwrap();
        for step in legacy::MIGRATIONS.iter().take(version) {
            apply_migration(&mut old, step).unwrap();
        }
        old.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
            INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-01-01',0,1,1);
            INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('t','p','e',1,'ONE-001','Title','planned',0,1,1);
            INSERT INTO activity_events(id,entity_type,entity_id,event_type,field_key,before_json,after_json,created_at) VALUES('status','task','t','task.moved','status','\"planned\"','\"done\"',1);").unwrap();
        assert!(is_legacy_schema(&old).unwrap());
        assert!(
            ensure_current_schema(&old)
                .unwrap_err()
                .to_string()
                .contains("run `oneloop db migrate")
        );
        convert_legacy(&mut old, version as i64).unwrap();
        // Conversion ends at the baseline; later migrations then run as usual.
        assert_eq!(inspect_schema_version(&old).unwrap(), MIGRATIONS[0].version);
        assert_eq!(schema_snapshot(&old), expected, "legacy version {version}");
        assert_eq!(
            old.query_row("SELECT status FROM tasks", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "planning"
        );
        assert_eq!(
            old.query_row("SELECT state FROM epics", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "planning"
        );
        assert_eq!(
            old.query_row(
                "SELECT before_json FROM activity_events WHERE id='status'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "\"planned\""
        );
        assert_eq!(
            old.query_row("SELECT count(*) FROM schema_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn legacy_recognition_rejects_missing_renamed_or_changed_steps() {
    for corruption in [
        "DELETE FROM schema_migrations WHERE version=2",
        "UPDATE schema_migrations SET name='unknown' WHERE version=2",
        "UPDATE schema_migrations SET checksum='changed' WHERE version=2",
    ] {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&c).unwrap();
        ensure_migration_table(&c).unwrap();
        for step in legacy::MIGRATIONS.iter().take(6) {
            apply_migration(&mut c, step).unwrap();
        }
        c.execute_batch(corruption).unwrap();
        assert!(!is_legacy_schema(&c).unwrap());
        assert!(ensure_supported_schema(&c).is_err());
    }
}

#[test]
fn frozen_chain_checksums_match_pre_baseline_releases() {
    let expected = [
        "50a8463e8dbdddf5c5a3233511f5e312cf365648382ac257cc89a1c0db751b0a",
        "eba987b1072bf9e0c226fa0b692e9dfe6402ca83914a80dfff3122369cd60ecc",
        "0107363c736e0880cb32a9ed52720a8e2ed13c73e7cdfb3a9faf3d031cdb220f",
        "37c8b5547c59d9442679bedd2d70d3e53eb3af45d6bff0931cb50f72c511d9ff",
        "cb37002d06a09458ac5ed9f438170ddfc52c914975a432b20f891bcff28b4320",
        "017762806b3fcc169352a78f733c3a77814a47302d6540e61a629f2d2e7fa9b1",
        "c25c2fae22944f83bd7883e463849f7fd9a784f20058181c62fb976f145f5109",
        "425d890fd03600704bf7735abab6b154fe55ee6751f6f27b6380e0192aafdc87",
        "5947a1890df9de073b0fc6df7f754d01a62341982da161015116aa366f961eeb",
        "83cc78a572c9ae0adec965a983576f93c54ae92b9ea87cfcd06ab0e9b5e3c7f5",
        "4df0e46f35374da39dfa3c91b34f009ce5b2e0f34b7974f9164d26e9b1f0a23e",
        "c518c15cf7dfc280575e1c331812ad7b6ed6b826dd5442a80c72e3ad21a8075f",
        "a0eb79b1520c47cdce6988ccfe25fc396402c4a0e2329b4eba8e2dc2175b1264",
        "7251131edbe9bf0de941b04fdc3b421f5ba031f63314f7841a813aad53737b5b",
        "bf2bca644651176e8b338b7ebb4f31ab0c221b64f47222baed535ab0b7804bc0",
        "9672d6c262f3489ded059ee12cfd3c343bf4024e498f5a9d8923bcce1f0406d6",
    ];
    for (migration, expected) in legacy::MIGRATIONS.iter().zip(expected) {
        assert_eq!(checksum(migration), expected);
    }
}
