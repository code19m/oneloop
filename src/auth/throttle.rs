//! Login delay bookkeeping combines account, address and pair buckets without blocking async workers.
use super::*;

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
        threshold: i64,
        cap: i64,
    ) -> AppResult<()> {
        self.db.transaction(move |tx| {
            // Keep cleanup proportional to hostile traffic as well as running
            // periodically: address rotation must not outrun the timer's batch.
            crate::retention::prune_login_throttles_connection(tx, now, 100)?;
            let existing=tx.query_row(
                "SELECT failure_count,window_started_at FROM login_throttles WHERE key=?1",[&key],
                |row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?)),
            ).optional()?;
            let (failure_count,window_started_at)=match existing {
                Some((count,start)) if now-start<LOGIN_FAILURE_WINDOW_SECONDS=>(count+1,start),
                _=>(1,now),
            };
            if cap == ACCOUNT_DELAY_CAP_SECONDS && failure_count == threshold {
                tracing::warn!(target: "oneloop::auth", account_key = %key, "account login delay started");
            }
            let blocked_until=if failure_count>=threshold {
                let exponent=(failure_count-threshold).min(5) as u32;
                now+30_i64.saturating_mul(2_i64.pow(exponent)).min(cap)
            } else { now };
            tx.execute(
                "INSERT INTO login_throttles(key,failure_count,window_started_at,last_failed_at,blocked_until)
                 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(key) DO UPDATE SET
                 failure_count=excluded.failure_count,window_started_at=excluded.window_started_at,
                 last_failed_at=excluded.last_failed_at,blocked_until=excluded.blocked_until",
                rusqlite::params![key,failure_count,window_started_at,now,blocked_until],
            )?;
            Ok(())
        }).await
    }
}
