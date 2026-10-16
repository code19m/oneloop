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
