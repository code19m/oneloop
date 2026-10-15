//! The one project access policy that every service uses, for browser
//! sessions and apps alike. Each check reads current data. Mentions are
//! checked here too, because they name project members.
use crate::collaboration::{MentionKind, MentionToken};
use crate::{
    AppError, AppResult,
    auth::{Actor, refresh_actor_connection},
};
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// Whether the actor may read private My Pool content, including its
/// activity. An app needs the `my_pool_private` scope; callers still check
/// the project.
pub(crate) fn can_read_private_pool(conn: &Connection, actor: &Actor) -> AppResult<bool> {
    allowed(require_scope(conn, actor, McpScope::MyPoolPrivate, None))
}

pub(crate) fn require_project(
    conn: &Connection,
    actor: &Actor,
    project: &str,
    need: Need,
    destructive: bool,
) -> AppResult<()> {
    let actor = refresh_actor_connection(conn, actor)?;
    let visible: bool = conn.query_row(
        concat!(
            "SELECT EXISTS(SELECT 1 FROM projects p JOIN users u ON u.id=?2
             WHERE p.id=?1 AND p.deleted_at IS NULL AND ",
            can_read_project!("u", "p.id"),
            ")"
        ),
        params![project, actor.user_id],
        |row| row.get(0),
    )?;
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

/// Checks mentions against the exact text they select and keeps those that
/// count: a mention in code or a quote is plain text. A person mentioned
/// before an edit (`retained`) stays valid after leaving the project.
pub(crate) fn validate_mentions(
    tx: &Transaction<'_>,
    project_id: &str,
    content: &str,
    mut mentions: Vec<MentionToken>,
    retained: &[String],
) -> AppResult<Vec<MentionToken>> {
    mentions.sort_by_key(|token| (token.start_offset, token.end_offset));
    let boundaries = utf16_boundaries(content);
    let mut previous_end = 0usize;
    let mut everyone_seen = false;
    let mut selected = Vec::with_capacity(mentions.len());
    for token in mentions {
        if token.start_offset < previous_end || token.end_offset <= token.start_offset {
            return Err(AppError::validation(
                "mentions",
                "ranges must be non-overlapping and ordered",
            ));
        }
        let Some(&start) = boundaries.get(&token.start_offset) else {
            return Err(AppError::validation(
                "mentions",
                "startOffset is not a UTF-16 boundary",
            ));
        };
        let Some(&end) = boundaries.get(&token.end_offset) else {
            return Err(AppError::validation(
                "mentions",
                "endOffset is not a UTF-16 boundary",
            ));
        };
        if content.get(start..end) != Some(token.label.as_str()) {
            return Err(AppError::validation(
                "mentions",
                "label does not match the selected text range",
            ));
        }
        previous_end = token.end_offset;
        // Match the composer's plain-text contexts, including unfinished code.
        let before = &content[..start];
        let line = before.rsplit('\n').next().unwrap_or_default();
        if before.matches("```").count() % 2 == 1
            || line.matches('`').count() % 2 == 1
            || line.trim_start().starts_with('>')
        {
            continue;
        }
        match token.kind {
            MentionKind::User => {
                let user_id = token.user_id.as_deref().ok_or_else(|| {
                    AppError::validation("mentions", "user mention requires userId")
                })?;
                let member: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM project_memberships m JOIN users u ON u.id=m.user_id
                     WHERE m.project_id=?1 AND m.user_id=?2 AND u.is_active=1)",
                    params![project_id, user_id], |row| row.get(0),
                )?;
                if !member && !retained.iter().any(|id| id == user_id) {
                    return Err(AppError::validation(
                        "mentions",
                        "mentioned user is not an active project member",
                    ));
                }
            }
            MentionKind::Everyone => {
                if token.user_id.is_some() {
                    return Err(AppError::validation(
                        "mentions",
                        "@everyone cannot contain userId",
                    ));
                }
                if token.label != "@everyone" {
                    return Err(AppError::validation(
                        "mentions",
                        "everyone mention label must be @everyone",
                    ));
                }
                if everyone_seen {
                    return Err(AppError::validation(
                        "mentions",
                        "@everyone can be selected only once",
                    ));
                }
                everyone_seen = true;
            }
        }
        selected.push(token);
    }
    Ok(selected)
}
fn utf16_boundaries(value: &str) -> HashMap<usize, usize> {
    let mut result = HashMap::new();
    let mut utf16 = 0usize;
    result.insert(0, 0);
    for (byte, character) in value.char_indices() {
        result.insert(utf16, byte);
        utf16 += character.len_utf16();
        result.insert(utf16, byte + character.len_utf8());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_in_code_and_quotes_are_plain_text() {
        let mut connection = Connection::open_in_memory().unwrap();
        let tx = connection.transaction().unwrap();
        for (content, expected) in [
            ("🙂 @everyone", 1),
            ("`@everyone`", 0),
            ("Before `@everyone", 0),
            ("```\n@everyone\n```", 0),
            (" > @everyone", 0),
            (">> @everyone", 0),
            ("> quote\n@everyone", 1),
            ("`code` @everyone", 1),
            ("```\ncode\n```\n@everyone", 1),
            ("`@everyone` then @everyone", 1),
        ] {
            let mentions = content
                .match_indices("@everyone")
                .map(|(start, label)| {
                    let start_offset = content[..start].encode_utf16().count();
                    MentionToken {
                        kind: MentionKind::Everyone,
                        user_id: None,
                        start_offset,
                        end_offset: start_offset + label.len(),
                        label: label.into(),
                    }
                })
                .collect();
            let selected = validate_mentions(&tx, "project", content, mentions, &[]).unwrap();
            assert_eq!(selected.len(), expected, "{content}");
        }
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config { failure_persistence: None, ..proptest::test_runner::Config::default() })]
        #[test]
        fn unicode_mention_offsets_land_only_on_codepoint_boundaries(value in ".{0,256}") {
            let boundaries = utf16_boundaries(&value);
            let mut units = 0;
            for (offset, ch) in value.char_indices() {
                proptest::prop_assert_eq!(boundaries.get(&units), Some(&offset));
                if ch.len_utf16() == 2 { proptest::prop_assert!(!boundaries.contains_key(&(units + 1))); }
                units += ch.len_utf16();
            }
            proptest::prop_assert_eq!(boundaries.get(&units), Some(&value.len()));
        }
    }
}
