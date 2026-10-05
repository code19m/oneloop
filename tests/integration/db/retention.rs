use oneloop::retention::{prune_login_throttles, prune_transient_state};

use crate::support;

#[tokio::test]
async fn retention_removes_only_dead_state_preserving_audit_families_and_cursor() {
    let (_root, db) = support::database();
    let now = 2_000_000_000_i64;
    db.transaction(move |tx| {
        tx.execute_batch(&format!(r#"
            INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('u','user','User','x',1,1,1);
            INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at,revoked_at)
            VALUES('old','u','old',1,1,1,2,2,NULL),('recent','u','recent',1,1,1,{now},{now},NULL),('active','u','active',1,1,1,{future},{future},NULL),('revoked','u','revoked',1,1,1,{future},{future},2);
            INSERT INTO login_throttles VALUES('old',1,1,1,2),('blocked',1,1,1,{future}),('window',1,{now},{now},{now});
            INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at,last_used_at) VALUES('client','Client','[]',1,1),('unused','Unused','[]',1,NULL);
            INSERT INTO oauth_authorization_codes(code_hash,user_id,client_id,client_name,redirect_uri,resource,projects_json,scopes_json,code_challenge,issued_at,expires_at,used_at)
            VALUES('expired','u','client','Client','https://example.test','https://example.test/mcp','[]','[]','x',1,2,NULL),('used','u','client','Client','https://example.test','https://example.test/mcp','[]','[]','x',1,{future},1),('active','u','client','Client','https://example.test','https://example.test/mcp','[]','[]','x',1,{future},NULL);
            INSERT INTO oauth_authorization_requests(id,user_id,client_id,redirect_uri,resource,requested_scopes_json,code_challenge,created_at,expires_at) VALUES('old','u','client','https://example.test','https://example.test/mcp','[]','x',1,2);
            INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at,last_used_at)
            VALUES('dead','u','client','Client',1,1,2,1),('audited','u','client','Client',1,1,2,1),('notified','u','client','Client',1,1,2,1),('active','u','client','Client',{now},{now},{future},{now}),('recently-expired','u','client','Client',{now},{now},{now},{now}),('idle','u','client','Client',1,1,{future},1);
            INSERT INTO mcp_tokens(id,grant_id,family_id,kind,token_hash,issued_at,expires_at,revoked_at,rotated_to_id)
            VALUES('new','active','family','refresh','new',{now},{future},NULL,NULL),('rotated','active','family','refresh','rotated',1,{future},{now},'new'),('ancient','dead','dead','access','ancient',1,2,NULL,NULL);
            INSERT INTO activity_events(id,entity_type,entity_id,actor_mcp_grant_id,event_type,created_at) VALUES('audit','task','t','audited','task.created',1);
            INSERT INTO notification_events(id,actor_mcp_grant_id,event_type,created_at) VALUES('notice','notified','task.created',1);
            INSERT INTO security_events(id,event_type,created_at) VALUES('security','session.created',1);
            INSERT INTO file_leases(id,lease_kind,owner,created_at,expires_at) VALUES('old','backup','test',1,2),('live','backup','test',1,{future});
            INSERT INTO outbox_messages(id,topic,aggregate_type,aggregate_id,payload_json,available_at,delivered_at,created_at)
            VALUES('old','test','test','test','{{}}',1,2,1),('undelivered','test','test','test','{{}}',1,NULL,1),('recent','test','test','test','{{}}',1,{now},1),('cursor','test','test','test','{{}}',1,2,1);
        "#, future=now+86400))?;
        Ok(())
    }).await.unwrap();
    db.run(|conn| {
        let mut plan = conn.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM login_throttles INDEXED BY login_throttles_expiry_idx WHERE blocked_until<=2000000000 AND window_started_at<=1999999100 LIMIT 500")?;
        let details = plan.query_map([], |row| row.get::<_,String>(3))?.collect::<Result<Vec<_>,_>>()?.join(" ");
        assert!(details.contains("window_started_at<?"), "must skip active windows: {details}");
        Ok(())
    }).await.unwrap();
    prune_login_throttles(&db, now).await.unwrap();
    prune_transient_state(&db, now).await.unwrap();
    db.run(|conn| {
        for (table, column, expected) in [
            ("sessions", "id", "active,recent"),
            ("login_throttles", "key", "blocked,window"),
            ("oauth_clients", "client_id", "client"),
            ("oauth_authorization_codes", "code_hash", "active"),
            ("oauth_authorization_requests", "id", ""),
            (
                "mcp_grants",
                "id",
                "active,audited,notified,recently-expired",
            ),
            ("mcp_tokens", "id", "new,rotated"),
            ("file_leases", "id", "live"),
            ("outbox_messages", "id", "cursor,recent,undelivered"),
            ("activity_events", "id", "audit"),
            ("notification_events", "id", "notice"),
            ("security_events", "id", "security"),
        ] {
            let values = conn
                .prepare(&format!("SELECT {column} FROM {table} ORDER BY {column}"))?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(values.join(","), expected, "{table}");
        }
        let cursor: String = conn.query_row(
            "SELECT id FROM outbox_messages ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(cursor, "cursor");
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retention_batches_limit_writer_work() {
    let (_root, db) = support::database();
    db.transaction(|tx| {
        tx.execute_batch("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1201) INSERT INTO outbox_messages(id,topic,aggregate_type,aggregate_id,payload_json,available_at,delivered_at,created_at) SELECT 'outbox-'||i,'test','test','test','{}',1,2,1 FROM n;")?;
        Ok(())
    }).await.unwrap();
    // A full batch asks for the next pass soon; the newest row stays as the cursor.
    for (expected, more) in [(701, true), (201, true), (1, false), (1, false)] {
        assert_eq!(
            prune_transient_state(&db, 2_000_000_000).await.unwrap(),
            more
        );
        let count = db
            .run(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM outbox_messages", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(count, expected);
    }
}
