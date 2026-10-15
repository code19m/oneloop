//! Delays after failed sign-ins, counted per account, per address and per
//! account and address together, and the cleanup of their counters.
use std::net::IpAddr;

use super::*;

/// Failures count toward a delay for 15 minutes after the first one.
const FAILURE_WINDOW_SECONDS: i64 = 15 * 60;

/// When failed attempts in one bucket start to delay the next ones, and how
/// long a delay can grow.
pub(super) struct ThrottleRule {
    /// Failures within the window before the first delay.
    threshold: i64,
    /// The longest delay, in seconds.
    max_delay: i64,
    /// Whether the start of the delay is logged.
    log_start: bool,
}

/// One account from one address.
pub(super) const PAIR_RULE: ThrottleRule = ThrottleRule {
    threshold: 5,
    max_delay: 15 * 60,
    log_start: false,
};
/// One address, across accounts.
pub(super) const ADDRESS_RULE: ThrottleRule = ThrottleRule {
    threshold: 20,
    max_delay: 15 * 60,
    log_start: false,
};
/// One account, across addresses. Its short delay keeps an attacker from
/// locking the owner out for long.
pub(super) const ACCOUNT_RULE: ThrottleRule = ThrottleRule {
    threshold: 15,
    max_delay: 60,
    log_start: true,
};
/// The current password, asked again before sensitive changes.
pub(super) const PASSWORD_CONFIRMATION_RULE: ThrottleRule = ThrottleRule {
    threshold: 5,
    max_delay: 15 * 60,
    log_start: false,
};

impl AuthService {
    pub(super) async fn check_login_throttle(&self, key: &str, now: i64) -> AppResult<()> {
        let key = key.to_owned();
        let blocked_until = self
            .db
            .run(move |connection| {
                connection
                    .query_row(
                        "SELECT blocked_until FROM login_throttles WHERE key=?1",
                        [key],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(AppError::from)
            })
            .await?;
        if let Some(blocked_until) = blocked_until.filter(|until| *until > now) {
            return Err(AppError::RateLimited {
                retry_after: (blocked_until - now) as u64,
            });
        }
        Ok(())
    }

    pub(super) async fn record_login_failure(
        &self,
        key: String,
        now: i64,
        rule: &'static ThrottleRule,
    ) -> AppResult<()> {
        self.db
            .transaction(move |tx| {
                // Keep cleanup proportional to hostile traffic as well as running
                // periodically: address rotation must not outrun the timer's batch.
                prune(tx, now, 100)?;
                let existing = tx
                    .query_row(
                        "SELECT failure_count,window_started_at FROM login_throttles WHERE key=?1",
                        [&key],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .optional()?;
                let (failure_count, window_started_at) = match existing {
                    Some((count, start)) if now - start < FAILURE_WINDOW_SECONDS => {
                        (count + 1, start)
                    }
                    _ => (1, now),
                };
                if rule.log_start && failure_count == rule.threshold {
                    tracing::warn!(
                        target: "oneloop::auth",
                        account_key = %key,
                        "account login delay started"
                    );
                }
                // 30 seconds at the threshold, doubling with each failure after it.
                let blocked_until = if failure_count >= rule.threshold {
                    let exponent = (failure_count - rule.threshold).min(5) as u32;
                    now + 30_i64
                        .saturating_mul(2_i64.pow(exponent))
                        .min(rule.max_delay)
                } else {
                    now
                };
                tx.execute(
                    "INSERT INTO login_throttles
                     (key,failure_count,window_started_at,last_failed_at,blocked_until)
                     VALUES(?1,?2,?3,?4,?5) ON CONFLICT(key) DO UPDATE SET
                       failure_count=excluded.failure_count,
                       window_started_at=excluded.window_started_at,
                       last_failed_at=excluded.last_failed_at,
                       blocked_until=excluded.blocked_until",
                    rusqlite::params![key, failure_count, window_started_at, now, blocked_until],
                )?;
                Ok(())
            })
            .await
    }
}

/// The address a counter of abuse groups by: an IPv4 address, or the /64
/// network of an IPv6 address, which one client usually holds whole. It is
/// never session metadata.
pub(crate) fn throttle_bucket(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!(
            "{}/64",
            std::net::Ipv6Addr::from(u128::from(ip) & (u128::MAX << 64))
        ),
    }
}

/// Removes a batch of counters whose window and delay have both ended, for
/// database maintenance.
pub async fn prune_login_throttles(db: &Db, now: i64) -> AppResult<()> {
    db.transaction(move |tx| prune(tx, now, MAINTENANCE_BATCH))
        .await
}

/// Counters one maintenance pass removes at most, so it never holds the
/// writer long.
const MAINTENANCE_BATCH: i64 = 500;

/// The expiry index bounds the scan, so active windows and delays are never
/// read.
const PRUNE_SQL: &str = "DELETE FROM login_throttles WHERE rowid IN (SELECT rowid FROM login_throttles INDEXED BY login_throttles_expiry_idx WHERE blocked_until<=?1 AND window_started_at<=?2 LIMIT ?3)";

fn prune(connection: &rusqlite::Connection, now: i64, batch: i64) -> AppResult<()> {
    connection.execute(
        PRUNE_SQL,
        rusqlite::params![now, now - FAILURE_WINDOW_SECONDS, batch],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prune_skips_active_counters_through_its_index() {
        let (_root, connection) = crate::db::migrated_connection();
        let plan = crate::db::query_plan(&connection, PRUNE_SQL);
        assert!(plan.contains("window_started_at<?"), "{plan}");
    }
}
