-- The Board can list Done with the most recently completed task first. The
-- partial index serves those pages in order, without sorting the column.
CREATE INDEX tasks_project_done_completed_idx
    ON tasks(project_id, completed_at DESC, id DESC)
    WHERE deleted_at IS NULL AND status = 'done';
