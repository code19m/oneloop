//! The one project access policy that every service uses, for browser
//! sessions and apps alike. Each check reads current data.
use crate::{
    AppError, AppResult, Db,
    auth::{Actor, refresh_actor_connection},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// SQL that holds when the account in `$user`, an alias of a `users` row, may
/// read the project in `$project`: the account is active, and an admin or a
/// member. Every query that picks people by project access uses it, so the
/// rule has one owner.
macro_rules! can_read_project {
    ($user:literal, $project:literal) => {
        concat!(
            "(",
            $user,
            ".is_active=1 AND (",
            $user,
            ".is_admin=1 OR EXISTS(",
            "SELECT 1 FROM project_memberships m WHERE m.user_id=",
            $user,
            ".id AND m.project_id=",
            $project,
            ")))"
        )
    };
}
pub(crate) use can_read_project;

/// SQL for the people who may be assigned to project `?1`'s tasks, mentioned
/// in it or reached by `@everyone`: its members whose accounts are active.
macro_rules! active_members_sql {
    () => {
        "SELECT m.user_id FROM project_memberships m JOIN users u ON u.id=m.user_id
         WHERE m.project_id=?1 AND u.is_active=1"
    };
}

/// Whether the person may be assigned, mentioned or reached by `@everyone`
/// in the project.
pub(crate) fn is_active_member(conn: &Connection, project: &str, user: &str) -> AppResult<bool> {
    Ok(conn
        .prepare_cached(concat!(
            "SELECT EXISTS(",
            active_members_sql!(),
            " AND m.user_id=?2)"
        ))?
        .query_row(params![project, user], |row| row.get(0))?)
}

/// Everyone `@everyone` reaches in the project.
pub(crate) fn active_members(conn: &Connection, project: &str) -> AppResult<BTreeSet<String>> {
    Ok(conn
        .prepare_cached(active_members_sql!())?
        .query_map([project], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

/// Runs a read in one snapshot, for the actor as the database knows it now,
/// so every part of the answer comes from the same moment. Writes run
/// through `Envelope` instead.
pub(crate) async fn read<T: Send + 'static>(
    db: &Db,
    actor: &Actor,
    read: impl FnOnce(&Connection, &Actor) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    actor.require_ready()?;
    let actor = actor.clone();
    db.snapshot(move |connection| {
        let actor = refresh_actor_connection(connection, &actor)?;
        read(connection, &actor)
    })
    .await
}

#[derive(Clone, Copy)]
pub(crate) enum Need {
    Read,
    Board,
    Roadmap,
    Discussion,
    Attachments { write: bool },
}

/// Where an MCP client may run a command. Every operation is classified
/// exhaustively, so a new one stays out of MCP until someone places it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpRoute {
    Tool(McpTool),
    /// Undo for deletions, which belongs to the browser's delete flow.
    Undo,
    /// Administration, which never goes through MCP.
    Administration,
}

/// The MCP tools that run commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTool {
    Work,
    Discussion,
    Destructive,
}

impl McpTool {
    pub(crate) const ALL: [Self; 3] = [Self::Work, Self::Discussion, Self::Destructive];

    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Work => "execute_work_command",
            Self::Discussion => "execute_discussion_command",
            Self::Destructive => "execute_destructive_command",
        }
    }
}

/// What an app's grant allows, within the person's own permissions. Grants
/// store the names, and the OAuth metadata lists them. The variants sort like
/// their names, as stored lists of scopes do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum McpScope {
    Attachments,
    BoardManage,
    Destructive,
    Discussion,
    InboxPrivate,
    MyPoolPrivate,
    ProjectRead,
    RoadmapManage,
}

impl McpScope {
    /// Every scope, in the order the OAuth metadata lists them.
    pub(crate) const ALL: [Self; 8] = [
        Self::ProjectRead,
        Self::Discussion,
        Self::BoardManage,
        Self::RoadmapManage,
        Self::InboxPrivate,
        Self::MyPoolPrivate,
        Self::Attachments,
        Self::Destructive,
    ];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Attachments => "attachments",
            Self::BoardManage => "board_manage",
            Self::Destructive => "destructive",
            Self::Discussion => "discussion",
            Self::InboxPrivate => "inbox_private",
            Self::MyPoolPrivate => "my_pool_private",
            Self::ProjectRead => "project_read",
            Self::RoadmapManage => "roadmap_manage",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|scope| scope.as_str() == name)
    }

    /// What the scope allows, as the Connect page says it.
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Attachments => "Read and manage attachments",
            Self::BoardManage => "Create and manage tasks and Pool items",
            Self::Destructive => "Permanently delete permitted work and files",
            Self::Discussion => "Read and write comments and replies",
            Self::InboxPrivate => "Read and manage your private Inbox (selected projects only)",
            Self::MyPoolPrivate => "Read and manage your private My Pool",
            Self::ProjectRead => "Read the selected projects",
            Self::RoadmapManage => "Create and manage roadmap work",
        }
    }

    /// The name of a scope that starts unticked on the Connect page, because
    /// it reaches private data or deletes for good.
    pub(crate) const fn off_by_default(self) -> Option<&'static str> {
        match self {
            Self::InboxPrivate => Some("Private Inbox"),
            Self::MyPoolPrivate => Some("My Pool"),
            Self::Destructive => Some("destructive access"),
            _ => None,
        }
    }

    /// Whether the scope manages work. Destructive access needs one that does.
    pub(crate) const fn manages(self) -> bool {
        matches!(
            self,
            Self::BoardManage | Self::RoadmapManage | Self::Attachments
        )
    }
}

pub(crate) fn require_scope(
    conn: &Connection,
    actor: &Actor,
    scope: McpScope,
    project: Option<&str>,
) -> AppResult<()> {
    let Some(grant) = actor.mcp_grant_id() else {
        return Ok(());
    };
    let allowed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mcp_grant_scopes WHERE grant_id=?1 AND scope=?2) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM mcp_grant_projects WHERE grant_id=?1 AND project_id=?3))",
        params![grant, scope.as_str(), project], |row| row.get(0))?;
    if allowed {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

/// Turns an access check into a yes or no. Other errors stay errors.
pub(crate) fn allowed<T>(result: AppResult<T>) -> AppResult<bool> {
    match result {
        Ok(_) => Ok(true),
        Err(AppError::Unauthorized | AppError::Forbidden | AppError::NotFound { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Access to a task is access to its project. Returns the project.
pub(crate) fn require_task(
    conn: &Connection,
    actor: &Actor,
    task: &str,
    need: Need,
    destructive: bool,
) -> AppResult<String> {
    let project: String = conn
        .prepare_cached("SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL")?
        .query_row([task], |row| row.get(0))
        .optional()?
        .ok_or(AppError::NotFound { resource: "task" })?;
    require_project(conn, actor, &project, need, destructive)?;
    Ok(project)
}

/// Access to an epic is access to its project. Returns the project.
pub(crate) fn require_epic(
    conn: &Connection,
    actor: &Actor,
    epic: &str,
    need: Need,
    destructive: bool,
) -> AppResult<String> {
    let project: String = conn
        .prepare_cached("SELECT project_id FROM epics WHERE id=?1 AND deleted_at IS NULL")?
        .query_row([epic], |row| row.get(0))
        .optional()?
        .ok_or(AppError::NotFound { resource: "epic" })?;
    require_project(conn, actor, &project, need, destructive)?;
    Ok(project)
}

/// Whether the actor may read private My Pool content, including its
/// activity. An app needs the `my_pool_private` scope; callers still check
/// the project.
pub(crate) fn can_read_private_pool(conn: &Connection, actor: &Actor) -> AppResult<bool> {
    allowed(require_scope(conn, actor, McpScope::MyPoolPrivate, None))
}

/// Access to the actor's own My Pool in the project: read access to the
/// project, and for an app the `my_pool_private` scope.
pub(crate) fn require_private_pool(
    conn: &Connection,
    actor: &Actor,
    project: &str,
    destructive: bool,
) -> AppResult<()> {
    require_project(conn, actor, project, Need::Read, destructive)?;
    require_scope(conn, actor, McpScope::MyPoolPrivate, None)
}

pub(crate) fn require_project(
    conn: &Connection,
    actor: &Actor,
    project: &str,
    need: Need,
    destructive: bool,
) -> AppResult<()> {
    let actor = refresh_actor_connection(conn, actor)?;
    let visible: bool = conn
        .prepare_cached(concat!(
            "SELECT EXISTS(SELECT 1 FROM projects p JOIN users u ON u.id=?2
             WHERE p.id=?1 AND p.deleted_at IS NULL AND ",
            can_read_project!("u", "p.id"),
            ")"
        ))?
        .query_row(params![project, actor.user_id], |row| row.get(0))?;
    if !visible {
        return Err(AppError::NotFound {
            resource: "project",
        });
    }
    if let Some(grant) = actor.mcp_grant_id() {
        let selected: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_grant_projects WHERE grant_id=?1 AND project_id=?2)",
            params![grant, project],
            |row| row.get(0),
        )?;
        if !selected {
            return Err(AppError::NotFound {
                resource: "project",
            });
        }
    }
    let (column, scope) = match need {
        Need::Read => (None, McpScope::ProjectRead),
        Need::Board => (Some("manage_board"), McpScope::BoardManage),
        Need::Roadmap => (Some("manage_roadmap"), McpScope::RoadmapManage),
        Need::Discussion => (None, McpScope::Discussion),
        Need::Attachments { write } => (write.then_some("manage_board"), McpScope::Attachments),
    };
    if let Some(column) = column.filter(|_| !actor.is_admin) {
        let allowed: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM project_memberships WHERE project_id=?1 AND user_id=?2 AND {column}=1)"), params![project, actor.user_id], |row| row.get(0))?;
        if !allowed {
            return Err(AppError::Forbidden);
        }
    }
    require_scope(conn, &actor, scope, Some(project)).map_err(|error| {
        if matches!(need, Need::Read) && matches!(error, AppError::Forbidden) {
            AppError::NotFound {
                resource: "project",
            }
        } else {
            error
        }
    })?;
    if let Need::Attachments { write } = need {
        require_scope(conn, &actor, McpScope::ProjectRead, Some(project))?;
        if write {
            require_scope(conn, &actor, McpScope::BoardManage, Some(project))?;
        }
    }
    if destructive {
        require_scope(conn, &actor, McpScope::Destructive, Some(project))?;
    }
    Ok(())
}
