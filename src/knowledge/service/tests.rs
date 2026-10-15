//! The tests of the Knowledge service, and a synced project that its
//! submodules' tests share.

use super::*;
use crate::clock::unix_now;

/// A project with a synced folder of Markdown `files`, and a signed-in
/// admin for each of `people`.
pub(super) async fn synced_project(
    files: Vec<(String, String)>,
    people: &[&str],
) -> (tempfile::TempDir, KnowledgeService, Vec<Actor>) {
    use crate::auth::{AuthService, LoginResult, NewUser, create_user, password::PasswordPolicy};
    let (root, db) = crate::db::migrated_db();
    let password = "test-only-password-012345";
    let usernames: Vec<String> = people.iter().map(|name| (*name).to_owned()).collect();
    let names = usernames.clone();
    db.transaction(move |tx| {
        for username in names {
            let user = NewUser {
                display_name: username.clone(),
                username,
                password: password.into(),
                is_admin: true,
                must_change_password: false,
            };
            create_user(tx, user, unix_now()?, &PasswordPolicy::default())?;
        }
        tx.execute_batch(
            "INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);
             INSERT INTO knowledge_sources(project_id,url,branch,folder,state,commit_id,created_at,updated_at,generation)
             VALUES('p','https://git.example.test/docs.git','main','','ready','c',1,1,'g');",
        )?;
        for (path, content) in files {
            tx.execute(
                "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                 VALUES('p',?1,?2,'text/plain','markdown',?3,1,?4)",
                params![path, content.len() as i64, format!("sum-{path}"), content.into_bytes()],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let auth = AuthService::new(db.clone(), PasswordPolicy::default());
    let mut actors = Vec::new();
    for username in &usernames {
        let login = auth
            .login(username, password, Default::default(), None)
            .await
            .unwrap();
        let LoginResult::Authenticated(session) = login else {
            panic!("the session limit can't be reached");
        };
        actors.push(session.actor);
    }
    (root, KnowledgeService::new(db, 0), actors)
}

#[test]
fn an_html_preview_reads_no_bytes_of_other_files() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CONTENT_READS: AtomicUsize = AtomicUsize::new(0);
    let (_root, mut connection) = crate::db::migrated_connection();
    connection.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','PRJ',1,1);").unwrap();
    for (path, media_type, kind, content) in [
        (
            "data.bin",
            "application/octet-stream",
            None,
            vec![7; 4 * 1024 * 1024],
        ),
        (
            "page.html",
            "text/html",
            Some("html"),
            b"<p>hi</p>".to_vec(),
        ),
    ] {
        connection
            .execute(
                "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                 VALUES('p',?1,?2,?3,?4,'sum',1,?5)",
                params![path, content.len() as i64, media_type, kind, content],
            )
            .unwrap();
    }
    connection.trace_v2(
        rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
        Some(|event| {
            if let rusqlite::trace::TraceEvent::Stmt(_, sql) = event
                && sql.contains("content")
            {
                CONTENT_READS.fetch_add(1, Ordering::Relaxed);
            }
        }),
    );
    let transaction = connection.transaction().unwrap();
    assert!(matches!(
        html_preview_bytes(&transaction, "p", "data.bin"),
        Err(AppError::NotFound {
            resource: "preview"
        })
    ));
    assert_eq!(CONTENT_READS.load(Ordering::Relaxed), 0);
    assert_eq!(
        html_preview_bytes(&transaction, "p", "page.html").unwrap(),
        b"<p>hi</p>"
    );
    assert_eq!(CONTENT_READS.load(Ordering::Relaxed), 1);
}
