-- Deleted attachments and comments can be restored for a few minutes.

-- Until file maintenance removes a deleted attachment, reads hide the row
-- and its bytes stay in place.
ALTER TABLE task_attachments ADD COLUMN deleted_at INTEGER;

-- Only rows waiting for removal are indexed, so the index stays small.
CREATE INDEX task_attachments_deleted_idx
    ON task_attachments(deleted_at) WHERE deleted_at IS NOT NULL;

-- A deleted comment keeps its text and mentions until the purge, which finds
-- it here. Comments deleted before this version have no text left.
CREATE INDEX comments_deleted_text_idx
    ON comments(deleted_at) WHERE deleted_at IS NOT NULL AND content <> '';
