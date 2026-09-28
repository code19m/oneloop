-- OAuth 2.1 authorization state for manually connected MCP clients.
-- Public clients use Authorization Code + PKCE (S256); no client secret is stored.

CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 100),
    redirect_uris_json TEXT NOT NULL CHECK (json_valid(redirect_uris_json)),
    client_uri TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    CHECK (client_uri IS NULL OR length(client_uri) <= 2048)
) STRICT;

CREATE TABLE oauth_authorization_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    state TEXT,
    resource TEXT NOT NULL,
    requested_scopes_json TEXT NOT NULL CHECK (json_valid(requested_scopes_json)),
    code_challenge TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
) STRICT;

CREATE INDEX oauth_authorization_requests_expiry_idx
    ON oauth_authorization_requests(expires_at, consumed_at);

CREATE TABLE oauth_authorization_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    client_name TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    projects_json TEXT NOT NULL CHECK (json_valid(projects_json)),
    scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
    code_challenge TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
) STRICT;

CREATE INDEX oauth_authorization_codes_expiry_idx
    ON oauth_authorization_codes(expires_at, used_at);

CREATE INDEX mcp_tokens_hash_active_idx
    ON mcp_tokens(token_hash, kind, revoked_at, expires_at);

CREATE TABLE mcp_file_transfers (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    attachment_id TEXT REFERENCES task_attachments(id) ON DELETE CASCADE,
    file_name TEXT,
    size_bytes INTEGER,
    is_ephemeral INTEGER NOT NULL DEFAULT 0 CHECK (is_ephemeral IN (0, 1)),
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    CHECK ((direction='upload' AND task_id IS NOT NULL AND attachment_id IS NULL
            AND file_name IS NOT NULL AND size_bytes IS NOT NULL AND idempotency_key IS NOT NULL)
        OR (direction='download' AND task_id IS NULL AND attachment_id IS NOT NULL
            AND file_name IS NULL AND size_bytes IS NULL AND idempotency_key IS NULL))
) STRICT;

CREATE INDEX mcp_file_transfers_expiry_idx
    ON mcp_file_transfers(expires_at, consumed_at);
