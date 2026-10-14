use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{access::Need, idempotency::RevisionRule};

/// Patch fields distinguish omission (keep) from an explicit null (clear).
fn nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// How long a deleted task, comment or attachment can be restored. Its
/// content stays until then, and maintenance removes it soon after.
pub const UNDO_WINDOW_SECONDS: i64 = 5 * 60;

/// Refuses a restore once the Undo window has passed, when maintenance may
/// already have removed the content.
pub(crate) fn require_undo_window(item: &str, deleted_at: i64, now: i64) -> crate::AppResult<()> {
    if now.saturating_sub(deleted_at) < UNDO_WINDOW_SECONDS {
        return Ok(());
    }
    Err(crate::AppError::PreconditionFailed(format!(
        "the {item} was deleted more than {} minutes ago and can no longer be restored",
        UNDO_WINDOW_SECONDS / 60
    )))
}

crate::idempotency::operations! {
    /// Stable command vocabulary shared by HTTP and MCP adapters.
    pub enum DomainOperation {
        CreateProject = "project.create",
        UpdateProject = "project.update",
        DeleteProject = "project.delete",
        AddMembership = "membership.add",
        UpdateMembership = "membership.update",
        RemoveMembership = "membership.remove",
        CreateTrack = "track.create",
        UpdateTrack = "track.update",
        ReorderTrack = "track.reorder",
        DeleteTrack = "track.delete",
        CreateEpic = "epic.create",
        UpdateEpic = "epic.update",
        CompleteEpic = "epic.complete",
        ReopenEpic = "epic.reopen",
        DeleteEpic = "epic.delete",
        CreateMilestone = "milestone.create",
        UpdateMilestone = "milestone.update",
        DeleteMilestone = "milestone.delete",
        CreateTask = "task.create",
        UpdateTask = "task.update",
        MoveTask = "task.move",
        DeleteTask = "task.delete",
        RestoreTask = "task.restore",
        BlockTask = "task.block",
        UpdateBlockReason = "task.block.update",
        UnblockTask = "task.unblock",
        UnblockAndCompleteTask = "task.unblock-and-complete",
        CreatePoolItem = "pool.create",
        UpdatePoolItem = "pool.update",
        DeletePoolItem = "pool.delete",
        PromotePoolItem = "pool.promote",
    }
}

/// What a domain operation needs from its caller. A retry checks it again
/// before it returns the stored result.
#[derive(Clone, Copy)]
pub(crate) enum Access {
    /// An administrator in the browser.
    Admin,
    /// An administrator in the browser who signed in recently.
    SensitiveAdmin,
    /// Access to the project, and an MCP client's destructive scope when
    /// `destructive`.
    Project { need: Need, destructive: bool },
}

impl DomainOperation {
    pub(crate) fn revision_rule(self) -> RevisionRule {
        if self.creates() {
            RevisionRule::Create
        } else {
            RevisionRule::Existing
        }
    }

    /// Whether the operation makes a new record, which has no revision yet.
    pub(crate) fn creates(self) -> bool {
        match self {
            Self::CreateProject
            | Self::AddMembership
            | Self::CreateTrack
            | Self::CreateEpic
            | Self::CreateMilestone
            | Self::CreateTask
            | Self::CreatePoolItem => true,
            Self::UpdateProject
            | Self::DeleteProject
            | Self::UpdateMembership
            | Self::RemoveMembership
            | Self::UpdateTrack
            | Self::ReorderTrack
            | Self::DeleteTrack
            | Self::UpdateEpic
            | Self::CompleteEpic
            | Self::ReopenEpic
            | Self::DeleteEpic
            | Self::UpdateMilestone
            | Self::DeleteMilestone
            | Self::UpdateTask
            | Self::MoveTask
            | Self::DeleteTask
            | Self::RestoreTask
            | Self::BlockTask
            | Self::UpdateBlockReason
            | Self::UnblockTask
            | Self::UnblockAndCompleteTask
            | Self::UpdatePoolItem
            | Self::DeletePoolItem
            | Self::PromotePoolItem => false,
        }
    }

    /// The access each handler checks. A personal Pool item needs only read
    /// access and the private Pool; its handlers and retries check that.
    pub(crate) fn access(self) -> Access {
        let project = |need, destructive| Access::Project { need, destructive };
        match self {
            Self::CreateProject
            | Self::UpdateProject
            | Self::AddMembership
            | Self::UpdateMembership
            | Self::RemoveMembership => Access::Admin,
            Self::DeleteProject => Access::SensitiveAdmin,
            Self::CreateTrack
            | Self::UpdateTrack
            | Self::ReorderTrack
            | Self::CreateEpic
            | Self::UpdateEpic
            | Self::CompleteEpic
            | Self::ReopenEpic
            | Self::CreateMilestone
            | Self::UpdateMilestone => project(Need::Roadmap, false),
            Self::DeleteTrack | Self::DeleteEpic | Self::DeleteMilestone => {
                project(Need::Roadmap, true)
            }
            Self::CreateTask
            | Self::UpdateTask
            | Self::MoveTask
            | Self::BlockTask
            | Self::UpdateBlockReason
            | Self::UnblockTask
            | Self::UnblockAndCompleteTask
            | Self::CreatePoolItem
            | Self::UpdatePoolItem
            | Self::PromotePoolItem => project(Need::Board, false),
            // Restoring is the Undo of a deletion, so it needs what deleting needs.
            Self::DeleteTask | Self::RestoreTask | Self::DeletePoolItem => {
                project(Need::Board, true)
            }
        }
    }

    /// Exhaustive classification keeps new operations out of MCP until reviewed.
    pub fn mcp_tool(self) -> Option<&'static str> {
        match self {
            Self::CreateProject
            | Self::UpdateProject
            | Self::DeleteProject
            | Self::AddMembership
            | Self::UpdateMembership
            | Self::RemoveMembership => None,
            // Undo belongs to the browser's delete flow (see the MCP tools).
            Self::RestoreTask => None,
            Self::DeleteTrack
            | Self::DeleteEpic
            | Self::DeleteMilestone
            | Self::DeleteTask
            | Self::DeletePoolItem => Some("execute_destructive_command"),
            Self::CreateTrack
            | Self::UpdateTrack
            | Self::ReorderTrack
            | Self::CreateEpic
            | Self::UpdateEpic
            | Self::CompleteEpic
            | Self::ReopenEpic
            | Self::CreateMilestone
            | Self::UpdateMilestone
            | Self::CreateTask
            | Self::UpdateTask
            | Self::MoveTask
            | Self::BlockTask
            | Self::UpdateBlockReason
            | Self::UnblockTask
            | Self::UnblockAndCompleteTask
            | Self::CreatePoolItem
            | Self::UpdatePoolItem
            | Self::PromotePoolItem => Some("execute_work_command"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandEnvelope {
    pub operation: DomainOperation,
    #[serde(default)]
    pub payload: Value,
    pub idempotency_key: String,
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

pub use crate::idempotency::CommandResult;

pub type DomainEvent = crate::collaboration::ActivityEvent;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCreate {
    pub name: String,
    pub task_prefix: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectUpdate {
    pub project_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub task_prefix: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDelete {
    pub project_id: String,
    pub confirmed_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MembershipCreate {
    pub project_id: String,
    pub user_id: String,
    #[serde(default)]
    pub manage_roadmap: bool,
    #[serde(default)]
    pub manage_board: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MembershipUpdate {
    pub project_id: String,
    pub user_id: String,
    pub manage_roadmap: bool,
    pub manage_board: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MembershipDelete {
    pub project_id: String,
    pub user_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackCreate {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackUpdate {
    pub track_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackReorder {
    pub track_id: String,
    pub position: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityId {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpicCreate {
    pub project_id: String,
    pub track_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub start_date: String,
    #[serde(default)]
    pub end_date: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpicUpdate {
    pub epic_id: String,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    pub end_date: Option<Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MilestoneCreate {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub milestone_date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MilestoneUpdate {
    pub milestone_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub milestone_date: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Planning,
    InProgress,
    InReview,
    Done,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::InProgress => "in_progress",
            Self::InReview => "in_review",
            Self::Done => "done",
        }
    }
}

/// How the Board orders its Done column: by the manual position, or with
/// the most recently completed task first.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DoneOrder {
    #[default]
    Manual,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCreate {
    pub project_id: String,
    pub epic_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub assignee_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskUpdate {
    pub task_id: String,
    #[serde(default)]
    pub epic_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    pub deadline: Option<Option<String>>,
    #[serde(default)]
    pub assignee_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskMove {
    pub task_id: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub position: Option<usize>,
    #[serde(default)]
    pub before_task_id: Option<String>,
    #[serde(default)]
    pub after_task_id: Option<String>,
}

pub use crate::collaboration::{MentionKind, MentionToken as MentionInput};

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskBlock {
    pub task_id: String,
    pub reason: String,
    #[serde(default)]
    pub mentions: Vec<MentionInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockReasonUpdate {
    pub block_id: String,
    pub reason: String,
    #[serde(default)]
    pub mentions: Vec<MentionInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskUnblock {
    pub task_id: String,
    #[serde(default)]
    pub resolution: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PoolScope {
    Personal,
    Team,
}

impl PoolScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Team => "team",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolItemCreate {
    pub project_id: String,
    pub scope: PoolScope,
    pub title: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolItemUpdate {
    pub pool_item_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolItemPromote {
    pub pool_item_id: String,
    pub epic_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub assignee_ids: Vec<String>,
}
