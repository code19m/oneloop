use oneloop::{
    AppError, Db,
    auth::{
        AccountUpdate, Actor, ActorSource, AuthService, LoginResult, NewUser, ProjectPermission,
        SessionMetadata, create_user, token_hash, unix_now,
    },
};

use crate::support::database;

async fn add_user(db: &Db, username: &str, admin: bool, temporary: bool) -> String {
    let username = username.to_owned();
    db.transaction(move |tx| {
        Ok(create_user(
            tx,
            NewUser {
                display_name: username.clone(),
                username,
                password: "correct horse battery staple".into(),
                is_admin: admin,
                must_change_password: temporary,
            },
            1_700_000_000,
        )?
        .id)
    })
    .await
    .unwrap()
}

async fn login(service: &AuthService, username: &str) -> (String, Actor) {
    match service
        .login(
            username,
            "correct horse battery staple",
            SessionMetadata::default(),
            None,
        )
        .await
        .unwrap()
    {
        LoginResult::Authenticated(session) => (session.token, session.actor),
        LoginResult::SessionLimit { .. } => panic!("unexpected session limit"),
    }
}

#[tokio::test]
async fn inactive_accounts_and_temporary_sessions_cannot_enter_the_application() {
    let (_directory, db) = database();
    let temporary_id = add_user(&db, "temporary", false, true).await;
    let inactive_id = add_user(&db, "inactive", false, false).await;
    db.run(move |connection| {
        connection.execute("UPDATE users SET is_active=0 WHERE id=?1", [inactive_id])?;
        Ok(())
    })
    .await
    .unwrap();

    let service = AuthService::new(db.clone());
    let (_, temporary) = login(&service, "temporary").await;
    assert!(matches!(
        temporary.require_ready(),
        Err(AppError::PreconditionFailed(_))
    ));
    assert!(matches!(
        service.list_sessions(&temporary).await,
        Err(AppError::PreconditionFailed(_))
    ));
    assert!(matches!(
        service
            .login(
                "inactive",
                "correct horse battery staple",
                SessionMetadata::default(),
                None
            )
            .await,
        Err(AppError::InvalidCredentials)
    ));
    assert_eq!(temporary.user_id, temporary_id);
}

#[tokio::test]
async fn permissions_are_rechecked_and_admin_assignment_still_requires_membership() {
    let (_directory, db) = database();
    let member_id = add_user(&db, "member", false, false).await;
    add_user(&db, "administrator", true, false).await;
    let project_id = "project-1".to_owned();
    let project_for_insert = project_id.clone();
    let member_for_insert = member_id.clone();
    db.transaction(move |tx| {
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES(?1,'Project','PRJ',1,1)",
            [&project_for_insert])?;
        tx.execute("INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at)
                    VALUES(?1,?2,1,1,1)", rusqlite::params![project_for_insert,member_for_insert])?;
        Ok(())
    }).await.unwrap();

    let service = AuthService::new(db.clone());
    let (_, member) = login(&service, "member").await;
    let (_, admin) = login(&service, "administrator").await;
    assert!(
        service
            .can_read_project(&member, &project_id)
            .await
            .unwrap()
    );
    assert!(
        service
            .can_manage_project(&member, &project_id, ProjectPermission::Board)
            .await
            .unwrap()
    );
    assert!(
        !service
            .can_manage_project(&member, &project_id, ProjectPermission::Roadmap)
            .await
            .unwrap()
    );
    assert!(service.can_read_project(&admin, &project_id).await.unwrap());

    let member_for_remove = member_id.clone();
    db.run(move |connection| {
        connection.execute(
            "DELETE FROM project_memberships WHERE user_id=?1",
            [member_for_remove],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        !service
            .can_read_project(&member, &project_id)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn session_lists_and_revocation_are_owner_private_even_for_admins() {
    let (_directory, db) = database();
    add_user(&db, "administrator", true, false).await;
    add_user(&db, "ordinary", false, false).await;
    let service = AuthService::new(db.clone());
    let (_, admin) = login(&service, "administrator").await;
    let (_, ordinary) = login(&service, "ordinary").await;

    let ordinary_id = ordinary.user_id.clone();
    db.run(move |connection| {
        connection.execute(
            "INSERT INTO mcp_grants
            (id,user_id,client_id,client_name,created_at,updated_at,expires_at)
            VALUES('ordinary-grant',?1,'client','Client',1,1,9999999999)",
            [ordinary_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let ordinary_session = ordinary.session_id().unwrap().to_owned();
    assert!(matches!(
        service.revoke_session(&admin, &ordinary_session).await,
        Err(AppError::NotFound {
            resource: "session"
        })
    ));
    assert_eq!(service.list_sessions(&admin).await.unwrap().len(), 1);
    assert_eq!(service.list_sessions(&ordinary).await.unwrap().len(), 1);
    assert!(
        service
            .list_connected_apps(&admin)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        service.list_connected_apps(&ordinary).await.unwrap().len(),
        1
    );
    assert!(matches!(
        service.revoke_connected_app(&admin, "ordinary-grant").await,
        Err(AppError::NotFound {
            resource: "connected app"
        })
    ));
}

#[tokio::test]
async fn changing_password_keeps_only_the_current_browser_and_revokes_apps() {
    let (_directory, db) = database();
    let user_id = add_user(&db, "person", false, false).await;
    let service = AuthService::new(db.clone());
    let (first_token, _first) = login(&service, "person").await;
    let (second_token, second) = login(&service, "person").await;
    let user_for_grant = user_id.clone();
    db.run(move |connection| {
        connection.execute(
            "INSERT INTO mcp_grants
            (id,user_id,client_id,client_name,created_at,updated_at,expires_at)
            VALUES('grant-1',?1,'client','Client',1,1,9999999999)",
            [user_for_grant],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let changed = service
        .change_password(
            &second,
            "correct horse battery staple",
            "an even better password",
        )
        .await
        .unwrap();
    assert!(!changed.actor.must_change_password);
    assert!(matches!(
        service.authenticate_session(&first_token, true).await,
        Err(AppError::Unauthorized)
    ));
    assert!(matches!(
        service.authenticate_session(&second_token, true).await,
        Err(AppError::Unauthorized)
    ));
    assert!(
        service
            .authenticate_session(&changed.token, true)
            .await
            .is_ok()
    );
    let revoked: Option<i64> = db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT revoked_at FROM mcp_grants WHERE id='grant-1'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(revoked.is_some());
}

#[tokio::test]
async fn database_trigger_protects_the_last_active_administrator() {
    let (_directory, db) = database();
    let admin_id = add_user(&db, "onlyadmin", true, false).await;
    let first = admin_id.clone();
    let error = db
        .run(move |connection| {
            connection.execute("UPDATE users SET is_admin=0 WHERE id=?1", [first])?;
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(matches!(error, AppError::Database(_)));

    add_user(&db, "secondadmin", true, false).await;
    db.run(move |connection| {
        connection.execute("UPDATE users SET is_admin=0 WHERE id=?1", [admin_id])?;
        Ok(())
    })
    .await
    .unwrap();
}

#[test]
fn mcp_actor_cannot_satisfy_recent_browser_authentication() {
    let actor = Actor {
        user_id: "u".into(),
        username: "u".into(),
        display_name: "User".into(),
        is_admin: true,
        must_change_password: false,
        authenticated_at: i64::MAX,
        source: ActorSource::McpGrant {
            grant_id: "grant".into(),
        },
    };
    assert!(matches!(actor.require_admin(), Err(AppError::Forbidden)));
    assert!(matches!(
        actor.require_recent_auth(1_700_000_000),
        Err(AppError::Rule {
            kind: oneloop::error::RuleKind::RecentAuthRequired,
            ..
        })
    ));
}

#[tokio::test]
async fn session_limit_requires_an_explicit_owned_session_choice() {
    let (_directory, db) = database();
    let user_id = add_user(&db, "sessionuser", false, false).await;
    let user_for_rows = user_id.clone();
    let now = unix_now().unwrap();
    db.transaction(move |tx| {
        for index in 0..10 {
            tx.execute("INSERT INTO sessions
                (id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                VALUES(?1,?2,?3,?4,?4,?4,?5,?6)",rusqlite::params![
                    format!("session-{index}"),user_for_rows,token_hash(&format!("token-{index}")),now,
                    now+3600,now+7200])?;
        }
        Ok(())
    }).await.unwrap();
    let service = AuthService::new(db.clone());
    let limited = service
        .login(
            "sessionuser",
            "correct horse battery staple",
            SessionMetadata::default(),
            None,
        )
        .await
        .unwrap();
    assert!(matches!(limited,LoginResult::SessionLimit{ref sessions} if sessions.len()==10));
    let issued = service
        .login(
            "sessionuser",
            "correct horse battery staple",
            SessionMetadata::default(),
            Some("session-0".into()),
        )
        .await
        .unwrap();
    assert!(matches!(issued, LoginResult::Authenticated(_)));
    let count: i64 = db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM sessions WHERE user_id=?1 AND revoked_at IS NULL",
                [user_id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 10);
}

#[tokio::test]
async fn login_throttles_and_expired_sessions_fail_closed() {
    let (_directory, db) = database();
    add_user(&db, "limited", false, false).await;
    let now = unix_now().unwrap();
    let key = token_hash("account\0limited\0unknown");
    db.run(move |connection| {
        connection.execute("INSERT INTO login_throttles
            (key,failure_count,window_started_at,last_failed_at,blocked_until) VALUES(?1,5,?2,?2,?3)",
            rusqlite::params![key,now,now+60])?;
        Ok(())
    }).await.unwrap();
    let service = AuthService::new(db.clone());
    assert!(
        matches!(service.login("limited","correct horse battery staple",SessionMetadata::default(),None).await,
        Err(AppError::RateLimited{retry_after}) if retry_after>0)
    );

    db.run(|connection| {
        connection.execute("DELETE FROM login_throttles", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let (token, actor) = login(&service, "limited").await;
    let session_id = actor.session_id().unwrap().to_owned();
    let sid = session_id.clone();
    db.run(move |connection| {
        connection.execute("UPDATE sessions SET idle_expires_at=0 WHERE id=?1", [sid])?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(matches!(
        service.authenticate_session(&token, true).await,
        Err(AppError::Unauthorized)
    ));
    let revoked: Option<i64> = db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT revoked_at FROM sessions WHERE id=?1",
                [session_id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(revoked.is_some());
}

#[tokio::test]
async fn passive_authentication_does_not_extend_idle_activity() {
    let (_directory, db) = database();
    add_user(&db, "passive", false, false).await;
    let service = AuthService::new(db.clone());
    let (token, actor) = login(&service, "passive").await;
    let session_id = actor.session_id().unwrap().to_owned();
    let old = unix_now().unwrap() - 120;
    let sid = session_id.clone();
    db.run(move |connection| {
        connection.execute(
            "UPDATE sessions SET last_activity_at=?1 WHERE id=?2",
            rusqlite::params![old, sid],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    service.authenticate_session(&token, false).await.unwrap();
    let unchanged: i64 = db
        .run({
            let sid = session_id.clone();
            move |connection| {
                Ok(connection.query_row(
                    "SELECT last_activity_at FROM sessions WHERE id=?1",
                    [sid],
                    |row| row.get(0),
                )?)
            }
        })
        .await
        .unwrap();
    assert_eq!(unchanged, old);
    service.authenticate_session(&token, true).await.unwrap();
    let updated: i64 = db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT last_activity_at FROM sessions WHERE id=?1",
                [session_id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(updated > old);
}

#[tokio::test]
async fn mcp_project_access_is_intersected_with_live_grant_scopes() {
    let (_directory, db) = database();
    let user_id = add_user(&db, "mcpuser", false, false).await;
    let project_id = "mcp-project".to_owned();
    let access_token = "mcp-access-token-with-at-least-32-bytes".to_owned();
    let access_hash = token_hash(&access_token);
    let uid = user_id.clone();
    let pid = project_id.clone();
    db.transaction(move |tx| {
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES(?1,'MCP','MCP',1,1)",[&pid])?;
        tx.execute("INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at)
            VALUES(?1,?2,1,1,1)",rusqlite::params![pid,uid])?;
        tx.execute("INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at)
            VALUES('grant',?1,'client','Client',1,1,9999999999)",[uid])?;
        tx.execute("INSERT INTO mcp_grant_projects(grant_id,project_id) VALUES('grant',?1)",[pid])?;
        tx.execute("INSERT INTO mcp_grant_scopes(grant_id,scope) VALUES('grant','project_read')",[])?;
        tx.execute("INSERT INTO mcp_tokens(id,grant_id,family_id,kind,token_hash,issued_at,expires_at)
            VALUES('access','grant','family','access',?1,1,9999999999)",[access_hash])?;
        Ok(())
    }).await.unwrap();
    let service = AuthService::new(db.clone());
    let actor = service
        .authenticate_mcp_access_token(&access_token)
        .await
        .unwrap();
    assert_eq!(actor.user_id, user_id);
    assert!(service.can_read_project(&actor, &project_id).await.unwrap());
    assert!(
        !service
            .can_manage_project(&actor, &project_id, ProjectPermission::Board)
            .await
            .unwrap()
    );
    db.run(|connection| {
        connection.execute(
            "INSERT INTO mcp_grant_scopes(grant_id,scope) VALUES('grant','board_manage')",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        service
            .can_manage_project(&actor, &project_id, ProjectPermission::Board)
            .await
            .unwrap()
    );
    db.run(|connection| {
        connection.execute("UPDATE mcp_grants SET revoked_at=2 WHERE id='grant'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(!service.can_read_project(&actor, &project_id).await.unwrap());
    assert!(matches!(
        service.authenticate_mcp_access_token(&access_token).await,
        Err(AppError::Unauthorized)
    ));
}

#[tokio::test]
async fn sensitive_account_changes_require_fresh_browser_authentication() {
    let (_directory, db) = database();
    add_user(&db, "adminuser", true, false).await;
    let service = AuthService::new(db.clone());
    let (_, admin) = login(&service, "adminuser").await;
    let created = service
        .create_account(&admin, "newperson", "New Person", false)
        .await
        .unwrap();
    assert!(created.temporary_password.len() >= 32);
    let mut stale = admin.clone();
    stale.authenticated_at = 0;
    let session_id = admin.session_id().unwrap().to_owned();
    db.run(move |connection| {
        connection.execute(
            "UPDATE sessions SET authenticated_at=0 WHERE id=?1",
            [session_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let error = service
        .update_account(
            &stale,
            &created.user.id,
            AccountUpdate {
                display_name: "New Person".into(),
                is_admin: false,
                is_active: false,
                expected_revision: created.user.revision,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "recent_auth_required");
    let updated = service
        .update_account(
            &admin,
            &created.user.id,
            AccountUpdate {
                display_name: "Updated Person".into(),
                is_admin: false,
                is_active: true,
                expected_revision: created.user.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.display_name, "Updated Person");
}

#[tokio::test]
async fn display_name_bounds_match_browser_utf16_limits() {
    let (_dir, db) = database();
    let invalid = db
        .transaction(|tx| {
            create_user(
                tx,
                NewUser {
                    username: "oversized".into(),
                    display_name: "x".repeat(81),
                    password: "correct horse battery staple".into(),
                    is_admin: false,
                    must_change_password: false,
                },
                unix_now()?,
            )
        })
        .await
        .unwrap_err();
    assert!(matches!(
        invalid,
        AppError::Validation {
            ref field, ..
        } if field == "displayName"
    ));
    let valid = db
        .transaction(|tx| {
            create_user(
                tx,
                NewUser {
                    username: "boundary".into(),
                    display_name: "🙂".repeat(40),
                    password: "correct horse battery staple".into(),
                    is_admin: false,
                    must_change_password: false,
                },
                unix_now()?,
            )
        })
        .await
        .unwrap();
    assert_eq!(valid.display_name, "🙂".repeat(40));
}

#[test]
fn sensitive_actions_use_a_fixed_thirty_minute_password_window() {
    let now = 1_800_000_000;
    let mut actor = Actor {
        user_id: "admin".into(),
        username: "admin".into(),
        display_name: "Admin".into(),
        is_admin: true,
        must_change_password: false,
        authenticated_at: now - 20 * 60,
        source: ActorSource::BrowserSession {
            session_id: "session".into(),
        },
    };
    assert!(actor.require_recent_auth(now).is_ok());
    actor.authenticated_at = now - 30 * 60 + 1;
    assert!(actor.require_recent_auth(now).is_ok());
    actor.authenticated_at -= 1;
    assert!(actor.require_recent_auth(now).is_err());
    actor.authenticated_at = now;
    actor.source = ActorSource::McpGrant {
        grant_id: "grant".into(),
    };
    assert!(actor.require_recent_auth(now).is_err());
}

#[tokio::test]
async fn cli_creation_reset_and_browser_password_change_share_the_five_character_rule() {
    use assert_cmd::Command;
    let (directory, db) = database();
    Command::cargo_bin("oneloop")
        .unwrap()
        .env_clear()
        .env("ONELOOP_DATA_DIR", directory.path())
        .args(["user", "add", "newadmin", "--admin", "--password-stdin"])
        .write_stdin("12345\n")
        .assert()
        .success();
    Command::cargo_bin("oneloop")
        .unwrap()
        .env_clear()
        .env("ONELOOP_DATA_DIR", directory.path())
        .args(["user", "passwd", "newadmin", "--password-stdin"])
        .write_stdin("😀😀😀😀\n")
        .assert()
        .failure();
    let service = AuthService::new(db.clone());
    assert!(matches!(
        service
            .login("newadmin", "12345", SessionMetadata::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
    let long = "x".repeat(8192);
    Command::cargo_bin("oneloop")
        .unwrap()
        .env_clear()
        .env("ONELOOP_DATA_DIR", directory.path())
        .args(["user", "passwd", "newadmin", "--password-stdin"])
        .write_stdin(format!("{long}\n"))
        .assert()
        .success();
    let LoginResult::Authenticated(session) = service
        .login("newadmin", &long, SessionMetadata::default(), None)
        .await
        .unwrap()
    else {
        panic!("unexpected session limit");
    };
    assert!(session.actor.must_change_password);
    let changed = service
        .change_password(&session.actor, &long, "😀😀😀😀😀")
        .await
        .unwrap();
    assert!(!changed.actor.must_change_password);
    assert!(matches!(
        service
            .login("newadmin", "😀😀😀😀😀", SessionMetadata::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
}

#[tokio::test]
async fn password_gates_share_account_delay_across_sessions_and_clear_on_success() {
    let (_directory, db) = database();
    add_user(&db, "confirm", false, false).await;
    let service = AuthService::new(db.clone());
    let (token, actor) = login(&service, "confirm").await;
    let (_, other) = login(&service, "confirm").await;
    for attempt in 0..5 {
        let error = if attempt % 2 == 0 {
            service
                .recent_authenticate(&actor, "wrong")
                .await
                .err()
                .unwrap()
        } else {
            service
                .change_password(&other, "wrong", "new password")
                .await
                .err()
                .unwrap()
        };
        assert!(matches!(error, AppError::IncorrectPassword { .. }));
    }
    assert!(
        matches!(service.recent_authenticate(&other, "correct horse battery staple").await,
        Err(AppError::RateLimited { retry_after }) if retry_after > 0)
    );
    assert!(
        matches!(service.change_password(&actor, "correct horse battery staple", "new password").await,
        Err(AppError::RateLimited { retry_after }) if retry_after > 0)
    );
    assert!(service.authenticate_session(&token, false).await.is_ok());
    // Advance the stored delay instead of sleeping in the test.
    db.run(|connection| {
        connection.execute("UPDATE login_throttles SET blocked_until=0", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let refreshed = service
        .recent_authenticate(&other, "correct horse battery staple")
        .await
        .unwrap();
    let failures: i64 = db
        .run(|connection| {
            Ok(connection
                .query_row("SELECT COUNT(*) FROM login_throttles", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(failures, 0);
    assert!(
        service
            .authenticate_session(&refreshed.token, false)
            .await
            .is_ok()
    );
    assert!(matches!(
        service
            .change_password(&refreshed.actor, "wrong", "new password")
            .await,
        Err(AppError::IncorrectPassword {
            field: "currentPassword"
        })
    ));
}

#[tokio::test]
async fn parallel_login_attempts_observe_completed_failures_before_hashing() {
    let (_directory, db) = database();
    add_user(&db, "parallel", false, false).await;
    add_user(&db, "independent", false, false).await;
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let service = AuthService::new(db.clone());
        requests.spawn(async move {
            service
                .login("parallel", "wrong", SessionMetadata::default(), None)
                .await
        });
    }
    let mut verified = 0;
    let mut limited = 0;
    while let Some(result) = requests.join_next().await {
        match result.unwrap() {
            Err(AppError::InvalidCredentials) => verified += 1,
            Err(AppError::RateLimited { retry_after }) => {
                assert!(retry_after > 0);
                limited += 1;
            }
            _ => panic!("unexpected parallel login result"),
        }
    }
    assert!((5..=8).contains(&verified), "verified {verified} attempts");
    assert_eq!(verified + limited, 12);
    let service = AuthService::new(db);
    assert!(matches!(
        service
            .login("parallel", "wrong", SessionMetadata::default(), None)
            .await,
        Err(AppError::RateLimited { .. })
    ));
    // A delayed account does not prevent another account from authenticating.
    login(&service, "independent").await;
}

#[tokio::test]
async fn password_commit_rechecks_revocation_and_both_expiries_after_verification() {
    for condition in [
        "revoked_at=1",
        "idle_expires_at=0",
        "idle_expires_at=0,absolute_expires_at=0",
    ] {
        for change_password in [true, false] {
            let (_directory, db) = database();
            let user_id = add_user(&db, "racing", false, false).await;
            let service = AuthService::new(db.clone());
            let (_, actor) = login(&service, "racing").await;
            let (other_token, _) = login(&service, "racing").await;
            let before: (String, i64) = db
                .run(|connection| {
                    Ok(connection.query_row(
                        "SELECT password_hash,revision FROM users WHERE username='racing'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?)
                })
                .await
                .unwrap();
            let throttle_key = token_hash(&format!("password-confirmation\0{user_id}"));
            let session_id = actor.session_id().unwrap().to_owned();
            // Successful verification clears its prior failure row. This trigger
            // invalidates the actor in that exact gap, before the commit transaction,
            // without depending on machine speed or a timer racing Argon2.
            db.run(move |connection| {
                connection.execute("CREATE TABLE test_revocation_target(session_id TEXT)", [])?;
                connection.execute("INSERT INTO test_revocation_target VALUES(?1)", [session_id])?;
                connection.execute("INSERT INTO login_throttles(key,failure_count,window_started_at,last_failed_at,blocked_until)
                    VALUES(?1,1,0,0,0)", [throttle_key])?;
                connection.execute("INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at)
                    VALUES('race-grant',?1,'client','Client',1,1,9999999999)", [user_id])?;
                connection.execute_batch(&format!("CREATE TRIGGER test_revoke_after_verification AFTER DELETE ON login_throttles
                    BEGIN UPDATE sessions SET {condition} WHERE id=(SELECT session_id FROM test_revocation_target); END;"))?;
                Ok(())
            }).await.unwrap();
            let result = if change_password {
                service
                    .change_password(&actor, "correct horse battery staple", "replacement")
                    .await
            } else {
                service
                    .recent_authenticate(&actor, "correct horse battery staple")
                    .await
            };
            assert!(
                matches!(result, Err(AppError::Unauthorized)),
                "{condition}, change={change_password}"
            );
            let after: (String, i64, Option<i64>, i64) = db.run(|connection| Ok(connection.query_row(
                "SELECT password_hash,revision,(SELECT revoked_at FROM mcp_grants WHERE id='race-grant'),
                 (SELECT COUNT(*) FROM security_events WHERE event_type='password.changed') FROM users WHERE username='racing'", [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?)).await.unwrap();
            assert_eq!((after.0, after.1), before);
            assert_eq!(after.2, None);
            assert_eq!(after.3, 0);
            assert!(
                service
                    .authenticate_session(&other_token, false)
                    .await
                    .is_ok()
            );
        }
    }
}

#[tokio::test]
async fn session_activity_does_not_wait_for_an_external_sqlite_writer() {
    let (_directory, db) = database();
    add_user(&db, "contention", false, false).await;
    let service = AuthService::new(db.clone());
    let (token, actor) = login(&service, "contention").await;
    let id = actor.session_id().unwrap().to_owned();
    db.transaction(move |tx| {
        tx.execute(
            "UPDATE sessions SET last_activity_at=last_activity_at-120 WHERE id=?1",
            [id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let lock = rusqlite::Connection::open(db.layout().database()).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = std::time::Instant::now();
    assert_eq!(
        service
            .authenticate_session(&token, true)
            .await
            .unwrap()
            .user_id,
        actor.user_id
    );
    // Far below the five-second SQLite busy timeout this read must not wait for.
    assert!(before.elapsed() < std::time::Duration::from_secs(3));
    lock.execute_batch("ROLLBACK").unwrap();
    service.authenticate_session(&token, true).await.unwrap();
    let id = actor.session_id().unwrap().to_owned();
    let last: i64 = db
        .run(move |c| {
            Ok(c.query_row(
                "SELECT last_activity_at FROM sessions WHERE id=?1",
                [id],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(last >= unix_now().unwrap() - 2);
}

#[tokio::test]
async fn distributed_login_failures_share_an_account_delay_and_clear_after_success() {
    let (_directory, db) = database();
    add_user(&db, "target", false, false).await;
    let service = AuthService::new(db.clone());
    for index in 0..30 {
        let result = service
            .login(
                "TARGET",
                "wrong",
                SessionMetadata {
                    client_ip: Some(format!("2001:db8:{index:x}::1")),
                    ..Default::default()
                },
                None,
            )
            .await;
        if index < 15 {
            assert!(matches!(result, Err(AppError::InvalidCredentials)));
        } else {
            assert!(matches!(
                result,
                Err(AppError::RateLimited {
                    retry_after: 1..=60
                })
            ));
        }
    }
    for index in 0..30 {
        assert!(matches!(
            service
                .login(
                    "target",
                    "wrong",
                    SessionMetadata {
                        client_ip: Some(format!("2001:db8:ffff:1::{index:x}")),
                        ..Default::default()
                    },
                    None
                )
                .await,
            Err(AppError::RateLimited { .. })
        ));
    }
    let metadata = SessionMetadata {
        client_ip: Some("198.51.100.77".into()),
        ..Default::default()
    };
    assert!(matches!(
        service
            .login(
                "target",
                "correct horse battery staple",
                metadata.clone(),
                None
            )
            .await,
        Err(AppError::RateLimited { .. })
    ));
    db.transaction(|tx| {
        tx.execute("UPDATE login_throttles SET blocked_until=0", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(matches!(
        service
            .login("target", "correct horse battery staple", metadata, None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
    let count = db
        .run(|conn| {
            Ok(conn.query_row(
                "SELECT count(*) FROM login_throttles WHERE key=?1",
                [token_hash("login-account\0target")],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn ipv6_subnet_login_throttle_preserves_exact_session_address() {
    let (_directory, db) = database();
    add_user(&db, "target", false, false).await;
    let service = AuthService::new(db.clone());
    for index in 1..=6 {
        let result = service
            .login(
                "target",
                "wrong",
                SessionMetadata {
                    client_ip: Some(format!("2001:db8:1:2::{index}")),
                    ..Default::default()
                },
                None,
            )
            .await;
        if index <= 5 {
            assert!(matches!(result, Err(AppError::InvalidCredentials)));
        } else {
            assert!(matches!(result, Err(AppError::RateLimited { .. })));
        }
    }
    let exact = "2001:db8:1:3::abc";
    let result = service
        .login(
            "target",
            "correct horse battery staple",
            SessionMetadata {
                client_ip: Some(exact.into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let LoginResult::Authenticated(session) = result else {
        panic!()
    };
    assert_eq!(
        service.list_sessions(&session.actor).await.unwrap()[0]
            .client_ip
            .as_deref(),
        Some(exact)
    );
}

#[tokio::test]
async fn unknown_addresses_do_not_share_a_global_login_counter() {
    let (_directory, db) = database();
    add_user(&db, "target", false, false).await;
    db.transaction(|tx| {
        tx.execute("INSERT INTO login_throttles VALUES('expired',1,1,1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let service = AuthService::new(db.clone());
    for index in 0..21 {
        assert!(matches!(
            service
                .login(
                    &format!("absent{index}"),
                    "wrong",
                    SessionMetadata::default(),
                    None
                )
                .await,
            Err(AppError::InvalidCredentials)
        ));
    }
    login(&service, "target").await;
    let expired: bool = db
        .run(|conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM login_throttles WHERE key='expired')",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(!expired, "failed-attempt bookkeeping prunes expired rows");
}

#[test]
fn passwords_hashed_by_argon2_0_5_still_verify() {
    // Generated by argon2 0.5.3 before upgrading the implementation. Keep this
    // literal so a future change cannot silently invalidate stored credentials.
    let encoded = "$argon2id$v=19$m=19456,t=2,p=1$b25lbG9vcC10ZXN0LXNhbHQ$IvEJSN6B09/0A+KPfHbKYslAL282h96SyeXGJ4AmVoc";
    assert!(oneloop::auth::password::verify_password("legacy password", encoded).unwrap());
    assert!(!oneloop::auth::password::verify_password("wrong password", encoded).unwrap());
}
