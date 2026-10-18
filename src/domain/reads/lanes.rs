//! The Roadmap's lanes: what each track's lane draws and counts. Work in
//! progress comes as tasks, the few most urgent of each section. Done tasks
//! and dated plans come counted by day for a window of days, with the task
//! itself on a day that has just one, so a read stays small however busy the
//! project is; a mark that counts several lists its tasks on demand.

use std::{cmp::Ordering, collections::HashMap};

use jiff::{ToSpan, civil::Date};

use super::board::task_views;
use super::roadmap::{local_date, local_midnight};
use super::*;
use crate::domain::{
    DayMark, LanesQuery, ListKind, NAMED_TASKS_LIMIT, RoadmapDays, RoadmapList, RoadmapListQuery,
    RoadmapMark, RoadmapTimeline, RoadmapWindow, SectionCounts, SectionDays,
    service::validation::date,
};

/// The work in progress each section draws as bars, the most urgent first;
/// the rest only count. The web client draws as many.
pub(super) const BARS: usize = 3;
/// How many of the longest overdue tasks a read gives, for Overdue.
pub(super) const LATE_LIMIT: usize = 20;
/// How many tasks a list gives, after the bars for work in progress.
pub(super) const LIST_LIMIT: usize = 50;
/// The most days one read covers. A read of a change's sections alone
/// counts few of them, so it covers every day the page holds: ten years at
/// most.
pub(super) const WINDOW_DAYS_MAX: i64 = 400;
pub(super) const SECTIONS_WINDOW_DAYS_MAX: i64 = 3660;
/// How many tasks of days with one task a read gives, unless it asks for
/// another number, and the most it may ask for.
pub(super) const MARKS_DEFAULT: usize = 150;
pub(super) const MARKS_MAX: usize = 400;
/// The days the Roadmap opens with: what its first view shows at Months on
/// a wide screen (about seven weeks back to three months ahead), with the 60
/// days to spare on each side that the page keeps loaded.
const DAYS_BACK: i64 = 120;
const DAYS_AHEAD: i64 = 165;

/// Tasks by track, status and epic. The track index holds all three, so
/// SQLite counts from it alone and in its order; it is named, as for the
/// Board's track filter (see `TRACK_CONTENTS_SQL`).
pub(super) const SECTION_COUNTS_SQL: &str =
    "SELECT track_id,status,epic_id,COUNT(*) FROM tasks INDEXED BY tasks_project_track_status_idx
    WHERE project_id=?1 AND deleted_at IS NULL GROUP BY track_id,status,epic_id";

/// Late plans from their own index, and late work from the In Progress and
/// In Review columns. The deadline index would pass over every done task
/// that had a deadline.
pub(super) const OVERDUE_SQL: &str = "SELECT
    (SELECT COUNT(*) FROM tasks INDEXED BY tasks_dated_plans_idx
     WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL
       AND deadline<?2)
    + (SELECT COUNT(*) FROM tasks INDEXED BY tasks_project_status_idx
     WHERE project_id=?1 AND deleted_at IS NULL AND status IN ('in_progress','in_review')
       AND deadline<?2)";

/// When the first task was done, and the first and last deadline of a dated
/// plan: each the end of an index.
pub(super) const REACH_SQL: &str = "SELECT
    (SELECT MIN(completed_at) FROM tasks INDEXED BY tasks_project_done_completed_idx
     WHERE project_id=?1 AND status='done' AND deleted_at IS NULL AND completed_at IS NOT NULL),
    (SELECT MIN(deadline) FROM tasks INDEXED BY tasks_dated_plans_idx
     WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL),
    (SELECT MAX(deadline) FROM tasks INDEXED BY tasks_dated_plans_idx
     WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL)";

/// Work in progress with what ranks it: its deadline, its start, and
/// whether it is blocked.
pub(super) const OPEN_SQL: &str = "SELECT t.id,t.track_id,t.epic_id,t.deadline,
    COALESCE(t.started_at,t.updated_at),
    EXISTS(SELECT 1 FROM task_blocks b WHERE b.task_id=t.id AND b.resolved_at IS NULL)
    FROM tasks t INDEXED BY tasks_project_status_idx
    WHERE t.project_id=?1 AND t.deleted_at IS NULL AND t.status IN ('in_progress','in_review')";

/// One section's work in progress, ranked as `OPEN_SQL`'s.
pub(super) const SECTION_OPEN_SQL: &str = "SELECT t.id,t.track_id,t.epic_id,t.deadline,
    COALESCE(t.started_at,t.updated_at),
    EXISTS(SELECT 1 FROM task_blocks b WHERE b.task_id=t.id AND b.resolved_at IS NULL)
    FROM tasks t INDEXED BY tasks_project_track_status_idx
    WHERE t.project_id=?1 AND t.track_id=?2 AND t.status IN ('in_progress','in_review')
      AND t.epic_id IS ?3 AND t.deleted_at IS NULL";

/// The plans longest overdue, the earliest deadline first.
pub(super) const LATE_PLANS_SQL: &str =
    "SELECT id,deadline FROM tasks INDEXED BY tasks_dated_plans_idx
    WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL
      AND deadline<?2
    ORDER BY deadline,id LIMIT ?3";

/// The named tasks that are in the project and not deleted, each found by
/// its ID: the cross join keeps SQLite from reading the project's tasks.
pub(super) const NAMED_SQL: &str = "SELECT t.id,t.track_id,t.epic_id FROM json_each(?2) j
    CROSS JOIN tasks t ON t.id=j.value WHERE t.project_id=?1 AND t.deleted_at IS NULL";

/// Tasks done in a span of instants, with their sections.
pub(super) const DONE_DAYS_SQL: &str = "SELECT id,track_id,epic_id,completed_at
    FROM tasks INDEXED BY tasks_project_done_completed_idx
    WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
      AND completed_at>=?2 AND completed_at<?3";

/// Plans due in a span of days, with their sections and whether each is
/// blocked.
pub(super) const PLAN_DAYS_SQL: &str = "SELECT t.id,t.track_id,t.epic_id,t.deadline,
    EXISTS(SELECT 1 FROM task_blocks b WHERE b.task_id=t.id AND b.resolved_at IS NULL)
    FROM tasks t INDEXED BY tasks_dated_plans_idx
    WHERE t.project_id=?1 AND t.deleted_at IS NULL AND t.status='planning'
      AND t.deadline IS NOT NULL AND t.deadline>=?2 AND t.deadline<=?3";

/// One section's tasks done in a span of instants, the latest first.
pub(super) const SECTION_DONE_SQL: &str =
    "SELECT id FROM tasks INDEXED BY tasks_project_done_completed_idx
    WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
      AND completed_at>=?4 AND completed_at<?5 AND track_id=?2 AND epic_id IS ?3
    ORDER BY completed_at DESC,completion_order DESC,id DESC";

/// One section's plans due in a span of days, the earliest first.
pub(super) const SECTION_PLANS_SQL: &str = "SELECT id FROM tasks INDEXED BY tasks_dated_plans_idx
    WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL
      AND deadline>=?4 AND deadline<=?5 AND track_id=?2 AND epic_id IS ?3
    ORDER BY deadline,id";

/// What the lanes' marks show of each task, each found by its ID.
pub(super) const MARKS_SQL: &str = "SELECT t.id,t.task_key,t.track_id,t.epic_id,t.title,t.status,
    t.deadline,t.started_at,t.completed_at,
    EXISTS(SELECT 1 FROM task_blocks b WHERE b.task_id=t.id AND b.resolved_at IS NULL)
    FROM json_each(?1) j CROSS JOIN tasks t ON t.id=j.value WHERE t.deleted_at IS NULL";

/// What the Roadmap's lanes draw, and what they count: with the days of the
/// query's window, and, for a change made elsewhere, the tasks it named and
/// the sections it changed.
pub(super) fn timeline(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    today: Date,
    query: &LanesQuery,
) -> AppResult<(RoadmapTimeline, Option<Vec<SectionKey>>)> {
    let named = match &query.tasks {
        Some(ids) if ids.len() > NAMED_TASKS_LIMIT => {
            return Err(AppError::validation("tasks", "names too many tasks"));
        }
        Some(ids) => Some(named_ids(connection, project_id, ids)?),
        None => None,
    };
    // A change made elsewhere changed only the sections it names and the
    // ones its tasks are in now: their work in progress and their days.
    let changed: Option<Vec<SectionKey>> = named.as_ref().map(|named| {
        let mut sections: Vec<SectionKey> =
            query.sections.iter().map(|key| section_of(key)).collect();
        sections.extend(named.iter().map(|(_, section)| section.clone()));
        sections.sort();
        sections.dedup();
        sections
    });
    let days = days(
        connection,
        project_id,
        timezone,
        today,
        &query.window,
        false,
        changed.as_deref(),
    )?;
    let sections = section_counts(connection, project_id)?;
    let overdue = connection
        .prepare_cached(OVERDUE_SQL)?
        .query_row(params![project_id, today.to_string()], |row| row.get(0))?;
    let reach = Reach::read(connection, project_id)?;
    let open = open_work(connection, OPEN_SQL, params![project_id], today)?;
    let late = late_marks(connection, project_id, today, &open)?;
    // The work in progress drawn: each section's most urgent.
    let mut drawn = Vec::new();
    let mut per_section: HashMap<&(String, Option<String>), usize> = HashMap::new();
    for task in &open {
        let wanted = changed
            .as_ref()
            .is_none_or(|sections| sections.contains(&task.section));
        let count = per_section.entry(&task.section).or_default();
        if wanted && *count < BARS {
            drawn.push(task.id.clone());
        }
        *count += 1;
    }
    let views = task_views(connection, &drawn, false)?;
    // A change made elsewhere changed the longest overdue only if a task it
    // named is among them, or was.
    let late = (named.is_none()
        || query.late
        || late
            .iter()
            .any(|mark| named.iter().flatten().any(|(id, _)| *id == mark.mark.id)))
    .then_some(late);
    // The named tasks that the work in progress leaves out.
    let tasks = named
        .map(|named| {
            let rest: Vec<String> = named
                .into_iter()
                .map(|(id, _)| id)
                .filter(|id| !drawn.contains(id))
                .collect();
            task_views(connection, &rest, false)
        })
        .transpose()?;
    let first_done = reach
        .first_done
        .map(|at| local_date(timezone, at).map(|day| day.to_string()))
        .transpose()?;
    // Dates in this form sort as text.
    let first_day = first_done.into_iter().chain(reach.first_plan).min();
    Ok((
        RoadmapTimeline {
            sections,
            overdue,
            first_day,
            last_day: reach.last_plan,
            open: views,
            late,
            days,
            tasks,
        },
        changed,
    ))
}

/// A track and one of its epics, or none for the track's own work.
pub(super) type SectionKey = (String, Option<String>);

/// A section's key, `trackId/epicId` or `trackId/` for a track's own work.
fn section_of(key: &str) -> SectionKey {
    let (track, epic) = key.split_once('/').unwrap_or((key, ""));
    (
        track.to_owned(),
        (!epic.is_empty()).then(|| epic.to_owned()),
    )
}

/// The first and last day of a window of days, each left out the one the
/// Roadmap opens with, and the day its marks come nearest to.
fn window_days(
    window: &RoadmapWindow,
    today: Date,
    required: bool,
    most: i64,
) -> AppResult<(Date, Date, Date)> {
    let bound = |value: Option<&str>, field| -> AppResult<Option<Date>> {
        match day(value, field)? {
            None if required => Err(AppError::validation(field, "is required")),
            day => Ok(day),
        }
    };
    let from = bound(window.from.as_deref(), "from")?.unwrap_or(today - DAYS_BACK.days());
    let to = bound(window.to.as_deref(), "to")?.unwrap_or(today + DAYS_AHEAD.days());
    let anchor = day(window.anchor.as_deref(), "anchor")?.unwrap_or(today);
    if from > to {
        return Err(AppError::validation("from", "must not be after to"));
    }
    if i64::from((to - from).get_days()) >= most {
        return Err(AppError::validation(
            "to",
            format!("must be within {most} days of from"),
        ));
    }
    Ok((from, to, anchor))
}

fn day(value: Option<&str>, field: &'static str) -> AppResult<Option<Date>> {
    value
        .map(|value| {
            date(value, field)?
                .parse::<Date>()
                .map_err(|_| AppError::validation(field, "must be a valid date"))
        })
        .transpose()
}

/// The instant the day after `day` starts: where tasks done by the end of
/// `day` stop.
fn day_end(timezone: &TimeZone, day: Date) -> AppResult<i64> {
    day.tomorrow()
        .map_or(Ok(i64::MAX), |next| local_midnight(timezone, next))
}

/// The days of `window`: each section's done tasks and dated plans by day,
/// and the task itself on days with one, nearest the window's anchor first;
/// of the sections `only` names, when it names some. A read of the days
/// alone (`required`) names both ends of the window.
pub(super) fn days(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    today: Date,
    window: &RoadmapWindow,
    required: bool,
    only: Option<&[SectionKey]>,
) -> AppResult<RoadmapDays> {
    let most = if only.is_some() {
        SECTIONS_WINDOW_DAYS_MAX
    } else {
        WINDOW_DAYS_MAX
    };
    let (from, to, anchor) = window_days(window, today, required, most)?;
    let marks = window.marks.unwrap_or(MARKS_DEFAULT).min(MARKS_MAX);
    let count = (to - from).get_days() as usize + 1;
    // Where each day starts, and where the last one ends.
    let mut starts = Vec::with_capacity(count + 1);
    for offset in 0..count as i64 {
        starts.push(local_midnight(timezone, from + offset.days())?);
    }
    starts.push(day_end(timezone, to)?);
    let mut sections: HashMap<SectionKey, Section> = HashMap::new();
    let counted = |key: &SectionKey| only.is_none_or(|only| only.contains(key));
    let mut statement = connection.prepare_cached(DONE_DAYS_SQL)?;
    let mut rows = statement.query(params![project_id, starts[0], starts[count]])?;
    while let Some(row) = rows.next()? {
        let key = (row.get(1)?, row.get(2)?);
        if !counted(&key) {
            continue;
        }
        let at: i64 = row.get(3)?;
        let index = starts
            .partition_point(|start| *start <= at)
            .saturating_sub(1);
        sections
            .entry(key)
            .or_insert_with(|| Section::new(count))
            .done
            .add(index, row.get(0)?);
    }
    let mut statement = connection.prepare_cached(PLAN_DAYS_SQL)?;
    let mut rows = statement.query(params![project_id, from.to_string(), to.to_string()])?;
    while let Some(row) = rows.next()? {
        let key = (row.get(1)?, row.get(2)?);
        if !counted(&key) {
            continue;
        }
        let deadline: String = row.get(3)?;
        let index = deadline
            .parse::<Date>()
            .map_err(|_| AppError::internal("stored deadline is invalid"))
            .map(|day| (day - from).get_days() as usize)?;
        let blocked: bool = row.get(4)?;
        let section = sections.entry(key).or_insert_with(|| Section::new(count));
        section.plans.add(index, row.get(0)?);
        if blocked {
            section.blocked[index] += 1;
        }
    }
    // A day with one task gives the task itself, the days nearest the anchor first.
    let anchor = (anchor - from).get_days() as i64;
    let mut singles: Vec<(i64, &String)> = sections
        .values()
        .flat_map(|section| section.done.singles().chain(section.plans.singles()))
        .map(|(index, id)| ((index as i64 - anchor).abs(), id))
        .collect();
    singles.sort();
    let ids: Vec<String> = singles
        .iter()
        .take(marks)
        .map(|(_, id)| (*id).clone())
        .collect();
    let mut sections: Vec<SectionDays> = sections
        .into_iter()
        .map(|((track_id, epic_id), section)| SectionDays {
            track_id,
            epic_id,
            done: trimmed(section.done.counts),
            plans: trimmed(section.plans.counts),
            blocked: trimmed(section.blocked),
            marks: Vec::new(),
        })
        .collect();
    sections.sort_by(|a, b| (&a.track_id, &a.epic_id).cmp(&(&b.track_id, &b.epic_id)));
    // Each task in its section, which names its track and epic for it. The
    // read sees one state of the tasks, so each is in a section it counted.
    for mark in mark_views(connection, &ids)? {
        if let Some(section) = sections
            .iter_mut()
            .find(|section| section.track_id == mark.track_id && section.epic_id == mark.epic_id)
        {
            section.marks.push(mark.mark);
        }
    }
    Ok(RoadmapDays {
        from: from.to_string(),
        to: to.to_string(),
        sections,
    })
}

/// One section's days while they are counted.
struct Section {
    done: Counts,
    plans: Counts,
    blocked: Vec<i64>,
}

impl Section {
    fn new(days: usize) -> Self {
        Self {
            done: Counts::new(days),
            plans: Counts::new(days),
            blocked: vec![0; days],
        }
    }
}

/// Tasks on each day, and the first one of each.
struct Counts {
    counts: Vec<i64>,
    first: Vec<Option<String>>,
}

impl Counts {
    fn new(days: usize) -> Self {
        Self {
            counts: vec![0; days],
            first: vec![None; days],
        }
    }

    fn add(&mut self, day: usize, id: String) {
        self.counts[day] += 1;
        self.first[day].get_or_insert(id);
    }

    /// The days with one task each, and that task.
    fn singles(&self) -> impl Iterator<Item = (usize, &String)> {
        self.counts
            .iter()
            .zip(&self.first)
            .enumerate()
            .filter_map(|(day, (count, id))| (*count == 1).then_some(day).zip(id.as_ref()))
    }
}

/// The counts without the days after the last one with any.
fn trimmed(mut counts: Vec<i64>) -> Vec<i64> {
    let kept = counts
        .iter()
        .rposition(|count| *count > 0)
        .map_or(0, |last| last + 1);
    counts.truncate(kept);
    counts
}

/// The tasks one section has that a mark counting several stands for: at most
/// `LIST_LIMIT`, after the bars for work in progress, and how many there are.
pub(super) fn list(
    connection: &rusqlite::Connection,
    timezone: &TimeZone,
    today: Date,
    query: &RoadmapListQuery,
) -> AppResult<RoadmapList> {
    let section = params![query.project_id, query.track_id, query.epic_id];
    let ids: Vec<String> = match query.kind {
        ListKind::Open => open_work(connection, SECTION_OPEN_SQL, section, today)?
            .into_iter()
            .map(|task| task.id)
            .collect(),
        kind => {
            let window = RoadmapWindow {
                from: query.from.clone(),
                to: query.to.clone(),
                ..RoadmapWindow::default()
            };
            let (from, to, _) = window_days(&window, today, true, WINDOW_DAYS_MAX)?;
            let (sql, start, end) = match kind {
                ListKind::Done => (
                    SECTION_DONE_SQL,
                    rusqlite::types::Value::from(local_midnight(timezone, from)?),
                    rusqlite::types::Value::from(day_end(timezone, to)?),
                ),
                _ => (
                    SECTION_PLANS_SQL,
                    from.to_string().into(),
                    to.to_string().into(),
                ),
            };
            connection
                .prepare_cached(sql)?
                .query_map(
                    params![query.project_id, query.track_id, query.epic_id, start, end],
                    |row| row.get(0),
                )?
                .collect::<Result<_, _>>()?
        }
    };
    let shown = if query.kind == ListKind::Open {
        LIST_LIMIT + BARS
    } else {
        LIST_LIMIT
    };
    Ok(RoadmapList {
        total: ids.len() as i64,
        items: mark_views(connection, &ids[..ids.len().min(shown)])?,
    })
}

/// A task in progress or in review, with what ranks it.
struct OpenTask {
    id: String,
    section: (String, Option<String>),
    deadline: Option<String>,
    start: i64,
    blocked: bool,
}

/// Work in progress, the most urgent first: late, then blocked, then the
/// nearest deadline, then the earliest start, as the lanes rank their bars.
fn open_work(
    connection: &rusqlite::Connection,
    sql: &str,
    values: impl rusqlite::Params,
    today: Date,
) -> AppResult<Vec<OpenTask>> {
    let mut open: Vec<OpenTask> = connection
        .prepare_cached(sql)?
        .query_map(values, |row| {
            Ok(OpenTask {
                id: row.get(0)?,
                section: (row.get(1)?, row.get(2)?),
                deadline: row.get(3)?,
                start: row.get(4)?,
                blocked: row.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let today = today.to_string();
    let late = |task: &OpenTask| {
        task.deadline
            .as_ref()
            .is_some_and(|deadline| *deadline < today)
    };
    open.sort_by(|a, b| {
        late(b)
            .cmp(&late(a))
            .then(b.blocked.cmp(&a.blocked))
            .then_with(|| match (&a.deadline, &b.deadline) {
                (Some(a), Some(b)) => a.cmp(b),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            })
            .then(a.start.cmp(&b.start))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(open)
}

/// The tasks longest overdue, the earliest deadline first: plans, and work
/// in progress.
fn late_marks(
    connection: &rusqlite::Connection,
    project_id: &str,
    today: Date,
    open: &[OpenTask],
) -> AppResult<Vec<RoadmapMark>> {
    let today = today.to_string();
    let mut late: Vec<(String, String)> = connection
        .prepare_cached(LATE_PLANS_SQL)?
        .query_map(params![project_id, today, LATE_LIMIT as i64], |row| {
            Ok((row.get(1)?, row.get(0)?))
        })?
        .collect::<Result<_, _>>()?;
    late.extend(open.iter().filter_map(|task| {
        task.deadline
            .clone()
            .filter(|deadline| *deadline < today)
            .map(|deadline| (deadline, task.id.clone()))
    }));
    late.sort();
    late.truncate(LATE_LIMIT);
    let ids: Vec<String> = late.into_iter().map(|(_, id)| id).collect();
    mark_views(connection, &ids)
}

/// What the lanes' marks show of the tasks `ids`, in their order.
fn mark_views(connection: &rusqlite::Connection, ids: &[String]) -> AppResult<Vec<RoadmapMark>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let encoded =
        serde_json::to_string(ids).map_err(|error| AppError::internal(error.to_string()))?;
    let mut marks: HashMap<String, RoadmapMark> = connection
        .prepare_cached(MARKS_SQL)?
        .query_map([&encoded], |row| {
            let status: String = row.get(5)?;
            let (done, open) = (
                status == "done",
                status == "in_progress" || status == "in_review",
            );
            Ok(RoadmapMark {
                track_id: row.get(2)?,
                epic_id: row.get(3)?,
                mark: DayMark {
                    id: row.get(0)?,
                    task_key: row.get(1)?,
                    title: row.get(4)?,
                    deadline: row.get(6)?,
                    started_at: if open { row.get(7)? } else { None },
                    completed_at: if done { row.get(8)? } else { None },
                    assignee_ids: Vec::new(),
                    blocked: !done && row.get::<_, bool>(9)?,
                    status,
                },
            })
        })?
        .map(|mark| mark.map(|mark| (mark.mark.id.clone(), mark)))
        .collect::<Result<_, _>>()?;
    let mut statement = connection.prepare_cached(
        "SELECT task_id,user_id FROM task_assignees WHERE task_id IN (SELECT value FROM \
                     json_each(?1)) ORDER BY assigned_at,user_id",
    )?;
    for row in statement.query_map([&encoded], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, user) = row?;
        if let Some(mark) = marks.get_mut(&id) {
            mark.mark.assignee_ids.push(user);
        }
    }
    Ok(ids.iter().filter_map(|id| marks.remove(id)).collect())
}

/// The tasks of each track's own work and of each of its epics, by status.
fn section_counts(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<Vec<SectionCounts>> {
    let mut sections: Vec<SectionCounts> = Vec::new();
    let mut statement = connection.prepare_cached(SECTION_COUNTS_SQL)?;
    let mut rows = statement.query([project_id])?;
    while let Some(row) = rows.next()? {
        let (track_id, epic_id): (String, Option<String>) = (row.get(0)?, row.get(2)?);
        // Rows come by track, then status: a track's sections are among the last few.
        let index = match sections
            .iter()
            .rposition(|section| section.track_id == track_id && section.epic_id == epic_id)
        {
            Some(index) => index,
            None => {
                sections.push(SectionCounts {
                    track_id,
                    epic_id,
                    planning: 0,
                    in_progress: 0,
                    in_review: 0,
                    done: 0,
                });
                sections.len() - 1
            }
        };
        let (counts, count) = (&mut sections[index], row.get(3)?);
        match row.get::<_, String>(1)?.as_str() {
            "planning" => counts.planning = count,
            "in_progress" => counts.in_progress = count,
            "in_review" => counts.in_review = count,
            "done" => counts.done = count,
            _ => return Err(AppError::internal("stored task has an invalid status")),
        }
    }
    Ok(sections)
}

/// The named tasks that are still in the project, each once, with their sections.
fn named_ids(
    connection: &rusqlite::Connection,
    project_id: &str,
    ids: &[String],
) -> AppResult<Vec<(String, SectionKey)>> {
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    let ids = serde_json::to_string(&ids).map_err(|error| AppError::internal(error.to_string()))?;
    Ok(connection
        .prepare_cached(NAMED_SQL)?
        .query_map(params![project_id, ids], |row| {
            Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
        })?
        .collect::<Result<_, _>>()?)
}

/// How far the project's done tasks and dated plans reach.
struct Reach {
    first_done: Option<i64>,
    first_plan: Option<String>,
    last_plan: Option<String>,
}

impl Reach {
    fn read(connection: &rusqlite::Connection, project_id: &str) -> AppResult<Self> {
        Ok(connection
            .prepare_cached(REACH_SQL)?
            .query_row([project_id], |row| {
                Ok(Self {
                    first_done: row.get(0)?,
                    first_plan: row.get(1)?,
                    last_plan: row.get(2)?,
                })
            })?)
    }
}
