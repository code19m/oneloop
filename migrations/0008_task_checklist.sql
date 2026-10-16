-- A task's checklist: short items in order, each done or not. Positions run
-- from 0 without gaps. An item has its own revision, so a change to it never
-- conflicts with an edit of the task.
CREATE TABLE task_checklist_items (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (task_id, position)
) STRICT;

-- The task's checklist version counts the changes to its checklist, so a
-- client can tell an older checklist from a newer one of the same task
-- revision.
ALTER TABLE tasks ADD COLUMN checklist_version INTEGER NOT NULL DEFAULT 0 CHECK (checklist_version >= 0);

-- Only a checklist command raises the version, in an UPDATE of its own. That
-- changes no page of tasks, so it leaves the cursors of those pages valid.
DROP TRIGGER task_page_update;
CREATE TRIGGER task_page_update AFTER UPDATE ON tasks
WHEN OLD.checklist_version = NEW.checklist_version BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id IN (OLD.project_id,NEW.project_id);
END;
