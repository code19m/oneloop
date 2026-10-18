-- Every task sits on a track. An epic is optional, and when a task has one,
-- it is on the task's track. Each task also records when work on it started.
-- SQLite can't change a column's constraints, so the table is rebuilt; the
-- runner turns foreign keys off around it and checks them all at the end.
CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
    epic_id TEXT REFERENCES epics(id) ON DELETE RESTRICT,
    task_number INTEGER NOT NULL CHECK (task_number > 0),
    task_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'in_progress', 'in_review', 'done')),
    position INTEGER NOT NULL,
    deadline TEXT CHECK (
        deadline IS NULL OR (length(deadline) = 10 AND deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    ),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    completion_order INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    search_title TEXT NOT NULL DEFAULT '',
    checklist_version INTEGER NOT NULL DEFAULT 0 CHECK (checklist_version >= 0),
    UNIQUE (project_id, task_number)
) STRICT;

-- Each task, deleted ones too, takes its epic's track. A task whose epic
-- can't be found has no track, which fails the migration instead of losing
-- the task.
INSERT INTO tasks_new (id,project_id,track_id,epic_id,task_number,task_key,title,description,status,position,
    deadline,created_by,created_at,updated_at,completed_at,completion_order,deleted_at,revision,search_title,
    checklist_version)
SELECT id,project_id,(SELECT track_id FROM epics WHERE epics.id = tasks.epic_id),epic_id,task_number,task_key,
    title,description,status,position,deadline,created_by,created_at,updated_at,completed_at,completion_order,
    deleted_at,revision,search_title,checklist_version
FROM tasks;

-- Work on a task started at its latest move from Planning into In Progress or
-- In Review, or its creation there, unless a later move back to Planning
-- undid it. Tasks in Planning have no start. History from before 0.1.0 may
-- call Planning `planned`.
UPDATE tasks_new SET started_at = (
    SELECT MAX(start.created_at) FROM activity_events start
    WHERE start.entity_type = 'task' AND start.entity_id = tasks_new.id
      AND ((start.event_type = 'task.moved' AND start.field_key = 'status'
            AND start.before_json IN ('"planning"', '"planned"')
            AND start.after_json IN ('"in_progress"', '"in_review"'))
        OR (start.event_type = 'task.created'
            AND json_extract(start.after_json, '$.status') IN ('in_progress', 'in_review')))
      AND NOT EXISTS (
        SELECT 1 FROM activity_events back
        WHERE back.entity_type = 'task' AND back.entity_id = tasks_new.id
          AND back.event_type = 'task.moved' AND back.field_key = 'status'
          AND back.after_json IN ('"planning"', '"planned"')
          AND (back.created_at, back.id) > (start.created_at, start.id))
)
WHERE status <> 'planning';

-- The rename checks every trigger, so the triggers of other tables that read
-- tasks go first. Dropping the table drops its own indexes and triggers. All
-- of them come back below, as they were.
DROP TRIGGER task_assignees_require_active_membership;
DROP TRIGGER memberships_protect_unfinished_assignments;
DROP TRIGGER comments_require_matching_thread_insert;
DROP TRIGGER task_blocks_require_matching_open_task;
DROP TRIGGER task_attachments_require_matching_available_blob;
DROP TRIGGER task_page_assignee_insert;
DROP TRIGGER task_page_assignee_delete;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX tasks_project_status_idx
    ON tasks(project_id, deleted_at, status, position);

CREATE INDEX tasks_epic_status_idx
    ON tasks(epic_id, deleted_at, status);

CREATE UNIQUE INDEX tasks_active_position_unique
    ON tasks(project_id, status, position) WHERE deleted_at IS NULL;

CREATE INDEX tasks_deadline_idx
    ON tasks(project_id, deadline) WHERE deleted_at IS NULL AND deadline IS NOT NULL;

CREATE INDEX tasks_deleted_idx ON tasks(id) WHERE deleted_at IS NOT NULL;

CREATE INDEX tasks_epic_page_idx ON tasks(epic_id,
    CASE status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'planning' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
    task_number,id) WHERE deleted_at IS NULL;

CREATE INDEX tasks_project_summary_idx
    ON tasks(project_id, epic_id, status, completed_at, deleted_at)
    WHERE deleted_at IS NULL;

CREATE INDEX tasks_completion_order_idx
    ON tasks(completion_order) WHERE completion_order > 0;

CREATE INDEX tasks_project_done_completed_idx
    ON tasks(project_id, completed_at DESC, completion_order DESC, id DESC)
    WHERE deleted_at IS NULL AND status = 'done';

-- A track's tasks by status: the Board's track filter, the check before a
-- track is deleted, and the Roadmap's lanes. Without the position, moving a
-- card within its column leaves the index as it is.
CREATE INDEX tasks_project_track_status_idx
    ON tasks(project_id, track_id, status) WHERE deleted_at IS NULL;

-- A task that is not deleted is on a track of its project that is not
-- deleted, and its epic, when it has one, is on that track and not deleted.
-- A deleted task keeps what it had; restoring it checks again.
CREATE TRIGGER tasks_require_track_in_project_insert
BEFORE INSERT ON tasks
WHEN NOT EXISTS (
    SELECT 1 FROM tracks
    WHERE id = NEW.track_id AND project_id = NEW.project_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task track must belong to the same project');
END;

CREATE TRIGGER tasks_require_track_in_project_update
BEFORE UPDATE OF track_id, project_id, deleted_at ON tasks
WHEN NEW.deleted_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM tracks
    WHERE id = NEW.track_id AND project_id = NEW.project_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task track must belong to the same project');
END;

CREATE TRIGGER tasks_require_epic_on_track_insert
BEFORE INSERT ON tasks
WHEN NEW.epic_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM epics
    WHERE id = NEW.epic_id AND track_id = NEW.track_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task epic must be on the task track');
END;

CREATE TRIGGER tasks_require_epic_on_track_update
BEFORE UPDATE OF epic_id, track_id, deleted_at ON tasks
WHEN NEW.deleted_at IS NULL AND NEW.epic_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM epics
    WHERE id = NEW.epic_id AND track_id = NEW.track_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task epic must be on the task track');
END;

CREATE TRIGGER task_page_insert AFTER INSERT ON tasks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;

-- Only a checklist command raises the checklist version, in an UPDATE of its
-- own. That changes no page of tasks, so it leaves their cursors valid.
CREATE TRIGGER task_page_update AFTER UPDATE ON tasks
WHEN OLD.checklist_version = NEW.checklist_version BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id IN (OLD.project_id,NEW.project_id);
END;

CREATE TRIGGER task_page_delete AFTER DELETE ON tasks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=OLD.project_id;
END;

CREATE TRIGGER task_title_normalize_insert AFTER INSERT ON tasks BEGIN
    UPDATE tasks SET search_title=oneloop_lower(NEW.title) WHERE id=NEW.id;
END;

CREATE TRIGGER task_title_normalize_update AFTER UPDATE OF title ON tasks WHEN NEW.title <> OLD.title BEGIN
    UPDATE tasks SET search_title=oneloop_lower(NEW.title) WHERE id=NEW.id;
END;

CREATE TRIGGER task_assignees_require_active_membership
BEFORE INSERT ON task_assignees
WHEN NOT EXISTS (
    SELECT 1
    FROM tasks t
    JOIN project_memberships pm ON pm.project_id = t.project_id AND pm.user_id = NEW.user_id
    JOIN users u ON u.id = pm.user_id AND u.is_active = 1
    WHERE t.id = NEW.task_id AND t.deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task assignee must be an active project member');
END;

CREATE TRIGGER memberships_protect_unfinished_assignments
BEFORE DELETE ON project_memberships
WHEN EXISTS (
    SELECT 1
    FROM task_assignees ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE ta.user_id = OLD.user_id
      AND t.project_id = OLD.project_id
      AND t.deleted_at IS NULL
      AND t.status <> 'done'
)
BEGIN
    SELECT RAISE(ABORT, 'membership has unfinished assigned tasks');
END;

CREATE TRIGGER comments_require_matching_thread_insert
BEFORE INSERT ON comments
WHEN NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id AND t.deleted_at IS NULL
    )
    OR (
        NEW.reply_to_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM comments target
            WHERE target.id = NEW.reply_to_id
              AND target.task_id = NEW.task_id
              AND target.root_id = NEW.root_id
              AND target.deleted_at IS NULL
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'comment thread must belong to the same task');
END;

CREATE TRIGGER task_blocks_require_matching_open_task
BEFORE INSERT ON task_blocks
WHEN NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND project_id = NEW.project_id
      AND deleted_at IS NULL
      AND status <> 'done'
)
BEGIN
    SELECT RAISE(ABORT, 'only an unfinished task in the same project can be blocked');
END;

CREATE TRIGGER task_attachments_require_matching_available_blob
BEFORE INSERT ON task_attachments
WHEN NOT EXISTS (
        SELECT 1 FROM tasks
        WHERE id = NEW.task_id AND project_id = NEW.project_id AND deleted_at IS NULL
    )
    OR NOT EXISTS (
        SELECT 1 FROM file_blobs WHERE id = NEW.blob_id AND state = 'available'
    )
BEGIN
    SELECT RAISE(ABORT, 'attachment must use an available blob and matching task project');
END;

CREATE TRIGGER task_page_assignee_insert AFTER INSERT ON task_assignees BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=(SELECT project_id FROM tasks WHERE id=NEW.task_id);
END;

CREATE TRIGGER task_page_assignee_delete AFTER DELETE ON task_assignees BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=(SELECT project_id FROM tasks WHERE id=OLD.task_id);
END;

-- Tracks have only a name.
ALTER TABLE tracks DROP COLUMN description;
