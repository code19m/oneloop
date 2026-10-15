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
async fn database_maintenance(db: Db, mut shutdown: watch::Receiver<bool>) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A data directory with a person, a task and an item from `seed`.
    async fn database(seed: &'static str) -> (tempfile::TempDir, Db) {
        let (root, db) = crate::db::migrated_db();
        db.run(move |connection| {
            connection.execute_batch(
                "INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                    VALUES('alice','alice','Alice','x',1,1,1);
                 INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p1','Project','ONE',1,1);
                 INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('track','p1','Track',0,1,1);
                 INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at)
                    VALUES('epic','p1','track','Epic','2026-01-01',0,1,1);
                 INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
                    VALUES('task','p1','epic',1,'ONE-001','Task','planning',0,1,1);",
            )?;
            connection.execute_batch(seed)?;
            Ok(())
        })
        .await
        .unwrap();
        (root, db)
    }

    /// Adds a comment deleted long before the Undo window, with its text.
    async fn delete_comment(db: &Db, id: &'static str) {
        let deleted_at = unix_now().unwrap() - 3600;
        db.run(move |connection| {
            connection.execute(
                "INSERT INTO comments(id,project_id,task_id,author_id,root_id,content,created_at,deleted_at)
                 VALUES(?1,'p1','task','alice',?1,'secret text',?2,?2)",
                rusqlite::params![id, deleted_at],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    async fn comment_kept(db: &Db, id: &'static str) -> bool {
        db.run(move |connection| {
            Ok(connection.query_row(
                "SELECT content<>'' FROM comments WHERE id=?1",
                [id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn jobs_run_by_elapsed_time_whatever_the_wall_clock_says() {
        let (_root, db) = database("").await;
        delete_comment(&db, "first").await;
        let (stop, signal) = watch::channel(false);
        let maintenance = tokio::spawn(database_maintenance(db.clone(), signal));
        // The first pass runs at once.
        while comment_kept(&db, "first").await {
            tokio::task::yield_now().await;
        }
        delete_comment(&db, "second").await;
        // The next pass comes a minute later on the monotonic clock, which
        // paused time advances while the wall clock stays where it was.
        tokio::time::sleep(MINUTE).await;
        let mut waited = 0;
        while comment_kept(&db, "second").await && waited < 10 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            waited += 1;
        }
        assert!(!comment_kept(&db, "second").await);
        stop.send(true).unwrap();
        maintenance.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_job_runs_again_a_minute_later() {
        // An Inbox item archived long ago, and a purge that fails.
        let (_root, db) = database(
            "INSERT INTO notification_events(id,project_id,actor_user_id,event_type,payload_json,created_at)
                VALUES('notice','p1','alice','test','{}',1);
             INSERT INTO notification_recipients(notification_id,user_id,project_name_snapshot,actor_name_snapshot,
                excerpt_snapshot,delivered_at,read_at,archived_at)
                VALUES('notice','alice','Project','Alice','purge me',1,1,1);
             CREATE TRIGGER fail_purge BEFORE UPDATE OF project_name_snapshot ON notification_recipients
                BEGIN SELECT RAISE(FAIL,'injected purge failure'); END;",
        )
        .await;
        let excerpt = async || -> Option<String> {
            db.run(|connection| {
                Ok(connection.query_row(
                    "SELECT excerpt_snapshot FROM notification_recipients",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await
            .unwrap()
        };
        let (stop, signal) = watch::channel(false);
        let maintenance = tokio::spawn(database_maintenance(db.clone(), signal));
        // The first pass fails, and the loop goes on.
        tokio::time::sleep(Duration::from_secs(1)).await;
        db.run(|connection| {
            connection.execute_batch("DROP TRIGGER fail_purge")?;
            Ok(())
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert_eq!(excerpt().await.as_deref(), Some("purge me"));
        assert!(!maintenance.is_finished());
        // A minute after the failure, the job runs again.
        tokio::time::sleep(Duration::from_secs(31)).await;
        let mut waited = 0;
        while excerpt().await.is_some() && waited < 10 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            waited += 1;
        }
        assert_eq!(excerpt().await, None);
        stop.send(true).unwrap();
        maintenance.await.unwrap();
    }
}
