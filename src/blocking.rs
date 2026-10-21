//! Lanes for blocking work. Each lane runs a few jobs at once on Tokio's
//! blocking threads, so a burst of slow work can't take those threads or add
//! up the memory each job needs.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{AppError, AppResult};

#[derive(Clone)]
pub(crate) struct Lane {
    /// Names the work in errors, such as "knowledge search is busy".
    name: &'static str,
    turns: Arc<Semaphore>,
}

/// A job's place in its lane. It lasts until the job ends, even when the
/// request that started the job ends first. Clones share the place, so a
/// caller can keep it across several jobs; it ends with the last clone.
#[derive(Clone)]
pub(crate) struct Turn {
    name: &'static str,
    _permit: Arc<OwnedSemaphorePermit>,
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
            _permit: Arc::new(permit.expect("a lane is never closed")),
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

/// A few places per person for work that waits for a lane or holds a
/// resource, so no one person can take every place in its queue.
#[derive(Clone)]
pub(crate) struct PerPerson {
    /// The places each person holds.
    people: Arc<Mutex<HashMap<String, usize>>>,
    /// The places one person may hold at once.
    each: usize,
    /// The most people with a place at once.
    max: usize,
}

/// A person's place, until it is dropped.
pub(crate) struct Place {
    people: Arc<Mutex<HashMap<String, usize>>>,
    user_id: String,
}

/// Why a person gets no place.
pub(crate) enum Taken {
    /// They hold all of theirs already.
    Mine,
    /// All places are taken.
    Full,
}

impl PerPerson {
    /// One place each, for at most `max` people.
    pub(crate) fn new(max: usize) -> Self {
        Self::with_places(1, max)
    }

    /// `each` places each, for at most `max` people.
    pub(crate) fn with_places(each: usize, max: usize) -> Self {
        Self {
            people: Arc::default(),
            each,
            max,
        }
    }

    pub(crate) fn claim(&self, user_id: &str) -> Result<Place, Taken> {
        let mut people = self.people.lock().expect("per-person lock");
        let held = people.get(user_id).copied().unwrap_or(0);
        if held >= self.each {
            return Err(Taken::Mine);
        }
        if held == 0 && people.len() >= self.max {
            return Err(Taken::Full);
        }
        people.insert(user_id.to_owned(), held + 1);
        Ok(Place {
            people: self.people.clone(),
            user_id: user_id.to_owned(),
        })
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        let mut people = self.people.lock().expect("per-person lock");
        if let Some(held) = people.get_mut(&self.user_id) {
            *held -= 1;
            if *held == 0 {
                people.remove(&self.user_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_person_holds_up_to_their_places_and_people_up_to_the_most() {
        let places = PerPerson::with_places(3, 2);
        let mine: Vec<Place> = (0..3).map(|_| places.claim("a").ok().unwrap()).collect();
        assert!(matches!(places.claim("a"), Err(Taken::Mine)));
        let other = places.claim("b").ok().unwrap();
        assert!(matches!(places.claim("c"), Err(Taken::Full)));
        drop(other);
        drop(places.claim("c").ok().unwrap());
        let mut mine = mine;
        mine.pop();
        assert!(places.claim("a").is_ok());
    }

    #[tokio::test]
    async fn a_turn_lasts_until_its_job_ends_even_when_its_request_does() {
        let lane = Lane::new("test", 1);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let request = tokio::spawn({
            let lane = lane.clone();
            async move {
                // The request keeps a clone, as sign-in keeps its turn.
                let turn = lane.turn().await;
                turn.clone()
                    .run(move || {
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
