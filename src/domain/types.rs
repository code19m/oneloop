use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Patch fields distinguish omission (keep) from an explicit null (clear).
fn nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Stable command vocabulary shared by HTTP and MCP adapters.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
pub enum DomainOperation {
    #[serde(rename = "project.create")]
    CreateProject,
    #[serde(rename = "project.update")]
    UpdateProject,
    #[serde(rename = "project.delete")]
    DeleteProject,
    #[serde(rename = "membership.add")]
    AddMembership,
    #[serde(rename = "membership.update")]
    UpdateMembership,
    #[serde(rename = "membership.remove")]
    RemoveMembership,
    #[serde(rename = "track.create")]
    CreateTrack,
    #[serde(rename = "track.update")]
    UpdateTrack,
    #[serde(rename = "track.reorder")]
    ReorderTrack,
    #[serde(rename = "track.delete")]
    DeleteTrack,
    #[serde(rename = "epic.create")]
    CreateEpic,
    #[serde(rename = "epic.update")]
    UpdateEpic,
    #[serde(rename = "epic.complete")]
    CompleteEpic,
    #[serde(rename = "epic.reopen")]
    ReopenEpic,
    #[serde(rename = "epic.delete")]
    DeleteEpic,
    #[serde(rename = "milestone.create")]
    CreateMilestone,
    #[serde(rename = "milestone.update")]
    UpdateMilestone,
    #[serde(rename = "milestone.delete")]
    DeleteMilestone,
    #[serde(rename = "task.create")]
    CreateTask,
    #[serde(rename = "task.update")]
    UpdateTask,
    #[serde(rename = "task.move")]
    MoveTask,
    #[serde(rename = "task.delete")]
    DeleteTask,
    #[serde(rename = "task.block")]
    BlockTask,
    #[serde(rename = "task.block.update")]
    UpdateBlockReason,
    #[serde(rename = "task.unblock")]
    UnblockTask,
    #[serde(rename = "task.unblock-and-complete")]
    UnblockAndCompleteTask,
    #[serde(rename = "pool.create")]
    CreatePoolItem,
    #[serde(rename = "pool.update")]
    UpdatePoolItem,
    #[serde(rename = "pool.delete")]
    DeletePoolItem,
    #[serde(rename = "pool.promote")]
    PromotePoolItem,
}

impl DomainOperation {
    /// Exhaustive classification keeps new operations out of MCP until reviewed.
    pub fn mcp_tool(self) -> Option<&'static str> {
        match self {
            Self::CreateProject
            | Self::UpdateProject
            | Self::DeleteProject
            | Self::AddMembership
            | Self::UpdateMembership
            | Self::RemoveMembership => None,
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

    pub fn as_str(self) -> &'static str {
        match self {
            Self::CreateProject => "project.create",
            Self::UpdateProject => "project.update",
            Self::DeleteProject => "project.delete",
            Self::AddMembership => "membership.add",
            Self::UpdateMembership => "membership.update",
            Self::RemoveMembership => "membership.remove",
            Self::CreateTrack => "track.create",
            Self::UpdateTrack => "track.update",
            Self::ReorderTrack => "track.reorder",
            Self::DeleteTrack => "track.delete",
            Self::CreateEpic => "epic.create",
            Self::UpdateEpic => "epic.update",
            Self::CompleteEpic => "epic.complete",
            Self::ReopenEpic => "epic.reopen",
            Self::DeleteEpic => "epic.delete",
            Self::CreateMilestone => "milestone.create",
            Self::UpdateMilestone => "milestone.update",
            Self::DeleteMilestone => "milestone.delete",
            Self::CreateTask => "task.create",
            Self::UpdateTask => "task.update",
            Self::MoveTask => "task.move",
            Self::DeleteTask => "task.delete",
            Self::BlockTask => "task.block",
            Self::UpdateBlockReason => "task.block.update",
            Self::UnblockTask => "task.unblock",
            Self::UnblockAndCompleteTask => "task.unblock-and-complete",
            Self::CreatePoolItem => "pool.create",
            Self::UpdatePoolItem => "pool.update",
            Self::DeletePoolItem => "pool.delete",
            Self::PromotePoolItem => "pool.promote",
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub entities: Vec<Value>,
    pub events: Vec<DomainEvent>,
    pub replayed: bool,
}

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
