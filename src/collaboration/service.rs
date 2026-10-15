//! `CollaborationService`: the comment and Inbox commands with the checks a
//! retry repeats. Its reads live in the submodules.

mod activity;
mod comments;
mod inbox;

use comments::{
    create_comment, delete_comment, edit_comment, require_comment_owner_or_admin, restore_comment,
    show_deleted_comment,
};
use inbox::{InboxChange, inbox_bulk_change, inbox_item_change};

pub(crate) use inbox::enqueue_inbox_change_tx;

use std::collections::BTreeSet;

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppError, AppResult, Db,
    access::{self, McpScope, Need, require_project},
    auth::{Actor, refresh_actor_connection},
    clock::unix_now,
    command::{Command, CommandResult, Mutation, check_revision},
    input::parse_payload,
    paging::{self, TimeCursor, next_cursor},
};

use super::{
    ActivityEvent, ActivityInput, ActivityPage, CollaborationOperation, CommentCreate,
    CommentDelete, CommentEdit, CommentPage, CommentRestore, CommentView, InboxBulkCommand,
    InboxFilter, InboxItem, InboxItemCommand, InboxPage, MentionToken, NotificationInput,
    mentions::{self, MentionNotice, Mentioned},
    record_activity_tx, snapshot_notification_tx,
};

const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 100;

#[derive(Clone)]
pub struct CollaborationService {
    db: Db,
}

impl CollaborationService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Rechecks an SSE principal without extending browser idle expiry.
    pub async fn actor_is_current(&self, actor: &Actor) -> AppResult<bool> {
        let actor = actor.clone();
        self.db
            .run(move |connection| access::allowed(refresh_actor_connection(connection, &actor)))
            .await
    }

    /// Passive authorization used before an SSE hint is emitted. It does not
    /// update session activity and therefore cannot keep an idle session alive.
    pub async fn actor_can_receive(
        &self,
        actor: &Actor,
        project_id: Option<&str>,
    ) -> AppResult<bool> {
        let actor = actor.clone();
        let project_id = project_id.map(str::to_owned);
        self.db
            .run(move |connection| {
                if !access::allowed(refresh_actor_connection(connection, &actor))? {
                    return Ok(false);
                }
                match project_id {
                    Some(project_id) => access::allowed(require_project(
                        connection,
                        &actor,
                        &project_id,
                        Need::Read,
                        false,
                    )),
                    None => Ok(true),
                }
            })
            .await
    }

    pub async fn execute(
        &self,
        actor: &Actor,
        command: Command<CollaborationOperation>,
    ) -> AppResult<CommandResult> {
        actor.require_ready()?;
        let envelope = command.envelope()?;
        let actor = actor.clone();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.run(
                    tx,
                    &actor,
                    now,
                    |actor, replay| {
                        authorize_replay(tx, actor, command.operation, &command.payload)?;
                        show_deleted_comment(tx, command.operation, replay)
                    },
                    |actor| dispatch(tx, actor, &command, now),
                )
            })
            .await
    }
}

fn dispatch(
    tx: &Transaction<'_>,
    actor: &Actor,
    command: &Command<CollaborationOperation>,
    now: i64,
) -> AppResult<Mutation> {
    use CollaborationOperation::*;
    if command.operation.is_inbox() {
        access::require_scope(tx, actor, McpScope::InboxPrivate, None)?;
    }
    let payload = &command.payload;
    let expected = command.revision();
    match command.operation {
        CreateComment => create_comment(tx, actor, parse_payload(payload)?, now),
        EditComment => edit_comment(tx, actor, parse_payload(payload)?, expected, now),
        DeleteComment => delete_comment(tx, actor, parse_payload(payload)?, expected, now),
        RestoreComment => restore_comment(tx, actor, parse_payload(payload)?, expected, now),
        MarkRead => inbox_item_change(tx, actor, parse_payload(payload)?, InboxChange::Read, now),
        MarkUnread => {
            inbox_item_change(tx, actor, parse_payload(payload)?, InboxChange::Unread, now)
        }
        Archive => inbox_item_change(
            tx,
            actor,
            parse_payload(payload)?,
            InboxChange::Archive,
            now,
        ),
        RestoreArchived => inbox_item_change(
            tx,
            actor,
            parse_payload(payload)?,
            InboxChange::Restore,
            now,
        ),
        BulkMarkRead => inbox_bulk_change(tx, actor, parse_payload(payload)?, false, now),
        BulkArchive => inbox_bulk_change(tx, actor, parse_payload(payload)?, true, now),
    }
}

fn authorize_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    operation: CollaborationOperation,
    payload: &Value,
) -> AppResult<()> {
    use CollaborationOperation::*;
    match operation {
        CreateComment => {
            let input: CommentCreate = parse_payload(payload)?;
            access::require_task(tx, actor, &input.task_id, Need::Discussion, false).map(drop)
        }
        EditComment | DeleteComment | RestoreComment => {
            let comment_id = payload
                .get("commentId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::validation("payload", "commentId is required"))?;
            let (project_id, author_id): (String, String) = tx
                .query_row(
                    "SELECT project_id,author_id FROM comments WHERE id=?1",
                    [comment_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or(AppError::NotFound {
                    resource: "comment",
                })?;
            let destructive = operation != EditComment;
            require_project(tx, actor, &project_id, Need::Discussion, destructive)?;
            require_comment_owner_or_admin(actor, &author_id)
        }
        MarkRead | MarkUnread | Archive | RestoreArchived | BulkMarkRead | BulkArchive => {
            access::require_scope(tx, actor, McpScope::InboxPrivate, None)
        }
    }
}
