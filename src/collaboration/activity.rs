use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppError, AppResult,
    auth::{Actor, ActorSource},
};

use super::ActivityEvent;

const CONSOLIDATION_WINDOW_SECONDS: i64 = 5 * 60;

#[derive(Clone, Debug)]
pub struct ActivityInput<'a> {
    pub project_id: Option<&'a str>,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub task_id: Option<&'a str>,
    pub event_type: &'a str,
    pub field_key: Option<&'a str>,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub metadata: Value,
    pub entity_revision: Option<i64>,
}

struct ProjectionContext<'input, 'value> {
    raw_id: &'value str,
    actor_user_id: Option<&'value str>,
    actor_name: &'value str,
    input: &'input ActivityInput<'value>,
    before_json: Option<&'value str>,
    after_json: Option<&'value str>,
    metadata_json: &'value str,
    now: i64,
}

struct ProjectionState<'a> {
    is_open: bool,
    is_hidden: bool,
    visibility: &'a str,
    private_owner_user_id: Option<&'a str>,
}

pub fn record_activity_tx(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: ActivityInput<'_>,
    now: i64,
) -> AppResult<ActivityEvent> {
    record_activity_inner(tx, Some(actor), input, now)
}

pub fn record_system_activity_tx(
    tx: &Transaction<'_>,
    input: ActivityInput<'_>,
    now: i64,
) -> AppResult<ActivityEvent> {
    record_activity_inner(tx, None, input, now)
}

fn record_activity_inner(
    tx: &Transaction<'_>,
    actor: Option<&Actor>,
    mut input: ActivityInput<'_>,
    now: i64,
) -> AppResult<ActivityEvent> {
    let id = Uuid::now_v7().to_string();
    let actor_user_id = actor.map(|actor| actor.user_id.as_str());
    let actor_name = actor
        .map(|actor| actor.display_name.as_str())
        .unwrap_or("oneloop");
    let (grant_id, actor_app_name) = match actor.map(|actor| &actor.source) {
        Some(ActorSource::McpGrant { grant_id }) => {
            let app_name = tx
                .query_row(
                    "SELECT client_name FROM mcp_grants WHERE id=?1",
                    [grant_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| AppError::internal("activity actor MCP grant is unavailable"))?;
            (Some(grant_id.as_str()), Some(app_name))
        }
        Some(ActorSource::BrowserSession { .. }) | None => (None, None),
    };
    input.metadata = provenance_metadata(input.metadata, grant_id, actor_app_name.as_deref())?;
    let before_json = input.before.as_ref().map(Value::to_string);
    let after_json = input.after.as_ref().map(Value::to_string);
    let metadata_json = input.metadata.to_string();
    let (visibility, private_owner) = projection_visibility(&input.metadata)?;
    tx.execute(
        "INSERT INTO activity_events
         (id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_mcp_grant_id,event_type,
          field_key,before_json,after_json,metadata_json,entity_revision,created_at,visibility,private_owner_user_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            id,
            input.project_id,
            input.entity_type,
            input.entity_id,
            input.task_id,
            actor_user_id,
            grant_id,
            input.event_type,
            input.field_key,
            before_json,
            after_json,
            metadata_json,
            input.entity_revision,
            now,
            visibility,
            private_owner,
        ],
    )?;
    let projection = ProjectionContext {
        raw_id: &id,
        actor_user_id,
        actor_name,
        input: &input,
        before_json: before_json.as_deref(),
        after_json: after_json.as_deref(),
        metadata_json: &metadata_json,
        now,
    };
    project_activity_tx(tx, &projection)?;
    let private_owner = input.metadata.get("ownerUserId").and_then(Value::as_str);
    let visibility = input.metadata.get("visibility").and_then(Value::as_str);
    let payload = json!({
        "activityEventId": id,
        "projectId": input.project_id,
        "taskId": input.task_id,
        "entityType": input.entity_type,
        "entityId": input.entity_id,
        "entityRevision": input.entity_revision,
        "actorUserId": actor_user_id,
        "visibility": visibility,
        "ownerUserId": private_owner,
    });
    // Live updates go to a project's audience or to the acting person. An
    // event with neither, such as a system event whose project was deleted,
    // stays in the audit trail only.
    if input.project_id.is_some() || actor_user_id.is_some() {
        tx.execute(
            "INSERT INTO outbox_messages
             (id,topic,aggregate_type,aggregate_id,payload_json,available_at,created_at)
             VALUES (?1,'domain.activity',?2,?3,?4,?5,?5)",
            params![
                Uuid::now_v7().to_string(),
                input.entity_type,
                input.entity_id,
                payload.to_string(),
                now
            ],
        )?;
    }
    Ok(ActivityEvent {
        id,
        project_id: input.project_id.map(str::to_owned),
        entity_type: input.entity_type.to_owned(),
        entity_id: input.entity_id.to_owned(),
        task_id: input.task_id.map(str::to_owned),
        actor_user_id: actor_user_id.map(str::to_owned),
        actor_name: Some(actor_name.to_owned()),
        actor_mcp_grant_id: grant_id.map(str::to_owned),
        actor_app_name,
        event_type: input.event_type.to_owned(),
        field_key: input.field_key.map(str::to_owned),
        before: input.before,
        after: input.after,
        metadata: input.metadata,
        entity_revision: input.entity_revision,
        created_at: now,
    })
}

fn provenance_metadata(
    mut metadata: Value,
    grant_id: Option<&str>,
    app_name: Option<&str>,
) -> AppResult<Value> {
    let values = metadata
        .as_object_mut()
        .ok_or_else(|| AppError::internal("activity metadata must be an object"))?;
    // Provenance is derived from the authenticated actor. Callers cannot forge
    // a connected-app label through domain metadata.
    values.remove("actorMcpGrantId");
    values.remove("actorAppName");
    if let (Some(grant_id), Some(app_name)) = (grant_id, app_name) {
        values.insert("actorMcpGrantId".into(), Value::String(grant_id.into()));
        values.insert("actorAppName".into(), Value::String(app_name.into()));
    }
    Ok(metadata)
}

fn project_activity_tx(tx: &Transaction<'_>, context: &ProjectionContext<'_, '_>) -> AppResult<()> {
    let input = context.input;
    let (visibility, private_owner_user_id) = projection_visibility(&input.metadata)?;
    // Column-relative positions are audit data, not user-facing activity. Never
    // merge them across columns or let them interrupt unrelated field chains.
    if (input.entity_type == "task" && input.field_key == Some("position"))
        || input.event_type == "track.reordered"
    {
        tx.execute("UPDATE activity_projection SET is_open=0 WHERE entity_type=?1 AND entity_id=?2 AND field_key='position' AND is_open=1",
            params![input.entity_type, input.entity_id])?;
        return insert_projection(
            tx,
            context,
            ProjectionState {
                is_open: false,
                is_hidden: true,
                visibility,
                private_owner_user_id,
            },
        );
    }
    if input.entity_type == "task" && input.field_key == Some("status") {
        tx.execute("UPDATE activity_projection SET is_open=0 WHERE entity_type='task' AND entity_id=?1 AND field_key='position' AND is_open=1", [input.entity_id])?;
    }
    let structured =
        input.field_key.is_some() && context.before_json.is_some() && context.after_json.is_some();
    if structured {
        let field_key = input.field_key.expect("structured field");
        type OpenProjection = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            i64,
            String,
            Option<String>,
        );
        let open: Option<OpenProjection> = tx
            .query_row(
                "SELECT id,actor_user_id,after_json,before_json,started_at,latest_at,
                        visibility,private_owner_user_id
                 FROM activity_projection
                 WHERE entity_type=?1 AND entity_id=?2 AND field_key=?3 AND is_open=1",
                params![input.entity_type, input.entity_id, field_key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()?;
        let can_merge = open.as_ref().is_some_and(
            |(
                _,
                chain_actor,
                chain_after,
                _,
                started_at,
                latest_at,
                chain_visibility,
                chain_owner,
            )| {
                chain_actor.as_deref() == context.actor_user_id
                    && context.now >= *latest_at
                    && context.now.saturating_sub(*started_at) <= CONSOLIDATION_WINDOW_SECONDS
                    && json_equal_field(
                        chain_after.as_deref(),
                        context.before_json,
                        input.field_key,
                    )
                    && chain_visibility == visibility
                    && chain_owner.as_deref() == private_owner_user_id
            },
        );
        if can_merge {
            let (projection_id, _, _, chain_before, _, _, _, _) = open.expect("checked");
            let hidden =
                json_equal_field(chain_before.as_deref(), context.after_json, input.field_key);
            tx.execute(
                "UPDATE activity_projection
                 SET event_type=?1,after_json=?2,metadata_json=?3,visibility=?4,
                     private_owner_user_id=?5,entity_revision=?6,latest_at=?7,is_hidden=?8
                 WHERE id=?9 AND is_open=1",
                params![
                    input.event_type,
                    context.after_json,
                    context.metadata_json,
                    visibility,
                    private_owner_user_id,
                    input.entity_revision,
                    context.now,
                    hidden,
                    projection_id
                ],
            )?;
            return Ok(());
        }
        tx.execute(
            "UPDATE activity_projection SET is_open=0
             WHERE entity_type=?1 AND entity_id=?2 AND field_key=?3 AND is_open=1",
            params![input.entity_type, input.entity_id, field_key],
        )?;
        insert_projection(
            tx,
            context,
            ProjectionState {
                is_open: true,
                is_hidden: json_equal_field(
                    context.before_json,
                    context.after_json,
                    input.field_key,
                ),
                visibility,
                private_owner_user_id,
            },
        )?;
        return Ok(());
    }

    if let Some(field_key) = input.field_key {
        tx.execute(
            "UPDATE activity_projection SET is_open=0
             WHERE entity_type=?1 AND entity_id=?2 AND field_key=?3 AND is_open=1",
            params![input.entity_type, input.entity_id, field_key],
        )?;
    } else {
        tx.execute(
            "UPDATE activity_projection SET is_open=0
             WHERE entity_type=?1 AND entity_id=?2 AND is_open=1",
            params![input.entity_type, input.entity_id],
        )?;
        if matches!(input.entity_type, "task_block" | "attachment")
            && let Some(task_id) = input.task_id
        {
            tx.execute(
                "UPDATE activity_projection SET is_open=0 WHERE entity_type='task' AND entity_id=?1 AND is_open=1",
                [task_id],
            )?;
        }
    }
    insert_projection(
        tx,
        context,
        ProjectionState {
            is_open: false,
            is_hidden: false,
            visibility,
            private_owner_user_id,
        },
    )
}

fn insert_projection(
    tx: &Transaction<'_>,
    context: &ProjectionContext<'_, '_>,
    state: ProjectionState<'_>,
) -> AppResult<()> {
    let input = context.input;
    tx.execute(
        "INSERT INTO activity_projection
         (id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_name_snapshot,
          event_type,field_key,before_json,after_json,metadata_json,visibility,
          private_owner_user_id,entity_revision,started_at,latest_at,is_open,is_hidden)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16,?17,?18)",
        params![
            context.raw_id,
            input.project_id,
            input.entity_type,
            input.entity_id,
            input.task_id,
            context.actor_user_id,
            context.actor_name,
            input.event_type,
            input.field_key,
            context.before_json,
            context.after_json,
            context.metadata_json,
            state.visibility,
            state.private_owner_user_id,
            input.entity_revision,
            context.now,
            state.is_open,
            state.is_hidden,
        ],
    )?;
    Ok(())
}

fn projection_visibility(metadata: &Value) -> AppResult<(&str, Option<&str>)> {
    match metadata.get("visibility").and_then(Value::as_str) {
        None | Some("public") => Ok(("public", None)),
        Some("owner") => {
            let owner = metadata
                .get("ownerUserId")
                .and_then(Value::as_str)
                .filter(|owner| !owner.is_empty())
                .ok_or_else(|| {
                    crate::AppError::internal("owner-private activity has no ownerUserId")
                })?;
            Ok(("owner", Some(owner)))
        }
        Some(_) => Err(crate::AppError::internal(
            "activity metadata has invalid visibility",
        )),
    }
}

fn json_equal_field(left: Option<&str>, right: Option<&str>, field: Option<&str>) -> bool {
    if matches!(field, Some("status" | "state")) {
        let parse = |raw: Option<&str>| {
            crate::legacy_values::activity(
                raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
                field,
            )
        };
        parse(left) == parse(right)
    } else {
        json_equal(left, right)
    }
}

fn json_equal(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            serde_json::from_str::<Value>(left).ok() == serde_json::from_str::<Value>(right).ok()
        }
        (None, None) => true,
        _ => false,
    }
}
