//! Bounded maintenance for transient state. Product audit history is permanent.
use crate::{AppResult, Db};

const DAY: i64 = 24 * 60 * 60;

/// At most 500 rows per table per pass; the worker retries errors after a minute.
/// Keep refresh-family evidence for 90 days after expiration/revocation, and
/// keep any grant referenced by audit events so app attribution never disappears.
pub async fn prune_transient_state(db: &Db, now: i64) -> AppResult<()> {
    db.transaction(move |tx| {
        for (sql, cutoff) in [
            ("DELETE FROM outbox_messages WHERE rowid IN (SELECT rowid FROM outbox_messages WHERE delivered_at<=?1 AND rowid<>(SELECT MAX(rowid) FROM outbox_messages) LIMIT 500)", now - 7 * DAY),
            ("DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE MIN(COALESCE(revoked_at,absolute_expires_at),idle_expires_at,absolute_expires_at)<=?1 LIMIT 500)", now - 30 * DAY),
            ("DELETE FROM oauth_authorization_codes WHERE rowid IN (SELECT rowid FROM oauth_authorization_codes WHERE (grant_id IS NULL AND (expires_at<=?1 OR used_at IS NOT NULL)) OR grant_id IN (SELECT id FROM mcp_grants WHERE revoked_at IS NOT NULL OR expires_at<=?1) LIMIT 500)", now),
            ("DELETE FROM oauth_authorization_requests WHERE rowid IN (SELECT rowid FROM oauth_authorization_requests WHERE expires_at<=?1 OR consumed_at IS NOT NULL LIMIT 500)", now),
            ("DELETE FROM mcp_tokens WHERE rowid IN (SELECT rowid FROM mcp_tokens WHERE MIN(expires_at,COALESCE(revoked_at,expires_at))<=?1 LIMIT 500)", now - 90 * DAY),
            ("DELETE FROM mcp_grants WHERE rowid IN (SELECT rowid FROM mcp_grants g WHERE MIN(expires_at,COALESCE(revoked_at,expires_at),COALESCE(last_used_at,created_at)+2592000)<=?1 AND NOT EXISTS(SELECT 1 FROM mcp_tokens t WHERE t.grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.actor_mcp_grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM notification_events n WHERE n.actor_mcp_grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM idempotency_keys i WHERE i.actor_mcp_grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM file_deletion_jobs j WHERE j.actor_mcp_grant_id=g.id) LIMIT 500)", now - 90 * DAY),
            ("DELETE FROM file_leases WHERE rowid IN (SELECT rowid FROM file_leases WHERE expires_at<=?1 LIMIT 500)", now),
            ("DELETE FROM oauth_registration_attempts WHERE rowid IN (SELECT rowid FROM oauth_registration_attempts WHERE created_at<=?1 LIMIT 500)", now - 3600),
            ("DELETE FROM oauth_clients WHERE rowid IN (SELECT rowid FROM oauth_clients WHERE last_used_at IS NULL AND created_at<=?1 LIMIT 500)", now - DAY),
            ("DELETE FROM mcp_file_transfers WHERE rowid IN (SELECT rowid FROM mcp_file_transfers WHERE expires_at<=?1 LIMIT 500)", now),
        ] {
            tx.execute(sql, [cutoff])?;
        }
        Ok(())
    }).await
}

/// The expiry index bounds the scan; active windows/blocks are never removed.
pub async fn prune_login_throttles(db: &Db, now: i64) -> AppResult<()> {
    db.transaction(move |tx| prune_login_throttles_connection(tx, now, 500))
        .await
}

pub(crate) fn prune_login_throttles_connection(
    conn: &rusqlite::Connection,
    now: i64,
    batch: i64,
) -> AppResult<()> {
    conn.execute("DELETE FROM login_throttles WHERE rowid IN (SELECT rowid FROM login_throttles INDEXED BY login_throttles_expiry_idx WHERE blocked_until<=?1 AND window_started_at<=?2 LIMIT ?3)", rusqlite::params![now, now - 900, batch])?;
    Ok(())
}
