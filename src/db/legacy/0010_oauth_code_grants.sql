-- Retain the originating grant for authorization-code replay revocation.
ALTER TABLE oauth_authorization_codes ADD COLUMN grant_id TEXT REFERENCES mcp_grants(id) ON DELETE SET NULL;
CREATE INDEX oauth_authorization_codes_grant_idx
    ON oauth_authorization_codes(grant_id) WHERE grant_id IS NOT NULL;
