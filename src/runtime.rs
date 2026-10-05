//! Application-owned background maintenance with explicit shutdown ownership.

use tokio::{
    sync::watch,
    task::JoinHandle,
    time::{Duration, MissedTickBehavior, interval},
};

use crate::{AppResult, files::FileService};

pub async fn prepare_files(files: &FileService) -> AppResult<()> {
    files.recover_interrupted_uploads().await?;
    files.reconcile().await?;
    Ok(())
}

/// File reconciliation and cleanup every minute, and the thumbnail worker.
pub fn spawn_file_maintenance(
    files: FileService,
    shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    let thumbnails = files.clone();
    let thumbnail_shutdown = shutdown.clone();
    tokio::spawn(async move {
        tokio::join!(
            file_maintenance(files, shutdown),
            thumbnails.run_thumbnail_worker(thumbnail_shutdown)
        );
    })
}

async fn file_maintenance(files: FileService, mut shutdown: watch::Receiver<bool>) {
    let mut timer = interval(Duration::from_secs(60));
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
    mut files: JoinHandle<()>,
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
        result = &mut files => Some(("file maintenance", format!("{result:?}"))),
        result = &mut knowledge => Some(("knowledge sync", format!("{result:?}"))),
    };
    shutdown.send_replace(true);
    collaboration.shutdown();
    if let Some((worker, result)) = failure {
        let detail = format!("{worker} worker ended unexpectedly: {result}");
        tracing::error!(%detail, "background worker failed; stopping server");
        // The finished handle must not be polled again.
        match worker {
            "outbox" => drop(tokio::join!(files, knowledge)),
            "file maintenance" => drop(tokio::join!(outbox, knowledge)),
            _ => drop(tokio::join!(outbox, files)),
        }
        return Err(crate::AppError::internal(detail));
    }
    let (outbox, files, knowledge) = tokio::join!(outbox, files, knowledge);
    outbox
        .map_err(|error| crate::AppError::internal(format!("outbox worker failed: {error}")))??;
    files.map_err(|error| crate::AppError::internal(format!("file worker failed: {error}")))?;
    knowledge.map_err(|error| {
        crate::AppError::internal(format!("knowledge sync worker failed: {error}"))
    })?;
    Ok(())
}
