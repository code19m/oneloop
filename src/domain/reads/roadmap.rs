//! Roadmap reads: tracks, epics with their task counts by local day,
//! milestones, and the tasks the Roadmap's lanes draw.

use jiff::{
    Timestamp, ToSpan,
    civil::{Date, DateTime},
    tz::AmbiguousOffset,
};

use super::board::{newest_done_ids, task_views};
use super::*;
use crate::domain::{RoadmapPage, RoadmapTimeline, TrackCounts};

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
/// team has a few at a time; the limit only bounds a project with very many.
pub(super) const OPEN_LIMIT: usize = 500;
/// How many dated plans or done tasks one page of the Roadmap holds.
pub(super) const TIMELINE_PAGE: usize = 200;

/// Each track's tasks by status. Its track index is named, as for the
/// Board's track filter (see `TRACK_CONTENTS_SQL`).
pub(super) const TRACK_COUNTS_SQL: &str =
    "SELECT track_id,status,COUNT(*) FROM tasks INDEXED BY tasks_project_track_status_idx
    WHERE project_id=?1 AND deleted_at IS NULL GROUP BY track_id,status";

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

/// Tasks in progress, then in review, each in the Board's order.
pub(super) const OPEN_SQL: &str = "SELECT id FROM tasks INDEXED BY tasks_project_status_idx
    WHERE project_id=?1 AND deleted_at IS NULL AND status IN ('in_progress','in_review')
    ORDER BY status,position LIMIT ?2";

/// Dated plans after a deadline and ID, the earliest first.
pub(super) const PLANS_SQL: &str = "SELECT id FROM tasks INDEXED BY tasks_dated_plans_idx
    WHERE project_id=?1 AND deleted_at IS NULL AND status='planning' AND deadline IS NOT NULL
      AND (deadline,id)>(?2,?3)
    ORDER BY deadline,id LIMIT ?4";

/// Where a page of the Roadmap's dated plans or done tasks goes on: after
/// the last task it holds. Other changes don't move it, so it stays valid.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TimelineCursor {
    Plans {
        deadline: String,
        id: String,
    },
    Done {
        completed_at: Option<i64>,
        completion_order: i64,
        id: String,
    },
}

/// The tasks the Roadmap's lanes draw on `today`, and what they count.
pub(super) fn timeline(
    connection: &rusqlite::Connection,
    project_id: &str,
    today: Date,
) -> AppResult<RoadmapTimeline> {
    let mut track_counts: Vec<TrackCounts> = Vec::new();
    let mut statement = connection.prepare_cached(TRACK_COUNTS_SQL)?;
    let mut rows = statement.query([project_id])?;
    while let Some(row) = rows.next()? {
        let track_id: String = row.get(0)?;
        if track_counts
            .last()
            .is_none_or(|last| last.track_id != track_id)
        {
            track_counts.push(TrackCounts {
                track_id,
                planning: 0,
                in_progress: 0,
                in_review: 0,
                done: 0,
            });
        }
        let counts = track_counts.last_mut().expect("pushed above");
        let count = row.get(2)?;
        match row.get::<_, String>(1)?.as_str() {
            "planning" => counts.planning = count,
            "in_progress" => counts.in_progress = count,
            "in_review" => counts.in_review = count,
            "done" => counts.done = count,
            _ => return Err(AppError::internal("stored task has an invalid status")),
        }
    }
    let overdue = connection
        .prepare_cached(OVERDUE_SQL)?
        .query_row(params![project_id, today.to_string()], |row| row.get(0))?;
    let open: Vec<String> = connection
        .prepare_cached(OPEN_SQL)?
        .query_map(params![project_id, OPEN_LIMIT as i64], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let plans = plan_ids(connection, project_id, "", "")?;
    let done = newest_done_ids(connection, project_id, None, TIMELINE_PAGE + 1)?;
    // One read gives every task the lanes draw.
    let (open_count, plans_count) = (open.len(), plans.len());
    let ids: Vec<String> = open.into_iter().chain(plans).chain(done).collect();
    let mut views = task_views(connection, &ids, false)?.into_iter();
    let open = views.by_ref().take(open_count).collect();
    let plans = page(views.by_ref().take(plans_count).collect(), plans_cursor);
    let done = page(views.collect(), done_cursor);
    Ok(RoadmapTimeline {
        track_counts,
        overdue,
        open,
        plans,
        done,
    })
}

/// The page of dated plans or done tasks that `cursor` goes on to.
pub(super) fn timeline_page(
    connection: &rusqlite::Connection,
    project_id: &str,
    cursor: &str,
) -> AppResult<RoadmapPage> {
    let (ids, cursor): (_, fn(&TaskView) -> TimelineCursor) = match paging::decode(cursor)? {
        TimelineCursor::Plans { deadline, id } => (
            plan_ids(connection, project_id, &deadline, &id)?,
            plans_cursor,
        ),
        TimelineCursor::Done {
            completed_at,
            completion_order,
            id,
        } => (
            newest_done_ids(
                connection,
                project_id,
                Some((completed_at, completion_order, &id)),
                TIMELINE_PAGE + 1,
            )?,
            done_cursor,
        ),
    };
    Ok(page(task_views(connection, &ids, false)?, cursor))
}

/// One page more than fits, the earliest deadline first.
fn plan_ids(
    connection: &rusqlite::Connection,
    project_id: &str,
    deadline: &str,
    id: &str,
) -> AppResult<Vec<String>> {
    Ok(connection
        .prepare_cached(PLANS_SQL)?
        .query_map(
            params![project_id, deadline, id, (TIMELINE_PAGE + 1) as i64],
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?)
}

/// A page cut back to its size from one task more, which says that another
/// page follows from the last task it keeps.
fn page(mut items: Vec<TaskView>, cursor: fn(&TaskView) -> TimelineCursor) -> RoadmapPage {
    let more = items.len() > TIMELINE_PAGE;
    items.truncate(TIMELINE_PAGE);
    let next_cursor = items
        .last()
        .filter(|_| more)
        .map(|task| paging::encode(&cursor(task)));
    RoadmapPage { items, next_cursor }
}

fn plans_cursor(task: &TaskView) -> TimelineCursor {
    TimelineCursor::Plans {
        deadline: task.deadline.clone().unwrap_or_default(),
        id: task.id.clone(),
    }
}

fn done_cursor(task: &TaskView) -> TimelineCursor {
    TimelineCursor::Done {
        completed_at: task.completed_at,
        completion_order: task.completion_order.unwrap_or(0),
        id: task.id.clone(),
    }
}
