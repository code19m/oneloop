//! Shared browser/MCP body deadlines. Reservations never live past one hour.
use std::{future::Future, time::Duration};

use tokio::time::{Instant, timeout_at};

use crate::{AppError, AppResult};

pub(crate) struct UploadDeadline {
    overall: Instant,
}

impl UploadDeadline {
    pub(crate) fn new() -> Self {
        Self {
            overall: Instant::now() + Duration::from_secs(super::UPLOAD_RESERVATION_SECONDS as u64),
        }
    }

    pub(crate) async fn read<T>(&self, read: impl Future<Output = T>) -> AppResult<T> {
        let now = Instant::now();
        // timeout_at polls the read first. Reject an expired overall deadline
        // even when the next buffered chunk is immediately ready.
        if now >= self.overall {
            return Err(AppError::validation(
                "file",
                "upload timed out; retry the upload",
            ));
        }
        timeout_at(self.overall.min(now + Duration::from_secs(60)), read)
            .await
            .map_err(|_| AppError::validation("file", "upload timed out; retry the upload"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn overall_deadline_ends_even_a_trickling_upload() {
        let deadline = UploadDeadline {
            overall: Instant::now() + Duration::from_millis(20),
        };
        assert_eq!(deadline.read(async { 7 }).await.unwrap(), 7);
        tokio::time::advance(Duration::from_millis(25)).await;
        assert!(deadline.read(async { 8 }).await.is_err());
        assert!(deadline.read(std::future::pending::<()>()).await.is_err());
    }
}
