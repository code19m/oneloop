-- A deleted attachment can be restored for a few minutes. Until file
-- maintenance removes it, reads hide the row and its bytes stay in place.
ALTER TABLE task_attachments ADD COLUMN deleted_at INTEGER;

-- Only rows waiting for removal are indexed, so the index stays small.
CREATE INDEX task_attachments_deleted_idx
    ON task_attachments(deleted_at) WHERE deleted_at IS NOT NULL;
