//! Domain commands: the operations, what each needs, and their payloads,
//! with the values they share, such as `TaskStatus`.
use serde::{Deserialize, Serialize};

use crate::{
    access::{McpRoute, McpTool, Need},
    collaboration::MentionToken,
};

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

crate::command::operations! {
    /// Stable command vocabulary shared by HTTP and MCP adapters, with what
    /// each operation says about `expectedRevision`.
    pub enum DomainOperation {
        CreateProject = "project.create" => Create,
        UpdateProject = "project.update" => Existing,
        DeleteProject = "project.delete" => Existing,
        AddMembership = "membership.add" => Create,
        UpdateMembership = "membership.update" => Existing,
        RemoveMembership = "membership.remove" => Existing,
        CreateTrack = "track.create" => Create,
        UpdateTrack = "track.update" => Existing,
        ReorderTrack = "track.reorder" => Existing,
        DeleteTrack = "track.delete" => Existing,
        CreateEpic = "epic.create" => Create,
        UpdateEpic = "epic.update" => Existing,
        CompleteEpic = "epic.complete" => Existing,
        ReopenEpic = "epic.reopen" => Existing,
        DeleteEpic = "epic.delete" => Existing,
        CreateMilestone = "milestone.create" => Create,
        UpdateMilestone = "milestone.update" => Existing,
        DeleteMilestone = "milestone.delete" => Existing,
        CreateTask = "task.create" => Create,
        UpdateTask = "task.update" => Existing,
        MoveTask = "task.move" => Existing,
        DeleteTask = "task.delete" => Existing,
        RestoreTask = "task.restore" => Existing,
        BlockTask = "task.block" => Existing,
        UpdateBlockReason = "task.block.update" => Existing,
        UnblockTask = "task.unblock" => Existing,
        UnblockAndCompleteTask = "task.unblock-and-complete" => Existing,
        AddChecklistItem = "task.checklist.add" => Create,
        UpdateChecklistItem = "task.checklist.update" => Existing,
        MoveChecklistItem = "task.checklist.move" => Existing,
        DeleteChecklistItem = "task.checklist.delete" => Existing,
        CreatePoolItem = "pool.create" => Create,
        UpdatePoolItem = "pool.update" => Existing,
        DeletePoolItem = "pool.delete" => Existing,
        PromotePoolItem = "pool.promote" => Existing,
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
            | Self::AddChecklistItem
            | Self::UpdateChecklistItem
            | Self::MoveChecklistItem
            | Self::CreatePoolItem
            | Self::UpdatePoolItem
            | Self::PromotePoolItem => project(Need::Board, false),
            // Restoring is the Undo of a deletion, so it needs what deleting needs.
            Self::DeleteTask
            | Self::RestoreTask
            | Self::DeleteChecklistItem
            | Self::DeletePoolItem => project(Need::Board, true),
        }
    }

    pub(crate) fn mcp_route(self) -> McpRoute {
        match self {
            Self::CreateProject
            | Self::UpdateProject
            | Self::DeleteProject
            | Self::AddMembership
            | Self::UpdateMembership
            | Self::RemoveMembership => McpRoute::Administration,
            Self::RestoreTask => McpRoute::Undo,
            Self::DeleteTrack
            | Self::DeleteEpic
            | Self::DeleteMilestone
            | Self::DeleteTask
            | Self::DeleteChecklistItem
            | Self::DeletePoolItem => McpRoute::Tool(McpTool::Destructive),
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
            | Self::AddChecklistItem
            | Self::UpdateChecklistItem
            | Self::MoveChecklistItem
            | Self::CreatePoolItem
            | Self::UpdatePoolItem
            | Self::PromotePoolItem => McpRoute::Tool(McpTool::Work),
        }
    }
}

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
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackUpdate {
    pub track_id: String,
    pub name: String,
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
    /// Checklist item titles, in order: at most 50, each one line of at most 140 characters.
    #[serde(default)]
    pub checklist: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskUpdate {
    /// Task ID or key, such as `WEB-042`.
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

/// Moves a task to `status`, at the place that one of `position`, `beforeTaskId` and `afterTaskId` gives. Without a place, the task goes to the top of the column; a move within the task's own column needs one.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskMove {
    /// Task ID or key, such as `WEB-042`.
    pub task_id: String,
    pub status: TaskStatus,
    /// The task's index in the column, counted from 0 at the top, without the task itself.
    #[serde(default)]
    pub position: Option<usize>,
    /// The ID or key of a task in the column; the task goes just above it.
    #[serde(default)]
    pub before_task_id: Option<String>,
    /// The ID or key of a task in the column; the task goes just below it.
    #[serde(default)]
    pub after_task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskBlock {
    /// Task ID or key, such as `WEB-042`.
    pub task_id: String,
    pub reason: String,
    #[serde(default)]
    pub mentions: Vec<MentionToken>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockReasonUpdate {
    pub block_id: String,
    pub reason: String,
    #[serde(default)]
    pub mentions: Vec<MentionToken>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskUnblock {
    /// Task ID or key, such as `WEB-042`.
    pub task_id: String,
    #[serde(default)]
    pub resolution: Option<String>,
}

/// Adds an item at the end of a task's checklist.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistItemAdd {
    /// Task ID or key, such as `WEB-042`.
    pub task_id: String,
    /// One line of at most 140 characters.
    pub title: String,
}

/// Changes a checklist item's title, whether it is done, or both.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistItemUpdate {
    pub item_id: String,
    /// One line of at most 140 characters.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub done: Option<bool>,
}

/// Moves a checklist item to the place that one of `position`, `beforeItemId` and `afterItemId` gives.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistItemMove {
    pub item_id: String,
    /// The item's index in the checklist, counted from 0 at the top, without the item itself.
    #[serde(default)]
    pub position: Option<usize>,
    /// The ID of another item of the checklist; the item goes just above it.
    #[serde(default)]
    pub before_item_id: Option<String>,
    /// The ID of another item of the checklist; the item goes just below it.
    #[serde(default)]
    pub after_item_id: Option<String>,
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
