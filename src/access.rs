//! Shared authorization and mention policy. Reload current identities and project access; private scopes never inherit administrator visibility.

//! Shared current-actor and project policy for all product services.
use crate::collaboration::{MentionKind, MentionToken};
use crate::{
    AppError, AppResult,
    auth::{Actor, refresh_actor_connection},
};
use rusqlite::{Connection, Transaction, params};
use std::collections::HashMap;

#[derive(Clone, Copy)]
pub(crate) enum Need {
    Read,
    Board,
    Roadmap,
    Discussion,
    Attachments { write: bool },
}

pub(crate) fn require_scope(
    conn: &Connection,
    actor: &Actor,
    scope: &str,
    project: Option<&str>,
) -> AppResult<()> {
    let Some(grant) = actor.mcp_grant_id() else {
        return Ok(());
    };
    let allowed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mcp_grant_scopes WHERE grant_id=?1 AND scope=?2) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM mcp_grant_projects WHERE grant_id=?1 AND project_id=?3))",
        params![grant, scope, project], |row| row.get(0))?;
    if allowed {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
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
        "SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=?1 AND p.deleted_at IS NULL AND (?3 OR EXISTS(SELECT 1 FROM project_memberships WHERE project_id=p.id AND user_id=?2)))",
        params![project, actor.user_id, actor.is_admin], |row| row.get(0))?;
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
        Need::Read => (None, "project_read"),
        Need::Board => (Some("manage_board"), "board_manage"),
        Need::Roadmap => (Some("manage_roadmap"), "roadmap_manage"),
        Need::Discussion => (None, "discussion"),
        Need::Attachments { write } => (write.then_some("manage_board"), "attachments"),
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
        require_scope(conn, &actor, "project_read", Some(project))?;
        if write {
            require_scope(conn, &actor, "board_manage", Some(project))?;
        }
    }
    if destructive {
        require_scope(conn, &actor, "destructive", Some(project))?;
    }
    Ok(())
}

pub(crate) fn validate_mentions(
    tx: &Transaction<'_>,
    project_id: &str,
    content: &str,
    mentions: Vec<MentionToken>,
) -> AppResult<Vec<MentionToken>> {
    validate_mentions_retaining(tx, project_id, content, mentions, &[])
}

pub(crate) fn validate_mentions_retaining(
    tx: &Transaction<'_>,
    project_id: &str,
    content: &str,
    mut mentions: Vec<MentionToken>,
    retained: &[String],
) -> AppResult<Vec<MentionToken>> {
    mentions.sort_by_key(|token| token.start_offset);
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
pub(crate) fn utf16_boundaries(value: &str) -> HashMap<usize, usize> {
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

const BROADCAST_COOLDOWN_SECONDS: i64 = 60;

pub(crate) fn enforce_broadcast_cooldown(
    tx: &Transaction<'_>,
    actor: &Actor,
    project_id: &str,
    now: i64,
) -> AppResult<()> {
    let recent: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notification_events
         WHERE project_id=?1 AND actor_user_id=?2 AND created_at>?3
           AND json_extract(payload_json,'$.broadcast')=1)",
        params![project_id, actor.user_id, now - BROADCAST_COOLDOWN_SECONDS],
        |row| row.get(0),
    )?;
    if recent {
        return Err(AppError::rule(
            crate::error::RuleKind::BroadcastCooldown,
            "@everyone can be used once per minute in this project",
        ));
    }
    Ok(())
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
            let selected = validate_mentions(&tx, "project", content, mentions).unwrap();
            assert_eq!(selected.len(), expected, "{content}");
        }
    }
}
