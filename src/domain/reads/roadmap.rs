//! Roadmap reads: tracks, epics with their task counts by local day,
//! milestones, and the tasks the Roadmap's lanes draw.

use jiff::{
    Timestamp, ToSpan,
    civil::{Date, DateTime},
    tz::AmbiguousOffset,
};

use super::board::task_views;
use super::*;
use crate::domain::{
    LanesQuery, NAMED_TASKS_LIMIT, RoadmapDays, RoadmapPage, RoadmapPageQuery, RoadmapTimeline,
    RoadmapWindow, SectionCounts, service::validation::date,
};

pub(super) fn tracks(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<Vec<TrackView>> {
    let mut s = connection.prepare_cached(
        "SELECT id,project_id,name,position,revision FROM tracks WHERE project_id=?1 \
                     AND deleted_at IS NULL ORDER BY position,id",
    )?;
    Ok(s.query_map([project_id], |r| {
        Ok(TrackView {
            id: r.get(0)?,
            project_id: r.get(1)?,
            name: r.get(2)?,
            position: r.get(3)?,
            revision: r.get(4)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?)
}
/// Epics in timeline order, with their task counts as of `counted_at` when
/// it is given. Only the Roadmap shows the counts, which read every task of
/// the project.
pub(super) fn epics(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    counted_at: Option<i64>,
) -> AppResult<Vec<EpicView>> {
    let Some(now) = counted_at else {
        return epic_rows(connection, project_id);
    };
    epics_on(connection, project_id, timezone, local_date(timezone, now)?)
}

/// The instance's date at `now`.
pub(super) fn local_date(timezone: &TimeZone, now: i64) -> AppResult<Date> {
    let now = Timestamp::from_second(now)
        .map_err(|error| AppError::internal(format!("read the current time: {error}")))?;
    Ok(timezone.rules().to_datetime(now).date())
}

fn epic_rows(connection: &rusqlite::Connection, project_id: &str) -> AppResult<Vec<EpicView>> {
    let mut statement = connection.prepare_cached("SELECT id,project_id,track_id,title,description,start_date,end_date,state,position,\
                     revision FROM epics WHERE project_id=?1 AND deleted_at IS NULL ORDER BY start_date,position,id")?;
    Ok(statement
        .query_map([project_id], |row| {
            Ok(EpicView {
                id: row.get(0)?,
                project_id: row.get(1)?,
                track_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                start_date: row.get(5)?,
                end_date: row.get(6)?,
                state: row.get(7)?,
                position: row.get(8)?,
                revision: row.get(9)?,
                summary: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn epics_on(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    today: Date,
) -> AppResult<Vec<EpicView>> {
    let week_start = today - today.weekday().to_monday_zero_offset().days();
    let week_start_epoch = local_midnight(timezone, week_start)?;
    let trailing_start = today - 6.days();
    let mut boundaries = Vec::with_capacity(8);
    for offset in 0..8 {
        boundaries.push(local_midnight(timezone, trailing_start + offset.days())?);
    }
    let mut result = epic_rows(connection, project_id)?;
    for epic in &mut result {
        epic.summary = Some(EpicSummary {
            task_total: 0,
            task_done: 0,
            task_open: 0,
            completed_this_week: 0,
            completed_since_start: 0,
            weekly_completions: vec![0; 7],
        });
    }
    let starts = result
        .iter()
        .map(|epic| {
            let start = epic
                .start_date
                .parse::<Date>()
                .map_err(|_| AppError::internal("stored epic start date is invalid"))?;
            Ok((&epic.id, local_midnight(timezone, start)?))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let starts =
        serde_json::to_string(&starts).map_err(|error| AppError::internal(error.to_string()))?;
    // Bounded covering-index ranges return one row per epic. COUNT ranges avoid
    // decoding completion groups or evaluating eleven sums for every task.
    // JSON packs the fixed-size result into a single scalar column.
    let mut counts = connection.prepare_cached(EPIC_SUMMARY_SQL)?;
    let mut rows = counts.query(params![
        project_id,
        starts,
        week_start_epoch,
        boundaries[0],
        boundaries[1],
        boundaries[2],
        boundaries[3],
        boundaries[4],
        boundaries[5],
        boundaries[6],
        boundaries[7]
    ])?;
    while let Some(row) = rows.next()? {
        let index = row.get::<_, i64>(0)? as usize;
        let counts: [i64; 11] = serde_json::from_str(&row.get::<_, String>(1)?)
            .map_err(|error| AppError::internal(format!("invalid epic summary: {error}")))?;
        result[index].summary = Some(EpicSummary {
            task_total: counts[0],
            task_done: counts[1],
            task_open: counts[0] - counts[1],
            completed_this_week: counts[2],
            completed_since_start: counts[3],
            weekly_completions: counts[4..].to_vec(),
        });
    }
    Ok(result)
}

pub(super) const EPIC_SUMMARY_SQL: &str = "
    SELECT e.key,json_array(
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done'),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?3),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=json_extract(e.value,'$[1]')),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?4 AND t.completed_at<?5),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?5 AND t.completed_at<?6),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?6 AND t.completed_at<?7),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?7 AND t.completed_at<?8),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?8 AND t.completed_at<?9),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?9 AND t.completed_at<?10),
        (SELECT COUNT(*) FROM tasks t
         WHERE t.project_id=?1 AND t.epic_id=json_extract(e.value,'$[0]')
           AND t.deleted_at IS NULL AND t.status='done' AND t.completed_at>=?10 AND t.completed_at<?11))
    FROM json_each(?2) e";

pub(super) fn local_midnight(timezone: &TimeZone, mut date: Date) -> AppResult<i64> {
    // Midnight gaps and even skipped calendar dates map to the first following
    // representable local instant. Date-only records remain valid in every zone.
    // The instant is plain arithmetic because jiff timestamps end before
    // 9999-12-31, a valid date.
    const UNIX_EPOCH: DateTime = jiff::civil::date(1970, 1, 1).at(0, 0, 0, 0);
    loop {
        for hour in 0..24 {
            for minute in 0..60 {
                let local = date.at(hour, minute, 0, 0);
                let offset = match timezone.rules().to_ambiguous_timestamp(local).offset() {
                    AmbiguousOffset::Unambiguous { offset } => offset,
                    AmbiguousOffset::Fold { before, .. } => before,
                    AmbiguousOffset::Gap { .. } => continue,
                };
                let seconds = local.duration_since(UNIX_EPOCH).as_secs();
                return Ok(seconds - i64::from(offset.seconds()));
            }
        }
        date = date
            .tomorrow()
            .map_err(|_| AppError::internal("calendar range exhausted"))?;
    }
}

pub(super) fn milestones(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<Vec<MilestoneView>> {
    let mut s = connection.prepare_cached(
        "SELECT id,project_id,title,description,milestone_date,revision FROM milestones WHERE \
                     project_id=?1 AND deleted_at IS NULL ORDER BY milestone_date,id",
    )?;
    Ok(s.query_map([project_id], |r| {
        Ok(MilestoneView {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            description: r.get(3)?,
            milestone_date: r.get(4)?,
            revision: r.get(5)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?)
}

/// How many tasks in progress and in review the Roadmap draws at most. A
/// team has a few at a time; the limit only bounds a project with very many,
/// whose counts stay exact.
pub(super) const OPEN_LIMIT: usize = 500;
/// The most dated plans, and the most done tasks, that one Roadmap read
/// gives. The page holds no more of each, so one read of the days it holds
/// gives them all again.
pub(super) const TIMELINE_LIMIT: usize = 2_000;
/// The days the Roadmap opens with: done work from this many days back, and
/// dated plans up to this many days ahead. They cover its first view at
/// every scale but Quarters, with room to scroll.
const DAYS_BACK: i64 = 120;
const DAYS_AHEAD: i64 = 180;

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

/// Tasks in progress, then in review, each in the Board's order.
pub(super) const OPEN_SQL: &str = "SELECT id FROM tasks INDEXED BY tasks_project_status_idx
    WHERE project_id=?1 AND deleted_at IS NULL AND status IN ('in_progress','in_review')
    ORDER BY status,position LIMIT ?2";

/// The named tasks that are in the project and not deleted, each found by
/// its ID: the cross join keeps SQLite from reading the project's tasks.
pub(super) const NAMED_SQL: &str = "SELECT t.id FROM json_each(?2) j CROSS JOIN tasks t
    ON t.id=j.value WHERE t.project_id=?1 AND t.deleted_at IS NULL";

/// Dated plans after a deadline and ID, up to a last deadline, the earliest
/// first.
pub(super) const PLANS_SQL: &str = "SELECT id FROM tasks INDEXED BY tasks_dated_plans_idx
    WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL
      AND (deadline,id)>(?2,?3) AND deadline<=?4
    ORDER BY deadline,id LIMIT ?5";

/// Tasks done from an instant on and before a place in the order of Done,
/// the latest first.
pub(super) const DONE_SQL: &str = "SELECT id FROM tasks INDEXED BY tasks_project_done_completed_idx
    WHERE project_id=?1 AND status='done' AND deleted_at IS NULL
      AND completed_at>=?2 AND (completed_at,completion_order,id)<(?3,?4,?5)
    ORDER BY completed_at DESC,completion_order DESC,id DESC LIMIT ?6";

/// Where a page of the Roadmap's dated plans or done tasks goes on: after
/// the last task it holds, or past the last day it covers. Other changes
/// don't move it, so it stays valid.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum TimelineCursor {
    Plans {
        deadline: String,
        id: String,
    },
    Done {
        completed_at: i64,
        completion_order: i64,
        id: String,
    },
}

/// The first and last day of the Roadmap's window, each the one it opens with
/// when `window` leaves it out.
fn window_days(window: &RoadmapWindow, today: Date) -> AppResult<(Date, Date)> {
    let from = day(window.from.as_deref(), "from")?.unwrap_or(today - DAYS_BACK.days());
    let to = day(window.to.as_deref(), "to")?.unwrap_or(today + DAYS_AHEAD.days());
    if from > to {
        return Err(AppError::validation("from", "must not be after to"));
    }
    Ok((from, to))
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

/// The tasks the Roadmap's lanes draw, and what they count: the work in
/// progress with the dated plans and done tasks of a window of days, or only
/// the tasks a change named, as the rest stays as it was.
pub(super) fn timeline(
    connection: &rusqlite::Connection,
    project_id: &str,
    timezone: &TimeZone,
    today: Date,
    query: &LanesQuery,
) -> AppResult<RoadmapTimeline> {
    let (window, open, plans, done, named) = match query {
        LanesQuery::Days(window) => {
            let (from, to) = window_days(window, today)?;
            let open = connection
                .prepare_cached(OPEN_SQL)?
                .query_map(params![project_id, OPEN_LIMIT as i64], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            let plans = plan_ids(connection, project_id, ("", ""), to, TIMELINE_LIMIT)?;
            let start = local_midnight(timezone, from)?;
            let end = (day_end(timezone, to)?, i64::MIN, "");
            let done = done_ids(connection, project_id, start, end, TIMELINE_LIMIT)?;
            (Some((from, to, start)), open, plans, done, Vec::new())
        }
        LanesQuery::Tasks(ids) if ids.len() > NAMED_TASKS_LIMIT => {
            return Err(AppError::validation("tasks", "names too many tasks"));
        }
        LanesQuery::Tasks(ids) => {
            let named = named_ids(connection, project_id, ids)?;
            (None, Vec::new(), Vec::new(), Vec::new(), named)
        }
    };
    let sections = section_counts(connection, project_id)?;
    let overdue = connection
        .prepare_cached(OVERDUE_SQL)?
        .query_row(params![project_id, today.to_string()], |row| row.get(0))?;
    let reach = Reach::read(connection, project_id)?;
    // One read gives every task the lanes draw.
    let counts = (open.len(), plans.len(), done.len());
    let ids: Vec<String> = [open, plans, done, named].concat();
    let mut views = task_views(connection, &ids, false)?.into_iter();
    let open = views.by_ref().take(counts.0).collect();
    let days = window
        .map(|(from, to, start)| -> AppResult<RoadmapDays> {
            let (plans, done) = (
                views.by_ref().take(counts.1).collect(),
                views.by_ref().take(counts.2).collect(),
            );
            Ok(RoadmapDays {
                from: from.to_string(),
                to: to.to_string(),
                limit: TIMELINE_LIMIT,
                plans: plans_page(plans, TIMELINE_LIMIT, to, &reach)?,
                done: done_page(done, TIMELINE_LIMIT, from, start, &reach, timezone)?,
            })
        })
        .transpose()?;
    let tasks = matches!(query, LanesQuery::Tasks(_)).then(|| views.collect());
    let first_done = reach
        .first_done
        .map(|at| local_date(timezone, at).map(|day| day.to_string()))
        .transpose()?;
    // Dates in this form sort as text.
    let first_day = first_done.into_iter().chain(reach.first_plan).min();
    Ok(RoadmapTimeline {
        sections,
        overdue,
        first_day,
        last_day: reach.last_plan,
        open,
        days,
        tasks,
    })
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

/// The named tasks that are still in the project, each once.
fn named_ids(
    connection: &rusqlite::Connection,
    project_id: &str,
    ids: &[String],
) -> AppResult<Vec<String>> {
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    let ids = serde_json::to_string(&ids).map_err(|error| AppError::internal(error.to_string()))?;
    Ok(connection
        .prepare_cached(NAMED_SQL)?
        .query_map(params![project_id, ids], |row| row.get(0))?
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

/// The page of dated plans or done tasks that `cursor` goes on to, up to the
/// day `query` names: `to` for plans, `from` for done tasks.
pub(super) fn timeline_page(
    connection: &rusqlite::Connection,
    timezone: &TimeZone,
    query: &RoadmapPageQuery,
) -> AppResult<RoadmapPage> {
    let limit = paging::page_limit(query.limit, TIMELINE_LIMIT, TIMELINE_LIMIT);
    let cursor = paging::decode(&query.cursor)?;
    let (needed, unwanted) = match cursor {
        TimelineCursor::Plans { .. } => (("to", &query.to), ("from", &query.from)),
        TimelineCursor::Done { .. } => (("from", &query.from), ("to", &query.to)),
    };
    if unwanted.1.is_some() {
        return Err(AppError::validation(
            unwanted.0,
            "is only for the other kind of page",
        ));
    }
    let bound = day(needed.1.as_deref(), needed.0)?
        .ok_or_else(|| AppError::validation(needed.0, "is required"))?;
    let (project_id, reach) = (
        &query.project_id,
        Reach::read(connection, &query.project_id)?,
    );
    match cursor {
        TimelineCursor::Plans { deadline, id } => {
            let ids = plan_ids(connection, project_id, (&deadline, &id), bound, limit)?;
            plans_page(task_views(connection, &ids, false)?, limit, bound, &reach)
        }
        TimelineCursor::Done {
            completed_at,
            completion_order,
            id,
        } => {
            let start = local_midnight(timezone, bound)?;
            let ids = done_ids(
                connection,
                project_id,
                start,
                (completed_at, completion_order, &id),
                limit,
            )?;
            done_page(
                task_views(connection, &ids, false)?,
                limit,
                bound,
                start,
                &reach,
                timezone,
            )
        }
    }
}

/// Dated plans after `after` and due by `to`: one more than `limit`, which
/// says the page is full.
fn plan_ids(
    connection: &rusqlite::Connection,
    project_id: &str,
    after: (&str, &str),
    to: Date,
    limit: usize,
) -> AppResult<Vec<String>> {
    Ok(connection
        .prepare_cached(PLANS_SQL)?
        .query_map(
            params![
                project_id,
                after.0,
                after.1,
                to.to_string(),
                (limit + 1) as i64
            ],
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?)
}

/// Tasks done from `start` on and before `before`: one more than `limit`,
/// which says the page is full.
fn done_ids(
    connection: &rusqlite::Connection,
    project_id: &str,
    start: i64,
    before: (i64, i64, &str),
    limit: usize,
) -> AppResult<Vec<String>> {
    Ok(connection
        .prepare_cached(DONE_SQL)?
        .query_map(
            params![
                project_id,
                start,
                before.0,
                before.1,
                before.2,
                (limit + 1) as i64
            ],
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?)
}

/// Dated plans up to `to`. A full page goes on after its last plan and
/// covers in full the days before that plan's; otherwise it covers up to
/// `to`, and goes on past it while a later plan is left.
fn plans_page(
    mut items: Vec<TaskView>,
    limit: usize,
    to: Date,
    reach: &Reach,
) -> AppResult<RoadmapPage> {
    if items.len() > limit {
        items.truncate(limit);
        let last = items.last().expect("a full page has tasks");
        let deadline = last.deadline.clone().unwrap_or_default();
        let day = deadline
            .parse::<Date>()
            .map_err(|_| AppError::internal("stored deadline is invalid"))?;
        let cursor = TimelineCursor::Plans {
            deadline,
            id: last.id.clone(),
        };
        return Ok(RoadmapPage {
            reach: day.yesterday().unwrap_or(day).to_string(),
            next_cursor: Some(paging::encode(&cursor)),
            items,
        });
    }
    let later = reach
        .last_plan
        .as_deref()
        .is_some_and(|last| last > to.to_string().as_str());
    let next_cursor = match to.tomorrow() {
        Ok(next) if later => Some(paging::encode(&TimelineCursor::Plans {
            deadline: next.to_string(),
            id: String::new(),
        })),
        _ => None,
    };
    Ok(RoadmapPage {
        items,
        reach: to.to_string(),
        next_cursor,
    })
}

/// Tasks done from `from` (whose first instant is `start`) on. A full page
/// goes on before its earliest task and covers in full the days after that
/// task's; otherwise it covers from `from`, and goes on before it while an
/// earlier done task is left.
fn done_page(
    mut items: Vec<TaskView>,
    limit: usize,
    from: Date,
    start: i64,
    reach: &Reach,
    timezone: &TimeZone,
) -> AppResult<RoadmapPage> {
    if items.len() > limit {
        items.truncate(limit);
        let last = items.last().expect("a full page has tasks");
        let completed_at = last.completed_at.unwrap_or(start);
        let day = local_date(timezone, completed_at)?;
        let cursor = TimelineCursor::Done {
            completed_at,
            completion_order: last.completion_order.unwrap_or(0),
            id: last.id.clone(),
        };
        return Ok(RoadmapPage {
            reach: day.tomorrow().unwrap_or(day).to_string(),
            next_cursor: Some(paging::encode(&cursor)),
            items,
        });
    }
    let earlier = reach.first_done.is_some_and(|first| first < start);
    let next_cursor = earlier.then(|| {
        paging::encode(&TimelineCursor::Done {
            completed_at: start,
            completion_order: i64::MIN,
            id: String::new(),
        })
    });
    Ok(RoadmapPage {
        items,
        reach: from.to_string(),
        next_cursor,
    })
}
