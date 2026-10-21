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
fn deciding_an_html_preview_reads_no_bytes() {
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
    // Neither another file, nor a page to send, nor a current copy.
    assert!(matches!(
        html_preview_file(&transaction, "p", "data.bin", None),
        Err(AppError::NotFound {
            resource: "preview"
        })
    ));
    let (etag, stored) = html_preview_file(&transaction, "p", "page.html", None).unwrap();
    let stored = stored.unwrap();
    assert_eq!((stored.checksum.as_str(), stored.size), ("sum", 9));
    let (current, stored) = html_preview_file(&transaction, "p", "page.html", Some(&etag)).unwrap();
    assert_eq!(current, etag);
    assert!(stored.is_none());
    assert_eq!(CONTENT_READS.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn html_that_older_syncs_stored_without_a_preview_previews_at_once() {
    // Syncs before 0.1.0-rc.8 stored HTML files over 1 MiB without a kind.
    let (_root, service, people) = synced_project(Vec::new(), &["admin"]).await;
    let mut page = b"<!doctype html><p>Report</p>".to_vec();
    page.resize(2 * 1024 * 1024, b' ');
    let content = page.clone();
    service
        .inner
        .db
        .transaction(move |tx| {
            tx.execute(
                "INSERT INTO knowledge_files(project_id,path,size,media_type,preview_kind,checksum,updated_at,content)
                 VALUES('p','report.html',?1,'text/html',NULL,'sum',1,?2)",
                params![content.len() as i64, content],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let view = service.view(&people[0], "p").await.unwrap();
    assert_eq!(view.files[0].kind, Some(PreviewKind::Html));
    let Ok(HtmlPreview::Page {
        page: mut cleaned, ..
    }) = service
        .html_preview(&people[0], "p", "report.html", None)
        .await
    else {
        panic!("the page previews");
    };
    let mut text = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut cleaned, &mut text)
        .await
        .unwrap();
    assert_eq!(text, page);
}
