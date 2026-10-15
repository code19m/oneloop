use oneloop::{
    AppError,
    auth::{
        AccountUpdate, Actor, ActorSource, AuthService, LoginResult, NewUser, SessionMetadata,
        create_user,
        password::{Blocklist, PasswordPolicy},
        token_hash, unix_now,
    },
};

use crate::support::{auth_service, database, query_one};

use super::{PASSWORD, add_user};

async fn login(service: &AuthService, username: &str) -> (String, Actor) {
    match service
        .login(username, PASSWORD, SessionMetadata::default(), None)
        .await
        .unwrap()
    {
        LoginResult::Authenticated(session) => (session.token, session.actor),
        LoginResult::SessionLimit { .. } => panic!("unexpected session limit"),
    }
}

#[tokio::test]
async fn temporary_password_sessions_cannot_list_sessions() {
    let (_directory, db) = database();
    add_user(&db, "temporary", false, true).await;
    let service = auth_service(&db);
    let (_, temporary) = login(&service, "temporary").await;
    assert!(matches!(
        service.list_sessions(&temporary).await,
        Err(AppError::PreconditionFailed(_))
    ));
}

#[tokio::test]
async fn self_service_writes_recheck_a_session_revoked_after_authentication() {
    let (_directory, db) = database();
    let user_id = add_user(&db, "person", false, false).await;
    let service = auth_service(&db);
    let (_, current) = login(&service, "person").await;
    let (other_token, other) = login(&service, "person").await;
    let revoked = current.session_id().unwrap().to_owned();
    db.run(move |connection| {
        connection.execute("INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at) VALUES('grant',?1,'client','Client',1,1,9999999999)", [&user_id])?;
        // The session ends after a request was authenticated with it.
        connection.execute("UPDATE sessions SET revoked_at=1 WHERE id=?1", [&revoked])?;
        Ok(())
    })
    .await
    .unwrap();
    let other_session = other.session_id().unwrap();
    for (write, result) in [
        (
            "profile",
            service.update_profile(&current, "Changed").await.map(drop),
        ),
        (
            "session",
            service.revoke_session(&current, other_session).await,
        ),
        (
            "other sessions",
            service.revoke_other_sessions(&current).await.map(drop),
        ),
        ("app", service.revoke_connected_app(&current, "grant").await),
        // A wrong password, because the commit rechecks a correct one.
        (
            "recent sign-in",
            service
                .recent_authenticate(&current, "wrong")
                .await
                .map(drop),
        ),
        (
            "password",
            service
                .change_password(&current, "wrong", "a new password for the person")
                .await
                .map(drop),
        ),
    ] {
        assert!(
            matches!(result, Err(AppError::Unauthorized)),
            "{write}: {result:?}"
        );
    }
    assert!(
        service
            .authenticate_session(&other_token, false)
            .await
            .is_ok()
    );
    // A revoked session can't count toward the password throttle either.
    let (name, app_revoked, throttles): (String, Option<i64>, i64) = query_one(
        &db,
        "SELECT (SELECT display_name FROM users),(SELECT revoked_at FROM mcp_grants),
                (SELECT COUNT(*) FROM login_throttles)",
        [],
    )
    .await;
    assert_eq!((name.as_str(), app_revoked, throttles), ("person", None, 0));
}

#[tokio::test]
async fn session_lists_and_revocation_are_owner_private_even_for_admins() {
    let (_directory, db) = database();
    add_user(&db, "administrator", true, false).await;
    add_user(&db, "ordinary", false, false).await;
    let service = auth_service(&db);
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
    let service = auth_service(&db);
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
        .change_password(&second, PASSWORD, "an even better password")
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
    let revoked: Option<i64> = query_one(
        &db,
        "SELECT revoked_at FROM mcp_grants WHERE id='grant-1'",
        [],
    )
    .await;
    assert!(revoked.is_some());
}

#[tokio::test]
async fn the_last_active_administrator_cannot_be_demoted() {
    let (_directory, db) = database();
    let admin_id = add_user(&db, "onlyadmin", true, false).await;
    let service = auth_service(&db);
    let (_, admin) = login(&service, "onlyadmin").await;
    let demotion = || AccountUpdate {
        display_name: "onlyadmin".into(),
        is_admin: false,
        is_active: true,
        expected_revision: 1,
    };
    let error = service
        .update_account(&admin, &admin_id, demotion())
        .await
        .unwrap_err();
    assert_eq!((error.code(), error.status().as_u16()), ("last_admin", 409));

    add_user(&db, "secondadmin", true, false).await;
    service
        .update_account(&admin, &admin_id, demotion())
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
    let service = auth_service(&db);
    let limited = service
        .login("sessionuser", PASSWORD, SessionMetadata::default(), None)
        .await
        .unwrap();
    assert!(matches!(limited,LoginResult::SessionLimit{ref sessions} if sessions.len()==10));
    // Another person's session can't be chosen, and it stays signed in.
    add_user(&db, "otheruser", false, false).await;
    let (other_token, other) = login(&service, "otheruser").await;
    let refused = service
        .login(
            "sessionuser",
            PASSWORD,
            SessionMetadata::default(),
            other.session_id().map(str::to_owned),
        )
        .await;
    assert!(matches!(refused, Err(AppError::Conflict(_))));
    service
        .authenticate_session(&other_token, false)
        .await
        .unwrap();
    let issued = service
        .login(
            "sessionuser",
            PASSWORD,
            SessionMetadata::default(),
            Some("session-0".into()),
        )
        .await
        .unwrap();
    assert!(matches!(issued, LoginResult::Authenticated(_)));
    let count: i64 = query_one(
        &db,
        "SELECT COUNT(*) FROM sessions WHERE user_id=?1 AND revoked_at IS NULL",
        [user_id],
    )
    .await;
    assert_eq!(count, 10);
}

#[tokio::test]
async fn idle_sessions_are_refused_and_revoked() {
    let (_directory, db) = database();
    add_user(&db, "limited", false, false).await;
    let service = auth_service(&db);
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
    let revoked: Option<i64> = query_one(
        &db,
        "SELECT revoked_at FROM sessions WHERE id=?1",
        [session_id],
    )
    .await;
    assert!(revoked.is_some());
}

#[tokio::test]
async fn passive_authentication_does_not_extend_idle_activity() {
    let (_directory, db) = database();
    add_user(&db, "passive", false, false).await;
    let service = auth_service(&db);
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
    let updated: i64 = query_one(
        &db,
        "SELECT last_activity_at FROM sessions WHERE id=?1",
        [session_id],
    )
    .await;
    assert!(updated > old);
}

#[tokio::test]
async fn sensitive_account_changes_require_fresh_browser_authentication() {
    let (_directory, db) = database();
    add_user(&db, "adminuser", true, false).await;
    let service = auth_service(&db);
    let (_, admin) = login(&service, "adminuser").await;
    let created = service
        .create_account(&admin, "newperson", "New Person", false)
        .await
        .unwrap();
    assert!(created.temporary_password.len() >= 32);
    let session_id = admin.session_id().unwrap().to_owned();
    // Every change reads the sign-in time from the session, not the actor.
    let signed_in_at = |at: i64| {
        let session_id = session_id.clone();
        db.run(move |connection| {
            connection.execute(
                "UPDATE sessions SET authenticated_at=?1 WHERE id=?2",
                rusqlite::params![at, session_id],
            )?;
            Ok(())
        })
    };
    let deactivate = || AccountUpdate {
        display_name: "New Person".into(),
        is_admin: false,
        is_active: false,
        expected_revision: created.user.revision,
    };
    signed_in_at(0).await.unwrap();
    let error = service
        .update_account(&admin, &created.user.id, deactivate())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "recent_auth_required");
    signed_in_at(unix_now().unwrap()).await.unwrap();
    let updated = service
        .update_account(&admin, &created.user.id, deactivate())
        .await
        .unwrap();
    assert!(!updated.is_active);
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
                    password: PASSWORD.into(),
                    is_admin: false,
                    must_change_password: false,
                },
                unix_now()?,
                &PasswordPolicy::default(),
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
                    password: PASSWORD.into(),
                    is_admin: false,
                    must_change_password: false,
                },
                unix_now()?,
                &PasswordPolicy::default(),
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
    let service = auth_service(&db);
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

fn refusal(error: AppError) -> String {
    match error {
        AppError::Validation { field, message } if field == "password" => message,
        error => panic!("expected a password refusal, got {error:?}"),
    }
}

#[tokio::test]
async fn stricter_password_rules_apply_to_every_password_by_role() {
    let (_directory, db) = database();
    add_user(&db, "chief", true, false).await;
    add_user(&db, "longusername", false, false).await;
    // The administrator chose a short password under the default rules.
    let (_, chief) = login(&auth_service(&db), "chief").await;
    auth_service(&db)
        .change_password(&chief, PASSWORD, "short pass")
        .await
        .unwrap();
    let service = AuthService::new(
        db.clone(),
        PasswordPolicy {
            min_length: 12,
            admin_min_length: 16,
            blocklist: Some(std::sync::Arc::new(Blocklist::from_text(
                "Summer of 2026\n",
            ))),
            temporary_lifetime_seconds: None,
        },
    );
    let current = PASSWORD;
    let (_, member) = login(&service, "longusername").await;
    for (password, message) in [
        ("eleven char", "Use at least 12 characters."),
        (
            "SUMMER OF 2026",
            "This password is too easy to guess. Choose another one.",
        ),
        (
            "LongUserName",
            "This password is too easy to guess. Choose another one.",
        ),
    ] {
        let Err(error) = service.change_password(&member, current, password).await else {
            panic!("{password} was accepted");
        };
        assert_eq!(refusal(error), message, "{password}");
    }
    service
        .change_password(&member, current, "twelve chars")
        .await
        .unwrap();
    let Err(error) = service
        .change_password(&chief, "short pass", "fifteen chars!!")
        .await
    else {
        panic!("an admin password needs 16 characters");
    };
    assert_eq!(refusal(error), "Use at least 16 characters.");
    // Temporary passwords from admins are long enough for any role.
    let created = service
        .create_account(&chief, "newcomer", "Newcomer", true)
        .await
        .unwrap();
    assert!(created.temporary_password.len() >= 16);
    let reset = service
        .reset_account_password(&chief, &created.user.id)
        .await
        .unwrap();
    assert!(reset.len() >= 16);
    assert!(matches!(
        service
            .login("newcomer", &reset, SessionMetadata::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
    // Sign-in never applies the rules, so the short password still works.
    assert!(matches!(
        service
            .login("chief", "short pass", SessionMetadata::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
}

#[tokio::test]
async fn temporary_passwords_stop_working_after_the_configured_lifetime() {
    let (_directory, db) = database();
    // Set at 1_700_000_000, long before now.
    add_user(&db, "invited", false, true).await;
    let password = PASSWORD;
    let weekly = AuthService::new(
        db.clone(),
        PasswordPolicy {
            temporary_lifetime_seconds: Some(7 * 24 * 60 * 60),
            ..PasswordPolicy::default()
        },
    );
    let Err(error) = weekly
        .login("invited", password, SessionMetadata::default(), None)
        .await
    else {
        panic!("an expired temporary password signed in");
    };
    assert_eq!(error.code(), "temporary_password_expired");
    assert_eq!(error.status().as_u16(), 401);
    // Without the setting, a temporary password works until it is changed.
    assert!(matches!(
        auth_service(&db)
            .login("invited", password, SessionMetadata::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
    // A wrong password still gets the usual answer.
    assert!(matches!(
        weekly
            .login(
                "invited",
                "wrong password",
                SessionMetadata::default(),
                None
            )
            .await,
        Err(AppError::InvalidCredentials)
    ));
    db.run(|connection| {
        connection.execute(
            "UPDATE users SET password_changed_at=?1 WHERE username='invited'",
            [unix_now()?],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let (_, invited) = login(&weekly, "invited").await;
    assert!(invited.must_change_password);
    // A password the person chose never expires.
    weekly
        .change_password(&invited, password, "my own password")
        .await
        .unwrap();
    db.run(|connection| {
        connection.execute(
            "UPDATE users SET password_changed_at=1 WHERE username='invited'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(matches!(
        weekly
            .login(
                "invited",
                "my own password",
                SessionMetadata::default(),
                None
            )
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
}

#[tokio::test]
async fn the_cli_applies_the_password_settings() {
    use assert_cmd::Command;
    let (directory, _db) = database();
    let lists = crate::support::scratch_dir();
    let blocklist = lists.path().join("common.txt");
    std::fs::write(&blocklist, "Summer of 2026\n").unwrap();
    let command = |args: &[&str], password: &str| {
        let mut command = Command::cargo_bin("oneloop").unwrap();
        command
            .env_clear()
            .env("ONELOOP_DATA_DIR", directory.path())
            .env("ONELOOP_PASSWORD_MIN_LENGTH", "10")
            .env("ONELOOP_ADMIN_PASSWORD_MIN_LENGTH", "14")
            .env("ONELOOP_PASSWORD_BLOCKLIST", &blocklist)
            .args(args)
            .write_stdin(format!("{password}\n"));
        command
    };
    let add = ["user", "add", "member", "--password-stdin"];
    command(&add, "nine char")
        .assert()
        .code(2)
        .stderr(predicates::str::contains("Use at least 10 characters."));
    command(&add, "summer OF 2026")
        .assert()
        .code(2)
        .stderr(predicates::str::contains("too easy to guess"));
    command(&add, "ten chars!").assert().success();
    let admin = ["user", "add", "boss", "--admin", "--password-stdin"];
    command(&admin, "thirteen char")
        .assert()
        .code(2)
        .stderr(predicates::str::contains("Use at least 14 characters."));
    command(&admin, "fourteen chars").assert().success();
    // A reset uses the minimum of the account's role.
    command(
        &["user", "passwd", "boss", "--password-stdin"],
        "ten chars!",
    )
    .assert()
    .code(2)
    .stderr(predicates::str::contains("Use at least 14 characters."));
    command(
        &["user", "passwd", "member", "--password-stdin"],
        "ten chars?",
    )
    .assert()
    .success();
    Command::cargo_bin("oneloop")
        .unwrap()
        .env_clear()
        .env("ONELOOP_DATA_DIR", directory.path())
        .env(
            "ONELOOP_PASSWORD_BLOCKLIST",
            lists.path().join("missing.txt"),
        )
        .args(["user", "passwd", "member", "--password-stdin"])
        .write_stdin("ten chars!\n")
        .assert()
        .code(2)
        .stderr(predicates::str::contains("ONELOOP_PASSWORD_BLOCKLIST"));
}

#[tokio::test]
async fn cli_creation_and_reset_enforce_the_password_byte_limit() {
    use assert_cmd::Command;
    let (directory, db) = database();
    let command = |args: &[&str], password: &str| {
        let mut command = Command::cargo_bin("oneloop").unwrap();
        command
            .env_clear()
            .env("ONELOOP_DATA_DIR", directory.path())
            .args(args)
            .write_stdin(format!("{password}\n"));
        command
    };
    let maximum = "😀".repeat(4096);
    let oversized = format!("{maximum}x");
    command(&["user", "add", "too-long", "--password-stdin"], &oversized)
        .assert()
        .code(2);
    command(
        &["user", "add", "person", "--admin", "--password-stdin"],
        &maximum,
    )
    .assert()
    .success();
    command(
        &["user", "passwd", "person", "--password-stdin"],
        &oversized,
    )
    .assert()
    .code(2);
    let auth = auth_service(&db);
    assert!(matches!(
        auth.login("person", &maximum, Default::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
    let replacement = "x".repeat(16384);
    command(
        &["user", "passwd", "person", "--password-stdin"],
        &replacement,
    )
    .assert()
    .success();
    assert!(matches!(
        auth.login("person", &replacement, Default::default(), None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
}

#[tokio::test]
async fn password_gates_share_account_delay_across_sessions_and_clear_on_success() {
    let (_directory, db) = database();
    add_user(&db, "confirm", false, false).await;
    let service = auth_service(&db);
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
        matches!(service.recent_authenticate(&other, PASSWORD).await,
        Err(AppError::RateLimited { retry_after }) if retry_after > 0)
    );
    assert!(
        matches!(service.change_password(&actor, PASSWORD, "new password").await,
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
    let refreshed = service.recent_authenticate(&other, PASSWORD).await.unwrap();
    let failures: i64 = query_one(&db, "SELECT COUNT(*) FROM login_throttles", []).await;
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
        let service = auth_service(&db);
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
    let service = auth_service(&db);
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
async fn password_commit_rechecks_revocation_and_expiry_after_verification() {
    // The idle expiry never comes after the absolute one, so it covers both.
    for condition in ["revoked_at=1", "idle_expires_at=0"] {
        for change_password in [true, false] {
            let (_directory, db) = database();
            let user_id = add_user(&db, "racing", false, false).await;
            let service = auth_service(&db);
            let (_, actor) = login(&service, "racing").await;
            let (other_token, _) = login(&service, "racing").await;
            let before: (String, i64) = query_one(
                &db,
                "SELECT password_hash,revision FROM users WHERE username='racing'",
                [],
            )
            .await;
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
                    .change_password(&actor, PASSWORD, "replacement")
                    .await
            } else {
                service.recent_authenticate(&actor, PASSWORD).await
            };
            assert!(
                matches!(result, Err(AppError::Unauthorized)),
                "{condition}, change={change_password}"
            );
            let after: (String, i64, Option<i64>, i64) = query_one(&db, "SELECT password_hash,revision,(SELECT revoked_at FROM mcp_grants WHERE id='race-grant'),
                 (SELECT COUNT(*) FROM security_events WHERE event_type='password.changed') FROM users WHERE username='racing'", []).await;
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
    let service = auth_service(&db);
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
    let last: i64 = query_one(
        &db,
        "SELECT last_activity_at FROM sessions WHERE id=?1",
        [id],
    )
    .await;
    assert!(last >= unix_now().unwrap() - 2);
}

#[tokio::test]
async fn distributed_login_failures_share_an_account_delay_and_clear_after_success() {
    let (_directory, db) = database();
    add_user(&db, "target", false, false).await;
    let service = auth_service(&db);
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
            .login("target", PASSWORD, metadata.clone(), None)
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
            .login("target", PASSWORD, metadata, None)
            .await
            .unwrap(),
        LoginResult::Authenticated(_)
    ));
    let count = query_one::<i64>(
        &db,
        "SELECT count(*) FROM login_throttles WHERE key=?1",
        [token_hash("login-account\0target")],
    )
    .await;
    assert_eq!(count, 0);
}

#[tokio::test]
async fn ipv6_subnet_login_throttle_preserves_exact_session_address() {
    let (_directory, db) = database();
    add_user(&db, "target", false, false).await;
    let service = auth_service(&db);
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
            PASSWORD,
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
    let service = auth_service(&db);
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
    let expired: bool = query_one(
        &db,
        "SELECT EXISTS(SELECT 1 FROM login_throttles WHERE key='expired')",
        [],
    )
    .await;
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
