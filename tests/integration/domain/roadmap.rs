//! The Roadmap read: the tasks its lanes draw, what it counts, and its pages
//! of dated plans and done tasks.

use super::*;

/// A task to insert: its ID, track, status, deadline, completion time and
/// whether it is deleted.
type Row = (
    String,
    &'static str,
    &'static str,
    Option<String>,
    Option<i64>,
    bool,
);

/// Inserts tasks into `p1`, each at its own number and position.
async fn insert_tasks(f: &Fixture, tasks: Vec<Row>) {
    f.db.transaction(move |tx| {
        let first: i64 = tx.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))?;
        for (offset, (id, track, status, deadline, completed, deleted)) in tasks.into_iter().enumerate() {
            let number = first + offset as i64 + 1;
            tx.execute(
                "INSERT INTO tasks(id,project_id,track_id,task_number,task_key,title,status,position,deadline,
                    created_at,updated_at,started_at,completed_at,deleted_at)
                 VALUES(?1,'p1',?2,?3,?4,?1,?5,?3,?6,1,1,CASE WHEN ?5<>'planning' THEN 1 END,?7,?8)",
                params![id, track, number, format!("ONE-{number}"), status, deadline, completed, deleted.then_some(2)],
            )?;
        }
        tx.execute(
            "UPDATE project_sequences SET next_task_number=(SELECT COUNT(*)+1 FROM tasks) WHERE project_id='p1'",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

fn ids(tasks: &[oneloop::domain::TaskView]) -> Vec<&str> {
    tasks.iter().map(|task| task.id.as_str()).collect()
}

#[tokio::test]
async fn the_roadmap_draws_work_at_hand_dated_plans_and_done_tasks_and_counts_the_rest() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr3','p1','Second',1,1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let past = || Some("2000-01-01".to_owned());
    let future = || Some("2999-01-01".to_owned());
    insert_tasks(
        &f,
        vec![
            (
                "late-work".into(),
                "tr1",
                "in_progress",
                past(),
                None,
                false,
            ),
            ("review".into(), "tr1", "in_review", None, None, false),
            ("plan".into(), "tr1", "planning", future(), None, false),
            ("late-plan".into(), "tr1", "planning", past(), None, false),
            ("backlog".into(), "tr1", "planning", None, None, false),
            ("older".into(), "tr1", "done", past(), Some(50), false),
            ("finished".into(), "tr1", "done", None, Some(100), false),
            ("deleted".into(), "tr1", "planning", future(), None, true),
            ("other".into(), "tr3", "planning", None, None, false),
        ],
    )
    .await;
    let roadmap = f
        .service
        .roadmap_view(&f.member, "p1".into())
        .await
        .unwrap();
    let timeline = &roadmap.timeline;
    assert_eq!(ids(&timeline.open), ["late-work", "review"]);
    // Plans without a deadline stay on the Board; a late plan comes first.
    assert_eq!(ids(&timeline.plans.items), ["late-plan", "plan"]);
    assert_eq!(ids(&timeline.done.items), ["finished", "older"]);
    assert_eq!(
        (&timeline.plans.next_cursor, &timeline.done.next_cursor),
        (&None, &None)
    );
    assert_eq!(timeline.open[0].started_at, Some(1));
    assert_eq!(timeline.overdue, 2);
    let counts: Vec<_> = timeline
        .track_counts
        .iter()
        .map(|track| {
            (
                track.track_id.as_str(),
                track.planning,
                track.in_progress,
                track.in_review,
                track.done,
            )
        })
        .collect();
    assert_eq!(counts, [("tr1", 3, 1, 1, 2), ("tr3", 1, 0, 0, 0)]);
    assert_eq!(roadmap.tracks.len(), 2);
    assert!(roadmap.epics.iter().all(|epic| epic.summary.is_some()));
}

#[tokio::test]
async fn roadmap_pages_of_plans_and_done_tasks_go_on_from_their_cursor() {
    let f = fixture().await;
    // One task more than a page of each, the plans in pairs that share a
    // deadline and the done tasks in pairs that share a second.
    let mut tasks = Vec::new();
    for index in 0..201 {
        let deadline = Some(format!("2999-01-{:02}", index / 2 % 28 + 1));
        tasks.push((
            format!("plan-{index:03}"),
            "tr1",
            "planning",
            deadline,
            None,
            false,
        ));
        tasks.push((
            format!("done-{index:03}"),
            "tr1",
            "done",
            None,
            Some(1000 - index / 2),
            false,
        ));
    }
    insert_tasks(&f, tasks).await;
    let first = f
        .service
        .roadmap_view(&f.member, "p1".into())
        .await
        .unwrap()
        .timeline;
    assert_eq!(
        (first.plans.items.len(), first.done.items.len()),
        (200, 200)
    );
    // A change between pages leaves the next page where it was.
    insert_tasks(
        &f,
        vec![("later".into(), "tr1", "planning", None, None, false)],
    )
    .await;
    let page = |cursor: Option<String>| {
        f.service
            .roadmap_tasks(&f.member, "p1".into(), cursor.unwrap())
    };
    let plans = page(first.plans.next_cursor.clone()).await.unwrap();
    let done = page(first.done.next_cursor.clone()).await.unwrap();
    assert_eq!((plans.next_cursor, done.next_cursor), (None, None));
    let mut all_plans = ids(&first.plans.items);
    all_plans.extend(ids(&plans.items));
    let mut expected: Vec<_> = (0..201).map(|index| format!("plan-{index:03}")).collect();
    expected.sort_by_key(|id| {
        let index: usize = id[5..].parse().unwrap();
        (index / 2 % 28, id.clone())
    });
    assert_eq!(all_plans, expected);
    let mut all_done = ids(&first.done.items);
    all_done.extend(ids(&done.items));
    assert_eq!(all_done.len(), 201);
    assert_eq!(
        all_done.iter().collect::<HashSet<_>>().len(),
        201,
        "no done task twice"
    );
    assert_eq!(*all_done.last().unwrap(), "done-200");
    let unreadable = f
        .service
        .roadmap_tasks(&f.member, "p1".into(), "not a cursor".into())
        .await
        .unwrap_err();
    assert_eq!(unreadable.code(), "validation_failed");
}
