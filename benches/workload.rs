//! Reproducible local API workload, not a production capacity guarantee.
//!
//! `cargo bench --bench workload` measures against a disposable database and
//! fails when an operation misses its p95 latency budget. `-- --small` shrinks
//! the fixture, `-- --burst` removes client-side pacing for overload
//! diagnostics and `-- --profile-sql` reports slow statements. By default four
//! HTTP requests and one ordering or deletion write are active at a time.
//! `-- --outbox` instead measures how fast the outbox delivers a burst of
//! notifications, and how long other writes wait meanwhile.
//!
//! `cargo test` runs the small fixtures as a quick harness check that every
//! operation succeeds; it does not enforce latency budgets.

use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{Router, body::Body, http::Request};
use http_body_util::BodyExt;
use oneloop::{AppState, Config, Db, application, auth::token_hash, db::migrate};
use rusqlite::params;
use serde_json::json;
use tokio::task::JoinSet;
use tower::ServiceExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var_os("RUST_LOG").is_some() {
        tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|arg| arg == name);
    // `cargo bench` passes --bench; without it this is a `cargo test` run.
    let measure = flag("--bench");
    let small = !measure || flag("--small");
    let burst = flag("--burst");
    let profile_sql = flag("--profile-sql");
    if flag("--outbox") {
        return outbox_burst(small).await;
    }
    let (tasks, events, clients, rounds) = if small {
        (1_000, 10_000, 10, 12)
    } else {
        (100_000, 1_000_000, 100, 12)
    };
    // Cargo's scratch folder inside the target directory, wherever that is.
    let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR"))?;
    let data_dir = root.path().join("data");
    migrate(&data_dir, None)?;
    let db = if profile_sql {
        Db::open_with_pool_size(&data_dir, 1)?
    } else {
        Db::open(&data_dir)?
    };
    let fixture_started = Instant::now();
    seed(&db, tasks, events, clients).await?;
    seed_files(&db).await?;
    if profile_sql {
        // Diagnostic only: one connection attributes individual statements.
        // Fixture-only SQL uses placeholders; no production data is read.
        db.run(|connection| {
            connection.trace_v2(
                rusqlite::trace::TraceEventCodes::SQLITE_TRACE_PROFILE,
                Some(|event| {
                    if let rusqlite::trace::TraceEvent::Profile(statement, duration) = event
                        && duration >= Duration::from_millis(2)
                    {
                        eprintln!(
                            "SQL_PROFILE {}ms {}",
                            duration.as_millis(),
                            statement.sql().replace('\n', " ")
                        );
                    }
                }),
            );
            Ok(())
        })
        .await?;
    }
    eprintln!(
        "Fixture ready: {tasks} tasks, {events} activity records in {:.2}s",
        fixture_started.elapsed().as_secs_f64()
    );
    let config = Config::from_os_iter([
        ("ONELOOP_PUBLIC_URL", "http://127.0.0.1:8080"),
        (
            "ONELOOP_DATA_DIR",
            data_dir.to_str().ok_or("invalid temporary path")?,
        ),
    ])?;
    let app = application(AppState::new(config, db.clone()));
    let (shutdown, stop) = tokio::sync::watch::channel(false);
    let outbox = app.collaboration.spawn_worker(stop);
    let mut subscribers = JoinSet::new();
    for client in 0..50 {
        let response = app
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/events")
                    .header(
                        "cookie",
                        format!("oneloop_session={}", fixture_token(client % clients)),
                    )
                    .body(Body::empty())?,
            )
            .await?;
        assert!(response.status().is_success());
        subscribers.spawn(async move {
            let mut body = response.into_body();
            while let Some(frame) = body.frame().await {
                frame.expect("SSE frame");
            }
        });
    }
    let backup_root = root.path().to_owned();
    let backup = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let result = oneloop::db::create_backup(
            backup_root.join("data"),
            backup_root.join("workload-backup"),
        );
        (started.elapsed().as_secs_f64() * 1000.0, result)
    });
    // Client think-time/admission is part of the workload, not a server limit.
    // --burst deliberately removes pacing to diagnose overload separately.
    let requests = Arc::new(tokio::sync::Semaphore::new(if burst { clients } else { 4 }));
    let ordering = Arc::new(tokio::sync::Semaphore::new(if burst { clients } else { 1 }));
    let mut workers = JoinSet::new();
    let start = Instant::now();
    for client in 0..clients {
        let router = app.router.clone();
        let requests = requests.clone();
        let ordering = ordering.clone();
        workers.spawn(async move { exercise(router, client, rounds, requests, ordering).await });
    }
    let mut samples: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    let mut failures = Vec::new();
    let mut transient_retries = 0;
    while let Some(result) = workers.join_next().await {
        for (kind, millis, failure, retries) in result? {
            transient_retries += retries;
            samples.entry(kind).or_default().push(millis);
            if let Some(failure) = failure {
                failures.push(failure);
            }
        }
    }
    let (backup_ms, backup_result) = backup.await?;
    backup_result?;
    samples.insert("backup", vec![backup_ms]);
    let started = Instant::now();
    let response = app.router.clone().oneshot(Request::builder().method("POST").uri("/api/commands")
        .header("origin", "http://127.0.0.1:8080").header("content-type", "application/json")
        .header("cookie", format!("oneloop_session={}", fixture_token(0)))
        .body(Body::from(json!({"operation":"project.delete","payload":{"projectId":"delete-project","confirmedName":"Delete workload"},"expectedRevision":1,"idempotencyKey":"delete-project-workload"}).to_string()))?).await?;
    if !response.status().is_success() {
        failures.push(format!("project_delete: {}", response.status()));
    }
    response.into_body().collect().await?;
    samples.insert(
        "project_delete",
        vec![started.elapsed().as_secs_f64() * 1000.0],
    );
    let elapsed = start.elapsed().as_secs_f64();
    subscribers.abort_all();
    while subscribers.join_next().await.is_some() {}
    app.collaboration.shutdown();
    let _ = shutdown.send(true);
    outbox.await??;
    let latency: BTreeMap<_, _> = samples
        .iter_mut()
        .map(|(kind, values)| {
            values.sort_by(f64::total_cmp);
            let at = |fraction: f64| values[((values.len() - 1) as f64 * fraction).ceil() as usize];
            (
                *kind,
                json!({"budgetMs":budget(kind),"count":values.len(),"p50Ms":at(0.5),"p95Ms":at(0.95),"maxMs":at(1.0)}),
            )
        })
        .collect();
    let within_budget = samples.iter().all(|(kind, values)| {
        values[((values.len() - 1) as f64 * 0.95).ceil() as usize] < budget(kind)
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "fixture":{"tasks":tasks,"activityRecords":events,"clients":clients,"rounds":rounds,"maxConcurrentRequests":if burst {clients} else {4},"maxConcurrentOrderingWrites":if burst {clients} else {1}},
            "measurement":"in-process HTTP router, real SQLite/filesystem, local host; no network; 50 SSE subscribers and concurrent backup; client pacing waits excluded from operation latency",
            "latencyBudget":"per-operation p95 budgets include retries; all logical operations must succeed",
            "elapsedSeconds":elapsed,"requestsPerSecond":(clients*rounds) as f64/elapsed,
            "latency":latency,"failureCount":failures.len(),"transient503Retries":transient_retries,"failures":failures.iter().take(10).collect::<Vec<_>>(),"passed":failures.is_empty()&&(within_budget||!measure)
        }))?
    );
    if !failures.is_empty() || (measure && !within_budget) {
        return Err("workload acceptance budget was not met".into());
    }
    if !measure {
        assert_eq!(latency_summary(Vec::new()), json!({"count":0}));
        outbox_burst(true).await?;
    }
    Ok(())
}

/// One person mentions `@everyone` and then edits the comment, which queues an
/// Inbox change for every member at once. Reports how long the outbox takes
/// to deliver that burst, and the latency of task edits made meanwhile.
async fn outbox_burst(small: bool) -> Result<(), Box<dyn std::error::Error>> {
    let members = if small { 20 } else { 300 };
    let writers = 4;
    let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR"))?;
    let data_dir = root.path().join("data");
    migrate(&data_dir, None)?;
    let db = Db::open(&data_dir)?;
    db.transaction(move |tx| {
        let now = oneloop::auth::unix_now()?;
        for user in 0..members {
            let id = format!("user-{user}");
            tx.execute("INSERT INTO users(id,username,display_name,password_hash,is_admin,password_changed_at,created_at,updated_at) VALUES(?1,?2,?2,'benchmark-disabled',0,?3,?3,?3)", params![id,format!("user{user:03}"),now])?;
            tx.execute("INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,?4,?4,?4,?5,?6)",params![format!("session-{user}"),id,token_hash(&fixture_token(user)),now,now+604800,now+2592000])?;
        }
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at) VALUES('project','Outbox','OUT','user-0',?1,?1)",[now])?;
        for user in 0..members {
            tx.execute("INSERT INTO project_memberships(project_id,user_id,manage_board,manage_roadmap,created_at,updated_at) VALUES('project',?1,1,1,?2,?2)",params![format!("user-{user}"),now])?;
        }
        tx.execute("INSERT INTO project_prefixes VALUES('OUT','project',?1)",[now])?;
        tx.execute("INSERT INTO project_sequences VALUES('project',?1)",[(writers+2) as i64])?;
        tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('track','project','Work',0,?1,?1)",[now])?;
        tx.execute("INSERT INTO epics(id,project_id,track_id,title,start_date,state,position,created_at,updated_at) VALUES('epic','project','track','Epic','2026-01-01','active',0,?1,?1)",[now])?;
        for task in 0..=writers {
            tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES(?1,'project','epic',?2,?3,'Outbox task','planning',?2,?4,?4)",params![format!("task-{task}"),(task+1) as i64,format!("OUT-{}",task+1),now])?;
        }
        Ok(())
    }).await?;
    let config = Config::from_os_iter([
        ("ONELOOP_PUBLIC_URL", "http://127.0.0.1:8080"),
        (
            "ONELOOP_DATA_DIR",
            data_dir.to_str().ok_or("invalid temporary path")?,
        ),
    ])?;
    let app = application(AppState::new(config, db.clone()));
    let (shutdown, stop) = tokio::sync::watch::channel(false);
    let outbox = app.collaboration.spawn_worker(stop);
    let command = |client: usize,
                   operation: &str,
                   payload: serde_json::Value,
                   revision: Option<i64>,
                   key: String| {
        let mut body = json!({"operation":operation,"payload":payload,"idempotencyKey":key});
        if let Some(revision) = revision {
            body["expectedRevision"] = json!(revision);
        }
        Request::builder()
            .method("POST")
            .uri("/api/commands")
            .header("origin", "http://127.0.0.1:8080")
            .header("content-type", "application/json")
            .header(
                "cookie",
                format!("oneloop_session={}", fixture_token(client)),
            )
            .body(Body::from(body.to_string()))
            .expect("valid command request")
    };
    // Messages queued so far that are not delivered yet; later edits keep
    // queueing their own messages, which the measurement doesn't wait for.
    let pending = |db: Db| async move {
        db.run(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*),(SELECT MAX(rowid) FROM outbox_messages) FROM outbox_messages WHERE delivered_at IS NULL",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0))),
            )?)
        })
        .await
    };
    let drain = |db: Db| async move {
        let started = Instant::now();
        let (_, last) = pending(db.clone()).await?;
        loop {
            let waiting = db
                .run(move |connection| {
                    Ok(connection.query_row(
                        "SELECT COUNT(*) FROM outbox_messages WHERE delivered_at IS NULL AND rowid<=?1",
                        [last],
                        |row| row.get::<_, i64>(0),
                    )?)
                })
                .await?;
            if waiting == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        Ok::<_, oneloop::AppError>(started.elapsed().as_secs_f64() * 1000.0)
    };
    let everyone = json!([{"kind":"everyone","startOffset":0,"endOffset":9,"label":"@everyone"}]);
    let response = app
        .router
        .clone()
        .oneshot(command(
            0,
            "discussion.comment.create",
            json!({"taskId":"task-0","content":"@everyone outbox burst","mentions":everyone}),
            None,
            "outbox-comment".into(),
        ))
        .await?;
    assert!(
        response.status().is_success(),
        "comment: {}",
        response.status()
    );
    let created: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await?.to_bytes())?;
    let comment = created["entities"][0]["id"]
        .as_str()
        .ok_or("comment id")?
        .to_owned();
    let comment_revision = created["entities"][0]["revision"]
        .as_i64()
        .ok_or("comment revision")?;
    let notification_ms = drain(db.clone()).await?;
    // Task edits by other people, before and while the burst is delivered.
    let editing = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mut edits = JoinSet::new();
    for writer in 1..=writers {
        let router = app.router.clone();
        let editing = editing.clone();
        edits.spawn(async move {
            tokio::time::sleep(Duration::from_millis(writer as u64 * 3)).await;
            let mut samples = Vec::new();
            let mut revision = 1;
            let mut round = 0;
            while editing.load(std::sync::atomic::Ordering::Relaxed) {
                let started = Instant::now();
                let request = command(writer, "task.update",
                    json!({"taskId":format!("task-{writer}"),"title":format!("Edit {writer} {round}")}),
                    Some(revision), format!("outbox-edit-{writer}-{round}"));
                let response = router.clone().oneshot(request).await.expect("router is infallible");
                let status = response.status();
                let bytes = response.into_body().collect().await.expect("response body").to_bytes();
                assert!(status.is_success(), "task edit: {status} {}", String::from_utf8_lossy(&bytes));
                let value: serde_json::Value = serde_json::from_slice(&bytes).expect("command JSON");
                revision = value["entities"][0]["revision"].as_i64().expect("task revision");
                samples.push((started, started.elapsed().as_secs_f64() * 1000.0));
                round += 1;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            samples
        });
    }
    // Edits before the burst give the baseline; `cargo test` only checks the harness.
    tokio::time::sleep(Duration::from_millis(if small { 100 } else { 1500 })).await;
    let started = Instant::now();
    let response = app.router.clone().oneshot(command(0, "discussion.comment.edit",
        json!({"commentId":comment,"content":"@everyone outbox burst, edited","mentions":everyone}), Some(comment_revision), "outbox-comment-edit".into())).await?;
    assert!(
        response.status().is_success(),
        "edit: {}",
        response.status()
    );
    response.into_body().collect().await?;
    let (queued, _) = pending(db.clone()).await?;
    drain(db.clone()).await?;
    let finished = Instant::now();
    let burst_ms = (finished - started).as_secs_f64() * 1000.0;
    tokio::time::sleep(Duration::from_millis(100)).await;
    editing.store(false, std::sync::atomic::Ordering::Relaxed);
    let (mut before, mut during) = (Vec::new(), Vec::new());
    while let Some(result) = edits.join_next().await {
        for (at, millis) in result? {
            if at < started {
                before.push(millis);
            } else if at <= finished {
                during.push(millis);
            }
        }
    }
    app.collaboration.shutdown();
    let _ = shutdown.send(true);
    outbox.await??;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "outbox":{
                "members":members,
                "mentionDeliveryMs":notification_ms,
                "burstMessages":queued,
                "burstDeliveryMs":burst_ms,
                "messagesPerSecond":queued as f64 / (burst_ms / 1000.0),
                "taskEditsBefore":latency_summary(before),
                "taskEditsDuring":latency_summary(during),
            }
        }))?
    );
    Ok(())
}

/// Percentiles of a latency sample. A fast host can deliver the whole burst
/// between two rounds of edits, so a sample may be empty.
fn latency_summary(mut values: Vec<f64>) -> serde_json::Value {
    if values.is_empty() {
        return json!({"count":0});
    }
    values.sort_by(f64::total_cmp);
    let at = |fraction: f64| values[((values.len() - 1) as f64 * fraction).ceil() as usize];
    json!({"count":values.len(),"p50Ms":at(0.5),"p95Ms":at(0.95),"maxMs":at(1.0)})
}

fn fixture_token(client: usize) -> String {
    format!("benchmark-only-session-{client:032}")
}

async fn seed(db: &Db, tasks: usize, events: usize, clients: usize) -> oneloop::AppResult<()> {
    db.transaction(move |tx| {
        let now = oneloop::auth::unix_now()?;
        // Tokens/passwords below are synthetic fixture data, never network-exposed.
        for user in 0..clients {
            let id = format!("user-{user}");
            tx.execute("INSERT INTO users(id,username,display_name,password_hash,is_admin,password_changed_at,created_at,updated_at) VALUES(?1,?2,?2,'benchmark-disabled',?3,?4,?4,?4)", params![id,format!("user{user:03}"),i64::from(user==0),now])?;
            tx.execute("INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at) VALUES(?1,?2,?3,?4,?4,?4,?5,?6)",params![format!("session-{user}"),id,token_hash(&fixture_token(user)),now,now+604800,now+2592000])?;
        }
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at) VALUES('project','Benchmark','BEN','user-0',?1,?1)",[now])?;
        tx.execute("INSERT INTO project_prefixes VALUES('BEN','project',?1)",[now])?;
        tx.execute("INSERT INTO project_sequences VALUES('project',?1)",[(tasks+1) as i64])?;
        for user in 0..clients {
            tx.execute("INSERT INTO project_memberships(project_id,user_id,manage_board,manage_roadmap,created_at,updated_at) VALUES('project',?1,1,1,?2,?2)",params![format!("user-{user}"),now])?;
        }
        tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('track','project','Work',0,?1,?1)",[now])?;
        for epic in 0..100 {
            tx.execute("INSERT INTO epics(id,project_id,track_id,title,start_date,state,position,created_at,updated_at) VALUES(?1,'project','track',?2,'2026-01-01','active',?3,?4,?4)",params![format!("epic-{epic}"),format!("Epic {epic}"),epic,now])?;
        }
        {
            let mut statement = tx.prepare("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at) VALUES(?1,'project',?2,?3,?4,?5,?6,?3,?7,?7,?8)")?;
            let statuses=["planning","in_progress","in_review","done"];
            for task in 0..tasks {
                statement.execute(params![format!("task-{task}"),format!("epic-{}",task%100),(task+1) as i64,format!("BEN-{}",task+1),format!("Benchmark task {task}"),if task<clients {"planning"} else if task<clients*2 || task%2==1 {"done"} else {statuses[(task/2)%3]},now,if task>=clients && (task<clients*2 || task%2==1) {Some(now-task as i64*61)}else{None}])?;
            }
        }
        {
            let mut raw=tx.prepare("INSERT INTO activity_events(id,project_id,entity_type,entity_id,task_id,actor_user_id,event_type,metadata_json,created_at) VALUES(?1,'project','task',?2,?2,'user-0','task.created','{}',?3)")?;
            let mut projection=tx.prepare("INSERT INTO activity_projection(id,project_id,entity_type,entity_id,task_id,actor_user_id,actor_name_snapshot,event_type,started_at,latest_at) VALUES(?1,'project','task',?2,?2,'user-0','Benchmark','task.created',?3,?3)")?;
            for event in 0..events {
                let id=format!("event-{event:09}");let task=format!("task-{}",event%tasks);let at=now-events as i64+event as i64;
                raw.execute(params![id,task,at])?;projection.execute(params![id,task,at])?;
            }
        }
        // Production planner maintenance; do not precondition the fixture with ANALYZE.
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at) VALUES('delete-project','Delete workload','DEL','user-0',?1,?1)", [now])?;
        tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('delete-track','delete-project','Work',0,?1,?1)", [now])?;
        tx.execute("INSERT INTO epics(id,project_id,track_id,title,start_date,state,position,created_at,updated_at) VALUES('delete-epic','delete-project','delete-track','Delete epic','2026-01-01','active',0,?1,?1)", [now])?;
        tx.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at)
            SELECT 'delete-'||id,'delete-project','delete-epic',task_number,'DEL-'||task_number,title,status,position,created_at,updated_at FROM tasks LIMIT ?1", [tasks as i64 / 10])?;
        tx.execute("INSERT INTO activity_events(id,project_id,entity_type,entity_id,task_id,actor_user_id,event_type,metadata_json,created_at)
            SELECT 'delete-'||id,'delete-project','task',id,id,'user-0','task.created','{}',?1 FROM tasks WHERE project_id='delete-project'", [now])?;
        Ok(())
    }).await
}

async fn exercise(
    router: Router,
    client: usize,
    rounds: usize,
    requests: Arc<tokio::sync::Semaphore>,
    ordering: Arc<tokio::sync::Semaphore>,
) -> Vec<(&'static str, f64, Option<String>, usize)> {
    tokio::time::sleep(Duration::from_millis(client as u64 * 10)).await;
    let mut records = Vec::new();
    let mut revision = 1;
    for round in 0..rounds {
        let (kind, path) = match round {
            0 => ("write", "/api/commands".to_owned()),
            1 => (
                "board",
                "/api/projects/project/board?status=planning&limit=50".to_owned(),
            ),
            2 => ("task", format!("/api/tasks/task-{client}")),
            3 => (
                "activity",
                "/api/activity/projects/project?limit=50".to_owned(),
            ),
            4 => ("roadmap", "/api/projects/project/roadmap".to_owned()),
            5 => (
                "search",
                "/api/projects/project/board-view?search=Benchmark".to_owned(),
            ),
            6 => (
                "bootstrap",
                "/api/bootstrap?projectId=project&view=board".to_owned(),
            ),
            7 => ("move", "/api/commands".to_owned()),
            8 => (
                "attachment",
                "/api/attachments/workload-file/download".to_owned(),
            ),
            9 => ("avatar", "/api/users/user-0/avatar".to_owned()),
            10 => ("delete", "/api/commands".to_owned()),
            _ => ("board_view", "/api/projects/project/board-view".to_owned()),
        };
        let ordering_permit = if matches!(kind, "move" | "delete") {
            Some(ordering.acquire().await.expect("workload ordering gate"))
        } else {
            None
        };
        let request_permit = requests.acquire().await.expect("workload request gate");
        let mut request = Request::builder().uri(path).header(
            "cookie",
            format!("oneloop_session={}", fixture_token(client)),
        );
        let body = if matches!(kind, "write" | "move" | "delete") {
            request = request
                .method("POST")
                .header("origin", "http://127.0.0.1:8080")
                .header("content-type", "application/json");
            let (operation, payload) = match kind {
                "move" => (
                    "task.move",
                    json!({"taskId":format!("task-{client}"),"status":"done","position":0}),
                ),
                "delete" => ("task.delete", json!({"id":format!("task-{client}")})),
                _ => (
                    "task.update",
                    json!({"taskId":format!("task-{client}"),"title":format!("Updated {client} round {round}")}),
                ),
            };
            json!({"operation":operation,"payload":payload,"idempotencyKey":format!("workload-{client}-{round}"),"expectedRevision":revision}).to_string()
        } else {
            String::new()
        };
        let request = request.body(()).expect("fixed valid request");
        let started = Instant::now();
        let mut retries = 0;
        let (status, content) = loop {
            let response = router
                .clone()
                .oneshot(request.clone().map(|()| Body::from(body.clone())))
                .await
                .expect("router is infallible");
            let status = response.status();
            let pause = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1)
                .clamp(1, 5);
            let content = response.into_body().collect().await;
            if status == axum::http::StatusCode::SERVICE_UNAVAILABLE && retries < 2 {
                retries += 1;
                // Preserve the exact payload, revision and idempotency key. The
                // reported latency includes retries and their advertised delay.
                tokio::time::sleep(Duration::from_secs(pause)).await;
                continue;
            }
            break (status, content);
        };
        let failure = match content {
            Ok(bytes) if status.is_success() => {
                if matches!(kind, "write" | "move") {
                    let value: serde_json::Value =
                        serde_json::from_slice(&bytes.to_bytes()).expect("command JSON response");
                    revision = value["entities"][0]["revision"]
                        .as_i64()
                        .expect("canonical task revision");
                }
                None
            }
            Ok(bytes) => Some(format!(
                "{kind}: HTTP {} {}",
                status.as_u16(),
                String::from_utf8_lossy(&bytes.to_bytes())
                    .chars()
                    .take(200)
                    .collect::<String>()
            )),
            Err(error) => Some(format!("{kind}: {error}")),
        };
        records.push((
            kind,
            started.elapsed().as_secs_f64() * 1_000.0,
            failure,
            retries,
        ));
        drop(request_permit);
        drop(ordering_permit);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    records
}

fn budget(kind: &str) -> f64 {
    match kind {
        "backup" => 120_000.0,
        "project_delete" => 30_000.0,
        "move" | "delete" | "attachment" | "avatar" => 5_000.0,
        _ => 2_000.0,
    }
}

async fn seed_files(db: &Db) -> Result<(), Box<dyn std::error::Error>> {
    use image::ImageEncoder;
    use sha2::Digest;
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes).write_image(
        &[20, 30, 40, 255],
        1,
        1,
        image::ExtendedColorType::Rgba8,
    )?;
    let store = oneloop::files::FileStore::new(db.layout().clone());
    store.ensure_directories().await?;
    let key = store.new_storage_key()?;
    let path = store.prepare_file_parent(&key).await?;
    tokio::fs::write(path, &bytes).await?;
    let size = bytes.len() as i64;
    let hash = hex::encode(sha2::Sha256::digest(&bytes));
    db.transaction(move |tx| {
        let now = oneloop::auth::unix_now()?;
        tx.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at) VALUES('workload-blob',?1,?2,?3,'image/png','available',?4)", params![key,hash,size,now])?;
        tx.execute("UPDATE users SET avatar_blob_id='workload-blob' WHERE id='user-0'", [])?;
        // A task outside the per-client write/delete set keeps this read fixture stable.
        tx.execute("INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,position,created_at,last_accessed_at,updated_at)
            VALUES('workload-file','project','task-999','workload-blob','pixel.png','user-0',0,?1,?1,?1)", [now])?;
        Ok(())
    }).await?;
    Ok(())
}
