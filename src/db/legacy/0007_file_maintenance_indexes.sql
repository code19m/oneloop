-- Discover deleted tasks without walking the available blob library.
CREATE INDEX tasks_deleted_idx ON tasks(id) WHERE deleted_at IS NOT NULL;
-- Orphan reference checks must not scan all users for each blob.
CREATE INDEX users_avatar_blob_idx ON users(avatar_blob_id) WHERE avatar_blob_id IS NOT NULL;
