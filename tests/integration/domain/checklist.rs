use super::*;

/// Creates a task in `p1` with a checklist of `titles`, and returns its ID.
async fn task_with_checklist(f: &Fixture, titles: &[&str]) -> String {
    let created = change(
        f,
        DomainOperation::CreateTask,
        json!({"projectId":"p1","epicId":"e1","title":"Steps","checklist":titles}),
        None,
    )
    .await
    .unwrap();
    created.entities[0]["id"].as_str().unwrap().to_owned()
}

/// Runs a command as the manager, with a key of its own.
async fn change(
    f: &Fixture,
    operation: DomainOperation,
    payload: Value,
    revision: Option<i64>,
) -> Result<oneloop::command::CommandResult, AppError> {
    let key = uuid::Uuid::now_v7().to_string();
    f.service
        .execute(&f.manager, command(operation, payload, &key, revision))
        .await
}

/// The task's checklist as a member reads it: each item's title and whether
/// it is done, in order.
async fn checklist(f: &Fixture, task: &str) -> Vec<(String, bool)> {
    let view = f.service.task(&f.member, task.to_owned()).await.unwrap();
    let items = view.checklist.unwrap();
    assert!(
        items
            .iter()
            .enumerate()
            .all(|(index, item)| item.position == index as i64),
        "positions run from 0 without gaps"
    );
    items
        .into_iter()
        .map(|item| (item.title, item.done))
        .collect()
}

fn items(entries: &[(&str, bool)]) -> Vec<(String, bool)> {
    entries
        .iter()
        .map(|&(title, done)| (title.to_owned(), done))
        .collect()
}

#[tokio::test]
async fn checklist_items_keep_a_gapless_order_through_adds_moves_and_deletions() {
    let f = fixture().await;
    let task = task_with_checklist(&f, &["Plan", "Build", "Ship"]).await;
    let view = f.service.task(&f.member, task.clone()).await.unwrap();
    let ids: Vec<_> = view
        .checklist
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
    let added = change(
        &f,
        DomainOperation::AddChecklistItem,
        json!({"taskId":task,"title":"Review"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(added.entities[0]["position"], 3, "a new item goes last");
    let review = added.entities[0]["id"].clone();
    change(
        &f,
        DomainOperation::MoveChecklistItem,
        json!({"itemId":review,"beforeItemId":ids[2]}),
        Some(1),
    )
    .await
    .unwrap();
    change(
        &f,
        DomainOperation::DeleteChecklistItem,
        json!({"id":ids[0]}),
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(
        checklist(&f, &task).await,
        items(&[("Build", false), ("Review", false), ("Ship", false)])
    );
}

#[tokio::test]
async fn a_checklist_item_has_its_own_revision_apart_from_the_task() {
    let f = fixture().await;
    let task = task_with_checklist(&f, &["Plan"]).await;
    let before = f.service.task(&f.member, task.clone()).await.unwrap();
    let item = before.checklist.as_ref().unwrap()[0].id.clone();
    let ticked = change(
        &f,
        DomainOperation::UpdateChecklistItem,
        json!({"itemId":item,"done":true}),
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(ticked.entities[0]["revision"], 2);
    assert_eq!(
        (
            &ticked.entities[1]["checklistDone"],
            &ticked.entities[1]["checklistTotal"],
            &ticked.entities[1]["checklistVersion"]
        ),
        (&json!(1), &json!(1), &json!(1)),
        "the result carries the task's new counts and checklist version"
    );
    let stale = change(
        &f,
        DomainOperation::UpdateChecklistItem,
        json!({"itemId":item,"title":"Plan it"}),
        Some(1),
    )
    .await;
    assert!(matches!(stale, Err(AppError::RevisionConflict { .. })));
    // The tick left the task as it was, so an edit read before it still saves;
    // only the checklist version tells that the checklist changed.
    let after = f.service.task(&f.member, task.clone()).await.unwrap();
    assert_eq!(
        (after.revision, after.updated_at, after.checklist_version),
        (
            before.revision,
            before.updated_at,
            before.checklist_version + 1
        )
    );
    change(
        &f,
        DomainOperation::UpdateTask,
        json!({"taskId":task,"title":"Renamed"}),
        Some(before.revision),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn checklist_items_follow_the_task_title_rule_up_to_fifty_items() {
    let f = fixture().await;
    let too_many = vec!["Step"; 51];
    for titles in [vec!["x".repeat(141)], vec!["Two\nlines".into()]]
        .into_iter()
        .map(|titles| json!(titles))
        .chain([json!(too_many)])
    {
        let refused = change(
            &f,
            DomainOperation::CreateTask,
            json!({"projectId":"p1","epicId":"e1","title":"Steps","checklist":titles}),
            None,
        )
        .await;
        assert!(
            matches!(&refused, Err(AppError::Validation { field, .. }) if field == "checklist"),
            "{refused:?}"
        );
    }
    let full = task_with_checklist(&f, &["Step"; 50]).await;
    let refused = change(
        &f,
        DomainOperation::AddChecklistItem,
        json!({"taskId":full,"title":"One more"}),
        None,
    )
    .await;
    assert!(matches!(refused, Err(AppError::Conflict(_))), "{refused:?}");
    for title in ["x".repeat(141), "Two\nlines".into()] {
        let refused = change(
            &f,
            DomainOperation::AddChecklistItem,
            json!({"taskId":full,"title":title}),
            None,
        )
        .await;
        assert!(
            matches!(&refused, Err(AppError::Validation { field, .. }) if field == "title"),
            "{refused:?}"
        );
    }
}

#[tokio::test]
async fn readers_see_a_checklist_that_only_board_managers_change() {
    let f = fixture().await;
    let task = task_with_checklist(&f, &["Plan"]).await;
    let refused = f
        .service
        .execute(
            &f.member,
            command(
                DomainOperation::AddChecklistItem,
                json!({"taskId":task,"title":"Mine"}),
                "member-add",
                None,
            ),
        )
        .await;
    assert!(matches!(refused, Err(AppError::Forbidden)), "{refused:?}");
    assert_eq!(checklist(&f, &task).await, items(&[("Plan", false)]));
}

#[tokio::test]
async fn a_deleted_task_keeps_its_checklist_for_undo() {
    let f = fixture().await;
    let task = task_with_checklist(&f, &["Plan"]).await;
    let view = f.service.task(&f.member, task.clone()).await.unwrap();
    let item = view.checklist.unwrap()[0].id.clone();
    let tick = json!({"itemId":item,"done":true});
    change(&f, DomainOperation::UpdateChecklistItem, tick, Some(1))
        .await
        .unwrap();
    change(&f, DomainOperation::DeleteTask, json!({"id":task}), Some(1))
        .await
        .unwrap();
    let untick = json!({"itemId":item,"done":false});
    let gone = change(&f, DomainOperation::UpdateChecklistItem, untick, Some(2)).await;
    assert!(matches!(gone, Err(AppError::NotFound { .. })), "{gone:?}");
    change(
        &f,
        DomainOperation::RestoreTask,
        json!({"id":task}),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(checklist(&f, &task).await, items(&[("Plan", true)]));
}

#[tokio::test]
async fn checklist_changes_stay_out_of_the_feed_and_name_the_checklist_at_its_new_version() {
    let f = fixture().await;
    let task = task_with_checklist(&f, &["Plan"]).await;
    let view = f.service.task(&f.member, task.clone()).await.unwrap();
    let item = view.checklist.unwrap()[0].id.clone();
    let tick = json!({"itemId":item,"done":true});
    let result = change(&f, DomainOperation::UpdateChecklistItem, tick, Some(1))
        .await
        .unwrap();
    let (recorded, shown): (i64, i64) = query_one(
        &f.db,
        "SELECT (SELECT COUNT(*) FROM activity_events WHERE entity_type='checklist'),
                (SELECT COUNT(*) FROM activity_projection WHERE entity_type='checklist' AND is_hidden=0)",
        [],
    )
    .await;
    assert_eq!((recorded, shown), (1, 0));
    let feed = CollaborationService::new(f.db.clone())
        .activity(&f.member, "p1", Some(&task), None, Some(100))
        .await
        .unwrap();
    assert!(
        feed.items
            .iter()
            .all(|event| event.entity_type != "checklist")
    );
    // The hint names the checklist at the version the command returns, which
    // the tab that made the change has, and no other tab has yet.
    let version = result.entities[1]["checklistVersion"].as_i64().unwrap();
    let hint: String = query_one(
        &f.db,
        "SELECT payload_json FROM outbox_messages ORDER BY id DESC LIMIT 1",
        [],
    )
    .await;
    let hint: Value = serde_json::from_str(&hint).unwrap();
    assert_eq!(
        [
            &hint["entityType"],
            &hint["entityId"],
            &hint["taskId"],
            &hint["entityRevision"]
        ],
        [
            &json!("checklist"),
            &json!(task),
            &json!(task),
            &json!(version)
        ]
    );
    assert_eq!(version, view.checklist_version + 1);
}

#[tokio::test]
async fn a_checklist_change_keeps_the_cursor_of_the_next_page() {
    let f = fixture().await;
    let task = task_with_checklist(&f, &["Plan"]).await;
    task_with_checklist(&f, &[]).await;
    let page = |cursor| BoardQuery {
        limit: Some(1),
        ..board_query("planning", cursor)
    };
    let first = f.service.board_page(&f.member, page(None)).await.unwrap();
    let view = f.service.task(&f.member, task).await.unwrap();
    let tick = json!({"itemId":view.checklist.unwrap()[0].id,"done":true});
    change(&f, DomainOperation::UpdateChecklistItem, tick, Some(1))
        .await
        .unwrap();
    // Load more after someone ticks an item reads the next page, not the Board again.
    let next = f
        .service
        .board_page(&f.member, page(first.next_cursor))
        .await;
    assert!(
        matches!(&next, Ok(next) if next.items.len() == 1),
        "{next:?}"
    );
}
