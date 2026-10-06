-- Newest first lists tasks completed in the same second in the order they
-- were completed. Each move to Done takes the next number; 0 means the task
-- is not in Done.
ALTER TABLE tasks ADD COLUMN completion_order INTEGER NOT NULL DEFAULT 0;

-- Tasks already in Done keep their order: by completion time, then by ID.
UPDATE tasks SET completion_order = ordered.number
FROM (
    SELECT id, row_number() OVER (ORDER BY completed_at, id) AS number
    FROM tasks
    WHERE status = 'done'
) AS ordered
WHERE tasks.id = ordered.id;

-- The highest number, for the next move to Done.
CREATE INDEX tasks_completion_order_idx
    ON tasks(completion_order) WHERE completion_order > 0;

DROP INDEX tasks_project_done_completed_idx;
CREATE INDEX tasks_project_done_completed_idx
    ON tasks(project_id, completed_at DESC, completion_order DESC, id DESC)
    WHERE deleted_at IS NULL AND status = 'done';
