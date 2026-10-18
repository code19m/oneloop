//! Tasks on tracks: where a task goes, what moves with its epic, and what a
//! deleted epic or track leaves.

use super::*;

/// Adds track `tr3` to `p1`, with open epic `e3`.
async fn second_track(f: &Fixture) {
    f.db.transaction(|tx| {
        tx.execute_batch("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr3','p1','Second',1,1,1);
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e3','p1','tr3','Third epic','2026-01-01',0,1,1);")?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn run(
    f: &Fixture,
    operation: DomainOperation,
    payload: Value,
    key: &str,
    revision: Option<i64>,
) -> oneloop::AppResult<oneloop::command::CommandResult> {
    f.service
        .execute(&f.manager, command(operation, payload, key, revision))
        .await
}

/// Creates a task in `p1` with `payload`'s track and epic, and returns its ID.
async fn task(f: &Fixture, title: &str, mut payload: Value) -> String {
    payload["projectId"] = json!("p1");
    payload["title"] = json!(title);
    let key = title.replace(' ', "-");
    let created = run(f, DomainOperation::CreateTask, payload, &key, None)
        .await
        .unwrap();
    created.entities[0]["id"].as_str().unwrap().to_owned()
}

/// A task's track, epic and revision.
async fn place(f: &Fixture, id: &str) -> (String, Option<String>, i64) {
    query_one(
        &f.db,
        "SELECT track_id,epic_id,revision FROM tasks WHERE id=?1",
        [id.to_owned()],
    )
    .await
}

fn invalid_field(result: oneloop::AppResult<oneloop::command::CommandResult>) -> String {
    match result {
        Err(AppError::Validation { field, .. }) => field,
        other => panic!("expected a validation error: {other:?}"),
    }
}

async fn outbox_messages(f: &Fixture) -> i64 {
    query_one(&f.db, "SELECT COUNT(*) FROM outbox_messages", []).await
}

#[tokio::test]
async fn a_new_task_goes_on_its_track_and_its_epic_must_be_on_that_track() {
    let f = fixture().await;
    second_track(&f).await;
    for (title, chosen, expected) in [
        // With only an epic, the task goes on the epic's track.
        ("Epic only", json!({"epicId":"e1"}), ("tr1", Some("e1"))),
        ("Track only", json!({"trackId":"tr3"}), ("tr3", None)),
        (
            "Both",
            json!({"trackId":"tr3","epicId":"e3"}),
            ("tr3", Some("e3")),
        ),
    ] {
        let id = task(&f, title, chosen).await;
        let (track, epic, _) = place(&f, &id).await;
        assert_eq!((track.as_str(), epic.as_deref()), expected, "{title}");
    }
    for (key, mut payload, field) in [
        (
            "epic-elsewhere",
            json!({"trackId":"tr3","epicId":"e1"}),
            "epicId",
        ),
        ("other-project", json!({"trackId":"tr2"}), "trackId"),
        ("nowhere", json!({}), "trackId"),
    ] {
        payload["projectId"] = json!("p1");
        payload["title"] = json!("Refused");
        let refused = run(&f, DomainOperation::CreateTask, payload, key, None).await;
        assert_eq!(invalid_field(refused), field, "{key}");
    }

    // A Pool item becomes a task on a track the same way.
    let item = run(
        &f,
        DomainOperation::CreatePoolItem,
        json!({"projectId":"p1","scope":"team","title":"Idea"}),
        "idea",
        None,
    )
    .await
    .unwrap();
    let promoted = run(
        &f,
        DomainOperation::PromotePoolItem,
        json!({"poolItemId":item.entities[0]["id"],"trackId":"tr3"}),
        "promote-idea",
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            &promoted.entities[0]["trackId"],
            &promoted.entities[0]["epicId"]
        ),
        (&json!("tr3"), &Value::Null)
    );
}

#[tokio::test]
async fn moving_a_task_to_another_track_clears_its_epic_unless_one_there_is_named() {
    let f = fixture().await;
    second_track(&f).await;
    let id = task(&f, "Mover", json!({"epicId":"e1"})).await;
    // An epic must be on the task's track, so choosing one elsewhere names its track too.
    for (payload, key) in [
        (json!({"taskId":id,"epicId":"e3"}), "epic-elsewhere"),
        (
            json!({"taskId":id,"trackId":"tr3","epicId":"e1"}),
            "epic-left-behind",
        ),
    ] {
        let refused = run(&f, DomainOperation::UpdateTask, payload, key, Some(1)).await;
        assert_eq!(invalid_field(refused), "epicId", "{key}");
    }
    assert_eq!(place(&f, &id).await, ("tr1".into(), Some("e1".into()), 1));

    let moved = run(
        &f,
        DomainOperation::UpdateTask,
        json!({"taskId":id,"trackId":"tr3"}),
        "to-second",
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(place(&f, &id).await, ("tr3".into(), None, 2));
    // The activity says that the move cleared the epic.
    let changes = moved
        .events
        .iter()
        .map(|event| {
            (
                event.field_key.as_deref(),
                event.before.clone(),
                event.after.clone(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        changes,
        [
            (Some("trackId"), Some(json!("tr1")), Some(json!("tr3"))),
            (Some("epicId"), Some(json!("e1")), Some(Value::Null)),
        ]
    );
    for (payload, key, revision, expected) in [
        (
            json!({"taskId":id,"trackId":"tr1","epicId":"e1"}),
            "back-in-epic",
            2,
            ("tr1", Some("e1")),
        ),
        (
            json!({"taskId":id,"epicId":null}),
            "no-epic",
            3,
            ("tr1", None),
        ),
    ] {
        run(
            &f,
            DomainOperation::UpdateTask,
            payload,
            key,
            Some(revision),
        )
        .await
        .unwrap();
        let (track, epic, _) = place(&f, &id).await;
        assert_eq!((track.as_str(), epic.as_deref()), expected, "{key}");
    }
}

#[tokio::test]
async fn moving_an_epic_moves_its_tasks_with_one_live_update() {
    let f = fixture().await;
    second_track(&f).await;
    let one = task(&f, "One", json!({"epicId":"e1"})).await;
    let two = task(&f, "Two", json!({"epicId":"e1"})).await;
    let deleted = task(&f, "Deleted", json!({"epicId":"e1"})).await;
    let loose = task(&f, "Loose", json!({"trackId":"tr1"})).await;
    run(
        &f,
        DomainOperation::DeleteTask,
        json!({"id":deleted}),
        "delete",
        Some(1),
    )
    .await
    .unwrap();
    let before = outbox_messages(&f).await;
    let moved = run(
        &f,
        DomainOperation::UpdateEpic,
        json!({"epicId":"e1","trackId":"tr3"}),
        "move-epic",
        Some(1),
    )
    .await
    .unwrap();
    // One event and one live update for the epic; the tasks each have their
    // own revision and activity.
    assert_eq!(moved.events.len(), 1);
    assert_eq!(outbox_messages(&f).await, before + 1);
    for id in [&one, &two] {
        assert_eq!(place(&f, id).await, ("tr3".into(), Some("e1".into()), 2));
        let activity: (String, i64) = query_one(
            &f.db,
            "SELECT after_json,entity_revision FROM activity_events WHERE entity_id=?1 AND field_key='trackId'",
            [id.clone()],
        )
        .await;
        assert_eq!(activity, ("\"tr3\"".into(), 2));
    }
    assert_eq!(place(&f, &loose).await, ("tr1".into(), None, 1));
    // A deleted task moved too, so Undo brings it back in its epic.
    let restored = run(
        &f,
        DomainOperation::RestoreTask,
        json!({"id":deleted}),
        "restore",
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            &restored.entities[0]["trackId"],
            &restored.entities[0]["epicId"]
        ),
        (&json!("tr3"), &json!("e1"))
    );
}

#[tokio::test]
async fn an_epic_without_tasks_moves_without_ending_board_pages_read_so_far() {
    let f = fixture().await;
    second_track(&f).await;
    for title in ["One", "Two"] {
        task(&f, title, json!({"trackId":"tr1"})).await;
    }
    let mut first = board_query("planning", None);
    first.limit = Some(1);
    let cursor = f
        .service
        .board_page(&f.member, first)
        .await
        .unwrap()
        .next_cursor;
    run(
        &f,
        DomainOperation::UpdateEpic,
        json!({"epicId":"e3","trackId":"tr1"}),
        "move-empty-epic",
        Some(1),
    )
    .await
    .unwrap();
    let mut next = board_query("planning", cursor);
    next.limit = Some(1);
    let page = f.service.board_page(&f.member, next).await.unwrap();
    assert_eq!(page.items.len(), 1);
}

#[tokio::test]
async fn deleting_an_epic_keeps_its_tasks_and_undo_takes_back_those_still_without_one() {
    let f = fixture().await;
    second_track(&f).await;
    let stays = task(&f, "Stays", json!({"epicId":"e3"})).await;
    let leaves = task(&f, "Leaves", json!({"epicId":"e3"})).await;
    let deleted = task(&f, "Deleted", json!({"epicId":"e3"})).await;
    run(
        &f,
        DomainOperation::DeleteTask,
        json!({"id":deleted}),
        "delete-task",
        Some(1),
    )
    .await
    .unwrap();
    let before = outbox_messages(&f).await;
    let removed = run(
        &f,
        DomainOperation::DeleteEpic,
        json!({"id":"e3"}),
        "delete-epic",
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(removed.events.len(), 1);
    assert_eq!(outbox_messages(&f).await, before + 1);
    for id in [&stays, &leaves] {
        assert_eq!(place(&f, id).await, ("tr3".into(), None, 2));
    }
    run(
        &f,
        DomainOperation::UpdateTask,
        json!({"taskId":leaves,"trackId":"tr1"}),
        "leave",
        Some(2),
    )
    .await
    .unwrap();

    let restore = command(
        DomainOperation::RestoreEpic,
        json!({"id":"e3"}),
        "undo-delete-epic",
        Some(2),
    );
    let restored = f
        .service
        .execute(&f.manager, restore.clone())
        .await
        .unwrap();
    assert_eq!(
        (
            &restored.entities[0]["title"],
            &restored.entities[0]["revision"]
        ),
        (&json!("Third epic"), &json!(3))
    );
    assert_eq!(restored.events[0].event_type, "epic.restored");
    assert_eq!(
        place(&f, &stays).await,
        ("tr3".into(), Some("e3".into()), 3)
    );
    assert_eq!(place(&f, &leaves).await, ("tr1".into(), None, 3));
    assert!(
        f.service
            .execute(&f.manager, restore)
            .await
            .unwrap()
            .replayed
    );
    // The task deleted before its epic kept it, and comes back in it.
    let task = run(
        &f,
        DomainOperation::RestoreTask,
        json!({"id":deleted}),
        "restore-task",
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(task.entities[0]["epicId"], "e3");

    let again = run(
        &f,
        DomainOperation::RestoreEpic,
        json!({"id":"e3"}),
        "undo-again",
        Some(3),
    )
    .await;
    assert!(matches!(again, Err(AppError::Conflict(_))), "{again:?}");
    run(
        &f,
        DomainOperation::DeleteEpic,
        json!({"id":"e3"}),
        "delete-epic-again",
        Some(3),
    )
    .await
    .unwrap();
    f.db.run(|connection| {
        connection.execute(
            "UPDATE epics SET deleted_at=deleted_at-300 WHERE id='e3'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let late = run(
        &f,
        DomainOperation::RestoreEpic,
        json!({"id":"e3"}),
        "undo-late",
        Some(4),
    )
    .await;
    assert!(
        matches!(late, Err(AppError::PreconditionFailed(_))),
        "{late:?}"
    );
}

#[tokio::test]
async fn a_track_is_deleted_only_when_it_has_no_tasks_or_epics() {
    let f = fixture().await;
    second_track(&f).await;
    f.db.transaction(|tx| {
        tx.execute_batch("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr4','p1','Fourth',2,1,1);
            INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e4','p1','tr4','Fourth epic','2026-01-01',0,1,1);")?;
        Ok(())
    })
    .await
    .unwrap();
    for title in ["One", "Two"] {
        task(&f, title, json!({"trackId":"tr1"})).await;
    }
    let only = task(&f, "Only", json!({"epicId":"e3"})).await;
    run(
        &f,
        DomainOperation::DeleteEpic,
        json!({"id":"e3"}),
        "delete-e3",
        Some(1),
    )
    .await
    .unwrap();
    for (track, message) in [
        ("tr1", "Move or delete its 2 tasks and 2 epics first"),
        ("tr3", "Move or delete its 1 task first"),
        ("tr4", "Move or delete its 1 epic first"),
    ] {
        let refused = run(
            &f,
            DomainOperation::DeleteTrack,
            json!({"id":track}),
            track,
            Some(1),
        )
        .await;
        assert!(
            matches!(&refused, Err(AppError::PreconditionFailed(text)) if text == message),
            "{refused:?}"
        );
    }
    // A deleted task doesn't keep its track; it then can't come back.
    run(
        &f,
        DomainOperation::DeleteTask,
        json!({"id":only}),
        "delete-only",
        Some(2),
    )
    .await
    .unwrap();
    run(
        &f,
        DomainOperation::DeleteTrack,
        json!({"id":"tr3"}),
        "delete-tr3",
        Some(1),
    )
    .await
    .unwrap();
    for (operation, id, revision) in [
        (DomainOperation::RestoreTask, only.as_str(), 3),
        (DomainOperation::RestoreEpic, "e3", 2),
    ] {
        let refused = run(&f, operation, json!({"id":id}), id, Some(revision)).await;
        assert!(
            matches!(&refused, Err(AppError::PreconditionFailed(text)) if text.contains("track was deleted")),
            "{operation:?}: {refused:?}"
        );
    }
}

#[tokio::test]
async fn work_starts_when_a_task_first_enters_progress_or_review_and_ends_in_planning() {
    let f = fixture().await;
    let id = task(&f, "Work", json!({"trackId":"tr1"})).await;
    let started = async || -> Option<i64> {
        query_one(
            &f.db,
            "SELECT started_at FROM tasks WHERE id=?1",
            [id.clone()],
        )
        .await
    };
    assert_eq!(started().await, None);
    let mut revision = 1;
    let mut move_to = async |status: &str| {
        run(
            &f,
            DomainOperation::MoveTask,
            json!({"taskId":id,"status":status}),
            &format!("{status}-{revision}"),
            Some(revision),
        )
        .await
        .unwrap();
        revision += 1;
    };
    move_to("in_progress").await;
    let at: i64 = query_one(
        &f.db,
        "SELECT updated_at FROM tasks WHERE id=?1",
        [id.clone()],
    )
    .await;
    assert_eq!(started().await, Some(at));
    // Mark the start, to see that the moves that follow keep it.
    f.db.run({
        let id = id.clone();
        move |connection| {
            connection.execute("UPDATE tasks SET started_at=1 WHERE id=?1", [id])?;
            Ok(())
        }
    })
    .await
    .unwrap();
    for status in ["in_review", "in_progress", "done"] {
        move_to(status).await;
        assert_eq!(started().await, Some(1), "{status}");
    }
    move_to("planning").await;
    assert_eq!(started().await, None);
    // Straight from Planning to Done, no work started; it starts on reopening.
    move_to("done").await;
    assert_eq!(started().await, None);
    move_to("in_progress").await;
    let at: i64 = query_one(
        &f.db,
        "SELECT updated_at FROM tasks WHERE id=?1",
        [id.clone()],
    )
    .await;
    assert_eq!(started().await, Some(at));
}
