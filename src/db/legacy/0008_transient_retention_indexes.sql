-- Expiry scans are independent of account/grant ownership indexes.
CREATE INDEX sessions_retention_idx ON sessions(MIN(COALESCE(revoked_at,absolute_expires_at),idle_expires_at,absolute_expires_at));
CREATE INDEX mcp_tokens_retention_idx ON mcp_tokens(MIN(expires_at,COALESCE(revoked_at,expires_at)));
CREATE INDEX mcp_grants_retention_idx ON mcp_grants(MIN(expires_at,COALESCE(revoked_at,expires_at),COALESCE(last_used_at,created_at)+2592000));
CREATE INDEX file_leases_expiry_idx ON file_leases(expires_at);
CREATE INDEX activity_grant_idx ON activity_events(actor_mcp_grant_id) WHERE actor_mcp_grant_id IS NOT NULL;
CREATE INDEX notification_grant_idx ON notification_events(actor_mcp_grant_id) WHERE actor_mcp_grant_id IS NOT NULL;
-- Failure-time pruning must skip all still-current windows, not scan each
-- recent unblocked failure. Retain the expiry index name used by maintenance.
DROP INDEX login_throttles_expiry_idx;
CREATE INDEX login_throttles_expiry_idx ON login_throttles(window_started_at, blocked_until);
