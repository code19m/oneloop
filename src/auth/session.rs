//! Browser authentication retains fixed session caps, idle/absolute expiry and explicit revocation.
use super::*;

impl AuthService {
    pub async fn login(
        &self,
        username: &str,
        password: &str,
        mut metadata: SessionMetadata,
        revoke_session_id: Option<String>,
    ) -> AppResult<LoginResult> {
        if let Some(name) = metadata.client_name.as_deref() {
            crate::text::validate(name, "clientName", crate::text::Lines::Single, false)?;
        }
        metadata.client_name = metadata
            .client_name
            .filter(|name| !crate::text::is_blank(name));
        let client_ip = metadata.client_ip.clone();
        let mut failure_outcome = "invalid_credentials";
        let result = self
            .login_inner(
                username,
                password,
                metadata,
                revoke_session_id,
                &mut failure_outcome,
            )
            .await;
        let outcome = match &result {
            Err(AppError::InvalidCredentials) => Some(failure_outcome),
            Err(AppError::RateLimited { .. }) => Some("rate_limited"),
            Err(AppError::Rule {
                kind: crate::error::RuleKind::TemporaryPasswordExpired,
                ..
            }) => Some(failure_outcome),
            _ => None,
        };
        if let Some(outcome) = outcome {
            let username = normalize_username(username).unwrap_or_else(|_| "<invalid>".into());
            tracing::warn!(target: "oneloop::auth", username, client_ip, outcome, "login rejected");
        }
        result
    }

    pub(super) async fn login_inner(
        &self,
        username: &str,
        password: &str,
        metadata: SessionMetadata,
        revoke_session_id: Option<String>,
        failure_outcome: &mut &'static str,
    ) -> AppResult<LoginResult> {
        let normalized = normalize_username(username).ok();
        let lookup_name = normalized
            .clone()
            .unwrap_or_else(|| format!("invalid:{}", token_hash(username)));
        let throttle_key = login_throttle_key(&lookup_name, metadata.client_ip.as_deref());
        let ip_throttle_key = login_ip_throttle_key(metadata.client_ip.as_deref());
        let account_key = token_hash(&format!("login-account\0{lookup_name}"));
        // Wait outside the blocking pool, then check the latest failure state.
        // Hold admission through bookkeeping so waiting attempts observe the delay.
        let permit = password_work_permit().await?;
        let now = unix_now()?;
        self.check_login_throttle(&throttle_key, now).await?;
        if let Some(key) = &ip_throttle_key {
            self.check_login_throttle(key, now).await?;
        }
        self.check_login_throttle(&account_key, now).await?;
        let user = self.db.run(move |connection| {
            connection.query_row(
                "SELECT id, username, display_name, password_hash, is_admin, is_active, must_change_password, revision,
                        password_changed_at
                 FROM users WHERE username = ?1",
                [lookup_name],
                |row| Ok(LoginUser {
                    user: User {
                        id: row.get(0)?, username: row.get(1)?, display_name: row.get(2)?,
                        is_admin: row.get(4)?, is_active: row.get(5)?, must_change_password: row.get(6)?,
                        revision: row.get(7)?,
                    },
                    password_hash: row.get(3)?,
                    password_changed_at: row.get(8)?,
                }),
            ).optional().map_err(AppError::from)
        }).await?;

        let password_owned = password.to_owned();
        let hash = user.as_ref().map(|u| u.password_hash.clone());
        let valid = password_work(&permit, move || {
            let hash = hash.unwrap_or_else(dummy_password_hash);
            verify_password(&password_owned, &hash)
        })
        .await?;
        let now = unix_now()?;
        if !valid || user.as_ref().is_none_or(|user| !user.user.is_active) {
            if user.as_ref().is_some_and(|user| !user.user.is_active) {
                *failure_outcome = "inactive";
            }
            self.record_login_failure(
                throttle_key,
                now,
                LOGIN_FAILURES_BEFORE_DELAY,
                LOGIN_FAILURE_WINDOW_SECONDS,
            )
            .await?;
            if let Some(key) = ip_throttle_key {
                self.record_login_failure(
                    key,
                    now,
                    IP_FAILURES_BEFORE_DELAY,
                    LOGIN_FAILURE_WINDOW_SECONDS,
                )
                .await?;
            }
            self.record_login_failure(
                account_key,
                now,
                ACCOUNT_FAILURES_BEFORE_DELAY,
                ACCOUNT_DELAY_CAP_SECONDS,
            )
            .await?;
            return Err(AppError::InvalidCredentials);
        }

        let user = user.expect("successful password verification requires an active account");
        // Only after the password matched, so the answer reveals nothing new.
        if user.user.must_change_password
            && self
                .policy
                .temporary_password_expired(user.password_changed_at, now)
        {
            *failure_outcome = "temporary_password_expired";
            return Err(AppError::rule(
                crate::error::RuleKind::TemporaryPasswordExpired,
                "This temporary password has expired. Ask an admin to reset it.",
            ));
        }
        let token = random_token()?;
        let token_hash = token_hash(&token);
        let session_id = Uuid::now_v7().to_string();
        let user_for_tx = user.user.clone();
        let verified_password_hash = user.password_hash.clone();
        let session_id_for_tx = session_id.clone();
        let result = self.db.transaction(move |tx| {
            let still_current: bool = tx.query_row(
                "SELECT is_active = 1 AND password_hash = ?2 FROM users WHERE id = ?1",
                rusqlite::params![user_for_tx.id, verified_password_hash], |row| row.get(0)
            )?;
            if !still_current { return Err(AppError::InvalidCredentials); }

            tx.execute("DELETE FROM login_throttles WHERE key IN (?1,?2)", rusqlite::params![throttle_key, account_key])?;

            tx.execute(
                "UPDATE sessions SET revoked_at = ?1
                 WHERE user_id = ?2 AND revoked_at IS NULL
                   AND (idle_expires_at <= ?1 OR absolute_expires_at <= ?1)",
                rusqlite::params![now, user_for_tx.id],
            )?;
            if let Some(revoke_id) = revoke_session_id {
                let changed = tx.execute(
                    "UPDATE sessions SET revoked_at = ?1
                     WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL
                       AND idle_expires_at > ?1 AND absolute_expires_at > ?1",
                    rusqlite::params![now, revoke_id, user_for_tx.id],
                )?;
                if changed != 1 {
                    return Err(AppError::Conflict("selected session is no longer active".into()));
                }
            }
            let active: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sessions
                 WHERE user_id = ?1 AND revoked_at IS NULL
                   AND idle_expires_at > ?2 AND absolute_expires_at > ?2",
                rusqlite::params![user_for_tx.id, now], |row| row.get(0),
            )?;
            if active >= MAX_BROWSER_SESSIONS {
                return Ok(LoginTransaction::Limit(list_sessions_tx(tx, &user_for_tx.id, None, now)?));
            }
            let absolute_expires_at = now + SESSION_ABSOLUTE_SECONDS;
            tx.execute(
                "INSERT INTO sessions
                 (id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,
                  absolute_expires_at,client_name,client_ip,user_agent)
                 VALUES (?1,?2,?3,?4,?4,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![session_id_for_tx, user_for_tx.id, token_hash, now,
                    now + SESSION_IDLE_SECONDS, absolute_expires_at, metadata.client_name,
                    metadata.client_ip, metadata.user_agent],
            )?;
            security_event(tx,&user_for_tx.id,Some(&user_for_tx.id),"session.created",
                serde_json::json!({"sessionId":session_id_for_tx}),now)?;
            Ok(LoginTransaction::Issued)
        }).await?;

        match result {
            LoginTransaction::Limit(sessions) => Ok(LoginResult::SessionLimit { sessions }),
            LoginTransaction::Issued => Ok(LoginResult::Authenticated(IssuedSession {
                token,
                absolute_expires_at: now + SESSION_ABSOLUTE_SECONDS,
                actor: actor_from_user(user.user, session_id, now),
            })),
        }
    }

    pub async fn authenticate_session(&self, token: &str, meaningful: bool) -> AppResult<Actor> {
        if token.len() < 32 || token.len() > 256 {
            return Err(AppError::Unauthorized);
        }
        let hash = token_hash(token);
        let now = unix_now()?;
        let session = self.db.run(move |connection| {
            let session = connection.prepare_cached("SELECT s.id,s.user_id,s.authenticated_at,s.last_activity_at,s.absolute_expires_at,
                        s.idle_expires_at,s.revoked_at,u.username,u.display_name,u.is_admin,u.is_active,
                        u.must_change_password
                 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1")?.query_row(
                [&hash],
                |row| Ok(SessionAuthentication {
                    session_id: row.get(0)?, user_id: row.get(1)?, authenticated_at: row.get(2)?,
                    last_activity_at: row.get(3)?, absolute_expires_at: row.get(4)?, idle_expires_at: row.get(5)?,
                    revoked_at: row.get(6)?, username: row.get(7)?, display_name: row.get(8)?,
                    is_admin: row.get(9)?, is_active: row.get(10)?, must_change_password: row.get(11)?,
                }),
            ).optional()?;
            let Some(session) = session else { return Err(AppError::Unauthorized); };
            Ok(session)
        }).await?;
        if !session.is_active
            || session.revoked_at.is_some()
            || session.idle_expires_at <= now
            || session.absolute_expires_at <= now
        {
            if session.revoked_at.is_none() {
                let id = session.session_id.clone();
                if let Err(error) = self
                    .db
                    .try_activity_write(move |tx| {
                        tx.prepare_cached(
                            "UPDATE sessions SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",
                        )?
                        .execute(rusqlite::params![now, id])?;
                        Ok(())
                    })
                    .await
                {
                    error.log_server_error();
                }
            }
            return Err(AppError::Unauthorized);
        }
        if meaningful && session.last_activity_at <= now.saturating_sub(60) {
            let id = session.session_id.clone();
            let idle = (now + SESSION_IDLE_SECONDS).min(session.absolute_expires_at);
            self.db.try_activity_write(move |tx| {
                tx.prepare_cached("UPDATE sessions SET last_activity_at=?1,idle_expires_at=?2 WHERE id=?3
                    AND revoked_at IS NULL AND idle_expires_at>?1 AND absolute_expires_at>?1 AND last_activity_at<=?4")?.execute(
                    rusqlite::params![now, idle, id, now.saturating_sub(60)])?;
                Ok(())
            }).await?;
        }
        Ok(Actor {
            user_id: session.user_id,
            username: session.username,
            display_name: session.display_name,
            is_admin: session.is_admin,
            must_change_password: session.must_change_password,
            authenticated_at: session.authenticated_at,
            source: ActorSource::BrowserSession {
                session_id: session.session_id,
            },
        })
    }

    pub async fn logout(&self, actor: &Actor) -> AppResult<()> {
        let Some(session_id) = actor.session_id() else {
            return Err(AppError::Forbidden);
        };
        let session_id = session_id.to_owned();
        let user_id = actor.user_id.clone();
        let now = unix_now()?;
        self.db.transaction(move |tx| {
            tx.execute("UPDATE sessions SET revoked_at=?1 WHERE id=?2 AND user_id=?3 AND revoked_at IS NULL",
                rusqlite::params![now, session_id, user_id])?;
            security_event(tx,&user_id,Some(&user_id),"session.signed_out",
                serde_json::json!({"sessionId":session_id}),now)?;
            Ok(())
        }).await
    }

    pub async fn list_sessions(&self, actor: &Actor) -> AppResult<Vec<SessionSummary>> {
        actor.require_ready()?;
        let current = actor.session_id().map(str::to_owned);
        let user_id = actor.user_id.clone();
        let now = unix_now()?;
        self.db
            .run(move |connection| {
                list_sessions_connection(connection, &user_id, current.as_deref(), now)
            })
            .await
    }

    pub async fn revoke_session(&self, actor: &Actor, target: &str) -> AppResult<()> {
        actor.require_ready()?;
        let current = actor.session_id().ok_or(AppError::Forbidden)?;
        if current == target {
            return Err(AppError::validation(
                "sessionId",
                "use sign out to revoke the current session",
            ));
        }
        let target = target.to_owned();
        let actor = actor.clone();
        let user_id = actor.user_id.clone();
        let now = unix_now()?;
        self.db.transaction(move |tx| {
            refresh_actor_connection(tx, &actor)?;
            let changed = tx.execute(
                "UPDATE sessions SET revoked_at=?1 WHERE id=?2 AND user_id=?3 AND revoked_at IS NULL",
                rusqlite::params![now, target, user_id],
            )?;
            if changed == 0 { return Err(AppError::NotFound { resource: "session" }); }
            security_event(tx,&user_id,Some(&user_id),"session.revoked",
                serde_json::json!({"sessionId":target}),now)?;
            Ok(())
        }).await
    }

    pub async fn revoke_other_sessions(&self, actor: &Actor) -> AppResult<u64> {
        actor.require_ready()?;
        let current = actor.session_id().ok_or(AppError::Forbidden)?.to_owned();
        let actor = actor.clone();
        let user_id = actor.user_id.clone();
        let now = unix_now()?;
        self.db.transaction(move |tx| {
            refresh_actor_connection(tx, &actor)?;
            let revoked=tx.execute(
                "UPDATE sessions SET revoked_at=?1 WHERE user_id=?2 AND id<>?3 AND revoked_at IS NULL",
                rusqlite::params![now, user_id, current],
            )? as u64;
            if revoked>0 { security_event(tx,&user_id,Some(&user_id),"sessions.revoked_others",
                serde_json::json!({"count":revoked}),now)?; }
            Ok(revoked)
        }).await
    }
}
