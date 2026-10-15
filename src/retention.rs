//! Bounded maintenance for transient state. Product audit history is permanent.
use rusqlite::params;

use crate::{AppResult, Db};

const DAY: i64 = 24 * 60 * 60;

/// Rows removed per table and pass, so one pass never holds the writer long.
const BATCH: i64 = 500;

/// Each table's prune, with the age its rows must reach. The `sessions`,
/// `mcp_tokens` and `mcp_grants` filters repeat their retention index
/// expressions in migrations/0001_initial.sql exactly: SQLite uses an
/// expression index only for the same expression, so another spelling, or a
/// parameter in place of `2592000`, scans the whole table without an error.
const PRUNES: [(&str, i64); 10] = [
    (
        "DELETE FROM outbox_messages WHERE rowid IN (SELECT rowid FROM outbox_messages WHERE delivered_at<=?1 AND rowid<>(SELECT MAX(rowid) FROM outbox_messages) LIMIT ?2)",
        7 * DAY,
    ),
    (
        "DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE MIN(COALESCE(revoked_at,absolute_expires_at),idle_expires_at,absolute_expires_at)<=?1 LIMIT ?2)",
        30 * DAY,
    ),
    (
        "DELETE FROM oauth_authorization_codes WHERE rowid IN (SELECT rowid FROM oauth_authorization_codes WHERE (grant_id IS NULL AND (expires_at<=?1 OR used_at IS NOT NULL)) OR grant_id IN (SELECT id FROM mcp_grants WHERE revoked_at IS NOT NULL OR expires_at<=?1) LIMIT ?2)",
        0,
    ),
    (
        "DELETE FROM oauth_authorization_requests WHERE rowid IN (SELECT rowid FROM oauth_authorization_requests WHERE expires_at<=?1 OR consumed_at IS NOT NULL LIMIT ?2)",
        0,
    ),
    (
        "DELETE FROM mcp_tokens WHERE rowid IN (SELECT rowid FROM mcp_tokens WHERE MIN(expires_at,COALESCE(revoked_at,expires_at))<=?1 LIMIT ?2)",
        90 * DAY,
    ),
    (
        "DELETE FROM mcp_grants WHERE rowid IN (SELECT rowid FROM mcp_grants g WHERE MIN(expires_at,COALESCE(revoked_at,expires_at),COALESCE(last_used_at,created_at)+2592000)<=?1 AND NOT EXISTS(SELECT 1 FROM mcp_tokens t WHERE t.grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.actor_mcp_grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM notification_events n WHERE n.actor_mcp_grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM idempotency_keys i WHERE i.actor_mcp_grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM file_deletion_jobs j WHERE j.actor_mcp_grant_id=g.id) LIMIT ?2)",
        90 * DAY,
    ),
    (
        "DELETE FROM file_leases WHERE rowid IN (SELECT rowid FROM file_leases WHERE expires_at<=?1 LIMIT ?2)",
        0,
    ),
    (
        "DELETE FROM oauth_registration_attempts WHERE rowid IN (SELECT rowid FROM oauth_registration_attempts WHERE created_at<=?1 LIMIT ?2)",
        3600,
    ),
    (
        "DELETE FROM oauth_clients WHERE rowid IN (SELECT rowid FROM oauth_clients WHERE last_used_at IS NULL AND created_at<=?1 LIMIT ?2)",
        DAY,
    ),
    (
        "DELETE FROM mcp_file_transfers WHERE rowid IN (SELECT rowid FROM mcp_file_transfers WHERE expires_at<=?1 LIMIT ?2)",
        0,
    ),
];

/// Removes at most one batch from each table; the maintenance loop retries
/// errors after a minute. Returns whether a table had a full batch, so a
/// backlog that grows faster than one batch an hour gets the next pass soon.
/// Refresh-family evidence stays 90 days after expiry or revocation, and a
/// grant that audit events name stays, so app attribution never disappears.
pub async fn prune_transient_state(db: &Db, now: i64) -> AppResult<bool> {
    db.transaction(move |tx| {
        let mut more = false;
        for (sql, age) in PRUNES {
            more |= tx.execute(sql, params![now - age, BATCH])? as i64 >= BATCH;
        }
        Ok(more)
    })
    .await
}

/// The expiry index bounds the scan; active windows/blocks are never removed.
pub async fn prune_login_throttles(db: &Db, now: i64) -> AppResult<()> {
    db.transaction(move |tx| prune_login_throttles_connection(tx, now, BATCH))
        .await
}

pub(crate) fn prune_login_throttles_connection(
    conn: &rusqlite::Connection,
    now: i64,
    batch: i64,
) -> AppResult<()> {
    conn.execute(PRUNE_LOGIN_THROTTLES_SQL, params![now, now - 900, batch])?;
    Ok(())
}

const PRUNE_LOGIN_THROTTLES_SQL: &str = "DELETE FROM login_throttles WHERE rowid IN (SELECT rowid FROM login_throttles INDEXED BY login_throttles_expiry_idx WHERE blocked_until<=?1 AND window_started_at<=?2 LIMIT ?3)";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrated_connection, query_plan};

    #[test]
    fn indexed_prunes_read_their_retention_indexes() {
        let (_root, connection) = migrated_connection();
        for (sql, _) in PRUNES {
            for table in ["sessions", "mcp_tokens", "mcp_grants"] {
                if sql.starts_with(&format!("DELETE FROM {table} ")) {
                    let plan = query_plan(&connection, sql);
                    assert!(plan.contains(&format!("{table}_retention_idx")), "{plan}");
                }
            }
        }
        // Active windows and blocks are skipped by the index, not read.
        let plan = query_plan(&connection, PRUNE_LOGIN_THROTTLES_SQL);
        assert!(plan.contains("window_started_at<?"), "{plan}");
    }
}
