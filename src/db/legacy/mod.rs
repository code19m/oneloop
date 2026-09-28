//! Frozen pre-publication chain. Never edit SQL, names, versions or the v4 hook.
use super::*;
use serde_json::Value;

pub(super) static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("0001_initial.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 2,
        name: "mcp_authorization",
        sql: include_str!("0002_mcp_authorization.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 3,
        name: "task_summary_index",
        sql: include_str!("0003_task_summary_index.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 4,
        name: "assignee_activity_projection",
        sql: include_str!("0004_assignee_activity_projection.sql"),
        hook_revision: "",
        hook: Some(backfill_assignee_activity_projection_v4),
        foreign_keys_off: false,
    },
    Migration {
        version: 5,
        name: "oauth_registration_throttle",
        sql: include_str!("0005_oauth_registration_throttle.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 6,
        name: "remove_unused_task_search",
        sql: include_str!("0006_remove_unused_task_search.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 7,
        name: "file_maintenance_indexes",
        sql: include_str!("0007_file_maintenance_indexes.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 8,
        name: "transient_retention_indexes",
        sql: include_str!("0008_transient_retention_indexes.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 9,
        name: "domain_integrity",
        sql: include_str!("0009_domain_integrity.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 10,
        name: "oauth_code_grants",
        sql: include_str!("0010_oauth_code_grants.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 11,
        name: "file_capacity_indexes",
        sql: include_str!("0011_file_capacity_indexes.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 12,
        name: "task_pagination",
        sql: include_str!("0012_task_pagination.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 13,
        name: "storage_cleanup_runs",
        sql: include_str!("0013_storage_cleanup_runs.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 14,
        name: "raw_activity_visibility",
        sql: include_str!("0014_raw_activity_visibility.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 15,
        name: "domain_feed_and_maintenance",
        sql: include_str!("0015_domain_feed_and_maintenance.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
    Migration {
        version: 16,
        name: "covering_task_summary",
        sql: include_str!("0016_covering_task_summary.sql"),
        hook_revision: "",
        hook: None,
        foreign_keys_off: false,
    },
];

/// Schema-4 data migration. This function is part of the immutable migration
/// contract and must not be reused for later projection-policy changes.
///
/// Version 3 stored one SQL NULL side for assignee membership changes. That
/// made those exact canonical events look unstructured to the feed projector.
/// Rebuild only their derived rows, leaving the append-only audit table and all
/// unrelated projections untouched.
pub(super) fn backfill_assignee_activity_projection_v4(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        "CREATE TEMP TABLE activity_assignee_fields_v4 (
            entity_id TEXT NOT NULL,
            field_key TEXT NOT NULL,
            PRIMARY KEY(entity_id,field_key)
         ) WITHOUT ROWID;
         INSERT INTO activity_assignee_fields_v4(entity_id,field_key)
         SELECT entity_id,field_key
         FROM activity_events
         WHERE entity_type='task' AND field_key GLOB 'assignee:?*'
         GROUP BY entity_id,field_key
         HAVING sum(CASE
           WHEN event_type='task.assignee.added'
             AND before_json IS NULL
             AND json_type(after_json)='text'
             AND json_extract(after_json,'$')=substr(field_key,length('assignee:')+1)
           THEN 0
           WHEN event_type='task.assignee.removed'
             AND after_json IS NULL
             AND json_type(before_json)='text'
             AND json_extract(before_json,'$')=substr(field_key,length('assignee:')+1)
           THEN 0
           ELSE 1 END)=0;
         CREATE TEMP TABLE activity_assignee_snapshot_v4 (
            raw_id TEXT PRIMARY KEY,
            actor_name_snapshot TEXT NOT NULL
         ) WITHOUT ROWID;
         INSERT INTO activity_assignee_snapshot_v4(raw_id,actor_name_snapshot)
         SELECT p.id,p.actor_name_snapshot
         FROM activity_projection p
         JOIN activity_events e ON e.id=p.id
         JOIN activity_assignee_fields_v4 f
           ON f.entity_id=e.entity_id AND f.field_key=e.field_key;
         DELETE FROM activity_projection
         WHERE entity_type='task' AND EXISTS (
           SELECT 1 FROM activity_assignee_fields_v4 f
           WHERE f.entity_id=activity_projection.entity_id
             AND f.field_key=activity_projection.field_key
         );",
    )?;

    let mut statement = tx.prepare(
        "SELECT e.id,e.project_id,e.entity_id,e.task_id,e.actor_user_id,
                COALESCE(s.actor_name_snapshot,u.display_name,'oneloop'),
                e.event_type,e.field_key,e.before_json,e.after_json,e.metadata_json,
                e.entity_revision,e.created_at
         FROM activity_events e
         LEFT JOIN activity_assignee_snapshot_v4 s ON s.raw_id=e.id
         LEFT JOIN users u ON u.id=e.actor_user_id
         WHERE e.entity_type='task' AND (
           (e.field_key IS NULL AND EXISTS (
             SELECT 1 FROM activity_assignee_fields_v4 f WHERE f.entity_id=e.entity_id
           )) OR EXISTS (
             SELECT 1 FROM activity_assignee_fields_v4 f
             WHERE f.entity_id=e.entity_id AND f.field_key=e.field_key
           )
         )
         ORDER BY e.created_at,e.id",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let raw_id: String = row.get(0)?;
        let project_id: Option<String> = row.get(1)?;
        let entity_id: String = row.get(2)?;
        let task_id: Option<String> = row.get(3)?;
        let actor_user_id: Option<String> = row.get(4)?;
        let actor_name: String = row.get(5)?;
        let event_type: String = row.get(6)?;
        let field_key: Option<String> = row.get(7)?;
        let raw_before: Option<String> = row.get(8)?;
        let raw_after: Option<String> = row.get(9)?;
        let metadata_json: String = row.get(10)?;
        let entity_revision: Option<i64> = row.get(11)?;
        let created_at: i64 = row.get(12)?;

        let Some(field_key) = field_key else {
            tx.execute(
                "UPDATE activity_projection SET is_open=0
                 WHERE entity_type='task' AND entity_id=?1
                   AND is_open=1 AND EXISTS (
                     SELECT 1 FROM activity_assignee_fields_v4 f
                     WHERE f.entity_id=activity_projection.entity_id
                       AND f.field_key=activity_projection.field_key
                   )",
                [&entity_id],
            )?;
            continue;
        };
        let Some(user_id) = field_key
            .strip_prefix("assignee:")
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let user_json = serde_json::to_string(user_id)
            .map_err(|error| AppError::internal(format!("serialize assignee activity: {error}")))?;
        let (before_json, after_json) = match event_type.as_str() {
            "task.assignee.added"
                if raw_before.is_none()
                    && json_equal_v4(raw_after.as_deref(), Some(&user_json)) =>
            {
                ("null".to_owned(), user_json)
            }
            "task.assignee.removed"
                if raw_after.is_none()
                    && json_equal_v4(raw_before.as_deref(), Some(&user_json)) =>
            {
                (user_json, "null".to_owned())
            }
            _ => continue,
        };
        let metadata: Value = serde_json::from_str(&metadata_json).map_err(|error| {
            AppError::internal(format!("invalid assignee activity metadata: {error}"))
        })?;
        let visibility = metadata
            .get("visibility")
            .and_then(Value::as_str)
            .unwrap_or("public");
        let private_owner = match visibility {
            "public" => None,
            "owner" => Some(
                metadata
                    .get("ownerUserId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        AppError::internal("owner-private assignee activity has no ownerUserId")
                    })?,
            ),
            _ => {
                return Err(AppError::internal(
                    "assignee activity metadata has invalid visibility",
                ));
            }
        };

        type OpenProjection = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            String,
            Option<String>,
        );
        let open: Option<OpenProjection> = tx
            .query_row(
                "SELECT id,actor_user_id,after_json,before_json,started_at,
                        visibility,private_owner_user_id
                 FROM activity_projection
                 WHERE entity_type='task' AND entity_id=?1 AND field_key=?2 AND is_open=1",
                params![entity_id, field_key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        let can_merge = open.as_ref().is_some_and(
            |(_, chain_actor, chain_after, _, started_at, chain_visibility, chain_owner)| {
                chain_actor.as_deref() == actor_user_id.as_deref()
                    && created_at.saturating_sub(*started_at) <= 5 * 60
                    && json_equal_v4(chain_after.as_deref(), Some(&before_json))
                    && chain_visibility == visibility
                    && chain_owner.as_deref() == private_owner
            },
        );
        if can_merge {
            let (projection_id, _, _, chain_before, _, _, _) = open.expect("checked");
            let hidden = json_equal_v4(chain_before.as_deref(), Some(&after_json));
            tx.execute(
                "UPDATE activity_projection
                 SET event_type=?1,after_json=?2,metadata_json=?3,visibility=?4,
                     private_owner_user_id=?5,entity_revision=?6,latest_at=?7,is_hidden=?8
                 WHERE id=?9 AND is_open=1",
                params![
                    event_type,
                    after_json,
                    metadata_json,
                    visibility,
                    private_owner,
                    entity_revision,
                    created_at,
                    hidden,
                    projection_id,
                ],
            )?;
            continue;
        }
        tx.execute(
            "UPDATE activity_projection SET is_open=0
             WHERE entity_type='task' AND entity_id=?1 AND field_key=?2 AND is_open=1",
            params![entity_id, field_key],
        )?;
        let hidden = json_equal_v4(Some(&before_json), Some(&after_json));
        tx.execute(
            "INSERT INTO activity_projection
             (id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_name_snapshot,
              event_type,field_key,before_json,after_json,metadata_json,visibility,
              private_owner_user_id,entity_revision,started_at,latest_at,is_open,is_hidden)
             VALUES (?1,?2,'task',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,1,?16)",
            params![
                raw_id,
                project_id,
                entity_id,
                task_id,
                actor_user_id,
                actor_name,
                event_type,
                field_key,
                before_json,
                after_json,
                metadata_json,
                visibility,
                private_owner,
                entity_revision,
                created_at,
                hidden,
            ],
        )?;
    }
    drop(rows);
    drop(statement);
    tx.execute_batch(
        "DROP TABLE activity_assignee_snapshot_v4;
         DROP TABLE activity_assignee_fields_v4;",
    )?;
    Ok(())
}

fn json_equal_v4(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            serde_json::from_str::<Value>(left).ok() == serde_json::from_str::<Value>(right).ok()
        }
        (None, None) => true,
        _ => false,
    }
}
