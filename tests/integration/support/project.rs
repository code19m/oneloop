use oneloop::{Db, auth::Actor};
use tempfile::TempDir;

use super::{browser_actor, database, now};

/// Project `p1` (prefix `ONE`) with members Alice and Bob, the administrator
/// Dave, one track, one epic and task `ONE-001`. Sessions are `sa`, `sb` and
/// `sd`; passwords are placeholders, so these users cannot sign in.
pub struct SeededProject {
    pub root: TempDir,
    pub db: Db,
    pub alice: Actor,
    pub bob: Actor,
}

pub async fn seeded_project() -> SeededProject {
    let (root, db) = database();
    let now = now();
    db.run(move |connection| {
        connection.execute_batch(&format!(r#"
            INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                VALUES ('alice','alice','Alice','x',{now},{now},{now}),
                       ('bob','bob','Bob','x',{now},{now},{now}),
                       ('dave','dave','Dave','x',{now},{now},{now});
            UPDATE users SET is_admin=1 WHERE id='dave';
            INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES ('p1','Project','ONE',{now},{now});
            INSERT INTO project_memberships(project_id,user_id,created_at,updated_at)
                VALUES ('p1','alice',{now},{now}),('p1','bob',{now},{now});
            INSERT INTO tracks(id,project_id,name,position,created_at,updated_at)
                VALUES ('track','p1','Track',0,{now},{now});
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at)
                VALUES ('epic','p1','track','Epic','2026-01-01',0,{now},{now});
            INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
                VALUES ('task','p1','epic',1,'ONE-001','Task','planning',0,{now},{now});
            INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                VALUES ('sa','alice','ha',{now},{now},{now},{expiry},{expiry}),
                       ('sb','bob','hb',{now},{now},{now},{expiry},{expiry}),
                       ('sd','dave','hd',{now},{now},{now},{expiry},{expiry});
        "#, expiry=now+86_400))?;
        Ok(())
    })
    .await
    .unwrap();
    SeededProject {
        root,
        db,
        alice: browser_actor("alice", "Alice", "sa", now),
        bob: browser_actor("bob", "Bob", "sb", now),
    }
}
