-- A queued deletion must retain its attribution after retry receipts expire.
ALTER TABLE file_deletion_jobs ADD COLUMN actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE file_deletion_jobs ADD COLUMN actor_mcp_grant_id TEXT REFERENCES mcp_grants(id) ON DELETE RESTRICT;
ALTER TABLE file_deletion_jobs ADD COLUMN actor_name TEXT;
ALTER TABLE file_deletion_jobs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE file_deletion_jobs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE file_deletion_jobs ADD COLUMN attachment_id TEXT;
ALTER TABLE file_deletion_jobs ADD COLUMN attachment_name TEXT;

CREATE INDEX file_deletion_jobs_grant_idx ON file_deletion_jobs(actor_mcp_grant_id);
CREATE INDEX file_deletion_jobs_project_idx ON file_deletion_jobs(project_id);
CREATE INDEX file_deletion_jobs_task_idx ON file_deletion_jobs(task_id);

-- Recover the earliest surviving request. Attribution already pruned before
-- this upgrade cannot be reconstructed; retain the remaining file context.
UPDATE file_deletion_jobs AS j
SET (actor_user_id, actor_mcp_grant_id) = (
    SELECT i.actor_user_id, i.actor_mcp_grant_id
    FROM task_attachments a JOIN idempotency_keys i
      ON i.resource_type='attachment' AND i.resource_id=a.id
     AND i.operation='attachment.delete'
    WHERE a.blob_id=j.blob_id
    ORDER BY i.created_at, i.id LIMIT 1
)
WHERE j.reason='manual';

UPDATE file_deletion_jobs AS j
SET actor_name=(SELECT display_name FROM users WHERE id=j.actor_user_id),
    (project_id, task_id, attachment_id, attachment_name)=(
        SELECT a.project_id, a.task_id, a.id, a.original_name
        FROM task_attachments a JOIN tasks t ON t.id=a.task_id
        WHERE a.blob_id=j.blob_id
          AND (j.actor_user_id IS NOT NULL OR t.deleted_at IS NULL)
    )
WHERE j.reason='manual';
