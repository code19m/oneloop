//! The bootstrap: what the client needs to show its first view.

use super::board::{board_columns, board_counts_connection};
use super::lanes::timeline;
use super::roadmap::{epics, local_date, milestones, tracks};
use super::*;

fn unread_notification_count(connection: &rusqlite::Connection, actor: &Actor) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM notification_recipients WHERE user_id=?1 AND delivered_at IS NOT \
                     NULL AND read_at IS NULL AND archived_at IS NULL",
        [&actor.user_id],
        |row| row.get(0),
    )?)
}

pub(super) fn bootstrap_snapshot(
    connection: &rusqlite::Connection,
    actor: &Actor,
    query: BootstrapQuery,
    view: String,
    time_zone: &TimeZone,
) -> AppResult<BootstrapView> {
    let projects = projects(connection, actor)?;
    let direct_task = query
        .task_id
        .as_deref()
        .map(|id| resolve_task_id(connection, id))
        .transpose()?;
    let direct_project = match direct_task.as_deref() {
        Some(id) => connection
            .query_row(
                "SELECT project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
                [id],
                |row| row.get(0),
            )
            .optional()?,
        None => None,
    };
    // Someone else's switch, or one to a project the person can no longer
    // open, counts as none.
    let switched = query.switched_to.filter(|id| {
        query.switched_by.as_deref() == Some(actor.user_id.as_str())
            && projects.iter().any(|project| &project.id == id)
    });
    let selected = direct_project
        .or(query.project_id)
        .or(switched)
        .or_else(|| projects.first().map(|project| project.id.clone()));
    if selected
        .as_ref()
        .is_some_and(|id| !projects.iter().any(|project| &project.id == id))
    {
        return Err(AppError::NotFound {
            resource: "project",
        });
    }
    let mut result = BootstrapView {
        limits: crate::files::FileLimits::default(),
        time_zone: time_zone.name().into(),
        users: vec![user_view(connection, &actor.user_id)?],
        session: SessionView {
            user_id: actor.user_id.clone(),
            username: actor.username.clone(),
            name: actor.display_name.clone(),
            is_admin: actor.is_admin,
        },
        projects,
        memberships: Vec::new(),
        tracks: Vec::new(),
        epics: Vec::new(),
        milestones: Vec::new(),
        tasks: Vec::new(),
        inbox_unread_count: unread_notification_count(connection, actor)?,
        selected_project_id: selected.clone(),
        view,
        board_filter: None,
        board_counts: None,
        board_pages: Default::default(),
        roadmap: None,
        pool_counts: Default::default(),
        sync_cursor: crate::collaboration::sync_cursor(connection)?,
    };
    if let Some(project_id) = selected.as_deref() {
        result.memberships = memberships(connection, project_id)?;
        result.users = users(connection, actor, project_id)?;
        result.tracks = tracks(connection, project_id)?;
        // Only the Roadmap shows epic task counts, and draws tasks on its lanes.
        let counted_at = (result.view == "roadmap").then(unix_now).transpose()?;
        result.epics = epics(connection, project_id, time_zone, counted_at)?;
        result.milestones = milestones(connection, project_id)?;
        if let Some(now) = counted_at {
            result.roadmap = Some(
                timeline(
                    connection,
                    project_id,
                    time_zone,
                    local_date(time_zone, now)?,
                    &LanesQuery {
                        window: query.roadmap.clone(),
                        ..LanesQuery::default()
                    },
                )?
                .0,
            );
        }
        let counts = if result.view == "board" {
            require_project(connection, actor, project_id, Need::Read, false)?;
            // The pages a Board read gives for the address's filter.
            let board = board_columns(connection, project_id, Some(PAGE_SIZE), &query.filter)?;
            for (status, page) in [
                (TaskStatus::Planning, board.planning),
                (TaskStatus::InProgress, board.in_progress),
                (TaskStatus::InReview, board.in_review),
                (TaskStatus::Done, board.done),
            ] {
                result.board_pages.insert(
                    status.as_str().into(),
                    PageSummary {
                        next_cursor: page.next_cursor,
                        total: page.total,
                    },
                );
                result.tasks.extend(page.items);
            }
            result.board_filter = Some(query.filter);
            board.counts
        } else {
            board_counts_connection(connection, project_id)?
        };
        if let Some(id) = direct_task.as_deref() {
            result.tasks.retain(|task| task.id != id);
            result.tasks.push(task_view(connection, id)?);
        }
        result.board_counts = Some(counts);
        let mut statement = connection.prepare_cached(
            "SELECT scope,COUNT(*) FROM pool_items WHERE project_id=?1 AND (scope='team' OR \
                     owner_user_id=?2) GROUP BY scope",
        )?;
        for row in statement.query_map(params![project_id, actor.user_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })? {
            let (scope, total) = row?;
            result.pool_counts.insert(scope, total);
        }
    }

    Ok(result)
}
