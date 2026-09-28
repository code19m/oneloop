-- Cover capacity sums without one table lookup per blob.
CREATE INDEX file_blobs_state_size_idx ON file_blobs(state, size_bytes);
-- Cheap, fresh eligibility checks when a near-full library is mostly permanent.
CREATE INDEX task_attachments_temporary_access_idx
    ON task_attachments(last_accessed_at, created_at, blob_id) WHERE is_ephemeral=1;
