//! Shared command transaction, authorization, idempotency and audit envelope.
mod project;
use project::*;
mod membership;
use membership::*;
mod roadmap;
use roadmap::*;
mod ordering;
use ordering::*;
mod task;
use task::*;
mod block;
use block::*;
mod pool;
use pool::*;
mod validation;
use validation::*;

use crate::access::validate_mentions_retaining as validate_mentions;
use crate::{auth::unix_now, idempotency::validate_key as validate_idempotency_key};
use std::collections::{BTreeSet, HashSet};

use chrono::NaiveDate;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    Db,
    auth::{Actor, ActorSource},
    collaboration::{
        ActivityInput, NotificationInput, record_activity_tx, snapshot_notification_tx,
    },
    error::{AppError, AppResult},
    timezone::TimeZone,
};

use super::{
    BlockReasonUpdate, CommandEnvelope, CommandResult, DomainEvent, DomainOperation, EntityId,
    EpicCreate, EpicUpdate, MembershipCreate, MembershipDelete, MembershipUpdate, MentionInput,
    MentionKind, MilestoneCreate, MilestoneUpdate, PoolItemCreate, PoolItemPromote, PoolItemUpdate,
    PoolScope, ProjectCreate, ProjectDelete, ProjectUpdate, TaskBlock, TaskCreate, TaskMove,
    TaskStatus, TaskUnblock, TaskUpdate, TrackCreate, TrackReorder, TrackUpdate,
    require_undo_window,
};

const TASK_POSITION_GAP: i64 = 1024;
const NAME_MAX: usize = 60;
const EPIC_TITLE_MAX: usize = 120;
const TASK_TITLE_MAX: usize = 140;
const EPIC_DESCRIPTION_MAX: usize = 2_000;
const TRACK_DESCRIPTION_MAX: usize = 2_000;
const POOL_DESCRIPTION_MAX: usize = 2_000;
const BLOCK_REASON_MAX: usize = 500;
const BLOCK_RESOLUTION_MAX: usize = 500;
const TASK_DESCRIPTION_MAX: usize = 4_000;
const MILESTONE_DESCRIPTION_MAX: usize = 500;

#[derive(Clone)]
pub struct DomainService {
    pub(super) db: Db,
    pub(super) time_zone: TimeZone,
}

impl DomainService {
    pub fn new(db: Db, time_zone: TimeZone) -> Self {
        Self { db, time_zone }
    }

    pub fn db(&self) -> &Db {
        &self.db
    }
    pub fn time_zone(&self) -> &str {
        self.time_zone.name()
    }

    /// Execute a logical write exactly once for an authenticated actor.
    ///
    /// The same method is used by browser and MCP adapters. The actor always
    /// comes from authentication middleware, never from command payload data.
    pub async fn execute(
        &self,
        actor: &Actor,
        command: CommandEnvelope,
    ) -> AppResult<CommandResult> {
        actor.require_ready()?;
        validate_idempotency_key(&command.idempotency_key)?;
        validate_revision_contract(&command)?;
        let actor = actor.clone();
        let request_hash = request_hash(&command)?;
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                let stored_actor = authorize_actor(tx, &actor, now)?;

                if let Some(mut replay) = replay_result(tx, &actor, &command, &request_hash)? {
                    authorize_replay(tx, &actor, &stored_actor, &command, &replay, now)?;
                    replay.replayed = true;
                    return Ok(replay);
                }

                let idempotency_id = crate::idempotency::start(
                    tx,
                    &actor,
                    &Uuid::now_v7().to_string(),
                    &command.idempotency_key,
                    command.operation.as_str(),
                    &request_hash,
                    now,
                )?;
                let mutation = dispatch(tx, &actor, &stored_actor, &command, now)?;
                let result = CommandResult {
                    entities: mutation.entities,
                    events: mutation.events,
                    replayed: false,
                };
                let response_json = serde_json::to_string(&result).map_err(|error| {
                    AppError::internal(format!("serialize command response: {error}"))
                })?;
                crate::idempotency::succeed(
                    tx,
                    &idempotency_id,
                    crate::idempotency::Receipt {
                        status: 200,
                        response: &response_json,
                        resource_type: mutation.resource_type.as_deref(),
                        resource_id: mutation.resource_id.as_deref(),
                        project_id: result
                            .events
                            .iter()
                            .find_map(|event| event.project_id.as_deref()),
                    },
                    now,
                )?;
                Ok(result)
            })
            .await
    }
}

struct Mutation {
    entities: Vec<Value>,
    events: Vec<DomainEvent>,
    resource_type: Option<String>,
    resource_id: Option<String>,
}

impl Mutation {
    fn one(entity: Value, event: DomainEvent, resource_type: &str, resource_id: &str) -> Self {
        Self {
            entities: vec![entity],
            events: vec![event],
            resource_type: Some(resource_type.into()),
            resource_id: Some(resource_id.into()),
        }
    }
}

#[derive(Clone, Copy)]
enum Permission {
    Read,
    Board,
    Roadmap,
}

pub(super) struct StoredActor {
    pub(super) is_admin: bool,
}

fn dispatch(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    command: &CommandEnvelope,
    now: i64,
) -> AppResult<Mutation> {
    macro_rules! payload {
        ($ty:ty) => {
            parse_payload::<$ty>(&command.payload)?
        };
    }
    let expected_revision = || {
        command.expected_revision.ok_or_else(|| {
            AppError::validation("expectedRevision", "is required for this operation")
        })
    };
    match command.operation {
        DomainOperation::CreateProject => {
            create_project(tx, actor, stored, payload!(ProjectCreate), now)
        }
        DomainOperation::UpdateProject => update_project(
            tx,
            actor,
            stored,
            payload!(ProjectUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::DeleteProject => delete_project(
            tx,
            actor,
            stored,
            payload!(ProjectDelete),
            expected_revision()?,
            now,
        ),
        DomainOperation::AddMembership => {
            add_membership(tx, actor, stored, payload!(MembershipCreate), now)
        }
        DomainOperation::UpdateMembership => update_membership(
            tx,
            actor,
            stored,
            payload!(MembershipUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::RemoveMembership => remove_membership(
            tx,
            actor,
            stored,
            payload!(MembershipDelete),
            expected_revision()?,
            now,
        ),
        DomainOperation::CreateTrack => create_track(tx, actor, stored, payload!(TrackCreate), now),
        DomainOperation::UpdateTrack => update_track(
            tx,
            actor,
            stored,
            payload!(TrackUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::ReorderTrack => reorder_track(
            tx,
            actor,
            stored,
            payload!(TrackReorder),
            expected_revision()?,
            now,
        ),
        DomainOperation::DeleteTrack => delete_track(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::CreateEpic => create_epic(tx, actor, stored, payload!(EpicCreate), now),
        DomainOperation::UpdateEpic => update_epic(
            tx,
            actor,
            stored,
            payload!(EpicUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::CompleteEpic => complete_epic(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::ReopenEpic => reopen_epic(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::DeleteEpic => delete_epic(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::CreateMilestone => {
            create_milestone(tx, actor, stored, payload!(MilestoneCreate), now)
        }
        DomainOperation::UpdateMilestone => update_milestone(
            tx,
            actor,
            stored,
            payload!(MilestoneUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::DeleteMilestone => delete_milestone(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::CreateTask => {
            create_task(tx, actor, stored, payload!(TaskCreate), now, None)
        }
        DomainOperation::UpdateTask => update_task(
            tx,
            actor,
            stored,
            payload!(TaskUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::MoveTask => move_task(
            tx,
            actor,
            stored,
            payload!(TaskMove),
            expected_revision()?,
            now,
        ),
        DomainOperation::DeleteTask => delete_task(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::RestoreTask => restore_task(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::BlockTask => block_task(
            tx,
            actor,
            stored,
            payload!(TaskBlock),
            expected_revision()?,
            now,
        ),
        DomainOperation::UpdateBlockReason => update_block_reason(
            tx,
            actor,
            stored,
            payload!(BlockReasonUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::UnblockTask => unblock_task(
            tx,
            actor,
            stored,
            payload!(TaskUnblock),
            expected_revision()?,
            false,
            now,
        ),
        DomainOperation::UnblockAndCompleteTask => unblock_task(
            tx,
            actor,
            stored,
            payload!(TaskUnblock),
            expected_revision()?,
            true,
            now,
        ),
        DomainOperation::CreatePoolItem => {
            create_pool_item(tx, actor, stored, payload!(PoolItemCreate), now)
        }
        DomainOperation::UpdatePoolItem => update_pool_item(
            tx,
            actor,
            stored,
            payload!(PoolItemUpdate),
            expected_revision()?,
            now,
        ),
        DomainOperation::DeletePoolItem => delete_pool_item(
            tx,
            actor,
            stored,
            payload!(EntityId),
            expected_revision()?,
            now,
        ),
        DomainOperation::PromotePoolItem => promote_pool_item(
            tx,
            actor,
            stored,
            payload!(PoolItemPromote),
            expected_revision()?,
            now,
        ),
    }
}

fn parse_payload<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    crate::http::input::parse_payload(value)
}

fn validate_revision_contract(command: &CommandEnvelope) -> AppResult<()> {
    let creates_new = matches!(
        command.operation,
        DomainOperation::CreateProject
            | DomainOperation::AddMembership
            | DomainOperation::CreateTrack
            | DomainOperation::CreateEpic
            | DomainOperation::CreateMilestone
            | DomainOperation::CreateTask
            | DomainOperation::CreatePoolItem
    );
    if !creates_new && command.expected_revision.is_none() {
        return Err(AppError::PreconditionFailed(
            "expectedRevision is required for changes to existing records".into(),
        ));
    }
    if creates_new && command.expected_revision.is_some() {
        return Err(AppError::validation(
            "expectedRevision",
            "must be omitted when creating a new record",
        ));
    }
    if command.expected_revision.is_some_and(|value| value < 1) {
        return Err(AppError::validation(
            "expectedRevision",
            "must be a positive integer",
        ));
    }
    Ok(())
}

fn request_hash(command: &CommandEnvelope) -> AppResult<String> {
    crate::idempotency::request_hash(
        &json!({"operation":command.operation,"payload":command.payload,"expectedRevision":command.expected_revision}),
    )
}

fn replay_result(
    tx: &Transaction<'_>,
    actor: &Actor,
    command: &CommandEnvelope,
    hash: &str,
) -> AppResult<Option<CommandResult>> {
    crate::idempotency::replay(
        tx,
        actor,
        &command.idempotency_key,
        command.operation.as_str(),
        hash,
    )
}

pub(super) fn authorize_actor(
    tx: &Transaction<'_>,
    actor: &Actor,
    _now: i64,
) -> AppResult<StoredActor> {
    let actor = crate::auth::refresh_actor_connection(tx, actor)?;
    Ok(StoredActor {
        is_admin: actor.is_admin,
    })
}

fn require_admin(actor: &Actor, stored: &StoredActor) -> AppResult<()> {
    if !stored.is_admin || !matches!(actor.source, ActorSource::BrowserSession { .. }) {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

fn require_sensitive_admin(actor: &Actor, stored: &StoredActor, now: i64) -> AppResult<()> {
    require_admin(actor, stored)?;
    actor.require_recent_auth(now)
}

fn require_project(
    tx: &Transaction<'_>,
    actor: &Actor,
    _stored: &StoredActor,
    project_id: &str,
    permission: Permission,
    destructive: bool,
) -> AppResult<()> {
    let need = match permission {
        Permission::Read => crate::access::Need::Read,
        Permission::Board => crate::access::Need::Board,
        Permission::Roadmap => crate::access::Need::Roadmap,
    };
    crate::access::require_project(tx, actor, project_id, need, destructive)
}

fn authorize_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    command: &CommandEnvelope,
    replay: &CommandResult,
    now: i64,
) -> AppResult<()> {
    if matches!(
        command.operation,
        DomainOperation::CreateProject
            | DomainOperation::UpdateProject
            | DomainOperation::DeleteProject
            | DomainOperation::AddMembership
            | DomainOperation::UpdateMembership
            | DomainOperation::RemoveMembership
    ) {
        return if matches!(command.operation, DomainOperation::DeleteProject) {
            require_sensitive_admin(actor, stored, now)
        } else {
            require_admin(actor, stored)
        };
    }
    let ledger_project: Option<String> = tx.query_row(
        &format!(
            "SELECT project_id FROM idempotency_keys WHERE {}",
            crate::idempotency::key_predicate(actor)
        ),
        params![actor.user_id, command.idempotency_key, actor.mcp_grant_id()],
        |row| row.get(0),
    )?;
    let project_id = ledger_project.as_deref().or_else(|| {
        replay
            .entities
            .iter()
            .find_map(|entity| entity.get("projectId").and_then(Value::as_str))
    });
    let Some(project_id) = project_id else {
        return Err(AppError::Forbidden);
    };
    if matches!(
        command.operation,
        DomainOperation::CreatePoolItem
            | DomainOperation::UpdatePoolItem
            | DomainOperation::DeletePoolItem
    ) && replay.entities.iter().any(|entity| {
        entity.get("entityType").and_then(Value::as_str) == Some("poolItem")
            && entity.get("scope").and_then(Value::as_str) == Some("personal")
    }) {
        return require_pool_scope(
            tx,
            actor,
            stored,
            project_id,
            &PoolScope::Personal,
            command.operation == DomainOperation::DeletePoolItem,
        );
    }
    let (permission, destructive) = operation_permission(command.operation);
    require_project(tx, actor, stored, project_id, permission, destructive)
}

fn operation_permission(operation: DomainOperation) -> (Permission, bool) {
    match operation {
        DomainOperation::CreateTrack
        | DomainOperation::UpdateTrack
        | DomainOperation::ReorderTrack
        | DomainOperation::DeleteTrack
        | DomainOperation::CreateEpic
        | DomainOperation::UpdateEpic
        | DomainOperation::CompleteEpic
        | DomainOperation::ReopenEpic
        | DomainOperation::DeleteEpic
        | DomainOperation::CreateMilestone
        | DomainOperation::UpdateMilestone
        | DomainOperation::DeleteMilestone => (
            Permission::Roadmap,
            matches!(
                operation,
                DomainOperation::DeleteTrack
                    | DomainOperation::DeleteEpic
                    | DomainOperation::DeleteMilestone
            ),
        ),
        DomainOperation::CreateTask
        | DomainOperation::UpdateTask
        | DomainOperation::MoveTask
        | DomainOperation::DeleteTask
        | DomainOperation::RestoreTask
        | DomainOperation::BlockTask
        | DomainOperation::UpdateBlockReason
        | DomainOperation::UnblockTask
        | DomainOperation::UnblockAndCompleteTask
        | DomainOperation::CreatePoolItem
        | DomainOperation::UpdatePoolItem
        | DomainOperation::DeletePoolItem
        | DomainOperation::PromotePoolItem => (
            Permission::Board,
            matches!(
                operation,
                DomainOperation::DeleteTask
                    | DomainOperation::RestoreTask
                    | DomainOperation::DeletePoolItem
            ),
        ),
        _ => (Permission::Read, false),
    }
}

fn is_constraint(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(inner, _) if inner.code == rusqlite::ErrorCode::ConstraintViolation)
}

fn not_found(resource: &'static str) -> AppError {
    AppError::NotFound { resource }
}

fn activity(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: ActivityInput<'_>,
    now: i64,
) -> AppResult<DomainEvent> {
    record_activity_tx(tx, actor, input, now)
}

fn notify(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: NotificationInput<'_>,
    recipient_ids: impl IntoIterator<Item = String>,
    now: i64,
) -> AppResult<()> {
    let broadcast = input
        .payload
        .get("broadcast")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if broadcast {
        crate::access::enforce_broadcast_cooldown(tx, actor, input.project_id, now)?;
    }
    snapshot_notification_tx(tx, actor, input, recipient_ids, now)?;
    Ok(())
}

fn normalize_prefix(value: &str) -> AppResult<String> {
    let value = value.trim().to_ascii_uppercase();
    if !(2..=4).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(AppError::validation(
            "taskPrefix",
            "must contain 2–4 uppercase letters or digits",
        ));
    }
    Ok(value)
}

fn ensure_project_and_active_user(
    tx: &Transaction<'_>,
    project_id: &str,
    user_id: &str,
) -> AppResult<()> {
    let project: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND deleted_at IS NULL)",
        [project_id],
        |row| row.get(0),
    )?;
    if !project {
        return Err(not_found("project"));
    }
    let user: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND is_active=1)",
        [user_id],
        |row| row.get(0),
    )?;
    if !user {
        return Err(not_found("active user"));
    }
    Ok(())
}

struct TaskRow {
    project_id: String,
    epic_id: String,
    task_key: String,
    title: String,
    description: String,
    status: String,
    deadline: Option<String>,
    revision: i64,
    position: i64,
}

fn task_row(tx: &Transaction<'_>, id: &str) -> AppResult<TaskRow> {
    tx.query_row(
        "SELECT project_id,epic_id,task_key,title,description,status,deadline,revision,position FROM tasks \
                     WHERE id=?1 AND deleted_at IS NULL",
        [id],
        |row| {
            Ok(TaskRow {
                project_id: row.get(0)?,
                epic_id: row.get(1)?,
                task_key: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                status: row.get(5)?,
                deadline: row.get(6)?,
                revision: row.get(7)?,
                position: row.get(8)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| not_found("task"))
}

#[derive(Serialize)]
#[serde(tag = "entityType", rename_all = "camelCase")]
enum Entity {
    Task(super::TaskView),
}

fn task_entity(tx: &Transaction<'_>, id: &str) -> AppResult<Value> {
    serde_json::to_value(Entity::Task(super::reads::task_view(tx, id)?))
        .map_err(|error| AppError::internal(format!("serialize task: {error}")))
}

fn ensure_open_epic(tx: &Transaction<'_>, epic_id: &str, project_id: &str) -> AppResult<()> {
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM epics WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL",
            params![epic_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    match state.as_deref() {
        None => Err(AppError::validation(
            "epicId",
            "epic does not belong to this project",
        )),
        Some("done") => Err(AppError::PreconditionFailed(
            "completed epics cannot receive new tasks".into(),
        )),
        Some(_) => Ok(()),
    }
}

fn validate_assignees(
    tx: &Transaction<'_>,
    project_id: &str,
    ids: Vec<String>,
) -> AppResult<Vec<String>> {
    let mut unique = BTreeSet::new();
    for id in ids {
        if !unique.insert(id.clone()) {
            continue;
        }
        let valid: bool =
            tx.query_row(SELECT_USERS_SQL, params![id, project_id], |row| row.get(0))?;
        if !valid {
            return Err(AppError::validation(
                "assigneeIds",
                "every assignee must be an active project member",
            ));
        }
    }
    Ok(unique.into_iter().collect())
}

fn assignee_ids(tx: &Transaction<'_>, task_id: &str) -> AppResult<Vec<String>> {
    let mut statement = tx.prepare(
        "SELECT user_id FROM task_assignees WHERE task_id=?1 ORDER BY assigned_at,user_id",
    )?;
    Ok(statement
        .query_map([task_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn set_assignees(
    tx: &Transaction<'_>,
    task_id: &str,
    actor_id: &str,
    old: &[String],
    new: &[String],
    now: i64,
) -> AppResult<()> {
    let old: HashSet<_> = old.iter().collect();
    let new_set: HashSet<_> = new.iter().collect();
    for id in old.difference(&new_set) {
        tx.execute(
            "DELETE FROM task_assignees WHERE task_id=?1 AND user_id=?2",
            params![task_id, id],
        )?;
    }
    for id in new_set.difference(&old) {
        tx.execute("INSERT INTO task_assignees (task_id,user_id,assigned_by,assigned_at) VALUES (?1,?2,?3,?4)",params![task_id,id,actor_id,now])?;
    }
    Ok(())
}

fn activated_epic_entity(project_id: &str, event: &DomainEvent) -> Value {
    json!({"entityType":"epic", "id":event.entity_id, "projectId":project_id,
        "state":"active", "revision":event.entity_revision})
}

fn activate_epic_for_work(
    tx: &Transaction<'_>,
    actor: &Actor,
    project_id: &str,
    epic_id: &str,
    now: i64,
) -> AppResult<Option<DomainEvent>> {
    let revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM epics WHERE id=?1 AND state='planning' AND deleted_at IS NULL",
            [epic_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(revision) = revision {
        tx.execute("UPDATE epics SET state='active',updated_at=?1,revision=revision+1 WHERE id=?2 AND revision=?3",params![now,epic_id,revision])?;
        return activity(
            tx,
            actor,
            ActivityInput {
                project_id: Some(project_id),
                entity_type: "epic",
                entity_id: epic_id,
                task_id: None,
                event_type: "epic.activated",
                field_key: Some("state"),
                before: Some(json!("planning")),
                after: Some(json!("active")),
                metadata: json!({"automatic":true}),
                entity_revision: Some(revision + 1),
            },
            now,
        )
        .map(Some);
    }
    Ok(None)
}

// SQL is kept outside calls so rustfmt can format the surrounding control flow.
const SELECT_PROJECT_MEMBERSHIPS_SQL: &str = "SELECT manage_roadmap,manage_board,revision FROM project_memberships WHERE project_id=?1 \
                     AND user_id=?2";
const SELECT_TASK_ASSIGNEES_SQL: &str = "SELECT EXISTS(SELECT 1 FROM task_assignees a JOIN tasks t ON t.id=a.task_id WHERE \
                     a.user_id=?1 AND t.project_id=?2 AND t.deleted_at IS NULL AND t.status<>'done')";
const SELECT_TRACKS_SQL: &str =
    "SELECT COALESCE(MAX(position),-1)+1 FROM tracks WHERE project_id=?1 AND deleted_at IS NULL";
const INSERT_EPICS_SQL: &str = "INSERT INTO epics (id,project_id,track_id,title,description,start_date,end_date,state,\
                     position,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'planning',?8,?9,?10,?10)";
const SELECT_EPICS_SQL: &str = "SELECT project_id,track_id,title,description,start_date,end_date,state,position,revision \
                     FROM epics WHERE id=?1 AND deleted_at IS NULL";
const UPDATE_EPICS_SQL: &str = "UPDATE epics SET state=?1,completed_at=?2,updated_at=?3,revision=?4 WHERE id=?5 AND revision=?6";
const SELECT_MILESTONES_SQL: &str = "SELECT project_id,title,description,milestone_date,revision FROM milestones WHERE id=?1 \
                     AND deleted_at IS NULL";
const INSERT_TASKS_SQL: &str = "INSERT INTO tasks (id,project_id,epic_id,task_number,task_key,title,description,status,\
                     position,deadline,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,\
                     'planning',?8,?9,?10,?11,?11)";
const UPDATE_TASKS_SQL: &str = "UPDATE tasks SET status=?1,position=?2,completed_at=CASE WHEN status=?1 THEN completed_at ELSE ?3 END,updated_at=?4,revision=revision+1 \
                     WHERE id=?5 AND revision=?6";

const SELECT_USERS_SQL: &str = "SELECT EXISTS(SELECT 1 FROM users u JOIN project_memberships m ON m.user_id=u.id WHERE \
                     u.id=?1 AND u.is_active=1 AND m.project_id=?2)";
const SELECT_TASK_BLOCKS_SQL: &str = "SELECT b.project_id,b.task_id,b.reason,b.revision FROM task_blocks b \
    JOIN tasks t ON t.id=b.task_id AND t.deleted_at IS NULL WHERE b.id=?1 AND b.resolved_at IS NULL";
const SELECT_POOL_ITEMS_SQL: &str =
    "SELECT project_id,scope,owner_user_id,title,description,revision FROM pool_items WHERE id=?1";

fn mention_text(value: &str) -> AppResult<String> {
    crate::text::validate(value, "reason", crate::text::Lines::Multi, true)?;
    if value.trim().is_empty() || value.encode_utf16().count() > BLOCK_REASON_MAX {
        return Err(AppError::validation(
            "reason",
            "must contain 1–500 characters",
        ));
    }
    Ok(value.to_owned())
}

struct TrackRow {
    project_id: String,
    name: String,
    description: String,
    position: i64,
    revision: i64,
}
impl TrackRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project_id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            position: row.get(3)?,
            revision: row.get(4)?,
        })
    }
}

struct EpicRow {
    project_id: String,
    track_id: String,
    title: String,
    description: String,
    start_date: String,
    end_date: Option<String>,
    state: String,
    position: i64,
    revision: i64,
}
impl EpicRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project_id: row.get(0)?,
            track_id: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            start_date: row.get(4)?,
            end_date: row.get(5)?,
            state: row.get(6)?,
            position: row.get(7)?,
            revision: row.get(8)?,
        })
    }
}

struct MilestoneRow {
    project_id: String,
    title: String,
    description: String,
    milestone_date: String,
    revision: i64,
}
impl MilestoneRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project_id: row.get(0)?,
            title: row.get(1)?,
            description: row.get(2)?,
            milestone_date: row.get(3)?,
            revision: row.get(4)?,
        })
    }
}

struct BlockRow {
    project_id: String,
    task_id: String,
    reason: String,
    revision: i64,
}
impl BlockRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            project_id: row.get(0)?,
            task_id: row.get(1)?,
            reason: row.get(2)?,
            revision: row.get(3)?,
        })
    }
}
