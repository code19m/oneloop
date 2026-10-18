//! The views that domain reads and commands return.
use serde::{Deserialize, Serialize};

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
    /// The prefixes the project had before `task_prefix`. Its older tasks
    /// keep their keys with them, which still name the tasks.
    pub earlier_prefixes: Vec<String>,
    pub revision: i64,
    pub manage_roadmap: bool,
    pub manage_board: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMembers {
    pub project: ProjectView,
    pub memberships: Vec<MembershipView>,
    /// The members, and the reader even when not a member.
    pub users: Vec<UserView>,
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
    pub track_id: String,
    /// An epic on the task's track, or null when the task has none.
    pub epic_id: Option<String>,
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
    /// When work on the task started: its first move into In Progress or In
    /// Review since it was last in Planning. Null until then.
    pub started_at: Option<i64>,
    /// When the task last moved to Done; null for open tasks.
    pub completed_at: Option<i64>,
    /// Orders tasks completed in the same second: a higher number moved to
    /// Done later. Null for open tasks.
    #[serde(default)]
    pub completion_order: Option<i64>,
    pub revision: i64,
    pub assignee_ids: Vec<String>,
    pub active_block: Option<BlockView>,
    /// How many checklist items the task has, and how many of them are done.
    #[serde(default)]
    pub checklist_done: i64,
    #[serde(default)]
    pub checklist_total: i64,
    /// Goes up with each change to the checklist, which leaves `revision` as it is.
    #[serde(default)]
    pub checklist_version: i64,
    /// The checklist items in order, on detail reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checklist: Option<Vec<ChecklistItemView>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItemView {
    pub id: String,
    pub task_id: String,
    pub position: i64,
    pub title: String,
    pub done: bool,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockView {
    pub id: String,
    pub reason: String,
    pub created_by: String,
    pub created_at: i64,
    pub revision: i64,
    pub mentions: Vec<crate::collaboration::MentionToken>,
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

/// A project's Roadmap: its tracks, its epics with their progress, its
/// milestones and, for the Roadmap page, the tasks its lanes draw.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapView {
    pub project_id: String,
    pub tracks: Vec<TrackView>,
    pub epics: Vec<EpicView>,
    pub milestones: Vec<MilestoneView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lanes: Option<RoadmapTimeline>,
}

/// The tasks the Roadmap's lanes draw, and what they count: the work in
/// progress, and the dated plans and done tasks of a window of days, or the
/// tasks a change made elsewhere named. Plans without a deadline stay on the
/// Board, and the counts include them.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapTimeline {
    /// The tasks of each track's own work and of each of its epics, by
    /// status; a section without tasks is left out.
    pub sections: Vec<SectionCounts>,
    /// Tasks past their deadline and not done.
    pub overdue: i64,
    /// The first and last day that any done task or dated plan of the project
    /// falls on, so the timeline spans them before their pages load.
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    /// Tasks in progress and in review, in the Board's order, up to a limit;
    /// a read of named tasks has only those among `tasks`.
    pub open: Vec<TaskView>,
    /// The window's dated plans and done tasks; a read of named tasks has none.
    #[serde(flatten)]
    pub days: Option<RoadmapDays>,
    /// The named tasks that are still in the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<TaskView>>,
}

/// The dated plans and done tasks of a window of days.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapDays {
    /// The first and last day of the window, which a read of the same lanes
    /// asks for again.
    pub from: String,
    pub to: String,
    /// The most dated plans, and the most done tasks, that one read gives and
    /// the lanes hold.
    pub limit: usize,
    /// Planned tasks with a deadline by the window's last day, the earliest
    /// first, late ones included.
    pub plans: RoadmapPage,
    /// Tasks done in the window, the latest finished first.
    pub done: RoadmapPage,
}

/// How many tasks a track's own work (without `epic_id`) or one of its epics
/// has in each status.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionCounts {
    pub track_id: String,
    pub epic_id: Option<String>,
    pub planning: i64,
    pub in_progress: i64,
    pub in_review: i64,
    pub done: i64,
}

/// A page of the Roadmap's dated plans or done tasks: every one from where
/// the page starts to `reach`, or as many as fit.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapPage {
    pub items: Vec<TaskView>,
    /// The day the page covers in full: done tasks from it on, or dated plans
    /// up to it. It is the day asked for unless the page was full.
    pub reach: String,
    /// Where the next page goes on, earlier for done tasks and later for
    /// plans; null when no task is left that way.
    pub next_cursor: Option<String>,
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
    pub inbox_unread_count: i64,
    pub selected_project_id: Option<String>,
    /// The initial view this bootstrap was built for.
    pub view: String,
    /// The filter and Done order of `board_pages`, present when the bootstrap
    /// has them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_filter: Option<super::TaskFilter>,
    pub board_counts: Option<BoardCounts>,
    #[serde(default)]
    pub board_pages: std::collections::BTreeMap<String, PageSummary>,
    /// The Roadmap's lanes, when the bootstrap is for the Roadmap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roadmap: Option<RoadmapTimeline>,
    #[serde(default)]
    pub pool_counts: std::collections::BTreeMap<String, i64>,
    #[serde(default)]
    pub sync_cursor: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub next_cursor: Option<String>,
    pub total: i64,
}
