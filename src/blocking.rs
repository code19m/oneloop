//! Lanes for blocking work. Each lane runs a few jobs at once on Tokio's
//! blocking threads, so a burst of slow work can't take those threads or add
//! up the memory each job needs.

use std::{sync::Arc, time::Duration};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{AppError, AppResult};

#[derive(Clone)]
pub(crate) struct Lane {
    /// Names the work in errors, such as "knowledge search is busy".
    name: &'static str,
    turns: Arc<Semaphore>,
}

/// A job's place in its lane. It lasts until the job ends, even when the
/// request that started the job ends first.
pub(crate) struct Turn {
    name: &'static str,
    _permit: OwnedSemaphorePermit,
}

impl Lane {
    pub(crate) fn new(name: &'static str, jobs: usize) -> Self {
        Self {
            name,
            turns: Arc::new(Semaphore::new(jobs)),
        }
    }

    /// Waits for a turn as long as it takes.
    pub(crate) async fn turn(&self) -> Turn {
        let permit = self.turns.clone().acquire_owned().await;
        Turn {
            name: self.name,
            _permit: permit.expect("a lane is never closed"),
        }
    }

    /// Waits at most `wait` for a turn; then the caller is told to try again.
    pub(crate) async fn turn_within(&self, wait: Duration) -> AppResult<Turn> {
        tokio::time::timeout(wait, self.turn())
            .await
            .map_err(|_| AppError::Unavailable(format!("{} is busy; try again shortly", self.name)))
    }

    /// Runs `job` when its turn comes.
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> AppResult<T> {
        self.turn().await.run(job).await
    }
}

impl Turn {
    pub(crate) async fn run<T: Send + 'static>(
        self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> AppResult<T> {
        let name = self.name;
        tokio::task::spawn_blocking(move || {
            let _turn = self;
            job()
        })
        .await
        .map_err(|error| AppError::internal(format!("{name} failed: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_turn_lasts_until_its_job_ends_even_when_its_request_does() {
        let lane = Lane::new("test", 1);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let request = tokio::spawn({
            let lane = lane.clone();
            async move {
                lane.run(move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .await
            }
        });
        started_rx.await.unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(lane.turns.available_permits(), 0, "the job still runs");
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), lane.turn())
            .await
            .expect("the turn comes back when the job ends");
    }
}
