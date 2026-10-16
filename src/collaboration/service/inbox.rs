//! The private Inbox: its pages, its changes and the purge of old archived
//! items. Changes are bounded by the same filters and grants as reads.
use super::*;

pub(super) const ARCHIVE_RETENTION_SECONDS: i64 = 90 * 24 * 60 * 60;

/// The Inbox items `filter` selects for `actor`, as `FROM … WHERE …` over
/// the recipient rows `r`, with its parameters from `?1` on. Conditions are
/// chosen here, not switched by parameters, so SQLite reads
/// `notification_inbox_idx` for the archived state; the event `n` is joined
/// only when the caller, a project filter or a grant needs it.
fn inbox_items_sql(
    actor: &Actor,
    filter: &InboxFilter,
    archived_since: i64,
    with_event: bool,
) -> AppResult<(String, Vec<rusqlite::types::Value>)> {
    let grant = actor.mcp_grant_id();
    let join = if with_event || grant.is_some() || !filter.project_ids.is_empty() {
        " JOIN notification_events n ON n.id=r.notification_id"
    } else {
        ""
    };
    let mut sql = format!(
        "FROM notification_recipients r{join}
         WHERE r.user_id=?1 AND r.delivered_at IS NOT NULL"
    );
    let mut values = vec![actor.user_id.clone().into()];
    if filter.archived {
        values.push(archived_since.into());
        sql.push_str(" AND r.archived_at>?2");
    } else {
        sql.push_str(" AND r.archived_at IS NULL");
    }
    if filter.unread_only {
        sql.push_str(" AND r.read_at IS NULL");
    }
    if !filter.project_ids.is_empty() {
        values.push(
            serde_json::to_string(&filter.project_ids)
                .map_err(|error| AppError::internal(format!("serialize Inbox filter: {error}")))?
                .into(),
        );
        sql.push_str(&format!(
            concat!(
                " AND n.project_id IN (SELECT value FROM json_each(?{}))
                  AND EXISTS(SELECT 1 FROM projects p WHERE p.id=n.project_id AND p.deleted_at IS NULL)
                  AND (r.task_key_snapshot IS NULL OR EXISTS(
                    SELECT 1 FROM tasks t WHERE t.id=n.task_id AND t.deleted_at IS NULL))
                  AND EXISTS(SELECT 1 FROM users me WHERE me.id=r.user_id AND ",
                access::can_read_project!("me", "n.project_id"),
                ")"
            ),
            values.len()
        ));
    }
    if let Some(grant) = grant {
        values.push(grant.to_owned().into());
        sql.push_str(&format!(
            " AND n.project_id IN (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?{})",
            values.len()
        ));
    }
    Ok((sql, values))
}

/// Clears what Inbox items archived before `?1` still show.
const PURGE_ARCHIVED_SQL: &str = "UPDATE notification_recipients
    SET project_name_snapshot='',task_key_snapshot=NULL,task_title_snapshot=NULL,
        actor_name_snapshot='',excerpt_snapshot=NULL
    WHERE archived_at IS NOT NULL AND archived_at<=?1 AND
      (project_name_snapshot<>'' OR actor_name_snapshot<>'' OR task_key_snapshot IS NOT NULL
       OR task_title_snapshot IS NOT NULL OR excerpt_snapshot IS NOT NULL)";

impl CollaborationService {
    pub async fn inbox(
        &self,
        actor: &Actor,
        filter: InboxFilter,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<InboxPage> {
        let cursor = cursor.map(str::to_owned);
        let limit = paging::page_limit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        access::read(&self.db, actor, move |connection, actor| {
            let cursor: Option<TimeCursor> = cursor.as_deref().map(paging::decode).transpose()?;
            access::require_scope(connection, actor, McpScope::InboxPrivate, None)?;
            validate_inbox_projects(connection, actor, &filter.project_ids)?;
            let cutoff = unix_now()?.saturating_sub(ARCHIVE_RETENTION_SECONDS);
            let count = |filter: &InboxFilter| -> AppResult<i64> {
                let (items, values) = inbox_items_sql(actor, filter, cutoff, false)?;
                Ok(connection.query_row(
                    &format!("SELECT COUNT(*) {items}"),
                    rusqlite::params_from_iter(values),
                    |row| row.get(0),
                )?)
            };
            let unread_count = count(&InboxFilter {
                unread_only: true,
                ..InboxFilter::default()
            })?;
            let filtered_count = count(&filter)?;
            let (mut items, mut values) = inbox_items_sql(actor, &filter, cutoff, true)?;
            if let Some(cursor) = cursor {
                values.push(cursor.time.into());
                values.push(cursor.id.into());
                items.push_str(&format!(
                    " AND (n.created_at<?{time} OR (n.created_at=?{time} AND n.id<?{id}))",
                    time = values.len() - 1,
                    id = values.len()
                ));
            }
            values.push(((limit + 1) as i64).into());
            let mut statement = connection.prepare(&format!(
                "WITH page AS (
                    SELECT n.id,n.created_at {items}
                    ORDER BY n.created_at DESC,n.id DESC LIMIT ?{limit}
                 )
                 SELECT n.id,n.event_type,n.project_id,n.task_id,n.comment_id,n.block_id,n.created_at,
                        COALESCE(p.name,r.project_name_snapshot),
                        COALESCE(t.task_key,r.task_key_snapshot),COALESCE(t.title,r.task_title_snapshot),
                        COALESCE(actor.display_name,r.actor_name_snapshot),
                        CASE WHEN n.comment_id IS NOT NULL THEN r.excerpt_snapshot
                             ELSE COALESCE(b.reason,r.excerpt_snapshot) END,r.read_at,r.archived_at,
                        p.deleted_at,t.deleted_at,c.deleted_at,
                        EXISTS(SELECT 1 FROM users me WHERE me.id=r.user_id AND {can_read}) AS can_read,
                        n.actor_user_id
                 FROM page
                 JOIN notification_events n ON n.id=page.id
                 JOIN notification_recipients r ON r.notification_id=page.id AND r.user_id=?1
                 LEFT JOIN projects p ON p.id=n.project_id
                 LEFT JOIN tasks t ON t.id=n.task_id
                 LEFT JOIN comments c ON c.id=n.comment_id
                 LEFT JOIN task_blocks b ON b.id=n.block_id
                 LEFT JOIN users actor ON actor.id=n.actor_user_id
                 ORDER BY page.created_at DESC,page.id DESC",
                limit = values.len(),
                can_read = access::can_read_project!("me", "n.project_id"),
            ))?;
            let rows = statement.query_map(rusqlite::params_from_iter(values), inbox_row)?;
            let mut items = rows.collect::<Result<Vec<_>, _>>()?;
            let next_cursor = next_cursor(&mut items, limit, |item| (item.created_at, &item.id));
            Ok(InboxPage {
                items,
                next_cursor,
                unread_count: unread_count.max(0) as u64,
                filtered_count: filtered_count.max(0) as u64,
            })
        })
        .await
    }

    pub async fn purge_archived(&self, now: i64) -> AppResult<u64> {
        self.db
            .delivery_transaction(move |connection| {
                let cutoff = now.saturating_sub(ARCHIVE_RETENTION_SECONDS);
                let changed = connection.execute(PURGE_ARCHIVED_SQL, [cutoff])?;
                Ok(changed as u64)
            })
            .await
    }
}

pub(super) fn inbox_item_change(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: InboxItemCommand,
    change: InboxChange,
    now: i64,
) -> AppResult<Mutation> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notification_recipients r
         JOIN notification_events n ON n.id=r.notification_id
         WHERE r.notification_id=?1 AND r.user_id=?2 AND r.delivered_at IS NOT NULL
         AND (r.archived_at IS NULL OR r.archived_at>?4)
         AND (?3 IS NULL OR n.project_id IN
           (SELECT project_id FROM mcp_grant_projects WHERE grant_id=?3)))",
        params![
            input.notification_id,
            actor.user_id,
            actor.mcp_grant_id(),
            now.saturating_sub(ARCHIVE_RETENTION_SECONDS)
        ],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound {
            resource: "notification",
        });
    }
    let changed = match change {
        InboxChange::Read => {
            tx.execute(
                "UPDATE notification_recipients SET read_at=?1 WHERE notification_id=?2 AND user_id=?3 AND read_at IS NULL",
                params![now,input.notification_id,actor.user_id],
            )?
        }
        InboxChange::Unread => {
            tx.execute(
                "UPDATE notification_recipients SET read_at=NULL WHERE notification_id=?1 AND user_id=?2 AND archived_at IS NULL AND read_at IS NOT NULL",
                params![input.notification_id,actor.user_id],
            )?
        }
        InboxChange::Archive => {
            tx.execute(
                "UPDATE notification_recipients SET read_at=COALESCE(read_at,?1),archived_at=COALESCE(archived_at,?1) WHERE notification_id=?2 AND user_id=?3 AND (read_at IS NULL OR archived_at IS NULL)",
                params![now,input.notification_id,actor.user_id],
            )?
        }
        InboxChange::Restore => {
            tx.execute(
                "UPDATE notification_recipients SET archived_at=NULL WHERE notification_id=?1 AND user_id=?2 AND archived_at IS NOT NULL",
                params![input.notification_id,actor.user_id],
            )?
        }
    };
    if changed > 0 {
        enqueue_inbox_change_tx(tx, &actor.user_id, now)?;
    }
    let entity = json!({"entityType":"notification","id":input.notification_id});
    Ok(Mutation::new(
        entity,
        Vec::new(),
        "notification",
        &input.notification_id,
    ))
}

pub(super) fn inbox_bulk_change(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: InboxBulkCommand,
    archive: bool,
    now: i64,
) -> AppResult<Mutation> {
    validate_inbox_projects(tx, actor, &input.filter.project_ids)?;
    let (items, mut values) = inbox_items_sql(
        actor,
        &input.filter,
        now.saturating_sub(ARCHIVE_RETENTION_SECONDS),
        false,
    )?;
    values.push(now.into());
    let now_parameter = values.len();
    let (assignment, changed_filter) = if archive {
        (
            format!(
                "read_at=COALESCE(read_at,?{now_parameter}),archived_at=COALESCE(archived_at,?{now_parameter})"
            ),
            "(read_at IS NULL OR archived_at IS NULL)",
        )
    } else {
        (format!("read_at=?{now_parameter}"), "read_at IS NULL")
    };
    let changed = tx.execute(
        &format!(
            "UPDATE notification_recipients SET {assignment}
         WHERE user_id=?1 AND {changed_filter} AND notification_id IN (
           SELECT r.notification_id {items})"
        ),
        rusqlite::params_from_iter(values),
    )?;
    if changed > 0 {
        enqueue_inbox_change_tx(tx, &actor.user_id, now)?;
    }
    let entity = json!({"entityType":"inboxBulkResult","changed":changed});
    Ok(Mutation {
        entities: vec![entity],
        events: Vec::new(),
        resource_type: "inbox",
        resource_id: None,
    })
}

pub(crate) fn enqueue_inbox_change_tx(
    tx: &Transaction<'_>,
    owner_id: &str,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO outbox_messages
         (id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
         VALUES (?1,'inbox.state_changed','inbox',?2,'{}',?3,?3)",
        params![Uuid::now_v7().to_string(), owner_id, now],
    )?;
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) enum InboxChange {
    Read,
    Unread,
    Archive,
    Restore,
}

fn validate_inbox_projects(
    connection: &rusqlite::Connection,
    actor: &Actor,
    project_ids: &BTreeSet<String>,
) -> AppResult<()> {
    for project_id in project_ids {
        require_project(connection, actor, project_id, Need::Read, false)?;
    }
    Ok(())
}

fn inbox_row(row: &Row<'_>) -> rusqlite::Result<InboxItem> {
    let event_type: String = row.get(1)?;
    let project_id: Option<String> = row.get(2)?;
    let task_id: Option<String> = row.get(3)?;
    let task_key_snapshot: Option<String> = row.get(8)?;
    let project_deleted: Option<i64> = row.get(14)?;
    let task_deleted: Option<i64> = row.get(15)?;
    let comment_deleted: Option<i64> = row.get(16)?;
    let can_read: bool = row.get(17)?;
    let had_task = task_key_snapshot.is_some();
    let available = can_read
        && project_id.is_some()
        && project_deleted.is_none()
        && (!had_task || (task_id.is_some() && task_deleted.is_none()));
    let comment_id: Option<String> = row.get(4)?;
    let comment_unavailable = event_type.starts_with("discussion.")
        && (comment_id.is_none() || comment_deleted.is_some());
    Ok(InboxItem {
        id: row.get(0)?,
        event_type,
        project_id: available.then_some(project_id).flatten(),
        project_name: available.then(|| row.get(7)).transpose()?,
        task_id: if available { task_id } else { None },
        task_key: if available { task_key_snapshot } else { None },
        task_title: if available { row.get(9)? } else { None },
        comment_id: if available { comment_id } else { None },
        block_id: if available { row.get(5)? } else { None },
        actor_name: if available { row.get(10)? } else { None },
        actor_user_id: if available { row.get(18)? } else { None },
        excerpt: if available && !comment_unavailable {
            row.get(11)?
        } else {
            None
        },
        destination_available: available,
        read_at: row.get(12)?,
        archived_at: row.get(13)?,
        created_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrated_connection, query_plan};

    #[test]
    fn inbox_counts_find_the_archived_state_in_the_index_without_the_events() {
        let (_root, connection) = migrated_connection();
        let actor = Actor {
            user_id: "user".into(),
            username: "user".into(),
            display_name: "User".into(),
            is_admin: false,
            must_change_password: false,
            authenticated_at: 0,
            source: crate::auth::ActorSource::BrowserSession {
                session_id: "session".into(),
            },
        };
        for archived in [false, true] {
            let filter = InboxFilter {
                archived,
                ..InboxFilter::default()
            };
            let (items, _) = inbox_items_sql(&actor, &filter, 0, false).unwrap();
            let plan = query_plan(&connection, &format!("SELECT COUNT(*) {items}"));
            assert!(
                plan.contains("notification_inbox_idx (user_id=? AND archived_at")
                    && !plan.contains("notification_events"),
                "{plan}"
            );
        }
    }

    #[test]
    fn the_archive_purge_reads_only_archived_items() {
        let (_root, connection) = migrated_connection();
        let plan = query_plan(&connection, PURGE_ARCHIVED_SQL);
        assert!(plan.contains("notification_archived_idx"), "{plan}");
    }
}
