-- Cover Roadmap aggregates without repeated random table reads per epic.
CREATE INDEX tasks_project_summary_idx
    ON tasks(project_id, epic_id, status, completed_at)
    WHERE deleted_at IS NULL;
