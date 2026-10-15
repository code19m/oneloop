//! Background maintenance of files and the database, and the supervision of
//! every background worker.

use tokio::{
    sync::watch,
    task::JoinHandle,
    time::{Duration, Instant, MissedTickBehavior, interval, sleep_until},
};

use crate::{
    AppResult, Db, clock::unix_now, collaboration::CollaborationService, files::FileService,
    retention,
};

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(60 * 60);

pub async fn prepare_files(files: &FileService) -> AppResult<()> {
    files.recover_interrupted_uploads().await?;
    files.reconcile().await?;
    Ok(())
}

/// File reconciliation and cleanup every minute, the thumbnail worker and
/// database maintenance.
pub fn spawn_maintenance(
    files: FileService,
    db: Db,
    shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    let thumbnails = files.clone();
    tokio::spawn(async move {
        tokio::join!(
            file_maintenance(files, shutdown.clone()),
            thumbnails.run_thumbnail_worker(shutdown.clone()),
            database_maintenance(db, shutdown)
        );
    })
}

/// A database maintenance job. Each one runs on its own timer.
#[derive(Clone, Copy)]
enum Job {
    LoginThrottles,
    TransientState,
    QueryPlanner,
    DeletedComments,
    ArchivedInbox,
}

impl Job {
    const ALL: [Self; 5] = [
        Self::LoginThrottles,
        Self::TransientState,
        Self::QueryPlanner,
        Self::DeletedComments,
        Self::ArchivedInbox,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::LoginThrottles => "login throttle cleanup",
            Self::TransientState => "transient state cleanup",
            Self::QueryPlanner => "query planner maintenance",
            Self::DeletedComments => "deleted comment purge",
            Self::ArchivedInbox => "archive purge",
        }
    }

    /// The wait after a pass that left nothing to do.
    fn every(self) -> Duration {
        match self {
            Self::LoginThrottles | Self::DeletedComments => MINUTE,
            Self::TransientState | Self::QueryPlanner | Self::ArchivedInbox => HOUR,
        }
    }

    /// The wait after a pass that filled its batch, so more is waiting.
    fn again(self) -> Duration {
        match self {
            Self::DeletedComments => Duration::ZERO,
            _ => MINUTE,
        }
    }

    /// Runs one pass. Returns whether a batch was full.
    async fn run(self, db: &Db, now: i64) -> AppResult<bool> {
        match self {
            Self::LoginThrottles => retention::prune_login_throttles(db, now)
                .await
                .map(|()| false),
            Self::TransientState => retention::prune_transient_state(db, now).await,
            Self::QueryPlanner => {
                db.run(|connection| {
                    connection.execute_batch("PRAGMA optimize;")?;
                    Ok(false)
                })
                .await
            }
            Self::DeletedComments => {
                CollaborationService::new(db.clone())
                    .purge_deleted_comments(now)
                    .await
            }
            Self::ArchivedInbox => CollaborationService::new(db.clone())
                .purge_archived(now)
                .await
                .map(|_| false),
        }
    }
}

/// Runs each maintenance job when it is due, on the monotonic clock, so a
/// step of the wall clock neither stops nor rushes it. The wall clock only
/// decides what each pass removes. A failed pass runs again a minute later.
pub async fn database_maintenance(db: Db, mut shutdown: watch::Receiver<bool>) {
    let mut due = [Instant::now(); Job::ALL.len()];
    loop {
        if *shutdown.borrow() {
            return;
        }
        let next = due.iter().min().copied().unwrap_or_else(Instant::now);
        tokio::select! {
            _ = sleep_until(next) => {}
            result = shutdown.changed() => {
                if result.is_err() || *shutdown.borrow() { return; }
            }
        }
        let tick = Instant::now();
        let now = match unix_now() {
            Ok(now) => now,
            Err(error) => {
                tracing::warn!(%error, "clock unavailable; retrying in one minute");
                due = due.map(|at| at.max(tick + MINUTE));
                continue;
            }
        };
        for (job, at) in Job::ALL.into_iter().zip(&mut due) {
            if *at > tick {
                continue;
            }
            *at = tick
                + match job.run(&db, now).await {
                    Ok(false) => job.every(),
                    Ok(true) => job.again(),
                    Err(error) => {
                        tracing::warn!(%error, "{} failed; retrying in one minute", job.name());
                        MINUTE
                    }
                };
        }
    }
}

async fn file_maintenance(files: FileService, mut shutdown: watch::Receiver<bool>) {
    let mut timer = interval(MINUTE);
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // prepare_files already reconciled before the listener was bound.
    // The immediate first tick only performs capacity cleanup.
    let mut first_tick = true;
    loop {
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            result = shutdown.changed() => {
                if result.is_err() || *shutdown.borrow() { break; }
            }
            _ = timer.tick() => {
                // Finish a claimed filesystem operation before honoring shutdown.
                // Abrupt process interruption is handled by durable reconciliation.
                if !first_tick && let Err(error) = files.reconcile().await {
                    tracing::error!(error = %error, "file reconciliation failed; will retry");
                    continue;
                }
                first_tick = false;
                if let Err(error) = files.cleanup_if_needed().await {
                    tracing::error!(error = %error, "temporary file cleanup failed; will retry");
                }
            }
        }
    }
}

/// A dead worker is a server failure: close streams, drain HTTP and let the
/// service manager restart the process. Every handle is always joined.
pub async fn supervise_workers(
    mut outbox: JoinHandle<AppResult<()>>,
    mut maintenance: JoinHandle<()>,
    mut knowledge: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
    collaboration: crate::collaboration::CollaborationRuntime,
) -> AppResult<()> {
    let mut stopped = shutdown.subscribe();
    let failure = tokio::select! {
        biased;
        _ = async {
            while !*stopped.borrow_and_update() {
                if stopped.changed().await.is_err() { break; }
            }
        } => None,
        result = &mut outbox => Some(("outbox", format!("{result:?}"))),
        result = &mut maintenance => Some(("maintenance", format!("{result:?}"))),
        result = &mut knowledge => Some(("knowledge sync", format!("{result:?}"))),
    };
    shutdown.send_replace(true);
    collaboration.shutdown();
    if let Some((worker, result)) = failure {
        let detail = format!("{worker} worker ended unexpectedly: {result}");
        tracing::error!(%detail, "background worker failed; stopping server");
        // The finished handle must not be polled again.
        match worker {
            "outbox" => drop(tokio::join!(maintenance, knowledge)),
            "maintenance" => drop(tokio::join!(outbox, knowledge)),
            _ => drop(tokio::join!(outbox, maintenance)),
        }
        return Err(crate::AppError::internal(detail));
    }
    let (outbox, maintenance, knowledge) = tokio::join!(outbox, maintenance, knowledge);
    outbox
        .map_err(|error| crate::AppError::internal(format!("outbox worker failed: {error}")))??;
    maintenance.map_err(|error| {
        crate::AppError::internal(format!("maintenance worker failed: {error}"))
    })?;
    knowledge.map_err(|error| {
        crate::AppError::internal(format!("knowledge sync worker failed: {error}"))
    })?;
    Ok(())
}
