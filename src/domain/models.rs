use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: String,
    pub username: String,
    pub name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub avatar_url: Option<String>,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub user_id: String,
    pub username: String,
    pub name: String,
    pub is_admin: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub task_prefix: String,
    pub revision: i64,
    pub manage_roadmap: bool,
    pub manage_board: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipView {
    pub project_id: String,
    pub user_id: String,
    pub manage_roadmap: bool,
    pub manage_board: bool,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackView {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub position: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicView {
    pub id: String,
    pub project_id: String,
    pub track_id: String,
    pub title: String,
    pub description: String,
    pub start_date: String,
    pub end_date: Option<String>,
    pub state: String,
    pub position: i64,
    /// Task counts, read only where the Roadmap shows them.
    #[serde(flatten)]
    pub summary: Option<EpicSummary>,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicSummary {
    pub task_total: i64,
    pub task_done: i64,
    pub task_open: i64,
    pub completed_this_week: i64,
    pub completed_since_start: i64,
    pub weekly_completions: Vec<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneView {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub milestone_date: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub project_id: String,
    pub epic_id: String,
    pub task_number: i64,
    pub task_key: String,
    pub title: String,
    /// Present on detail reads; omitted from bounded Board card projections.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: String,
    pub position: i64,
    pub deadline: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub assignee_ids: Vec<String>,
    pub active_block: Option<BlockView>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockView {
    pub id: String,
    pub reason: String,
    pub created_by: String,
    pub created_at: i64,
    pub revision: i64,
    pub mentions: Vec<super::MentionInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolItemView {
    pub id: String,
    pub project_id: String,
    pub scope: String,
    pub owner_user_id: Option<String>,
    pub title: String,
    pub description: String,
    pub created_at: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCounts {
    pub planning: i64,
    pub in_progress: i64,
    pub in_review: i64,
    pub done: i64,
    pub blocked: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    pub project_id: String,
    pub planning: Page<TaskView>,
    pub in_progress: Page<TaskView>,
    pub in_review: Page<TaskView>,
    pub done: Page<TaskView>,
    /// Project-wide counts stay unfiltered so navigation totals do not jump
    /// while the user narrows the Board.
    pub counts: BoardCounts,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapView {
    pub limits: crate::files::FileLimits,
    pub time_zone: String,
    pub users: Vec<UserView>,
    pub session: SessionView,
    pub projects: Vec<ProjectView>,
    pub memberships: Vec<MembershipView>,
    pub tracks: Vec<TrackView>,
    pub epics: Vec<EpicView>,
    pub milestones: Vec<MilestoneView>,
    pub tasks: Vec<TaskView>,
    pub pool: Vec<PoolItemView>,
    pub notifications: Vec<Value>,
    pub inbox_unread_count: i64,
    pub browser_sessions: Vec<Value>,
    pub app_grants: Vec<Value>,
    pub page_info: BootstrapPageInfo,
    pub selected_project_id: Option<String>,
    pub view: Option<String>,
    pub board_counts: Option<BoardCounts>,
    #[serde(default)]
    pub board_pages: std::collections::BTreeMap<String, PageSummary>,
    #[serde(default)]
    pub pool_counts: std::collections::BTreeMap<String, i64>,
    #[serde(default)]
    pub sync_cursor: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPageInfo {
    pub tasks_truncated: bool,
    pub tasks_next_cursor: Option<String>,
    pub notifications_truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub next_cursor: Option<String>,
    pub total: i64,
}
