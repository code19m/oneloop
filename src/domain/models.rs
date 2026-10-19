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
/// milestones and, for the Roadmap page, the tasks its lanes draw. A read of
/// the tasks a change named has the epics of the sections it changed alone,
/// and no tracks or milestones, which a task's change leaves as they are.
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

/// What the Roadmap's lanes draw, and what they count: the work in progress,
/// the longest overdue tasks, and the done tasks and dated plans of a window
/// of days, counted by day. Plans without a deadline stay on the Board, and
/// the counts include them.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapTimeline {
    /// The tasks of each track's own work and of each of its epics, by
    /// status; a section without tasks is left out.
    pub sections: Vec<SectionCounts>,
    /// Tasks past their deadline and not done.
    pub overdue: i64,
    /// The first and last day that any done task or dated plan of the project
    /// falls on, so the timeline spans them before their days load.
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    /// The work in progress the lanes draw: in each section, the few most
    /// urgent tasks; the rest only count. A read of the tasks a change named
    /// has those of their sections and of the sections it names.
    pub open: Vec<TaskView>,
    /// The tasks longest overdue, the longest first, which Overdue steps
    /// through. A read of the tasks a change named has them only when they
    /// may have changed: when a named task is among them, or the read says
    /// one was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub late: Option<Vec<RoadmapMark>>,
    /// The window's done tasks and dated plans.
    pub days: RoadmapDays,
    /// What one read of the lanes may ask for.
    pub limits: RoadmapLimits,
    /// The tasks a change named that are still in the project, when a read
    /// names them, but for those among `open`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<TaskView>>,
}

/// The done tasks and dated plans of a window of days, `from` to `to`: how
/// many each section has on each day, and the task itself on a day that has
/// one.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapDays {
    pub from: String,
    pub to: String,
    /// Each section with a done task or dated plan in the window.
    pub sections: Vec<SectionDays>,
    /// The days whose tasks of days with one all came, when the read asked
    /// for them: the window, or the days nearest its anchor when there were
    /// more of those tasks than it gives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marked: Option<DayRange>,
}

/// A span of days, `from` to `to`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayRange {
    pub from: String,
    pub to: String,
}

/// The most one read of the Roadmap's lanes may ask for: days in a window,
/// tasks of days with one, and days in a read of a change's sections alone.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapLimits {
    pub days: i64,
    pub marks: usize,
    pub change_days: i64,
}

/// One section's days: for each day of the window, from its first, the
/// tasks done on it, the plans due on it, and how many of those are blocked.
/// Each list ends at its last day with any.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionDays {
    pub track_id: String,
    pub epic_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub done: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plans: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked: Vec<i64>,
    /// The task of each of its days with one: as many as the read asks for
    /// in all sections, those nearest its anchor day first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<DayMark>,
}

/// A task as a mark on the Roadmap shows it, within its section: on its
/// line, in its card and in a list. Only what those show.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayMark {
    pub id: String,
    pub task_key: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assignee_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub blocked: bool,
}

/// A task as a mark shows it, with its track and epic: as the longest
/// overdue and the tasks of a list are.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapMark {
    pub track_id: String,
    pub epic_id: Option<String>,
    #[serde(flatten)]
    pub mark: DayMark,
}

/// The tasks a mark that counts several lists: the first ones, and how many
/// there are.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapList {
    pub items: Vec<RoadmapMark>,
    pub total: i64,
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
