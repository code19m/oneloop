-- Parent deletion must seek retained history instead of scanning it per child.
CREATE INDEX activity_projection_task_fk_idx ON activity_projection(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX notification_task_fk_idx ON notification_events(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX notification_comment_fk_idx ON notification_events(comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX notification_block_fk_idx ON notification_events(block_id) WHERE block_id IS NOT NULL;
CREATE INDEX notification_broadcast_lookup_idx ON notification_events(project_id,actor_user_id,created_at);
-- Authorization metadata survives deletion and older receipts retain a JSON fallback.
ALTER TABLE idempotency_keys ADD COLUMN project_id TEXT;
