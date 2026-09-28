//! Account/profile/password changes preserve recent-authentication and last-administrator guards.
use super::*;

impl AuthService {
    pub async fn recent_authenticate(
        &self,
        actor: &Actor,
        password: &str,
    ) -> AppResult<IssuedSession> {
        actor.require_ready()?;
        let session_id = actor.session_id().ok_or(AppError::Forbidden)?.to_owned();
        let permit = password_work_permit().await?;
        let verified_hash = self
            .verify_current_password(actor, password, "password", &permit)
            .await?;
        let token = random_token()?;
        let new_token_hash = token_hash(&token);
        let user_id = actor.user_id.clone();
        let (authenticated_at, absolute_expires_at) = self.db.transaction(move |connection| {
            let now = unix_now()?;
            let changed = connection.execute(
                "UPDATE sessions SET authenticated_at=?1,token_hash=?2 WHERE id=?3 AND user_id=?5
                 AND revoked_at IS NULL AND idle_expires_at>?1 AND absolute_expires_at>?1
                 AND EXISTS(SELECT 1 FROM users WHERE id=sessions.user_id AND is_active=1 AND password_hash=?4)",
                rusqlite::params![now,new_token_hash,session_id,verified_hash,user_id],
            )?;
            if changed != 1 { return Err(AppError::Unauthorized); }
            let absolute_expires_at = connection.query_row(
                "SELECT absolute_expires_at FROM sessions WHERE id=?1",
                [&session_id], |row| row.get(0),
            )?;
            Ok((now, absolute_expires_at))
        }).await?;
        let mut refreshed = actor.clone();
        refreshed.authenticated_at = authenticated_at;
        Ok(IssuedSession {
            token,
            absolute_expires_at,
            actor: refreshed,
        })
    }

    pub async fn change_password(
        &self,
        actor: &Actor,
        current: &str,
        new: &str,
    ) -> AppResult<IssuedSession> {
        let session_id = actor.session_id().ok_or(AppError::Forbidden)?.to_owned();
        let permit = password_work_permit().await?;
        let verified_hash = self
            .verify_current_password(actor, current, "currentPassword", &permit)
            .await?;
        let new_owned = new.to_owned();
        let new_hash = password_work(&permit, move || hash_password(&new_owned)).await?;
        let user_id = actor.user_id.clone();
        let token = random_token()?;
        let new_token_hash = token_hash(&token);
        let (authenticated_at, absolute_expires_at) = self.db.transaction(move |tx| {
            // Recheck authority at commit, including temporary-password sessions.
            // Rotating exactly one live owned session is part of this transaction;
            // any later failure rolls it back with the password/access changes.
            let now = unix_now()?;
            let changed = tx.execute(
                "UPDATE sessions SET authenticated_at=?1,token_hash=?2 WHERE id=?3 AND user_id=?4
                 AND revoked_at IS NULL AND idle_expires_at>?1 AND absolute_expires_at>?1",
                rusqlite::params![now,new_token_hash,session_id,user_id],
            )?;
            if changed != 1 { return Err(AppError::Unauthorized); }
            let changed = tx.execute(
                "UPDATE users SET password_hash=?1,must_change_password=0,password_changed_at=?2,
                        updated_at=?2,revision=revision+1 WHERE id=?3 AND is_active=1 AND password_hash=?4",
                rusqlite::params![new_hash, now, user_id,verified_hash],
            )?;
            if changed != 1 { return Err(AppError::Unauthorized); }
            tx.execute("UPDATE sessions SET revoked_at=?1 WHERE user_id=?2 AND id<>?3 AND revoked_at IS NULL",
                rusqlite::params![now, user_id, session_id])?;
            revoke_all_app_access(tx, &user_id, now)?;
            security_event(tx,&user_id,Some(&user_id),"password.changed",serde_json::json!({}),now)?;
            let absolute_expires_at = tx.query_row(
                "SELECT absolute_expires_at FROM sessions WHERE id=?1",
                [&session_id], |row| row.get(0),
            )?;
            Ok((now, absolute_expires_at))
        }).await?;
        let mut refreshed = actor.clone();
        refreshed.must_change_password = false;
        refreshed.authenticated_at = authenticated_at;
        Ok(IssuedSession {
            token,
            absolute_expires_at,
            actor: refreshed,
        })
    }

    // Both password gates share one account counter, independent of session/IP.
    // Switching browser sessions or alternating endpoints cannot reset it.
    pub(super) async fn verify_current_password(
        &self,
        actor: &Actor,
        supplied: &str,
        field: &'static str,
        permit: &Arc<OwnedSemaphorePermit>,
    ) -> AppResult<String> {
        let hash = self.password_hash_for_session(actor).await?;
        let throttle_key = token_hash(&format!("password-confirmation\0{}", actor.user_id));
        self.check_login_throttle(&throttle_key, unix_now()?)
            .await?;
        let verified_hash = hash.clone();
        let supplied = supplied.to_owned();
        let valid = password_work(permit, move || verify_password(&supplied, &hash)).await?;
        if !valid {
            self.record_login_failure(
                throttle_key,
                unix_now()?,
                LOGIN_FAILURES_BEFORE_DELAY,
                LOGIN_FAILURE_WINDOW_SECONDS,
            )
            .await?;
            return Err(AppError::IncorrectPassword { field });
        }
        self.db
            .transaction(move |connection| {
                connection.execute("DELETE FROM login_throttles WHERE key=?1", [throttle_key])?;
                Ok(())
            })
            .await?;
        Ok(verified_hash)
    }

    pub async fn update_profile(&self, actor: &Actor, display_name: &str) -> AppResult<Actor> {
        actor.require_ready()?;
        let display_name = normalize_display_name(display_name)?;
        let saved_name = display_name.clone();
        let user_id = actor.user_id.clone();
        let now = unix_now()?;
        self.db
            .transaction(move |connection| {
                let changed = connection.execute(
                    "UPDATE users SET display_name=?1,updated_at=?2,revision=revision+1
                 WHERE id=?3 AND is_active=1",
                    rusqlite::params![saved_name, now, user_id],
                )?;
                if changed != 1 {
                    return Err(AppError::Unauthorized);
                }
                Ok(())
            })
            .await?;
        let mut updated = actor.clone();
        updated.display_name = display_name;
        Ok(updated)
    }

    pub(super) async fn password_hash_for_session(&self, actor: &Actor) -> AppResult<String> {
        let user_id = actor.user_id.clone();
        let session_id = actor.session_id().ok_or(AppError::Forbidden)?.to_owned();
        self.db
            .run(move |connection| {
                connection
                    .query_row(
                        "SELECT u.password_hash FROM users u JOIN sessions s ON s.user_id=u.id
                 WHERE u.id=?1 AND s.id=?2 AND u.is_active=1 AND s.revoked_at IS NULL
                 AND s.idle_expires_at>?3 AND s.absolute_expires_at>?3",
                        rusqlite::params![user_id, session_id, unix_now()?],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or(AppError::Unauthorized)
            })
            .await
    }

    pub async fn list_accounts(
        &self,
        actor: &Actor,
        after_username: Option<&str>,
    ) -> AppResult<(Vec<AccountSummary>, Option<String>)> {
        actor.require_admin()?;
        let cursor = after_username.unwrap_or("").to_owned();
        let actor = actor.clone();
        self.db
            .run(move |connection| {
                refresh_actor_connection(connection, &actor)?.require_admin()?;
                let mut statement = connection.prepare(
                "SELECT id,username,display_name,is_admin,is_active,must_change_password,revision,avatar_blob_id
                 FROM users WHERE username>?1 ORDER BY username LIMIT ?2")?;
                let rows = statement.query_map(rusqlite::params![cursor, (ACCOUNT_PAGE_SIZE + 1) as i64], account_from_row)?;
                let mut users=rows.collect::<Result<Vec<_>, _>>()?;
                let has_more=users.len()>ACCOUNT_PAGE_SIZE;
                users.truncate(ACCOUNT_PAGE_SIZE);
                let next_cursor=has_more.then(||users.last().map(|user|user.username.clone())).flatten();
                Ok((users,next_cursor))
            })
            .await
    }

    pub async fn create_account(
        &self,
        actor: &Actor,
        username: &str,
        display_name: &str,
        is_admin: bool,
    ) -> AppResult<CreatedAccount> {
        actor.require_admin()?;
        let now = unix_now()?;
        if is_admin {
            actor.require_recent_auth(now)?;
        }
        let temporary_password = random_token()?;
        let username = normalize_username(username)?;
        let display_name = normalize_display_name(display_name)?;
        let password_for_hash = temporary_password.clone();
        let permit = password_work_permit().await?;
        let password_hash =
            password_work(&permit, move || hash_password(&password_for_hash)).await?;
        let actor_id = actor.user_id.clone();
        let actor_for_tx = actor.clone();
        let user = self
            .db
            .transaction(move |tx| {
                let current = refresh_actor_connection(tx, &actor_for_tx)?;
                current.require_admin()?;
                if is_admin {
                    current.require_recent_auth(unix_now()?)?;
                }
                insert_user(
                    tx,
                    PreparedUser {
                        username,
                        display_name,
                        password_hash,
                        is_admin,
                        must_change_password: true,
                    },
                    now,
                    Some(&actor_id),
                )
            })
            .await?;
        Ok(CreatedAccount {
            user: account_from_user(user),
            temporary_password,
        })
    }

    pub async fn update_account(
        &self,
        actor: &Actor,
        user_id: &str,
        update: AccountUpdate,
    ) -> AppResult<AccountSummary> {
        actor.require_admin()?;
        let display_name = normalize_display_name(&update.display_name)?;
        let user_id = user_id.to_owned();
        let actor_for_tx = actor.clone();
        let now = unix_now()?;
        self.db.transaction(move |tx| {
            let actor_for_tx = refresh_actor_connection(tx, &actor_for_tx)?;
            actor_for_tx.require_admin()?;
            let existing = tx.query_row(
                "SELECT id,username,display_name,is_admin,is_active,must_change_password,revision,avatar_blob_id
                 FROM users WHERE id=?1", [&user_id], account_from_row,
            ).optional()?.ok_or(AppError::NotFound { resource:"user" })?;
            let sensitive = existing.is_admin != update.is_admin || existing.is_active != update.is_active;
            if sensitive { actor_for_tx.require_recent_auth(now)?; }
            if existing.revision != update.expected_revision {
                return Err(AppError::revision(update.expected_revision, existing.revision));
            }
            let changed = tx.execute(
                "UPDATE users SET display_name=?1,is_admin=?2,is_active=?3,updated_at=?4,revision=revision+1
                 WHERE id=?5 AND revision=?6",
                rusqlite::params![display_name,update.is_admin,update.is_active,now,user_id,update.expected_revision],
            ).map_err(map_admin_constraint)?;
            if changed != 1 { return Err(AppError::revision(update.expected_revision, existing.revision)); }
            if existing.is_active && !update.is_active { revoke_user_access(tx,&user_id,now)?; }
            if sensitive { security_event(tx,&user_id,Some(&actor_for_tx.user_id),"account.access_changed",
                serde_json::json!({"isAdmin":update.is_admin,"isActive":update.is_active}),now)?; }
            Ok(AccountSummary { id:existing.id,username:existing.username,display_name,
                is_admin:update.is_admin,is_active:update.is_active,
                must_change_password:existing.must_change_password,revision:update.expected_revision+1,
                avatar_url:existing.avatar_url })
        }).await
    }

    pub async fn reset_account_password(&self, actor: &Actor, user_id: &str) -> AppResult<String> {
        actor.require_admin()?;
        actor.require_recent_auth(unix_now()?)?;
        if actor.user_id == user_id {
            return Err(AppError::validation(
                "userId",
                "use profile password change for your own account",
            ));
        }
        let password = random_token()?;
        let password_for_hash = password.clone();
        let permit = password_work_permit().await?;
        let password_hash =
            password_work(&permit, move || hash_password(&password_for_hash)).await?;
        let user_id = user_id.to_owned();
        let actor_id = actor.user_id.clone();
        let now = unix_now()?;
        let actor_for_tx = actor.clone();
        self.db
            .transaction(move |tx| {
                let current = refresh_actor_connection(tx, &actor_for_tx)?;
                current.require_admin()?;
                current.require_recent_auth(unix_now()?)?;
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1)",
                    [&user_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(AppError::NotFound { resource: "user" });
                }
                reset_password_hash_with_actor(tx, &user_id, password_hash, now, Some(&actor_id))
            })
            .await?;
        Ok(password)
    }
}
