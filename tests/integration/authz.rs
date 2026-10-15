use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use oneloop::{
    AppError, AppState, Db, application,
    auth::{Actor, ActorSource},
    collaboration::{CollaborationCommand, CollaborationService},
    domain::{BootstrapQuery, CommandEnvelope, DomainOperation, DomainService},
    files::FileService,
};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::support::http::body_bytes;
use crate::support::{
    self, Role, SeededProject, TestInstance, database, now, seed_project, seeded_project,
};

#[tokio::test]
async fn project_reads_recheck_a_cached_admin_role() {
    let instance = TestInstance::new().await;
    let db = instance.db.clone();
    let cached_admin = support::add_user(&db, "old-admin", true).await.actor;
    let project = DomainService::new(db.clone(), crate::support::utc())
        .execute(
            &instance.owner.actor,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::CreateProject,
                payload: json!({"name":"Private project","taskPrefix":"PRV"}),
                idempotency_key: "private-project".into(),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let project_id = project.entities[0]["id"].as_str().unwrap().to_owned();
    demote(&db, &instance.owner.actor, &cached_admin).await;

    // A still-valid session must not preserve an earlier admin role.
    let error = DomainService::new(db, crate::support::utc())
        .bootstrap(
            &cached_admin,
            BootstrapQuery {
                project_id: Some(project_id),
                task_id: None,
                view: None,
                done_order: Default::default(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        AppError::NotFound {
            resource: "project"
        }
    ));
}

#[tokio::test]
async fn account_administration_rechecks_a_cached_admin_role() {
    let instance = TestInstance::new().await;
    let db = instance.db.clone();
    let cached_admin = support::add_user(&db, "old-admin", true).await.actor;
    demote(&db, &instance.owner.actor, &cached_admin).await;
    assert!(matches!(
        support::auth_service(&db)
            .list_accounts(&cached_admin, None)
            .await,
        Err(AppError::Forbidden)
    ));
}

#[tokio::test]
async fn mcp_admin_cannot_moderate_another_authors_comment() {
    let (_root, db) = database();
    seed_project(&db, [("member", Role::Member), ("admin", Role::Admin)]).await;
    let timestamp = now();
    db.run(move |connection| {
        connection.execute_batch(&format!(
            r#"
            INSERT INTO comments
                (id,project_id,task_id,author_id,root_id,content,created_at)
            VALUES ('comment','p1','task','member','comment','Original comment',{timestamp});
            INSERT INTO mcp_grants
                (id,user_id,client_id,client_name,created_at,updated_at,expires_at)
            VALUES ('grant','admin','client','Assistant',{timestamp},{timestamp},{expiry});
            INSERT INTO mcp_grant_projects(grant_id,project_id) VALUES ('grant','p1');
            INSERT INTO mcp_grant_scopes(grant_id,scope)
            VALUES ('grant','project_read'),('grant','discussion');
            "#,
            expiry = timestamp + 86_400,
        ))?;
        Ok(())
    })
    .await
    .unwrap();

    let mcp_admin = Actor {
        user_id: "admin".into(),
        username: "admin".into(),
        display_name: "Admin".into(),
        is_admin: true,
        must_change_password: false,
        authenticated_at: 0,
        source: ActorSource::McpGrant {
            grant_id: "grant".into(),
        },
    };
    let result = CollaborationService::new(db)
        .execute(
            &mcp_admin,
            CollaborationCommand {
                operation: "discussion.comment.edit".into(),
                payload: json!({"commentId":"comment","content":"Moderated through MCP"}),
                idempotency_key: "mcp-admin-comment-moderation".into(),
                expected_revision: Some(1),
            },
        )
        .await;
    assert!(matches!(result, Err(AppError::Forbidden)));
}

#[tokio::test]
async fn malformed_auth_json_uses_the_structured_error_contract_without_echoing_secrets() {
    let (root, db) = database();
    let config = support::config(root.path(), "http://127.0.0.1:8080", &[]);
    let app = application(AppState::new(config, db)).router;
    let secret = "never-echo-this-password";
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"username":"person","password":"{secret}""#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let structured_content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    let body = body_bytes(response).await;
    assert!(!String::from_utf8_lossy(&body).contains(secret));
    assert!(structured_content_type);
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["error"]["code"], "validation_failed");
}

async fn demote(db: &Db, owner: &Actor, old_admin: &Actor) {
    support::auth_service(db)
        .update_account(
            owner,
            &old_admin.user_id,
            oneloop::auth::AccountUpdate {
                display_name: old_admin.display_name.clone(),
                is_admin: false,
                is_active: true,
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn browser_role_matrix_uses_current_identity_across_service_boundaries() {
    let SeededProject {
        root: _root,
        db,
        alice,
        ..
    } = seeded_project().await;
    let domain = DomainService::new(db.clone(), crate::support::utc());
    let discussion = CollaborationService::new(db.clone());
    let files = FileService::new(db.clone(), 1 << 30, 0);
    for (name, member, board, roadmap, active, admin, ready, valid_session) in [
        ("non-member", false, false, false, true, false, true, true),
        ("reader", true, false, false, true, false, true, true),
        ("board", true, true, false, true, false, true, true),
        ("roadmap", true, false, true, true, false, true, true),
        ("removed", false, true, true, true, false, true, true),
        ("deactivated", true, true, true, false, false, true, true),
        ("admin", false, false, false, true, true, true, true),
        (
            "demoted-admin",
            false,
            false,
            false,
            true,
            false,
            true,
            true,
        ),
        (
            "password-change",
            true,
            true,
            true,
            true,
            false,
            false,
            true,
        ),
        (
            "revoked-session",
            true,
            true,
            true,
            true,
            false,
            true,
            false,
        ),
    ] {
        db.transaction(move |tx| {
            tx.execute("UPDATE users SET is_active=?1,is_admin=?2,must_change_password=?3 WHERE id='alice'", rusqlite::params![active,admin,!ready])?;
            tx.execute("UPDATE sessions SET revoked_at=?1 WHERE id='s-alice'", [(!valid_session).then_some(1)])?;
            tx.execute("DELETE FROM project_memberships WHERE user_id='alice'", [])?;
            if member { tx.execute("INSERT INTO project_memberships(project_id,user_id,manage_board,manage_roadmap,created_at,updated_at) VALUES('p1','alice',?1,?2,1,1)", rusqlite::params![board,roadmap])?; }
            Ok(())
        }).await.unwrap();
        let mut actor = alice.clone();
        actor.is_admin = name == "demoted-admin"; // stale elevated snapshot must not win.
        let readable = active && ready && valid_session && (member || admin);
        assert_eq!(
            domain.task(&actor, "task".into()).await.is_ok(),
            readable,
            "{name}: task"
        );
        assert_eq!(
            domain.roadmap(&actor, "p1".into()).await.is_ok(),
            readable,
            "{name}: roadmap"
        );
        assert_eq!(
            discussion
                .comments(&actor, "task", None, None)
                .await
                .is_ok(),
            readable,
            "{name}: comments"
        );
        assert_eq!(
            discussion
                .activity(&actor, "p1", None, None, None)
                .await
                .is_ok(),
            readable,
            "{name}: activity"
        );
        assert_eq!(
            files.list_attachments(&actor, "task").await.is_ok(),
            readable,
            "{name}: files"
        );
        assert_eq!(
            may_change(&domain, &actor, Area::Board).await,
            readable && (admin || board),
            "{name}: board"
        );
        assert_eq!(
            may_change(&domain, &actor, Area::Roadmap).await,
            readable && (admin || roadmap),
            "{name}: roadmap management"
        );
    }
}

#[tokio::test]
async fn mcp_scope_and_stale_grant_matrix_intersects_all_services() {
    let SeededProject {
        root: _root,
        db,
        alice: mut actor,
        ..
    } = seeded_project().await;
    let now = now();
    db.transaction(move |tx| {
        tx.execute("UPDATE project_memberships SET manage_board=1,manage_roadmap=1 WHERE user_id='alice'", [])?;
        tx.execute("INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at,last_used_at) VALUES('g','alice','c','Client',?1,?1,?2,?1)", rusqlite::params![now,now+86400])?;
        tx.execute("INSERT INTO mcp_grant_projects VALUES('g','p1')", [])?;
        for scope in ["project_read","board_manage","roadmap_manage","attachments","discussion","destructive","inbox_private","my_pool_private"] { tx.execute("INSERT INTO mcp_grant_scopes VALUES('g',?1)", [scope])?; }
        Ok(())
    }).await.unwrap();
    actor.source = ActorSource::McpGrant {
        grant_id: "g".into(),
    };
    let auth = support::auth_service(&db);
    let domain = DomainService::new(db.clone(), crate::support::utc());
    let discussion = CollaborationService::new(db.clone());
    let files = FileService::new(db.clone(), 1 << 30, 0);
    for missing in [
        "project_read",
        "board_manage",
        "roadmap_manage",
        "attachments",
        "discussion",
        "destructive",
        "inbox_private",
        "my_pool_private",
    ] {
        db.transaction(move |tx| {
            tx.execute(
                "DELETE FROM mcp_grant_scopes WHERE grant_id='g' AND scope=?1",
                [missing],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            domain.task(&actor, "task".into()).await.is_ok(),
            missing != "project_read",
            "{missing}: task"
        );
        assert_eq!(
            files.list_attachments(&actor, "task").await.is_ok(),
            !matches!(missing, "project_read" | "attachments"),
            "{missing}: files"
        );
        if matches!(missing, "project_read" | "attachments") {
            for task in ["task", "missing"] {
                assert!(
                    matches!(
                        files.list_attachments(&actor, task).await,
                        Err(oneloop::AppError::NotFound { .. })
                    ),
                    "{missing}: {task}"
                );
            }
        }
        assert_eq!(
            may_change(&domain, &actor, Area::Board).await,
            missing != "board_manage",
            "{missing}: board"
        );
        assert_eq!(
            may_change(&domain, &actor, Area::Roadmap).await,
            missing != "roadmap_manage",
            "{missing}: roadmap"
        );
        for (scope, name) in [
            (oneloop::auth::McpScope::Discussion, "discussion"),
            (oneloop::auth::McpScope::Destructive, "destructive"),
            (oneloop::auth::McpScope::InboxPrivate, "inbox_private"),
            (oneloop::auth::McpScope::MyPoolPrivate, "my_pool_private"),
        ] {
            assert_eq!(
                auth.require_mcp_scope(&actor, scope).await.is_ok(),
                missing != name
            );
        }
        db.transaction(move |tx| {
            tx.execute("INSERT INTO mcp_grant_scopes VALUES('g',?1)", [missing])?;
            Ok(())
        })
        .await
        .unwrap();
    }
    for change in [
        "DELETE FROM mcp_grant_projects WHERE grant_id='g'",
        "UPDATE mcp_grants SET last_used_at=1 WHERE id='g'",
        "UPDATE mcp_grants SET revoked_at=1 WHERE id='g'",
        "UPDATE mcp_grants SET expires_at=1 WHERE id='g'",
        "UPDATE users SET must_change_password=1 WHERE id='alice'",
    ] {
        db.transaction(move |tx| {
            tx.execute_batch(change)?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            domain.task(&actor, "task".into()).await.is_err(),
            "{change}"
        );
        assert!(
            discussion
                .comments(&actor, "task", None, None)
                .await
                .is_err(),
            "{change}"
        );
        assert!(
            files.list_attachments(&actor, "task").await.is_err(),
            "{change}"
        );
        db.transaction(move |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO mcp_grant_projects VALUES('g','p1')",
                [],
            )?;
            tx.execute(
                "UPDATE mcp_grants SET last_used_at=?1,revoked_at=NULL,expires_at=?2",
                rusqlite::params![now, now + 86400],
            )?;
            tx.execute(
                "UPDATE users SET must_change_password=0 WHERE id='alice'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }
}

enum Area {
    Board,
    Roadmap,
}

/// Whether `actor` may change the seeded project's Board or Roadmap. The
/// command names a stale revision: access is checked first, so an allowed
/// actor gets a revision conflict and nothing changes.
async fn may_change(domain: &DomainService, actor: &Actor, area: Area) -> bool {
    let (operation, payload): (_, Value) = match area {
        Area::Board => (
            DomainOperation::UpdateTask,
            json!({"taskId":"task","title":"Changed"}),
        ),
        Area::Roadmap => (
            DomainOperation::UpdateTrack,
            json!({"trackId":"track","name":"Changed"}),
        ),
    };
    let command = CommandEnvelope {
        operation,
        payload,
        idempotency_key: uuid::Uuid::now_v7().to_string(),
        expected_revision: Some(99),
    };
    match domain.execute(actor, command).await {
        Err(AppError::RevisionConflict { .. }) => true,
        Err(
            AppError::Forbidden
            | AppError::NotFound { .. }
            | AppError::Unauthorized
            | AppError::PreconditionFailed(_),
        ) => false,
        other => panic!("{operation:?}: {other:?}"),
    }
}
