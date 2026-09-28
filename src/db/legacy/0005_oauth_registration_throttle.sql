-- Keep only a short-lived, opaque caller key for dynamic registration quotas.
-- The handler removes entries outside the rolling hour on each registration.
CREATE TABLE oauth_registration_attempts (
    caller_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX oauth_registration_attempts_caller_time_idx
    ON oauth_registration_attempts(caller_hash, created_at);

CREATE INDEX oauth_clients_created_at_idx ON oauth_clients(created_at);
