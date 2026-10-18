-- The Roadmap counts each track's tasks by status. With deleted_at in the
-- track index, which its condition keeps NULL, SQLite counts from the index
-- alone instead of reading every task of the project.
DROP INDEX tasks_project_track_status_idx;
CREATE INDEX tasks_project_track_status_idx
    ON tasks(project_id, track_id, status, deleted_at) WHERE deleted_at IS NULL;

-- The Roadmap draws each planned task that has a deadline, earliest first,
-- and counts the late ones. Done tasks keep their deadlines, so the deadline
-- index would pass over every finished task. Status and deleted_at, which
-- the condition fixes, let SQLite page and count from the index alone.
CREATE INDEX tasks_dated_plans_idx
    ON tasks(project_id, deadline, id, status, deleted_at)
    WHERE deleted_at IS NULL AND status = 'planning' AND deadline IS NOT NULL;
