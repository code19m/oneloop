//! Projects, tracks, epics, tasks, the personal Pool, the Board and reads.

mod board;
mod reads;
mod structure;
mod tasks;

use std::collections::HashSet;

use axum::{Extension, body::Body};
use oneloop::{
    AppError, AppState, Db,
    auth::{Actor, ActorSource, AuthService},
    collaboration::CollaborationService,
    domain::{
        BoardQuery, BoardViewQuery, BootstrapQuery, CommandEnvelope, DomainOperation,
        DomainService, DoneOrder,
    },
};
use rusqlite::params;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::support::http::body_bytes;
use crate::support::{self, now};

struct Fixture {
    _root: TempDir,
    db: Db,
    service: DomainService,
    manager: Actor,
    member: Actor,
    admin: Actor,
}

async fn fixture() -> Fixture {
    let (root, db) = crate::support::database();
    let now = now();
    db.transaction(move|tx|{
        for (id,username,name,admin) in [("u1","manager","Manager",false),("u2","member","Member",false),("u3","assignee","Assignee",false),("admin","admin","Admin",true)]{
            tx.execute("INSERT INTO users (id,username,display_name,password_hash,is_admin,password_changed_at,created_at,updated_at) VALUES (?1,?2,?3,'hash',?4,?5,?5,?5)",params![id,username,name,admin,now])?;
            tx.execute("INSERT INTO sessions (id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at) VALUES (?1,?2,?3,?4,?4,?4,?5,?5)",params![format!("s-{id}"),id,format!("h-{id}"),now,now+3600])?;
        }
        for (id,name,prefix) in [("p1","Project One","ONE"),("p2","Project Two","TWO")]{
            tx.execute("INSERT INTO projects (id,name,task_prefix,created_by,created_at,updated_at) VALUES (?1,?2,?3,'admin',?4,?4)",params![id,name,prefix,now])?;
            tx.execute("INSERT INTO project_prefixes (prefix,project_id,reserved_at) VALUES (?1,?2,?3)",params![prefix,id,now])?;
            tx.execute("INSERT INTO project_sequences (project_id,next_task_number) VALUES (?1,1)",[id])?;
        }
        for (project,user,roadmap,board) in [("p1","u1",1,1),("p1","u2",0,0),("p1","u3",0,0),("p2","u1",1,1)]{
            tx.execute("INSERT INTO project_memberships (project_id,user_id,manage_roadmap,manage_board,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",params![project,user,roadmap,board,now])?;
        }
        for (id,project,name) in [("tr1","p1","Track One"),("tr2","p2","Track Two")]{tx.execute("INSERT INTO tracks (id,project_id,name,position,created_by,created_at,updated_at) VALUES (?1,?2,?3,0,'u1',?4,?4)",params![id,project,name,now])?;}
        tx.execute("INSERT INTO epics (id,project_id,track_id,title,start_date,state,position,created_by,created_at,updated_at) VALUES ('e1','p1','tr1','Open epic','2026-01-01','planning',0,'u1',?1,?1)",[now])?;
        tx.execute("INSERT INTO epics (id,project_id,track_id,title,start_date,state,position,created_by,created_at,updated_at) VALUES ('edone','p1','tr1','Done epic','2026-01-01','done',1,'u1',?1,?1)",[now])?;
        tx.execute("INSERT INTO epics (id,project_id,track_id,title,start_date,state,position,created_by,created_at,updated_at) VALUES ('e2','p2','tr2','Other epic','2026-01-01','planning',0,'u1',?1,?1)",[now])?;
        Ok(())
    }).await.unwrap();
    let actor = |id: &str, name: &str| support::browser_actor(id, name, &format!("s-{id}"), now);
    let mut admin = actor("admin", "Admin");
    admin.is_admin = true;
    Fixture {
        service: DomainService::new(
            db.clone(),
            oneloop::timezone::TimeZone::built_in("Asia/Tashkent").unwrap(),
        ),
        db,
        _root: root,
        manager: actor("u1", "Manager"),
        member: actor("u2", "Member"),
        admin,
    }
}

fn command(
    operation: DomainOperation,
    payload: Value,
    key: &str,
    revision: Option<i64>,
) -> CommandEnvelope {
    CommandEnvelope {
        operation,
        payload,
        idempotency_key: key.into(),
        expected_revision: revision,
    }
}

async fn seed_ordering_column(f: &Fixture, count: i64) {
    f.db.transaction(move |tx| {
        let mut insert = tx.prepare("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
            VALUES(?1,'p1','e1',?2,?3,'Ordering workload',?4,?5,1,1)")?;
        for index in 0..count {
            for (offset, status) in [(0, "planning"), (count, "in_review")] {
                let number = index + offset + 1;
                insert.execute(params![format!("order-{number}"),number,format!("ONE-{number}"),status,index])?;
            }
        }
        tx.execute("UPDATE project_sequences SET next_task_number=?1 WHERE project_id='p1'", [count * 2 + 1])?;
        Ok(())
    }).await.unwrap();
}

fn board_query(status: &str, cursor: Option<String>) -> BoardQuery {
    BoardQuery {
        project_id: "p1".into(),
        status: serde_json::from_value(json!(status)).unwrap(),
        cursor,
        limit: Some(50),
        search: None,
        track_ids: vec![],
        epic_ids: vec![],
        assignee_ids: vec![],
        no_assignee: false,
        blocked: false,
        done_order: Default::default(),
    }
}
