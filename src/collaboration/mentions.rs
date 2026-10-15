//! Mentions in comments and block reasons: how they are checked, stored,
//! read and turned into notifications.
use std::collections::{BTreeSet, HashMap};

use rusqlite::{
    Connection, Row, Transaction, params,
    types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef},
};
use uuid::Uuid;

use crate::{AppError, AppResult, auth::Actor};

use super::{MentionKind, MentionToken, NotificationInput, snapshot_notification_tx};

impl ToSql for MentionKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            Self::User => "user",
            Self::Everyone => "everyone",
        }
        .into())
    }
}

impl FromSql for MentionKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "user" => Ok(Self::User),
            "everyone" => Ok(Self::Everyone),
            _ => Err(FromSqlError::InvalidType),
        }
    }
}

/// The text that holds mentions, by ID.
#[derive(Clone, Copy)]
pub(crate) enum Mentioned<'a> {
    Comment(&'a str),
    Block(&'a str),
}

impl<'a> Mentioned<'a> {
    fn id(self) -> &'a str {
        match self {
            Self::Comment(id) | Self::Block(id) => id,
        }
    }

    /// The mention table, and the column that links its rows and the
    /// notifications about the text to it.
    fn table(self) -> (&'static str, &'static str) {
        match self {
            Self::Comment(_) => ("comment_mentions", "comment_id"),
            Self::Block(_) => ("block_mentions", "block_id"),
        }
    }
}

/// Replaces the stored mentions of `item`.
pub(crate) fn replace(
    tx: &Transaction<'_>,
    item: Mentioned<'_>,
    mentions: &[MentionToken],
) -> AppResult<()> {
    let (table, column) = item.table();
    tx.execute(
        &format!("DELETE FROM {table} WHERE {column}=?1"),
        [item.id()],
    )?;
    let mut insert = tx.prepare_cached(&format!(
        "INSERT INTO {table} (id,{column},kind,user_id,start_offset,end_offset,label)
         VALUES (?1,?2,?3,?4,?5,?6,?7)"
    ))?;
    for mention in mentions {
        insert.execute(params![
            Uuid::now_v7().to_string(),
            item.id(),
            mention.kind,
            mention.user_id,
            mention.start_offset as i64,
            mention.end_offset as i64,
            mention.label,
        ])?;
    }
    Ok(())
}

/// The stored mentions of `item`, in text order.
pub(crate) fn load(connection: &Connection, item: Mentioned<'_>) -> AppResult<Vec<MentionToken>> {
    let (table, column) = item.table();
    let mut statement = connection.prepare_cached(&format!(
        "SELECT kind,user_id,start_offset,end_offset,label FROM {table}
         WHERE {column}=?1 ORDER BY start_offset,id"
    ))?;
    Ok(statement
        .query_map([item.id()], |row| token(row, 0))?
        .collect::<Result<Vec<_>, _>>()?)
}

/// Reads a mention from five columns, starting at `first`: kind, user ID,
/// start offset, end offset and label.
pub(crate) fn token(row: &Row<'_>, first: usize) -> rusqlite::Result<MentionToken> {
    Ok(MentionToken {
        kind: row.get(first)?,
        user_id: row.get(first + 1)?,
        start_offset: row.get::<_, i64>(first + 2)? as usize,
        end_offset: row.get::<_, i64>(first + 3)? as usize,
        label: row.get(first + 4)?,
    })
}

/// New or edited text with mentions, and what an Inbox shows about it.
pub(crate) struct MentionNotice<'a> {
    pub(crate) item: Mentioned<'a>,
    pub(crate) project_id: &'a str,
    pub(crate) task_id: &'a str,
    pub(crate) excerpt: &'a str,
    pub(crate) mentions: &'a [MentionToken],
    /// The mentions before an edit; none for new text.
    pub(crate) previous: &'a [MentionToken],
}

/// Notifies the people the text newly mentions: each person it names, and,
/// the first time it has `@everyone`, the project's other active members.
/// Nobody hears twice about one text: people it notified before and people
/// its previous version named are left out. Returns everyone notified.
pub(crate) fn notify(
    tx: &Transaction<'_>,
    actor: &Actor,
    notice: MentionNotice<'_>,
    now: i64,
) -> AppResult<BTreeSet<String>> {
    let (_, column) = notice.item.table();
    let mut previous: BTreeSet<String> = tx
        .prepare_cached(&format!(
            "SELECT DISTINCT r.user_id FROM notification_recipients r
             JOIN notification_events n ON n.id=r.notification_id WHERE n.{column}=?1"
        ))?
        .query_map([notice.item.id()], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    previous.extend(
        notice
            .previous
            .iter()
            .filter_map(|token| token.user_id.clone()),
    );
    let mut direct: BTreeSet<String> = notice
        .mentions
        .iter()
        .filter(|token| token.kind == MentionKind::User)
        .filter_map(|token| token.user_id.clone())
        .filter(|id| !previous.contains(id))
        .collect();
    direct.remove(&actor.user_id);
    let has_everyone = notice
        .mentions
        .iter()
        .any(|token| token.kind == MentionKind::Everyone);
    let had_everyone = notice
        .previous
        .iter()
        .any(|token| token.kind == MentionKind::Everyone)
        || tx
            .prepare_cached(&format!(
                "SELECT EXISTS(SELECT 1 FROM notification_events
                 WHERE {column}=?1 AND json_extract(payload_json,'$.broadcast')=1)"
            ))?
            .query_row([notice.item.id()], |row| row.get(0))?;
    let (comment_id, block_id) = match notice.item {
        Mentioned::Comment(id) => (Some(id), None),
        Mentioned::Block(id) => (None, Some(id)),
    };
    let (mentioned, everyone_event) = match notice.item {
        Mentioned::Comment(_) => ("discussion.mention", "discussion.everyone"),
        Mentioned::Block(_) => ("task.block.mentioned", "task.block.everyone"),
    };
    let input = |event_type, broadcast: bool| NotificationInput {
        project_id: notice.project_id,
        event_type,
        task_id: Some(notice.task_id),
        comment_id,
        block_id,
        excerpt: Some(notice.excerpt),
        broadcast,
    };
    let mut notified = direct.clone();
    snapshot_notification_tx(tx, actor, input(mentioned, false), direct, now)?;
    if has_everyone && !had_everyone {
        let mut everyone = crate::access::active_members(tx, notice.project_id)?;
        everyone.remove(&actor.user_id);
        everyone.retain(|id| !notified.contains(id) && !previous.contains(id));
        notified.extend(everyone.iter().cloned());
        snapshot_notification_tx(tx, actor, input(everyone_event, true), everyone, now)?;
    }
    Ok(notified)
}

/// Checks mentions against the exact text they select and keeps those that
/// count: a mention in code or a quote is plain text. A person mentioned
/// before an edit (`retained`) stays valid after leaving the project.
pub(crate) fn validate(
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
                if !crate::access::is_active_member(tx, project_id, user_id)?
                    && !retained.iter().any(|id| id == user_id)
                {
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
            let selected = validate(&tx, "project", content, mentions, &[]).unwrap();
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
