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

pub fn spawn_file_maintenance(
    files: FileService,
    mut shutdown: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
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
    })
}

/// A dead worker is a server failure: close streams, drain HTTP and let the
/// service manager restart the process. Both handles are always joined.
pub async fn supervise_workers(
    mut outbox: JoinHandle<AppResult<()>>,
    mut files: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
    collaboration: crate::collaboration::CollaborationRuntime,
) -> AppResult<()> {
    let mut stopped = shutdown.subscribe();
    let result = tokio::select! {
        biased;
        _ = async {
            while !*stopped.borrow_and_update() {
                if stopped.changed().await.is_err() { break; }
            }
        } => None,
        result = &mut outbox => Some((true, format!("outbox worker ended unexpectedly: {result:?}"))),
        result = &mut files => Some((false, format!("file maintenance worker ended unexpectedly: {result:?}"))),
    };
    shutdown.send_replace(true);
    collaboration.shutdown();
    if let Some((outbox_finished, detail)) = result {
        tracing::error!(%detail, "background worker failed; stopping server");
        if outbox_finished {
            let _ = files.await;
        } else {
            let _ = outbox.await;
        }
        return Err(crate::AppError::internal(detail));
    }
    let (outbox, files) = tokio::join!(outbox, files);
    outbox
        .map_err(|error| crate::AppError::internal(format!("outbox worker failed: {error}")))??;
    files.map_err(|error| crate::AppError::internal(format!("file worker failed: {error}")))?;
    Ok(())
}
