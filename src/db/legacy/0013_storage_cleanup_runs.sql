-- Durable run identity survives per-file retries and does not scan audit history.
CREATE TABLE storage_cleanup_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    files INTEGER NOT NULL DEFAULT 0 CHECK(files >= 0),
    bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0),
    trigger TEXT NOT NULL CHECK(trigger IN ('watermark','disk_floor'))
) STRICT;
CREATE INDEX storage_cleanup_runs_recent_idx ON storage_cleanup_runs(started_at DESC, id DESC)
    WHERE files > 0 OR bytes > 0;
ALTER TABLE file_deletion_jobs ADD COLUMN cleanup_run_id TEXT REFERENCES storage_cleanup_runs(id);
CREATE INDEX task_attachments_project_idx ON task_attachments(project_id, blob_id);
