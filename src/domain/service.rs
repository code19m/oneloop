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

use crate::{
    clock::unix_now,
    idempotency::{Envelope, Mutation},
};
use std::collections::{BTreeSet, HashSet};

use chrono::NaiveDate;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    Db,
    access::{Need, require_project, validate_mentions},
    auth::Actor,
    collaboration::{
        ActivityInput, NotificationInput,
        mentions::{self, MentionNotice, Mentioned},
        record_activity_tx, snapshot_notification_tx,
    },
    error::{AppError, AppResult},
    timezone::TimeZone,
};

use super::{
    Access, BlockReasonUpdate, CommandEnvelope, CommandResult, DomainEvent, DomainOperation,
    EntityId, EpicCreate, EpicUpdate, MembershipCreate, MembershipDelete, MembershipUpdate,
    MilestoneCreate, MilestoneUpdate, PoolItemCreate, PoolItemPromote, PoolItemUpdate, PoolScope,
    ProjectCreate, ProjectDelete, ProjectUpdate, TaskBlock, TaskCreate, TaskMove, TaskStatus,
    TaskUnblock, TaskUpdate, TrackCreate, TrackReorder, TrackUpdate, require_undo_window,
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
        let operation = command.operation;
        let envelope = Envelope::new(
            operation.as_str(),
            &command.payload,
            &command.idempotency_key,
            command.expected_revision,
            operation.revision_rule(),
        )?;
        let actor = actor.clone();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.run(
                    tx,
                    &actor,
                    now,
                    |actor, replay| authorize_replay(tx, actor, operation, replay, now),
                    |actor| dispatch(tx, actor, &command, now),
                )
            })
            .await
    }
}

fn dispatch(
    tx: &Transaction<'_>,
    actor: &Actor,
    command: &CommandEnvelope,
    now: i64,
) -> AppResult<Mutation> {
    macro_rules! payload {
        ($ty:ty) => {
            crate::input::parse_payload::<$ty>(&command.payload)?
        };
    }
    // The revision rule has required one for every operation that takes it.
    let expected = command.expected_revision.unwrap_or_default();
    match command.operation {
        DomainOperation::CreateProject => create_project(tx, actor, payload!(ProjectCreate), now),
        DomainOperation::UpdateProject => {
            update_project(tx, actor, payload!(ProjectUpdate), expected, now)
        }
        DomainOperation::DeleteProject => {
            delete_project(tx, actor, payload!(ProjectDelete), expected, now)
        }
        DomainOperation::AddMembership => {
            add_membership(tx, actor, payload!(MembershipCreate), now)
        }
        DomainOperation::UpdateMembership => {
            update_membership(tx, actor, payload!(MembershipUpdate), expected, now)
        }
        DomainOperation::RemoveMembership => {
            remove_membership(tx, actor, payload!(MembershipDelete), expected, now)
        }
        DomainOperation::CreateTrack => create_track(tx, actor, payload!(TrackCreate), now),
        DomainOperation::UpdateTrack => {
            update_track(tx, actor, payload!(TrackUpdate), expected, now)
        }
        DomainOperation::ReorderTrack => {
            reorder_track(tx, actor, payload!(TrackReorder), expected, now)
        }
        DomainOperation::DeleteTrack => delete_track(tx, actor, payload!(EntityId), expected, now),
        DomainOperation::CreateEpic => create_epic(tx, actor, payload!(EpicCreate), now),
        DomainOperation::UpdateEpic => update_epic(tx, actor, payload!(EpicUpdate), expected, now),
        DomainOperation::CompleteEpic => {
            complete_epic(tx, actor, payload!(EntityId), expected, now)
        }
        DomainOperation::ReopenEpic => reopen_epic(tx, actor, payload!(EntityId), expected, now),
        DomainOperation::DeleteEpic => delete_epic(tx, actor, payload!(EntityId), expected, now),
        DomainOperation::CreateMilestone => {
            create_milestone(tx, actor, payload!(MilestoneCreate), now)
        }
        DomainOperation::UpdateMilestone => {
            update_milestone(tx, actor, payload!(MilestoneUpdate), expected, now)
        }
        DomainOperation::DeleteMilestone => {
            delete_milestone(tx, actor, payload!(EntityId), expected, now)
        }
        DomainOperation::CreateTask => create_task(tx, actor, payload!(TaskCreate), now, None),
        DomainOperation::UpdateTask => update_task(tx, actor, payload!(TaskUpdate), expected, now),
        DomainOperation::MoveTask => move_task(tx, actor, payload!(TaskMove), expected, now),
        DomainOperation::DeleteTask => delete_task(tx, actor, payload!(EntityId), expected, now),
        DomainOperation::RestoreTask => restore_task(tx, actor, payload!(EntityId), expected, now),
        DomainOperation::BlockTask => block_task(tx, actor, payload!(TaskBlock), expected, now),
        DomainOperation::UpdateBlockReason => {
            update_block_reason(tx, actor, payload!(BlockReasonUpdate), expected, now)
        }
        DomainOperation::UnblockTask => {
            unblock_task(tx, actor, payload!(TaskUnblock), expected, false, now)
        }
        DomainOperation::UnblockAndCompleteTask => {
            unblock_task(tx, actor, payload!(TaskUnblock), expected, true, now)
        }
        DomainOperation::CreatePoolItem => {
            create_pool_item(tx, actor, payload!(PoolItemCreate), now)
        }
        DomainOperation::UpdatePoolItem => {
            update_pool_item(tx, actor, payload!(PoolItemUpdate), expected, now)
        }
        DomainOperation::DeletePoolItem => {
            delete_pool_item(tx, actor, payload!(EntityId), expected, now)
        }
        DomainOperation::PromotePoolItem => {
            promote_pool_item(tx, actor, payload!(PoolItemPromote), expected, now)
        }
    }
}

/// Deleting a project also needs a recent sign-in.
fn require_sensitive_admin(actor: &Actor, now: i64) -> AppResult<()> {
    actor.require_admin()?;
    actor.require_recent_auth(now)
}

/// A retry needs the access its first run needed, checked against today's
/// data in the project the stored result names.
fn authorize_replay(
    tx: &Transaction<'_>,
    actor: &Actor,
    operation: DomainOperation,
    replay: &CommandResult,
    now: i64,
) -> AppResult<()> {
    let (need, destructive) = match operation.access() {
        Access::Admin => return actor.require_admin(),
        Access::SensitiveAdmin => return require_sensitive_admin(actor, now),
        Access::Project { need, destructive } => (need, destructive),
    };
    // Its receipt recorded the same project, from the same events.
    let project_id = replay
        .events
        .iter()
        .find_map(|event| event.project_id.as_deref())
        .or_else(|| {
            replay
                .entities
                .iter()
                .find_map(|entity| entity.get("projectId").and_then(Value::as_str))
        })
        .ok_or(AppError::Forbidden)?;
    let personal = replay.entities.iter().any(|entity| {
        entity.get("entityType").and_then(Value::as_str) == Some("poolItem")
            && entity.get("scope").and_then(Value::as_str) == Some("personal")
    });
    if personal
        && matches!(
            operation,
            DomainOperation::CreatePoolItem
                | DomainOperation::UpdatePoolItem
                | DomainOperation::DeletePoolItem
        )
    {
        return require_pool_scope(tx, actor, project_id, &PoolScope::Personal, destructive);
    }
    require_project(tx, actor, project_id, need, destructive)
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
const UPDATE_TASKS_SQL: &str = "UPDATE tasks SET status=?1,position=?2,completed_at=CASE WHEN status=?1 THEN completed_at ELSE ?3 END,\
                     completion_order=CASE WHEN status=?1 THEN completion_order WHEN ?1='done' THEN (SELECT \
                     COALESCE(MAX(completion_order),0)+1 FROM tasks WHERE completion_order>0) ELSE 0 END,updated_at=?4,\
                     revision=revision+1 WHERE id=?5 AND revision=?6";

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
