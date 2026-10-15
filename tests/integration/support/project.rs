use oneloop::{
    Db,
    auth::{Actor, token_hash},
};
use tempfile::TempDir;

use super::{browser_actor, database, now};

/// How a seeded person relates to project `p1`.
#[derive(Clone, Copy, PartialEq)]
pub enum Role {
    /// An administrator who is not a member.
    Admin,
    /// A member who manages the Board.
    Manager,
    /// A member without management rights.
    Member,
    /// An account outside the project.
    Outsider,
}

/// Seeds project `p1`, named `Project` with task prefix `ONE`: track
/// `track`, epic `epic` and task `task` (`ONE-001`). Then adds `people`, as
/// `add_people` does, and returns their actors in the same order.
pub async fn seed_project<const N: usize>(db: &Db, people: [(&str, Role); N]) -> [Actor; N] {
    let now = now();
    db.run(move |connection| {
        connection.execute_batch(&format!(r#"
            INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES ('p1','Project','ONE',{now},{now});
            INSERT INTO project_prefixes(prefix,project_id,reserved_at) VALUES ('ONE','p1',{now});
            INSERT INTO project_sequences(project_id,next_task_number) VALUES ('p1',2);
            INSERT INTO tracks(id,project_id,name,position,created_at,updated_at)
                VALUES ('track','p1','Track',0,{now},{now});
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at)
                VALUES ('epic','p1','track','Epic','2026-01-01',0,{now},{now});
            INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
                VALUES ('task','p1','epic',1,'ONE-001','Task','planning',0,{now},{now});
        "#))?;
        Ok(())
    })
    .await
    .unwrap();
    add_people(db, &people).await.try_into().unwrap()
}

/// Adds an account for each person, with the role in project `p1`, and signs
/// it in with session `s-{id}`; `session_cookie` sends it. The display name is
/// the ID with a capital first letter. Passwords are placeholders, so these
/// people cannot sign in again.
pub async fn add_people(db: &Db, people: &[(&str, Role)]) -> Vec<Actor> {
    let now = now();
    let rows = people
        .iter()
        .map(|&(id, role)| (id.to_owned(), display_name(id), role))
        .collect::<Vec<_>>();
    db.transaction(move |tx| {
        for (id, name, role) in &rows {
            tx.execute(
                "INSERT INTO users(id,username,display_name,password_hash,is_admin,password_changed_at,created_at,updated_at)
                 VALUES(?1,?1,?2,'x',?3,?4,?4,?4)",
                rusqlite::params![id, name, *role == Role::Admin, now],
            )?;
            tx.execute(
                "INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                 VALUES(?1,?2,?3,?4,?4,?4,?5,?5)",
                rusqlite::params![format!("s-{id}"), id, token_hash(&session_token(id)), now, now + 86_400],
            )?;
            if matches!(role, Role::Manager | Role::Member) {
                tx.execute(
                    "INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at)
                     VALUES('p1',?1,?2,?3,?3)",
                    rusqlite::params![id, *role == Role::Manager, now],
                )?;
            }
        }
        Ok(())
    })
    .await
    .unwrap();
    people
        .iter()
        .map(|&(id, role)| Actor {
            is_admin: role == Role::Admin,
            ..browser_actor(id, &display_name(id), &format!("s-{id}"), now)
        })
        .collect()
}

/// The session cookie of a seeded person, for an application served over
/// HTTPS.
pub fn session_cookie(id: &str) -> String {
    format!("__Host-oneloop_session={}", session_token(id))
}

fn session_token(id: &str) -> String {
    format!("{id}-session-token-for-integration-tests")
}

fn display_name(id: &str) -> String {
    let mut characters = id.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

/// `seed_project` in a fresh database, with the members Alice and Bob and the
/// administrator Dave.
pub struct SeededProject {
    pub root: TempDir,
    pub db: Db,
    pub alice: Actor,
    pub bob: Actor,
}

pub async fn seeded_project() -> SeededProject {
    let (root, db) = database();
    let [alice, bob, _] = seed_project(
        &db,
        [
            ("alice", Role::Member),
            ("bob", Role::Member),
            ("dave", Role::Admin),
        ],
    )
    .await;
    SeededProject {
        root,
        db,
        alice,
        bob,
    }
}
