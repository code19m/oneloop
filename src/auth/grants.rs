//! Connected-app access is bounded by current account/project permissions and explicit grant scopes.
use super::*;

impl AuthService {
    pub async fn authenticate_mcp_access_token(&self, token: &str) -> AppResult<Actor> {
        if token.len() < 32 || token.len() > 256 {
            return Err(AppError::Unauthorized);
        }
        let hash = token_hash(token);
        let now = unix_now()?;
        let lookup_hash = hash.clone();
        let authenticated = self.db.run(move |connection| {
            let authenticated=connection.query_row(
                "SELECT g.id,u.id,u.username,u.display_name,u.is_admin,u.must_change_password,
                        t.last_used_at,g.last_used_at
                 FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
                 JOIN users u ON u.id=g.user_id
                 WHERE t.token_hash=?1 AND t.kind='access' AND t.revoked_at IS NULL
                   AND t.expires_at>?2 AND g.revoked_at IS NULL AND g.expires_at>?2 AND u.is_active=1",
                rusqlite::params![lookup_hash,now],|row|Ok(McpAuthentication {
                    grant_id:row.get(0)?,user_id:row.get(1)?,username:row.get(2)?,display_name:row.get(3)?,
                    is_admin:row.get(4)?,must_change_password:row.get(5)?,token_last_used:row.get(6)?,
                    grant_last_used:row.get(7)?,
                })).optional()?;
            let Some(authenticated)=authenticated else { return Err(AppError::Unauthorized); };
            Ok(authenticated)
        }).await?;
        if authenticated
            .token_last_used
            .is_none_or(|used| used <= now.saturating_sub(60))
            || authenticated
                .grant_last_used
                .is_none_or(|used| used <= now.saturating_sub(60))
        {
            let grant = authenticated.grant_id.clone();
            self.db.try_activity_write(move |tx| {
                tx.execute("UPDATE mcp_tokens SET last_used_at=MAX(COALESCE(last_used_at,0),?1) WHERE token_hash=?2 \
                     AND revoked_at IS NULL", rusqlite::params![now,hash])?;
                tx.execute("UPDATE mcp_grants SET last_used_at=MAX(COALESCE(last_used_at,0),?1) WHERE id=?2 AND \
                     revoked_at IS NULL", rusqlite::params![now,grant])?;
                Ok(())
            }).await?;
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
        let user_id = actor.user_id.clone();
        let grant_id = grant_id.to_owned();
        let now = unix_now()?;
        self.db
            .transaction(move |tx| {
                let changed = tx.execute(
                    "UPDATE mcp_grants SET revoked_at=?1,updated_at=?1,revision=revision+1
                 WHERE id=?2 AND user_id=?3 AND revoked_at IS NULL",
                    rusqlite::params![now, grant_id, user_id],
                )?;
                if changed != 1 {
                    return Err(AppError::NotFound {
                        resource: "connected app",
                    });
                }
                tx.execute(
                    "UPDATE mcp_tokens SET revoked_at=?1 WHERE grant_id=?2 AND revoked_at IS NULL",
                    rusqlite::params![now, grant_id],
                )?;
                security_event(
                    tx,
                    &user_id,
                    Some(&user_id),
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
                project_access_bool(crate::access::require_project(
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

    pub async fn can_manage_project(
        &self,
        actor: &Actor,
        project_id: &str,
        permission: ProjectPermission,
    ) -> AppResult<bool> {
        let actor = actor.clone();
        let project_id = project_id.to_owned();
        let need = match permission {
            ProjectPermission::Board => crate::access::Need::Board,
            ProjectPermission::Roadmap => crate::access::Need::Roadmap,
        };
        self.db
            .run(move |connection| {
                project_access_bool(crate::access::require_project(
                    connection,
                    &actor,
                    &project_id,
                    need,
                    false,
                ))
            })
            .await
    }

    pub async fn require_project_management(
        &self,
        actor: &Actor,
        project_id: &str,
        permission: ProjectPermission,
    ) -> AppResult<()> {
        if self
            .can_manage_project(actor, project_id, permission)
            .await?
        {
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
