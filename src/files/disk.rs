//! One disk admission budget for uploads and Knowledge syncs in a data directory.
//! Count the full reservation until publication or cleanup finishes. Counting
//! written bytes again is conservative and avoids racing a free-space sample.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

use crate::{AppError, AppResult, error::RuleKind};

#[derive(Clone)]
pub(crate) struct DiskAdmission {
    root: PathBuf,
    floor: u64,
    usage: Arc<Mutex<Usage>>,
}

#[derive(Default)]
struct Usage {
    reservations: HashMap<uuid::Uuid, Reservation>,
}
struct Reservation {
    bytes: u64,
    paths: Vec<PathBuf>,
    abandoned: bool,
}

#[derive(Clone)]
pub(crate) struct DiskReservation(Arc<Lease>);
struct Lease {
    usage: Arc<Mutex<Usage>>,
    id: uuid::Uuid,
}

impl DiskAdmission {
    pub(crate) fn new(root: &Path, floor: u64) -> Self {
        type Budgets = HashMap<PathBuf, Weak<Mutex<Usage>>>;
        static BUDGETS: OnceLock<Mutex<Budgets>> = OnceLock::new();
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut budgets = BUDGETS
            .get_or_init(Mutex::default)
            .lock()
            .expect("disk budgets lock");
        budgets.retain(|_, budget| budget.strong_count() > 0);
        let usage = budgets
            .get(&root)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let usage = Arc::new(Mutex::new(Usage::default()));
                budgets.insert(root.clone(), Arc::downgrade(&usage));
                usage
            });
        Self { root, floor, usage }
    }

    pub(crate) fn deficit(&self, bytes: u64) -> AppResult<u64> {
        self.deficit_locked(&mut self.usage.lock().expect("disk usage lock"), bytes)
    }

    fn deficit_locked(&self, usage: &mut Usage, bytes: u64) -> AppResult<u64> {
        // A failed unlink keeps its reservation until reconciliation removes
        // the bytes. An I/O error must not be mistaken for an absent path.
        usage.reservations.retain(|_, reservation| {
            !reservation.abandoned
                || reservation
                    .paths
                    .iter()
                    .any(|path| path.try_exists().unwrap_or(true))
        });
        let reserved = usage
            .reservations
            .values()
            .map(|r| u128::from(r.bytes))
            .sum::<u128>();
        let free = fs4::available_space(&self.root)?;
        Ok(disk_floor_deficit(self.floor, free, reserved, bytes))
    }

    pub(crate) fn reserve(&self, bytes: u64) -> AppResult<DiskReservation> {
        let mut usage = self.usage.lock().expect("disk usage lock");
        if self.deficit_locked(&mut usage, bytes)? > 0 {
            return Err(AppError::rule(
                RuleKind::StorageFull,
                "storage safety floor would be exceeded",
            ));
        }
        let id = uuid::Uuid::now_v7();
        usage.reservations.insert(
            id,
            Reservation {
                bytes,
                paths: Vec::new(),
                abandoned: false,
            },
        );
        Ok(DiskReservation(Arc::new(Lease {
            usage: self.usage.clone(),
            id,
        })))
    }
}

impl DiskReservation {
    pub(crate) fn keep_until_removed(&self, path: PathBuf) {
        self.0
            .usage
            .lock()
            .expect("disk usage lock")
            .reservations
            .get_mut(&self.0.id)
            .expect("live disk reservation")
            .paths
            .push(path);
    }

    /// Committed files now consume measured free space and cannot grow further.
    pub(crate) fn published(self) {
        self.0
            .usage
            .lock()
            .expect("disk usage lock")
            .reservations
            .get_mut(&self.0.id)
            .expect("live disk reservation")
            .paths
            .clear();
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut usage = self.usage.lock().expect("disk usage lock");
        let reservation = usage
            .reservations
            .get_mut(&self.id)
            .expect("live disk reservation");
        reservation.abandoned = true;
        if reservation
            .paths
            .iter()
            .all(|path| path.try_exists().is_ok_and(|exists| !exists))
        {
            usage.reservations.remove(&self.id);
        }
    }
}

fn disk_floor_deficit(floor: u64, free: u64, outstanding: u128, claimed: u64) -> u64 {
    (u128::from(floor) + outstanding + u128::from(claimed))
        .saturating_sub(u128::from(free))
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_deficit_counts_outstanding_bytes_without_wrapping() {
        assert_eq!(disk_floor_deficit(100, 200, 75, 50), 25);
        assert_eq!(disk_floor_deficit(100, 200, 0, 50), 0);
        assert_eq!(disk_floor_deficit(100, 200, 50, 50), 0);
        assert_eq!(disk_floor_deficit(u64::MAX, 0, 1, 1), u64::MAX);
        assert_eq!(disk_floor_deficit(u64::MAX, u64::MAX, 1, 1), 2);
    }

    #[test]
    fn cleanup_keeps_the_reservation_until_all_owners_and_temporary_bytes_are_gone() {
        let root = tempfile::tempdir_in("target").unwrap();
        let disk = DiskAdmission::new(root.path(), 0);
        let other = DiskAdmission::new(root.path(), 0);
        let bytes = fs4::available_space(root.path()).unwrap() / 4 * 3;
        let reservation = disk.reserve(bytes).unwrap();
        let path = root.path().join("unfinished");
        std::fs::write(&path, b"data").unwrap();
        reservation.keep_until_removed(path.clone());
        let cleanup = reservation.clone();
        drop(reservation);
        assert!(
            other.reserve(bytes).is_err(),
            "cleanup still owns the reservation"
        );
        drop(cleanup);
        assert!(
            other.reserve(bytes).is_err(),
            "failed cleanup keeps its bytes reserved"
        );
        std::fs::remove_file(path).unwrap();
        assert!(
            other.reserve(bytes).is_ok(),
            "reconciliation releases the leftover reservation"
        );
    }
}
