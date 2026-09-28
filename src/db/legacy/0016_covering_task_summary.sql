-- Include the live-row predicate in the covering index as well.
DROP INDEX tasks_project_summary_idx;
CREATE INDEX tasks_project_summary_idx
    ON tasks(project_id, epic_id, status, completed_at, deleted_at)
    WHERE deleted_at IS NULL;
