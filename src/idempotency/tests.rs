use super::*;
use crate::{Db, auth::ActorSource};
use serde_json::json;

#[tokio::test]
async fn ledger_restarts_failed_requests_and_isolates_browser_and_grant_keys() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    db.transaction(|tx| {
        tx.execute_batch("INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at) VALUES('actor','actor','Actor','hash',1,1,1);
            INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at) VALUES('grant','actor','client','Client',1,1,9999999999);")?;
        let now=crate::clock::unix_now()?;
        let mut actor=Actor {user_id:"actor".into(),username:"actor".into(),display_name:"Actor".into(),is_admin:false,must_change_password:false,authenticated_at:now,source:ActorSource::BrowserSession{session_id:"session".into()}};
        let hash=request_hash(&json!({"a":{"z":1,"b":2},"items":[1,2]}))?;
        assert_eq!(hash,request_hash(&json!({"items":[1,2],"a":{"b":2,"z":1}}))?);
        assert!(replay::<Value>(tx,&actor,"key","work",&hash)?.is_none());
        assert_eq!(start(tx,&actor,"receipt","key","work",&hash,now)?,"receipt");
        assert!(matches!(replay::<Value>(tx,&actor,"key","work",&hash),Err(AppError::Conflict(_))));
        tx.execute("UPDATE idempotency_keys SET state='failed' WHERE id='receipt'",[])?;
        assert!(replay::<Value>(tx,&actor,"key","work",&hash)?.is_none());
        assert!(matches!(replay::<Value>(tx,&actor,"key","other",&hash),Err(AppError::Rule {kind:crate::error::RuleKind::IdempotencyKeyReused,..})));
        assert_eq!(start(tx,&actor,"unused","key","work",&hash,now)?,"receipt");
        succeed(tx,"receipt",Receipt {response:"{\"ok\":true}",status:201,resource_type:Some("task"),resource_id:Some("task"),project_id:Some("project")},now)?;
        assert_eq!(replay::<Value>(tx,&actor,"key","work",&hash)?,Some(json!({"ok":true})));
        tx.execute("UPDATE idempotency_keys SET response_json=?1 WHERE id='receipt'", [r#"{"task":{"status":"planned","title":"planned"},"epic":{"state":"planned"}}"#])?;
        let mapped = replay::<Value>(tx,&actor,"key","work",&hash)?.unwrap();
        assert_eq!(mapped["task"]["status"],"planning");
        assert_eq!(mapped["epic"]["state"],"planning");
        assert_eq!(mapped["task"]["title"],"planned");
        let stored: String = tx.query_row("SELECT response_json FROM idempotency_keys WHERE id='receipt'",[],|r|r.get(0))?;
        assert!(stored.contains(r#""status":"planned""#));
        for grant in [false,true] {
            if grant {actor.source=ActorSource::McpGrant{grant_id:"grant".into()};}
            let plan:String=tx.query_row(&format!("EXPLAIN QUERY PLAN SELECT id FROM idempotency_keys WHERE {}",key_predicate(&actor)),params![actor.user_id,"key",actor.mcp_grant_id()],|r|r.get(3))?;
            assert!(plan.contains("SEARCH") && plan.contains("idempotency_"),"{plan}");
        }
        assert!(replay::<Value>(tx,&actor,"key","work",&hash)?.is_none());
        assert_eq!(start(tx,&actor,"grant-receipt","key","work",&hash,now)?,"grant-receipt");
        tx.execute("UPDATE idempotency_keys SET expires_at=?1 WHERE id='grant-receipt'",[now-1])?;
        assert!(replay::<Value>(tx,&actor,"key","different","new-hash")?.is_none());
        assert_eq!(start(tx,&actor,"after-expiry","key","different","new-hash",now)?,"after-expiry");
        Ok(())
    }).await.unwrap();
}
