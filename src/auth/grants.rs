//! Connected apps: how OAuth grants and their tokens are issued, rotated and
//! revoked, and when a grant still works.
use super::*;

/// An access token works for 15 minutes; the app refreshes it after that.
pub(crate) const ACCESS_TOKEN_SECONDS: i64 = 15 * 60;
/// A refresh token unused for 30 days stops working, and so does its grant.
/// `src/retention.rs` repeats the value as a literal, because its index
/// expression must match.
pub(super) const REFRESH_IDLE_SECONDS: i64 = 30 * 24 * 60 * 60;
/// A grant stops working 90 days after consent, however often it is used.
const GRANT_ABSOLUTE_SECONDS: i64 = 90 * 24 * 60 * 60;
/// How long a rotated refresh token still works, for an app that lost the
/// answer to its refresh and asks again.
const REFRESH_REUSE_GRACE_SECONDS: i64 = 30;

/// What a person allowed an app on the consent page.
pub(crate) struct NewGrant {
    pub(crate) user_id: String,
    pub(crate) client_id: String,
    pub(crate) client_name: String,
    pub(crate) projects: Vec<String>,
    pub(crate) scopes: Vec<String>,
}

/// Tokens just issued to a connected app; the database keeps only hashes.
pub(crate) struct AppTokens {
    pub(crate) access: String,
    pub(crate) refresh: String,
    /// The grant's scopes, which the token response names.
    pub(crate) scopes: Vec<String>,
}

impl AuthService {
    /// Signs in a connected app. A grant that no longer works is revoked
    /// here, so that getting access back later doesn't revive it.
    pub async fn authenticate_mcp_access_token(&self, token: &str) -> AppResult<Actor> {
        if token.len() < 32 || token.len() > 256 {
            return Err(AppError::Unauthorized);
        }
        let hash = token_hash(token);
        let now = unix_now()?;
        let lookup_hash = hash.clone();
        let (authenticated, current) = self
            .db
            .run(move |connection| {
                let authenticated = connection
                    .query_row(
                        "SELECT g.id,u.id,u.username,u.display_name,u.is_admin,
                                u.must_change_password,t.last_used_at,g.last_used_at
                         FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
                         JOIN users u ON u.id=g.user_id
                         WHERE t.token_hash=?1 AND t.kind='access' AND t.revoked_at IS NULL
                           AND t.expires_at>?2",
                        rusqlite::params![lookup_hash, now],
                        |row| {
                            Ok(McpAuthentication {
                                grant_id: row.get(0)?,
                                user_id: row.get(1)?,
                                username: row.get(2)?,
                                display_name: row.get(3)?,
                                is_admin: row.get(4)?,
                                must_change_password: row.get(5)?,
                                token_last_used: row.get(6)?,
                                grant_last_used: row.get(7)?,
                            })
                        },
                    )
                    .optional()?
                    .ok_or(AppError::Unauthorized)?;
                let current = grant_is_current(connection, &authenticated.grant_id, now)?;
                Ok((authenticated, current))
            })
            .await?;
        if !current {
            // Recheck under the writer lock: the person may have access again.
            let grant = authenticated.grant_id.clone();
            let current = self
                .db
                .transaction(move |tx| revoke_unless_current(tx, &grant, now))
                .await?;
            if !current {
                return Err(AppError::Unauthorized);
            }
        }
        if authenticated
            .token_last_used
            .is_none_or(|used| used <= now.saturating_sub(60))
            || authenticated
                .grant_last_used
                .is_none_or(|used| used <= now.saturating_sub(60))
        {
            let grant = authenticated.grant_id.clone();
            self.db
                .try_activity_write(move |tx| {
                    tx.execute(
                        "UPDATE mcp_tokens SET last_used_at=MAX(COALESCE(last_used_at,0),?1)
                         WHERE token_hash=?2 AND revoked_at IS NULL",
                        rusqlite::params![now, hash],
                    )?;
                    tx.execute(
                        "UPDATE mcp_grants SET last_used_at=MAX(COALESCE(last_used_at,0),?1)
                         WHERE id=?2 AND revoked_at IS NULL",
                        rusqlite::params![now, grant],
                    )?;
                    Ok(())
                })
                .await?;
        }
        Ok(Actor {
            user_id: authenticated.user_id,
            username: authenticated.username,
            display_name: authenticated.display_name,
            is_admin: authenticated.is_admin,
            must_change_password: authenticated.must_change_password,
            authenticated_at: 0,
            source: ActorSource::McpGrant {
                grant_id: authenticated.grant_id,
            },
        })
    }

    /// Trades an app's refresh token for new tokens. None means the token no
    /// longer works. A refresh token used again after its grace period may
    /// have leaked, so that revokes the whole grant.
    pub(crate) async fn refresh_app_tokens(
        &self,
        refresh_token: &str,
        client_id: &str,
    ) -> AppResult<Option<AppTokens>> {
        let hash = token_hash(refresh_token);
        let client_id = client_id.to_owned();
        let (lookup_hash, lookup_client) = (hash.clone(), client_id.clone());
        // An unknown token needs no writer.
        let known: bool = self
            .db
            .run(move |connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
                     WHERE t.token_hash=?1 AND t.kind='refresh' AND g.client_id=?2)",
                    rusqlite::params![lookup_hash, lookup_client],
                    |row| row.get(0),
                )?)
            })
            .await?;
        if !known {
            return Ok(None);
        }
        self.db
            .transaction(move |tx| rotate_refresh(tx, &hash, &client_id, unix_now()?))
            .await
    }

    /// Revokes the grant that issued a token, if the token is known; with a
    /// client ID, only when the grant is that client's.
    pub(crate) async fn revoke_app_token(
        &self,
        token: &str,
        client_id: Option<String>,
    ) -> AppResult<()> {
        let hash = token_hash(token);
        let now = unix_now()?;
        let grant: Option<String> = self
            .db
            .run(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT t.grant_id FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
                         WHERE t.token_hash=?1 AND (?2 IS NULL OR g.client_id=?2)",
                        rusqlite::params![hash, client_id],
                        |row| row.get(0),
                    )
                    .optional()?)
            })
            .await?;
        if let Some(grant) = grant {
            self.db
                .transaction(move |tx| revoke_grant(tx, &grant, now).map(drop))
                .await?;
        }
        Ok(())
    }

    pub async fn list_connected_apps(&self, actor: &Actor) -> AppResult<Vec<ConnectedAppSummary>> {
        actor.require_ready()?;
        let user_id = actor.user_id.clone();
        let now = unix_now()?;
        self.db
            .run(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT id,client_id,client_name,created_at,last_used_at,expires_at
                     FROM mcp_grants WHERE user_id=?1 AND revoked_at IS NULL AND expires_at>?2
                     ORDER BY last_used_at DESC,created_at DESC,id DESC",
                )?;
                let grants = statement
                    .query_map(rusqlite::params![user_id, now], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut result = Vec::with_capacity(grants.len());
                for (id, client_id, client_name, created_at, last_used_at, expires_at) in grants {
                    let projects =
                        values_for_grant(connection, "mcp_grant_projects", "project_id", &id)?;
                    let scopes = values_for_grant(connection, "mcp_grant_scopes", "scope", &id)?;
                    result.push(ConnectedAppSummary {
                        id,
                        client_id,
                        client_name,
                        created_at,
                        last_used_at,
                        expires_at,
                        projects,
                        scopes,
                    });
                }
                Ok(result)
            })
            .await
    }

    pub async fn revoke_connected_app(&self, actor: &Actor, grant_id: &str) -> AppResult<()> {
        actor.require_ready()?;
        let actor = actor.clone();
        let grant_id = grant_id.to_owned();
        let now = unix_now()?;
        self.db
            .transaction(move |tx| {
                refresh_actor_connection(tx, &actor)?;
                let owner: Option<String> = tx
                    .query_row(
                        "SELECT user_id FROM mcp_grants WHERE id=?1 AND revoked_at IS NULL",
                        [&grant_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if owner.as_deref() != Some(actor.user_id.as_str()) {
                    return Err(AppError::NotFound {
                        resource: "connected app",
                    });
                }
                revoke_grant(tx, &grant_id, now)?;
                security_event(
                    tx,
                    &actor.user_id,
                    Some(&actor.user_id),
                    "connected_app.revoked",
                    serde_json::json!({"grantId":grant_id}),
                    now,
                )?;
                Ok(())
            })
            .await
    }

    pub async fn can_read_project(&self, actor: &Actor, project_id: &str) -> AppResult<bool> {
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        self.db
            .run(move |connection| {
                crate::access::allowed(crate::access::require_project(
                    connection,
                    &actor,
                    &project_id,
                    crate::access::Need::Read,
                    false,
                ))
            })
            .await
    }

    pub async fn require_project_read(&self, actor: &Actor, project_id: &str) -> AppResult<()> {
        if self.can_read_project(actor, project_id).await? {
            Ok(())
        } else {
            Err(AppError::NotFound {
                resource: "project",
            })
        }
    }

    /// For MCP upload tickets, which are issued before the upload checks.
    pub(crate) async fn require_board_management(
        &self,
        actor: &Actor,
        project_id: &str,
    ) -> AppResult<()> {
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        let allowed = self
            .db
            .run(move |connection| {
                crate::access::allowed(crate::access::require_project(
                    connection,
                    &actor,
                    &project_id,
                    crate::access::Need::Board,
                    false,
                ))
            })
            .await?;
        if allowed {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn require_mcp_scope(&self, actor: &Actor, scope: McpScope) -> AppResult<()> {
        let actor = actor.clone();
        self.db
            .run(move |connection| {
                let actor = refresh_actor_connection(connection, &actor)?;
                crate::access::require_scope(connection, &actor, scope.as_str(), None)
            })
            .await
    }
}

/// Stores a grant with its first tokens and returns the grant's ID.
pub(crate) fn issue_grant(
    tx: &Transaction<'_>,
    grant: NewGrant,
    now: i64,
) -> AppResult<(String, AppTokens)> {
    let id = Uuid::now_v7().to_string();
    let expires_at = now + GRANT_ABSOLUTE_SECONDS;
    tx.execute(
        "INSERT INTO mcp_grants
         (id,user_id,client_id,client_name,created_at,updated_at,expires_at,last_used_at)
         VALUES(?1,?2,?3,?4,?5,?5,?6,?5)",
        rusqlite::params![
            id,
            grant.user_id,
            grant.client_id,
            grant.client_name,
            now,
            expires_at
        ],
    )?;
    for project in &grant.projects {
        tx.execute(
            "INSERT INTO mcp_grant_projects(grant_id,project_id) VALUES(?1,?2)",
            rusqlite::params![id, project],
        )?;
    }
    for scope in &grant.scopes {
        tx.execute(
            "INSERT INTO mcp_grant_scopes(grant_id,scope) VALUES(?1,?2)",
            rusqlite::params![id, scope],
        )?;
    }
    let family = Uuid::now_v7().to_string();
    let tokens = insert_tokens(tx, &id, &family, now, expires_at)?;
    Ok((
        id,
        AppTokens {
            access: tokens.access,
            refresh: tokens.refresh,
            scopes: grant.scopes,
        },
    ))
}

/// A new access and refresh token pair.
struct NewTokens {
    access: String,
    refresh: String,
    refresh_id: String,
}

/// Stores a new token pair for a grant. A refresh token lasts as long as its
/// grant, `refresh_expires_at`.
fn insert_tokens(
    tx: &Transaction<'_>,
    grant_id: &str,
    family_id: &str,
    now: i64,
    refresh_expires_at: i64,
) -> AppResult<NewTokens> {
    let tokens = NewTokens {
        access: token::random_token(32)?,
        refresh: token::random_token(48)?,
        refresh_id: Uuid::now_v7().to_string(),
    };
    for (id, kind, secret, expires_at) in [
        (
            Uuid::now_v7().to_string(),
            "access",
            &tokens.access,
            now + ACCESS_TOKEN_SECONDS,
        ),
        (
            tokens.refresh_id.clone(),
            "refresh",
            &tokens.refresh,
            refresh_expires_at,
        ),
    ] {
        tx.execute(
            "INSERT INTO mcp_tokens
             (id,grant_id,family_id,kind,token_hash,issued_at,expires_at,last_used_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?6)",
            rusqlite::params![
                id,
                grant_id,
                family_id,
                kind,
                token_hash(secret),
                now,
                expires_at
            ],
        )?;
    }
    Ok(tokens)
}

/// Replaces a refresh token with a new token pair. See
/// `AuthService::refresh_app_tokens`.
fn rotate_refresh(
    tx: &Transaction<'_>,
    hash: &str,
    client_id: &str,
    now: i64,
) -> AppResult<Option<AppTokens>> {
    struct RefreshToken {
        id: String,
        grant_id: String,
        family_id: String,
        expires_at: i64,
        last_used_at: Option<i64>,
        rotated: bool,
        revoked: bool,
    }
    let old = tx
        .query_row(
            "SELECT t.id,t.grant_id,t.family_id,t.expires_at,t.last_used_at,
                    t.rotated_to_id IS NOT NULL,t.revoked_at IS NOT NULL
             FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
             WHERE t.token_hash=?1 AND t.kind='refresh' AND g.client_id=?2",
            rusqlite::params![hash, client_id],
            |row| {
                Ok(RefreshToken {
                    id: row.get(0)?,
                    grant_id: row.get(1)?,
                    family_id: row.get(2)?,
                    expires_at: row.get(3)?,
                    last_used_at: row.get(4)?,
                    rotated: row.get(5)?,
                    revoked: row.get(6)?,
                })
            },
        )
        .optional()?;
    let Some(old) = old else { return Ok(None) };
    // A rotated token's last use is the time of its rotation.
    let within_grace = old.rotated
        && old
            .last_used_at
            .is_some_and(|rotation| (0..=REFRESH_REUSE_GRACE_SECONDS).contains(&(now - rotation)));
    if old.rotated && !within_grace {
        revoke_grant(tx, &old.grant_id, now)?;
        return Ok(None);
    }
    if (old.revoked && !within_grace)
        || old.expires_at <= now
        || old.last_used_at.unwrap_or(now) <= now - REFRESH_IDLE_SECONDS
    {
        tx.execute(
            "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE id=?2",
            rusqlite::params![now, old.id],
        )?;
        return Ok(None);
    }
    if !revoke_unless_current(tx, &old.grant_id, now)? {
        return Ok(None);
    }
    let grant_expires_at: i64 = tx.query_row(
        "SELECT expires_at FROM mcp_grants WHERE id=?1",
        [&old.grant_id],
        |row| row.get(0),
    )?;
    let tokens = insert_tokens(tx, &old.grant_id, &old.family_id, now, grant_expires_at)?;
    // Keep the first rotation time, so that retries can't extend the grace.
    if !old.rotated {
        tx.execute(
            "UPDATE mcp_tokens SET revoked_at=?1,last_used_at=?1,rotated_to_id=?2
             WHERE id=?3 AND revoked_at IS NULL",
            rusqlite::params![now, tokens.refresh_id, old.id],
        )?;
    }
    tx.execute(
        "UPDATE mcp_grants SET last_used_at=?1,updated_at=?1 WHERE id=?2",
        rusqlite::params![now, old.grant_id],
    )?;
    Ok(Some(AppTokens {
        access: tokens.access,
        refresh: tokens.refresh,
        scopes: values_for_grant(tx, "mcp_grant_scopes", "scope", &old.grant_id)?,
    }))
}

/// Whether a grant still works: it is not revoked or expired, its account is
/// active, and it selected at least one project, each of which still exists
/// and is still open to the person.
pub(crate) fn grant_is_current(
    connection: &rusqlite::Connection,
    grant_id: &str,
    now: i64,
) -> AppResult<bool> {
    Ok(connection
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM mcp_grants g JOIN users u ON u.id=g.user_id
             WHERE g.id=?1 AND g.revoked_at IS NULL AND g.expires_at>?2 AND u.is_active=1
               AND EXISTS(SELECT 1 FROM mcp_grant_projects WHERE grant_id=g.id)
               AND NOT EXISTS(
                 SELECT 1 FROM mcp_grant_projects gp
                 LEFT JOIN projects p ON p.id=gp.project_id AND p.deleted_at IS NULL
                 LEFT JOIN project_memberships m
                   ON m.project_id=gp.project_id AND m.user_id=u.id
                 WHERE gp.grant_id=g.id
                   AND (p.id IS NULL OR (u.is_admin=0 AND m.user_id IS NULL))))",
        )?
        .query_row(rusqlite::params![grant_id, now], |row| row.get(0))?)
}

/// Revokes a grant and every token issued under it. Rows that are already
/// revoked keep their time. Returns whether the grant was still live.
pub(crate) fn revoke_grant(tx: &Transaction<'_>, grant_id: &str, now: i64) -> AppResult<bool> {
    let revoked = tx.execute(
        "UPDATE mcp_grants SET revoked_at=?1,updated_at=?1,revision=revision+1
         WHERE id=?2 AND revoked_at IS NULL",
        rusqlite::params![now, grant_id],
    )?;
    tx.execute(
        "UPDATE mcp_tokens SET revoked_at=?1 WHERE grant_id=?2 AND revoked_at IS NULL",
        rusqlite::params![now, grant_id],
    )?;
    Ok(revoked == 1)
}

/// Whether a grant still works; one that doesn't is revoked for good. The
/// caller returns a rejection as data, so that the revocation commits.
pub(crate) fn revoke_unless_current(
    tx: &Transaction<'_>,
    grant_id: &str,
    now: i64,
) -> AppResult<bool> {
    if grant_is_current(tx, grant_id, now)? {
        return Ok(true);
    }
    revoke_grant(tx, grant_id, now)?;
    Ok(false)
}

/// Revokes every grant whose ID the query `grants` selects with `parameters`.
fn revoke_grants(
    tx: &Transaction<'_>,
    grants: &str,
    parameters: impl rusqlite::Params,
    now: i64,
) -> AppResult<()> {
    let ids: Vec<String> = tx
        .prepare(grants)?
        .query_map(parameters, |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for id in ids {
        revoke_grant(tx, &id, now)?;
    }
    Ok(())
}

/// Revokes a person's connected apps and drops their unfinished
/// authorizations, which must not restore access later.
pub(super) fn revoke_all_app_access(
    tx: &Transaction<'_>,
    user_id: &str,
    now: i64,
) -> AppResult<()> {
    revoke_grants(
        tx,
        "SELECT id FROM mcp_grants WHERE user_id=?1 AND revoked_at IS NULL",
        [user_id],
        now,
    )?;
    tx.execute(
        "DELETE FROM oauth_authorization_requests WHERE user_id=?1 AND consumed_at IS NULL",
        [user_id],
    )?;
    tx.execute(
        "DELETE FROM oauth_authorization_codes WHERE user_id=?1 AND used_at IS NULL",
        [user_id],
    )?;
    Ok(())
}

/// Revoke the connected apps that selected a project, with their tokens; their
/// transfer tickets stop working with them. Authorization codes for the project
/// that were not exchanged yet are dropped too. With a user, only that person's
/// apps and codes end; without one, everyone's do. Call it in the transaction
/// that takes the project away, so that an app that also selected other
/// projects ends too and a later change can't revive it.
pub(crate) fn revoke_project_app_access(
    tx: &Transaction<'_>,
    project_id: &str,
    user_id: Option<&str>,
    now: i64,
) -> AppResult<()> {
    revoke_grants(
        tx,
        "SELECT g.id FROM mcp_grants g JOIN mcp_grant_projects gp ON gp.grant_id=g.id
         WHERE gp.project_id=?1 AND g.revoked_at IS NULL AND (?2 IS NULL OR g.user_id=?2)",
        rusqlite::params![project_id, user_id],
        now,
    )?;
    // Exchanging such a code would otherwise connect the app to a project the
    // person lost, or fail on a deleted project with a server error.
    tx.execute(
        "DELETE FROM oauth_authorization_codes WHERE used_at IS NULL
         AND (?2 IS NULL OR user_id=?2)
         AND EXISTS(SELECT 1 FROM json_each(projects_json) WHERE value=?1)",
        rusqlite::params![project_id, user_id],
    )?;
    Ok(())
}

/// Revoke a person's connected apps, and drop their unexchanged authorization
/// codes, for every project they can no longer open, for example after losing
/// the admin role. As with removal from a project, getting access back later
/// doesn't revive them.
pub(crate) fn revoke_lost_project_app_access(
    tx: &Transaction<'_>,
    user_id: &str,
    now: i64,
) -> AppResult<()> {
    let lost: Vec<String> = tx
        .prepare(
            "SELECT gp.project_id FROM mcp_grants g JOIN mcp_grant_projects gp ON gp.grant_id=g.id
             WHERE g.user_id=?1 AND g.revoked_at IS NULL
             UNION
             SELECT p.value FROM oauth_authorization_codes c, json_each(c.projects_json) p
             WHERE c.user_id=?1 AND c.used_at IS NULL
             EXCEPT
             SELECT project_id FROM project_memberships WHERE user_id=?1",
        )?
        .query_map([user_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for project_id in lost {
        revoke_project_app_access(tx, &project_id, Some(user_id), now)?;
    }
    Ok(())
}
