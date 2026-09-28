-- One-time status conversion. Stored historical payloads stay immutable.

DROP TRIGGER users_protect_last_admin_deactivate;

DROP TRIGGER epics_require_track_in_project_insert;

DROP TRIGGER epics_require_track_in_project_update;

DROP TRIGGER tasks_require_epic_in_project_insert;

DROP TRIGGER tasks_require_epic_in_project_update;

DROP TRIGGER task_assignees_require_active_membership;

DROP TRIGGER memberships_protect_unfinished_assignments;

DROP TRIGGER comments_require_matching_thread_insert;

DROP TRIGGER task_blocks_require_matching_open_task;

DROP TRIGGER task_attachments_require_matching_available_blob;

DROP TRIGGER project_task_version_created;

DROP TRIGGER task_page_insert;

DROP TRIGGER task_page_update;

DROP TRIGGER task_page_delete;

DROP TRIGGER task_page_epic_update;

DROP TRIGGER task_page_assignee_insert;

DROP TRIGGER task_page_assignee_delete;

DROP TRIGGER task_page_block_insert;

DROP TRIGGER task_page_block_update;

DROP TRIGGER task_page_block_delete;

DROP TRIGGER task_title_normalize_insert;

DROP TRIGGER task_title_normalize_update;

CREATE TABLE epics_baseline (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL CHECK (
        length(start_date) = 10 AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    end_date TEXT CHECK (
        end_date IS NULL OR (length(end_date) = 10 AND end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    ),
    state TEXT NOT NULL DEFAULT 'planning' CHECK (state IN ('planning', 'active', 'done')),
    position INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK (end_date IS NULL OR end_date >= start_date)
) STRICT;

INSERT INTO epics_baseline (id,project_id,track_id,title,description,start_date,end_date,state,position,created_by,created_at,updated_at,completed_at,deleted_at,revision) SELECT id,project_id,track_id,title,description,start_date,end_date,CASE state WHEN 'planned' THEN 'planning' ELSE state END,position,created_by,created_at,updated_at,completed_at,deleted_at,revision FROM epics;

DROP TABLE epics;

ALTER TABLE epics_baseline RENAME TO epics;

CREATE INDEX epics_project_timeline_idx
    ON epics(project_id, deleted_at, start_date, id);

CREATE INDEX epics_track_active_idx
    ON epics(track_id, deleted_at, position);

CREATE UNIQUE INDEX epics_active_position_unique
    ON epics(track_id, position) WHERE deleted_at IS NULL;

CREATE TABLE tasks_baseline (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
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
    completed_at INTEGER,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), search_title TEXT NOT NULL DEFAULT '',
    UNIQUE (project_id, task_number)
) STRICT;

INSERT INTO tasks_baseline (id,project_id,epic_id,task_number,task_key,title,description,status,position,deadline,created_by,created_at,updated_at,completed_at,deleted_at,revision,search_title) SELECT id,project_id,epic_id,task_number,task_key,title,description,CASE status WHEN 'planned' THEN 'planning' ELSE status END,position,deadline,created_by,created_at,updated_at,completed_at,deleted_at,revision,search_title FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_baseline RENAME TO tasks;

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

CREATE TRIGGER users_protect_last_admin_deactivate
BEFORE UPDATE OF is_admin, is_active ON users
WHEN OLD.is_admin = 1 AND OLD.is_active = 1
 AND (NEW.is_admin = 0 OR NEW.is_active = 0)
 AND NOT EXISTS (
    SELECT 1 FROM users WHERE id <> OLD.id AND is_admin = 1 AND is_active = 1
 )
BEGIN
    SELECT RAISE(ABORT, 'cannot remove the last active administrator');
END;

CREATE TRIGGER epics_require_track_in_project_insert
BEFORE INSERT ON epics
WHEN NOT EXISTS (
    SELECT 1 FROM tracks
    WHERE id = NEW.track_id AND project_id = NEW.project_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'epic track must belong to the same project');
END;

CREATE TRIGGER epics_require_track_in_project_update
BEFORE UPDATE OF track_id, project_id ON epics
WHEN NOT EXISTS (
    SELECT 1 FROM tracks
    WHERE id = NEW.track_id AND project_id = NEW.project_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'epic track must belong to the same project');
END;

CREATE TRIGGER tasks_require_epic_in_project_insert
BEFORE INSERT ON tasks
WHEN NOT EXISTS (
    SELECT 1 FROM epics
    WHERE id = NEW.epic_id AND project_id = NEW.project_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task epic must belong to the same project');
END;

CREATE TRIGGER tasks_require_epic_in_project_update
BEFORE UPDATE OF epic_id, project_id ON tasks
WHEN NOT EXISTS (
    SELECT 1 FROM epics
    WHERE id = NEW.epic_id AND project_id = NEW.project_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'task epic must belong to the same project');
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

CREATE TRIGGER task_page_block_insert AFTER INSERT ON task_blocks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;

CREATE TRIGGER task_page_block_update AFTER UPDATE ON task_blocks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=NEW.project_id;
END;

CREATE TRIGGER task_page_block_delete AFTER DELETE ON task_blocks BEGIN
    UPDATE project_task_versions SET generation=generation+1 WHERE project_id=OLD.project_id;
END;

CREATE TRIGGER task_title_normalize_insert AFTER INSERT ON tasks BEGIN
    UPDATE tasks SET search_title=oneloop_lower(NEW.title) WHERE id=NEW.id;
END;

CREATE TRIGGER task_title_normalize_update AFTER UPDATE OF title ON tasks WHEN NEW.title <> OLD.title BEGIN
    UPDATE tasks SET search_title=oneloop_lower(NEW.title) WHERE id=NEW.id;
END;
