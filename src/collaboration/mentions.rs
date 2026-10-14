//! Mentions in comments and block reasons: how they are stored, read and
//! turned into notifications. Validation is part of the access policy.
use std::collections::BTreeSet;

use rusqlite::{
    Connection, Row, Transaction, params,
    types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef},
};
use uuid::Uuid;

use crate::{AppResult, auth::Actor};

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
        let mut everyone: BTreeSet<String> = tx
            .prepare_cached(
                "SELECT m.user_id FROM project_memberships m JOIN users u ON u.id=m.user_id
                 WHERE m.project_id=?1 AND u.is_active=1",
            )?
            .query_map([notice.project_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        everyone.remove(&actor.user_id);
        everyone.retain(|id| !notified.contains(id) && !previous.contains(id));
        notified.extend(everyone.iter().cloned());
        snapshot_notification_tx(tx, actor, input(everyone_event, true), everyone, now)?;
    }
    Ok(notified)
}
