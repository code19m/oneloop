-- Knowledge: each project can show one folder of a Git repository, read-only.
-- The server keeps the latest synced copy of that folder; Git keeps history.

CREATE TABLE knowledge_sources (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    branch TEXT NOT NULL,
    -- Relative to the repository root; empty for the root itself.
    folder TEXT NOT NULL,
    -- Encrypted with the instance key in keys/; NULL for public repositories and SSH.
    token_ciphertext BLOB,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
    -- Set when a sync should start now: after a settings change or a retry.
    requested_at INTEGER,
    attempted_at INTEGER,
    -- The last time the files were confirmed to match the branch.
    checked_at INTEGER,
    -- The commit whose files are stored in knowledge_files.
    commit_id TEXT,
    error_code TEXT,
    -- Files left out because each is larger than the per-file limit.
    skipped_files INTEGER NOT NULL DEFAULT 0 CHECK (skipped_files >= 0),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE TABLE knowledge_deploy_keys (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    private_key_ciphertext BLOB NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Relative to the source folder, '/'-separated.
    path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    -- Detected from the content, as for attachments.
    media_type TEXT NOT NULL,
    preview_kind TEXT CHECK (preview_kind IN ('image', 'pdf', 'html', 'markdown', 'text')),
    -- SHA-256 of the content, hex.
    checksum TEXT NOT NULL,
    -- Time of the latest commit that changed the file, as far as the fetched history shows.
    updated_at INTEGER NOT NULL,
    -- Last, so listings never read file contents.
    content BLOB NOT NULL,
    PRIMARY KEY (project_id, path)
) STRICT;
