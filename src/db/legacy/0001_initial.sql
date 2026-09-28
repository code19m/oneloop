-- oneloop initial durable schema. Applied once; never edit after release.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    avatar_blob_id TEXT REFERENCES file_blobs(id) ON DELETE SET NULL,
    password_changed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task_prefix TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE TABLE project_prefixes (
    prefix TEXT PRIMARY KEY COLLATE NOCASE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    reserved_at INTEGER NOT NULL
) STRICT;

CREATE TABLE project_sequences (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0)
) STRICT;

CREATE TABLE project_memberships (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manage_roadmap INTEGER NOT NULL DEFAULT 0 CHECK (manage_roadmap IN (0, 1)),
    manage_board INTEGER NOT NULL DEFAULT 0 CHECK (manage_board IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (project_id, user_id)
) STRICT;

CREATE INDEX project_memberships_user_idx
    ON project_memberships(user_id, project_id);

CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE INDEX tracks_project_active_idx
    ON tracks(project_id, deleted_at, position);
CREATE UNIQUE INDEX tracks_active_position_unique
    ON tracks(project_id, position) WHERE deleted_at IS NULL;

CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    milestone_date TEXT NOT NULL CHECK (
        length(milestone_date) = 10 AND milestone_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE INDEX milestones_project_date_idx
    ON milestones(project_id, deleted_at, milestone_date, id);

CREATE TABLE epics (
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
    state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'active', 'done')),
    position INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK (end_date IS NULL OR end_date >= start_date)
) STRICT;

CREATE INDEX epics_project_timeline_idx
    ON epics(project_id, deleted_at, start_date, id);
CREATE INDEX epics_track_active_idx
    ON epics(track_id, deleted_at, position);
CREATE UNIQUE INDEX epics_active_position_unique
    ON epics(track_id, position) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
    task_number INTEGER NOT NULL CHECK (task_number > 0),
    task_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'in_review', 'done')),
    position INTEGER NOT NULL,
    deadline TEXT CHECK (
        deadline IS NULL OR (length(deadline) = 10 AND deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    ),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (project_id, task_number)
) STRICT;

CREATE INDEX tasks_project_status_idx
    ON tasks(project_id, deleted_at, status, position);
CREATE INDEX tasks_epic_status_idx
    ON tasks(epic_id, deleted_at, status);
CREATE UNIQUE INDEX tasks_active_position_unique
    ON tasks(project_id, status, position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_deadline_idx
    ON tasks(project_id, deadline) WHERE deleted_at IS NULL AND deadline IS NOT NULL;

CREATE VIRTUAL TABLE task_search USING fts5(
    task_id UNINDEXED,
    project_id UNINDEXED,
    task_key,
    title,
    description,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER tasks_search_insert AFTER INSERT ON tasks WHEN NEW.deleted_at IS NULL BEGIN
    INSERT INTO task_search(task_id, project_id, task_key, title, description)
    VALUES (NEW.id, NEW.project_id, NEW.task_key, NEW.title, NEW.description);
END;
CREATE TRIGGER tasks_search_update AFTER UPDATE OF task_key, title, description, deleted_at ON tasks BEGIN
    DELETE FROM task_search WHERE task_id = OLD.id;
    INSERT INTO task_search(task_id, project_id, task_key, title, description)
    SELECT NEW.id, NEW.project_id, NEW.task_key, NEW.title, NEW.description
    WHERE NEW.deleted_at IS NULL;
END;
CREATE TRIGGER tasks_search_delete AFTER DELETE ON tasks BEGIN
    DELETE FROM task_search WHERE task_id = OLD.id;
END;

CREATE TABLE task_assignees (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, user_id)
) STRICT;

CREATE INDEX task_assignees_user_idx ON task_assignees(user_id, task_id);

CREATE TABLE pool_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'team')),
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'team' AND owner_user_id IS NULL))
) STRICT;

CREATE INDEX pool_items_project_scope_idx
    ON pool_items(project_id, scope, owner_user_id, created_at, id);

CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    root_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    reply_to_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK ((reply_to_id IS NULL AND root_id = id) OR reply_to_id IS NOT NULL)
) STRICT;

CREATE INDEX comments_task_timeline_idx
    ON comments(task_id, created_at, id);
CREATE INDEX comments_thread_idx
    ON comments(root_id, created_at, id);
CREATE INDEX comments_reply_target_idx
    ON comments(reply_to_id, created_at, id) WHERE reply_to_id IS NOT NULL;

CREATE TABLE comment_mentions (
    id TEXT PRIMARY KEY,
    comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'everyone')),
    user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    label TEXT NOT NULL,
    CHECK ((kind = 'user' AND user_id IS NOT NULL) OR (kind = 'everyone' AND user_id IS NULL))
) STRICT;

CREATE INDEX comment_mentions_comment_idx ON comment_mentions(comment_id);
CREATE INDEX comment_mentions_user_idx ON comment_mentions(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE task_blocks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    resolved_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
    resolved_at INTEGER,
    resolution TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK ((resolved_at IS NULL AND resolved_by IS NULL) OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX task_blocks_one_open_idx
    ON task_blocks(task_id) WHERE resolved_at IS NULL;
CREATE INDEX task_blocks_task_history_idx
    ON task_blocks(task_id, created_at, id);

CREATE TABLE block_mentions (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES task_blocks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'everyone')),
    user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    label TEXT NOT NULL,
    CHECK ((kind = 'user' AND user_id IS NOT NULL) OR (kind = 'everyone' AND user_id IS NULL))
) STRICT;

CREATE INDEX block_mentions_block_idx ON block_mentions(block_id);

CREATE TABLE activity_events (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_mcp_grant_id TEXT REFERENCES mcp_grants(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    field_key TEXT,
    before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'owner')),
    private_owner_user_id TEXT,
    entity_revision INTEGER,
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX activity_project_cursor_idx
    ON activity_events(project_id, created_at DESC, id DESC);
CREATE INDEX activity_task_cursor_idx
    ON activity_events(task_id, created_at, id) WHERE task_id IS NOT NULL;
CREATE INDEX activity_entity_window_idx
    ON activity_events(entity_type, entity_id, field_key, actor_user_id, created_at);

-- Derived, transactionally maintained feed projection. Raw activity_events stay
-- immutable; this table makes consolidation correct before cursor pagination
-- without rescanning an unbounded audit history on every request.
CREATE TABLE activity_projection (
    id TEXT PRIMARY KEY REFERENCES activity_events(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_name_snapshot TEXT NOT NULL,
    event_type TEXT NOT NULL,
    field_key TEXT,
    before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'owner')),
    private_owner_user_id TEXT,
    entity_revision INTEGER,
    started_at INTEGER NOT NULL,
    latest_at INTEGER NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 0 CHECK (is_open IN (0, 1)),
    is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
    CHECK (latest_at >= started_at),
    CHECK ((visibility = 'public' AND private_owner_user_id IS NULL)
        OR (visibility = 'owner' AND private_owner_user_id IS NOT NULL))
) STRICT;

CREATE INDEX activity_projection_project_public_feed_idx
    ON activity_projection(project_id, latest_at DESC, id DESC)
    WHERE is_hidden = 0 AND visibility = 'public';
CREATE INDEX activity_projection_project_owner_feed_idx
    ON activity_projection(project_id, private_owner_user_id, latest_at DESC, id DESC)
    WHERE is_hidden = 0 AND visibility = 'owner';
CREATE INDEX activity_projection_task_public_feed_idx
    ON activity_projection(project_id, task_id, latest_at DESC, id DESC)
    WHERE is_hidden = 0 AND visibility = 'public';
CREATE INDEX activity_projection_task_owner_feed_idx
    ON activity_projection(project_id, task_id, private_owner_user_id, latest_at DESC, id DESC)
    WHERE is_hidden = 0 AND visibility = 'owner';
CREATE INDEX activity_projection_open_idx
    ON activity_projection(entity_type, entity_id, field_key, is_open, latest_at);
CREATE UNIQUE INDEX activity_projection_one_open_field
    ON activity_projection(entity_type, entity_id, field_key)
    WHERE is_open = 1 AND field_key IS NOT NULL;

CREATE TABLE security_events (
    id TEXT PRIMARY KEY,
    subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX security_events_subject_time_idx
    ON security_events(subject_user_id, created_at DESC, id DESC);

CREATE TABLE notification_events (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_mcp_grant_id TEXT REFERENCES mcp_grants(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
    block_id TEXT REFERENCES task_blocks(id) ON DELETE SET NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE notification_recipients (
    notification_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_name_snapshot TEXT NOT NULL,
    task_key_snapshot TEXT,
    task_title_snapshot TEXT,
    actor_name_snapshot TEXT,
    excerpt_snapshot TEXT,
    read_at INTEGER,
    archived_at INTEGER,
    delivered_at INTEGER,
    PRIMARY KEY (notification_id, user_id)
) STRICT;

CREATE INDEX notification_inbox_idx
    ON notification_recipients(user_id, archived_at, read_at, notification_id);

CREATE TABLE outbox_messages (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at INTEGER NOT NULL,
    locked_at INTEGER,
    locked_by TEXT,
    delivered_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX outbox_ready_idx
    ON outbox_messages(delivered_at, available_at, id);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    authenticated_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    client_name TEXT,
    client_ip TEXT,
    user_agent TEXT,
    CHECK (idle_expires_at <= absolute_expires_at)
) STRICT;

CREATE INDEX sessions_user_active_idx
    ON sessions(user_id, revoked_at, absolute_expires_at);

CREATE TABLE login_throttles (
    key TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
    window_started_at INTEGER NOT NULL,
    last_failed_at INTEGER NOT NULL,
    blocked_until INTEGER NOT NULL
) STRICT;

CREATE INDEX login_throttles_expiry_idx ON login_throttles(blocked_until);

CREATE TABLE mcp_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE INDEX mcp_grants_user_active_idx
    ON mcp_grants(user_id, revoked_at, expires_at);

CREATE TABLE mcp_grant_projects (
    grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (grant_id, project_id)
) STRICT;

CREATE TABLE mcp_grant_scopes (
    grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN (
        'project_read', 'discussion', 'board_manage', 'roadmap_manage',
        'inbox_private', 'my_pool_private', 'attachments', 'destructive'
    )),
    PRIMARY KEY (grant_id, scope)
) STRICT;

CREATE TABLE mcp_tokens (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
    family_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    token_hash TEXT NOT NULL UNIQUE,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    rotated_to_id TEXT REFERENCES mcp_tokens(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX mcp_tokens_grant_active_idx
    ON mcp_tokens(grant_id, kind, revoked_at, expires_at);
CREATE INDEX mcp_tokens_family_idx ON mcp_tokens(family_id, issued_at);

CREATE TABLE file_blobs (
    id TEXT PRIMARY KEY,
    storage_key TEXT UNIQUE,
    checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    media_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'available', 'cleaned', 'deleting')),
    created_at INTEGER NOT NULL,
    cleaned_at INTEGER,
    CHECK ((state IN ('pending', 'available', 'deleting') AND storage_key IS NOT NULL AND cleaned_at IS NULL)
        OR (state = 'cleaned' AND storage_key IS NULL AND cleaned_at IS NOT NULL))
) STRICT;

CREATE INDEX file_blobs_cleanup_idx
    ON file_blobs(state, created_at, id);

CREATE TABLE file_deletion_jobs (
    id TEXT PRIMARY KEY,
    blob_id TEXT NOT NULL UNIQUE REFERENCES file_blobs(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('manual', 'cleanup', 'rollback', 'orphan')),
    scheduled_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at INTEGER NOT NULL,
    locked_at INTEGER,
    locked_by TEXT,
    last_error TEXT
) STRICT;

CREATE INDEX file_deletion_jobs_ready_idx
    ON file_deletion_jobs(available_at, locked_at, id);

CREATE TABLE task_attachments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL UNIQUE REFERENCES file_blobs(id) ON DELETE RESTRICT,
    original_name TEXT NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    is_ephemeral INTEGER NOT NULL DEFAULT 0 CHECK (is_ephemeral IN (0, 1)),
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (task_id, position)
) STRICT;

CREATE INDEX task_attachments_task_idx
    ON task_attachments(task_id, position);
CREATE INDEX task_attachments_ephemeral_idx
    ON task_attachments(is_ephemeral, last_accessed_at, id);

CREATE TABLE upload_reservations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    staging_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    committed_at INTEGER
) STRICT;

CREATE INDEX upload_reservations_active_idx
    ON upload_reservations(expires_at, committed_at);

CREATE TABLE file_leases (
    id TEXT PRIMARY KEY,
    blob_id TEXT REFERENCES file_blobs(id) ON DELETE CASCADE,
    lease_kind TEXT NOT NULL CHECK (lease_kind IN ('upload', 'download', 'preview', 'backup', 'cleanup')),
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX file_leases_blob_active_idx
    ON file_leases(blob_id, expires_at);

CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_mcp_grant_id TEXT REFERENCES mcp_grants(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
    response_status INTEGER,
    response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
    resource_type TEXT,
    resource_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at);
CREATE UNIQUE INDEX idempotency_browser_key_unique
    ON idempotency_keys(actor_user_id, idempotency_key)
    WHERE actor_mcp_grant_id IS NULL;
CREATE UNIQUE INDEX idempotency_mcp_key_unique
    ON idempotency_keys(actor_mcp_grant_id, idempotency_key)
    WHERE actor_mcp_grant_id IS NOT NULL;

CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

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
