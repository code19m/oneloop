-- The Roadmap counts each track's tasks by status, in its own work and in
-- each epic. With the epic and deleted_at in the track index, which its
-- condition keeps NULL, SQLite counts from the index alone and in its order,
-- instead of reading every task of the project.
DROP INDEX tasks_project_track_status_idx;
CREATE INDEX tasks_project_track_status_idx
    ON tasks(project_id, track_id, status, epic_id, deleted_at) WHERE deleted_at IS NULL;

-- The Roadmap counts the planned tasks that have a deadline by day and by
-- track and epic, lists them earliest first, and counts the late ones. Done
-- tasks keep their deadlines, so the deadline index would pass over every
-- finished task. With the track, the epic, and the status and deleted_at
-- that the condition fixes, SQLite reads them from the index alone.
CREATE INDEX tasks_dated_plans_idx
    ON tasks(project_id, deadline, id, track_id, epic_id, status, deleted_at)
    WHERE deleted_at IS NULL AND status = 'planning' AND deadline IS NOT NULL;

-- The Roadmap counts done tasks by day and by track and epic. The track and
-- epic after the Board's order of Done, and the status and deleted_at that
-- the condition fixes, let SQLite read them from the index alone.
DROP INDEX tasks_project_done_completed_idx;
CREATE INDEX tasks_project_done_completed_idx
    ON tasks(project_id, completed_at DESC, completion_order DESC, id DESC, track_id, epic_id,
        status, deleted_at)
    WHERE deleted_at IS NULL AND status = 'done';
