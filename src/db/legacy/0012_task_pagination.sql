-- A durable freshness boundary for task pages, updated in the same write transaction.
CREATE TABLE project_task_versions (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO project_task_versions(project_id) SELECT id FROM projects;
CREATE TRIGGER project_task_version_created AFTER INSERT ON projects BEGIN
    INSERT INTO project_task_versions(project_id) VALUES(NEW.id);
END;
CREATE TRIGGER task_page_insert AFTER INSERT ON tasks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;
CREATE TRIGGER task_page_update AFTER UPDATE ON tasks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id IN (OLD.project_id,NEW.project_id);
END;
CREATE TRIGGER task_page_delete AFTER DELETE ON tasks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=OLD.project_id;
END;
CREATE TRIGGER task_page_epic_update AFTER UPDATE OF track_id ON epics BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;
CREATE TRIGGER task_page_assignee_insert AFTER INSERT ON task_assignees BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=(SELECT project_id FROM tasks WHERE id=NEW.task_id);
END;
CREATE TRIGGER task_page_assignee_delete AFTER DELETE ON task_assignees BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=(SELECT project_id FROM tasks WHERE id=OLD.task_id);
END;
CREATE INDEX tasks_epic_page_idx ON tasks(epic_id,
    CASE status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'planned' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
    task_number,id) WHERE deleted_at IS NULL;
CREATE TRIGGER task_page_block_insert AFTER INSERT ON task_blocks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;
CREATE TRIGGER task_page_block_update AFTER UPDATE ON task_blocks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;
CREATE TRIGGER task_page_block_delete AFTER DELETE ON task_blocks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=OLD.project_id;
END;
