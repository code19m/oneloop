//! The Roadmap read: the tasks its lanes draw in a window of days, what it
//! counts, and its pages of dated plans and done tasks.

use oneloop::domain::{
    LanesQuery, RoadmapDays, RoadmapPageQuery, RoadmapTimeline, RoadmapWindow, TaskView,
};

use super::*;

/// A task to insert: its ID, track, epic, status, deadline, completion time
/// and whether it is deleted.
type Row = (
    String,
    &'static str,
    Option<&'static str>,
    &'static str,
    Option<String>,
    Option<i64>,
    bool,
);

/// Inserts tasks into `p1`, each at its own number and position.
async fn insert_tasks(f: &Fixture, tasks: Vec<Row>) {
    f.db.transaction(move |tx| {
        let first: i64 = tx.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))?;
        let mut insert = tx.prepare(
            "INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,deadline,
                created_at,updated_at,started_at,completed_at,completion_order,deleted_at)
             VALUES(?1,'p1',?2,?3,?4,?5,?1,?6,?4,?7,1,1,CASE WHEN ?6<>'planning' THEN 1 END,?8,?4,?9)",
        )?;
        for (offset, (id, track, epic, status, deadline, completed, deleted)) in tasks.into_iter().enumerate() {
            let number = first + offset as i64 + 1;
            insert.execute(params![id, track, epic, number, format!("ONE-{number}"), status, deadline, completed, deleted.then_some(2)])?;
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

fn ids(tasks: &[TaskView]) -> Vec<&str> {
    tasks.iter().map(|task| task.id.as_str()).collect()
}

fn window(from: &str, to: &str) -> RoadmapWindow {
    RoadmapWindow {
        from: Some(from.into()),
        to: Some(to.into()),
    }
}

async fn read_lanes(f: &Fixture, window: RoadmapWindow) -> (RoadmapTimeline, RoadmapDays) {
    let lanes = f
        .service
        .roadmap(&f.member, "p1".into(), Some(LanesQuery::Days(window)))
        .await
        .unwrap()
        .lanes
        .unwrap();
    let days = lanes.days.clone().unwrap();
    (lanes, days)
}

fn page_query(
    cursor: &Option<String>,
    bound: (&str, &str),
    limit: Option<usize>,
) -> RoadmapPageQuery {
    let day = |field: &str| (bound.0 == field).then(|| bound.1.to_owned());
    RoadmapPageQuery {
        project_id: "p1".into(),
        cursor: cursor.clone().unwrap(),
        from: day("from"),
        to: day("to"),
        limit,
    }
}

/// The instant `day` starts in the fixture's time zone, Tashkent (UTC+5).
fn tashkent(day: &str) -> i64 {
    let date: jiff::civil::Date = day.parse().unwrap();
    date.to_zoned(jiff::tz::TimeZone::fixed(jiff::tz::offset(5)))
        .unwrap()
        .timestamp()
        .as_second()
}

#[tokio::test]
async fn the_roadmap_draws_work_at_hand_and_the_dated_tasks_of_its_window_and_counts_the_rest() {
    let f = fixture().await;
    f.db.transaction(|tx| {
        tx.execute("INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr3','p1','Second',1,1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let day = |day: &str| Some(day.to_owned());
    let row = |id: &str, epic, status, deadline, completed| {
        (
            id.to_owned(),
            "tr1",
            epic,
            status,
            deadline,
            completed,
            false,
        )
    };
    insert_tasks(
        &f,
        vec![
            row("late-work", None, "in_progress", day("2000-01-01"), None),
            row("review", Some("e1"), "in_review", None, None),
            row("plan", None, "planning", day("2026-12-01"), None),
            row("late-plan", None, "planning", day("2000-01-01"), None),
            row("far-plan", None, "planning", day("2030-01-01"), None),
            row("backlog", None, "planning", None, None),
            row("older", None, "done", None, Some(tashkent("1999-06-01"))),
            row(
                "finished",
                Some("e1"),
                "done",
                day("2000-01-01"),
                Some(tashkent("2026-02-01")),
            ),
            (
                "deleted".into(),
                "tr1",
                None,
                "planning",
                day("2026-03-01"),
                None,
                true,
            ),
            ("other".into(), "tr3", None, "planning", None, None, false),
        ],
    )
    .await;
    let (lanes, days) = read_lanes(&f, window("2026-01-01", "2026-12-31")).await;
    assert_eq!(
        (days.from.as_str(), days.to.as_str(), days.limit),
        ("2026-01-01", "2026-12-31", 2000)
    );
    assert_eq!(ids(&lanes.open), ["late-work", "review"]);
    assert_eq!(lanes.open[0].started_at, Some(1));
    // Plans without a deadline stay on the Board; a late plan comes first, and
    // a plan due after the window waits for the next page.
    assert_eq!(ids(&days.plans.items), ["late-plan", "plan"]);
    assert_eq!(days.plans.reach, "2026-12-31");
    // Only the tasks done in the window come; an earlier one waits.
    assert_eq!(ids(&days.done.items), ["finished"]);
    assert_eq!(days.done.reach, "2026-01-01");
    assert_eq!(lanes.overdue, 2);
    assert_eq!(
        (lanes.first_day.as_deref(), lanes.last_day.as_deref()),
        (Some("1999-06-01"), Some("2030-01-01"))
    );
    let mut sections: Vec<_> = lanes
        .sections
        .iter()
        .map(|section| {
            (
                section.track_id.as_str(),
                section.epic_id.as_deref(),
                [
                    section.planning,
                    section.in_progress,
                    section.in_review,
                    section.done,
                ],
            )
        })
        .collect();
    sections.sort();
    assert_eq!(
        sections,
        [
            ("tr1", None, [4, 1, 0, 1]),
            ("tr1", Some("e1"), [0, 0, 1, 1]),
            ("tr3", None, [1, 0, 0, 0]),
        ]
    );
    // The next pages reach the earlier done task and the later plan.
    let earlier = f
        .service
        .roadmap_tasks(
            &f.member,
            page_query(&days.done.next_cursor, ("from", "1990-01-01"), None),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            ids(&earlier.items),
            earlier.reach.as_str(),
            &earlier.next_cursor
        ),
        (vec!["older"], "1990-01-01", &None)
    );
    let later = f
        .service
        .roadmap_tasks(
            &f.member,
            page_query(&days.plans.next_cursor, ("to", "2031-01-01"), None),
        )
        .await
        .unwrap();
    assert_eq!(
        (ids(&later.items), later.reach.as_str(), &later.next_cursor),
        (vec!["far-plan"], "2031-01-01", &None)
    );

    // Without a window, the lanes hold the days the Roadmap opens with; the
    // Roadmap read of other pages and MCP has no lanes.
    let (_, opening) = read_lanes(&f, RoadmapWindow::default()).await;
    let (from, to): (jiff::civil::Date, jiff::civil::Date) =
        (opening.from.parse().unwrap(), opening.to.parse().unwrap());
    assert_eq!((to - from).get_days(), 300);
    let structure = f
        .service
        .roadmap(&f.member, "p1".into(), None)
        .await
        .unwrap();
    assert!(structure.lanes.is_none());
    assert_eq!(structure.tracks.len(), 2);
    assert!(structure.epics.iter().all(|epic| epic.summary.is_some()));
}

#[tokio::test]
async fn roadmap_pages_go_on_from_their_cursor_whatever_changes_between_them() {
    let f = fixture().await;
    // More than a read holds of each: plans in pairs that share a deadline,
    // and done tasks in pairs that share a second.
    let count = 2_004;
    let mut tasks = Vec::new();
    for index in 0..count {
        let deadline = jiff::civil::date(2027, 1, 1) + jiff::Span::new().days(index / 2);
        tasks.push((
            format!("plan-{index:04}"),
            "tr1",
            None,
            "planning",
            Some(deadline.to_string()),
            None,
            false,
        ));
        let completed = tashkent("2026-06-01") - 3_600 * (index / 2);
        tasks.push((
            format!("done-{index:04}"),
            "tr1",
            None,
            "done",
            None,
            Some(completed),
            false,
        ));
    }
    insert_tasks(&f, tasks).await;
    let (_, first) = read_lanes(&f, window("2020-01-01", "2035-01-01")).await;
    assert_eq!(
        (first.plans.items.len(), first.done.items.len()),
        (2_000, 2_000)
    );
    // A full page covers in full the days before its last plan's, and the days
    // after its earliest done task's.
    let last_plan = first.plans.items.last().unwrap().deadline.clone().unwrap();
    assert_eq!(
        first.plans.reach,
        (last_plan.parse::<jiff::civil::Date>().unwrap() - jiff::Span::new().days(1)).to_string()
    );
    assert!(
        first.done.reach.as_str() > "2026-03-01" && first.done.reach.as_str() < "2026-06-01",
        "{}",
        first.done.reach
    );

    // Changes in the part already read, a plan due on the first day and a task
    // just finished, leave the next pages where they were; a plan in the
    // part still to read joins it.
    let row = |id: &str, status, deadline: Option<&str>, completed| {
        (
            id.to_owned(),
            "tr1",
            None,
            status,
            deadline.map(str::to_owned),
            completed,
            false,
        )
    };
    insert_tasks(
        &f,
        vec![
            row("plan-new-early", "planning", Some("2027-01-01"), None),
            row("done-new", "done", None, Some(tashkent("2026-06-01") + 60)),
            row("plan-new-late", "planning", Some("2029-12-31"), None),
        ],
    )
    .await;
    let page = |cursor: &Option<String>, bound, limit| {
        f.service
            .roadmap_tasks(&f.member, page_query(cursor, bound, limit))
    };
    let plans = page(&first.plans.next_cursor, ("to", "2035-01-01"), Some(3))
        .await
        .unwrap();
    let rest = page(&plans.next_cursor, ("to", "2035-01-01"), None)
        .await
        .unwrap();
    assert_eq!(rest.next_cursor, None);
    let mut all_plans = ids(&first.plans.items);
    all_plans.extend(ids(&plans.items));
    all_plans.extend(ids(&rest.items));
    let mut expected: Vec<String> = (0..count).map(|index| format!("plan-{index:04}")).collect();
    expected.push("plan-new-late".into());
    assert_eq!(all_plans, expected);

    let done = page(&first.done.next_cursor, ("from", "2020-01-01"), Some(3))
        .await
        .unwrap();
    let rest = page(&done.next_cursor, ("from", "2020-01-01"), None)
        .await
        .unwrap();
    assert_eq!(rest.next_cursor, None);
    let mut all_done = ids(&first.done.items);
    all_done.extend(ids(&done.items));
    all_done.extend(ids(&rest.items));
    assert_eq!(
        all_done.len(),
        count as usize,
        "every done task once, and not the new one"
    );
    assert_eq!(
        all_done.iter().collect::<HashSet<_>>().len(),
        count as usize
    );
    assert!(!all_done.contains(&"done-new"));
    // The oldest pair finished in the same second; the one done first is last.
    assert_eq!(*all_done.last().unwrap(), format!("done-{:04}", count - 2));
}

#[tokio::test]
async fn roadmap_windows_and_pages_check_their_days_and_cursor() {
    let f = fixture().await;
    let invalid = |error: AppError, field: &str| {
        assert_eq!(error.code(), "validation_failed");
        assert!(format!("{error:?}").contains(field), "{error:?}");
    };
    for (window, field) in [
        (window("2026-02-01", "2026-01-01"), "from"),
        (window("2026-1-1", "2026-02-01"), "from"),
        (window("2026-01-01", "soon"), "to"),
    ] {
        invalid(
            f.service
                .roadmap(&f.member, "p1".into(), Some(LanesQuery::Days(window)))
                .await
                .unwrap_err(),
            field,
        );
    }
    let plans = paging_cursor(r#"{"kind":"plans","deadline":"2026-01-01","id":"x"}"#);
    let done = paging_cursor(r#"{"kind":"done","completed_at":1,"completion_order":0,"id":"x"}"#);
    for (cursor, bound, field) in [
        (&plans, ("from", "2026-01-01"), "from"),
        (&done, ("to", "2026-01-01"), "to"),
        (&plans, ("", ""), "to"),
        (&done, ("", ""), "from"),
        (&done, ("from", "Monday"), "from"),
    ] {
        invalid(
            f.service
                .roadmap_tasks(&f.member, page_query(cursor, bound, None))
                .await
                .unwrap_err(),
            field,
        );
    }
    for cursor in [
        Some("not a cursor".to_owned()),
        // A cursor names only where the page goes on.
        paging_cursor(r#"{"kind":"plans","deadline":"2026-01-01","id":"x","limit":5}"#),
    ] {
        let error = f
            .service
            .roadmap_tasks(&f.member, page_query(&cursor, ("to", "2026-01-01"), None))
            .await
            .unwrap_err();
        assert_eq!(error.code(), "validation_failed");
    }
}

fn paging_cursor(json: &str) -> Option<String> {
    Some(base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        json,
    ))
}

#[tokio::test]
async fn the_roadmap_page_and_its_bootstrap_read_the_lanes_of_the_days_they_name() {
    let f = fixture().await;
    let app = router(&f);
    let get = |uri: &str| {
        let app = app.clone();
        let uri = uri.to_owned();
        async move {
            let response = app.oneshot(signed_in_get("u2", &uri)).await.unwrap();
            assert_eq!(response.status(), 200, "{uri}");
            serde_json::from_slice::<Value>(&body_bytes(response).await).unwrap()
        }
    };
    // Other pages read the tracks, epics and milestones alone.
    let structure = get("/api/projects/p1/roadmap").await;
    assert_eq!(structure["epics"].as_array().unwrap().len(), 2);
    assert!(structure.get("lanes").is_none());
    let page = get("/api/projects/p1/roadmap/lanes?from=2026-01-01&to=2026-02-01").await;
    assert_eq!(
        (&page["lanes"]["from"], &page["lanes"]["to"]),
        (&json!("2026-01-01"), &json!("2026-02-01"))
    );
    let bootstrap =
        get("/api/bootstrap?projectId=p1&view=roadmap&roadmapFrom=2026-01-01&roadmapTo=2026-02-01")
            .await;
    assert_eq!(
        (&bootstrap["roadmap"]["from"], &bootstrap["roadmap"]["to"]),
        (&json!("2026-01-01"), &json!("2026-02-01"))
    );
    let unknown = app
        .clone()
        .oneshot(signed_in_get("u2", "/api/projects/p1/roadmap/lanes?days=3"))
        .await
        .unwrap();
    assert_eq!(unknown.status(), 400);
}

#[tokio::test]
async fn a_read_of_the_tasks_a_change_named_gives_them_with_the_counts_and_no_days() {
    let f = fixture().await;
    let row = |id: &str, status, deleted| (id.to_owned(), "tr1", None, status, None, None, deleted);
    insert_tasks(
        &f,
        vec![
            row("renamed", "planning", false),
            row("working", "in_progress", false),
            row("gone", "planning", true),
        ],
    )
    .await;
    f.db.transaction(|tx| {
        tx.execute("INSERT INTO tasks(id,project_id,track_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('elsewhere','p2','tr2',1,'TWO-1','Other','planning',1,1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let named = ["renamed", "gone", "elsewhere", "missing"]
        .map(String::from)
        .to_vec();
    let lanes = f
        .service
        .roadmap(&f.member, "p1".into(), Some(LanesQuery::Tasks(named)))
        .await
        .unwrap()
        .lanes
        .unwrap();
    // Only the named tasks still in the project, and no window's plans or done tasks.
    assert_eq!(ids(lanes.tasks.as_deref().unwrap()), ["renamed"]);
    assert!(lanes.days.is_none());
    assert!(
        lanes.open.is_empty(),
        "the rest of the work in progress stays as it was"
    );
    assert_eq!(
        (
            lanes.sections.len(),
            lanes.sections[0].planning,
            lanes.sections[0].in_progress
        ),
        (1, 1, 1)
    );
    let many = (0..51).map(|index| format!("t{index}")).collect();
    let error = f
        .service
        .roadmap(&f.member, "p1".into(), Some(LanesQuery::Tasks(many)))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "validation_failed");
    // Over HTTP, named tasks come without days, and not with them.
    let app = router(&f);
    let response = app
        .clone()
        .oneshot(signed_in_get(
            "u2",
            "/api/projects/p1/roadmap/lanes?tasks=renamed,working",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = serde_json::from_slice(&body_bytes(response).await).unwrap();
    assert_eq!(body["lanes"]["tasks"].as_array().unwrap().len(), 2);
    assert!(body["lanes"].get("plans").is_none() && body["lanes"].get("from").is_none());
    let both = app
        .oneshot(signed_in_get(
            "u2",
            "/api/projects/p1/roadmap/lanes?tasks=renamed&from=2026-01-01",
        ))
        .await
        .unwrap();
    assert_eq!(both.status(), 400);
}
