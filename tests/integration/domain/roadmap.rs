//! The Roadmap read: what its lanes draw for a window of days, what it
//! counts, and the lists of its marks that count several tasks.

use oneloop::domain::{
    DayMark, LanesQuery, ListKind, RoadmapDays, RoadmapListQuery, RoadmapMark, RoadmapTimeline,
    RoadmapWindow, SectionDays, TaskView,
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

/// Inserts tasks into `p1`, each at its own number and position; work in
/// progress starts at its number, so earlier rows started earlier.
async fn insert_tasks(f: &Fixture, tasks: Vec<Row>) {
    f.db.transaction(move |tx| {
        let first: i64 = tx.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))?;
        let mut insert = tx.prepare(
            "INSERT INTO tasks(id,project_id,track_id,epic_id,task_number,task_key,title,status,position,deadline,
                created_at,updated_at,started_at,completed_at,completion_order,deleted_at)
             VALUES(?1,'p1',?2,?3,?4,?5,?1,?6,?4,?7,1,1,CASE WHEN ?6<>'planning' THEN ?4 END,?8,?4,?9)",
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

/// Blocks the task `id` of `p1`.
async fn block(f: &Fixture, id: &'static str) {
    f.db.transaction(move |tx| {
        tx.execute(
            "INSERT INTO task_blocks(id,project_id,task_id,reason,created_by,created_at) VALUES(?1,'p1',?2,'Waiting','u1',1)",
            params![format!("block-{id}"), id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

fn ids(tasks: &[TaskView]) -> Vec<&str> {
    tasks.iter().map(|task| task.id.as_str()).collect()
}

fn mark_ids(marks: &[RoadmapMark]) -> Vec<&str> {
    marks.iter().map(|mark| mark.mark.id.as_str()).collect()
}

/// The tasks of days with one, as (section's epic, id), in each section's order.
fn day_marks(days: &RoadmapDays) -> Vec<(Option<&str>, &DayMark)> {
    days.sections
        .iter()
        .flat_map(|section| {
            section
                .marks
                .iter()
                .map(|mark| (section.epic_id.as_deref(), mark))
        })
        .collect()
}

fn day_mark_ids(days: &RoadmapDays) -> Vec<&str> {
    day_marks(days)
        .into_iter()
        .map(|(_, mark)| mark.id.as_str())
        .collect()
}

fn window(from: &str, to: &str) -> RoadmapWindow {
    RoadmapWindow {
        from: Some(from.into()),
        to: Some(to.into()),
        ..RoadmapWindow::default()
    }
}

async fn read_lanes(f: &Fixture, query: LanesQuery) -> RoadmapTimeline {
    f.service
        .roadmap(&f.member, "p1".into(), Some(query))
        .await
        .unwrap()
        .lanes
        .unwrap()
}

fn days_of(window: RoadmapWindow) -> LanesQuery {
    LanesQuery {
        window,
        ..LanesQuery::default()
    }
}

/// Each section's days as (track, epic, done, plans, blocked).
type Days<'a> = (&'a str, Option<&'a str>, &'a [i64], &'a [i64], &'a [i64]);

fn sections(days: &[SectionDays]) -> Vec<Days<'_>> {
    days.iter()
        .map(|section| {
            (
                section.track_id.as_str(),
                section.epic_id.as_deref(),
                &section.done[..],
                &section.plans[..],
                &section.blocked[..],
            )
        })
        .collect()
}

/// The instant `day` starts in the fixture's time zone, Tashkent (UTC+5),
/// and `hours` after.
fn tashkent(day: &str, hours: i64) -> i64 {
    let date: jiff::civil::Date = day.parse().unwrap();
    date.to_zoned(jiff::tz::TimeZone::fixed(jiff::tz::offset(5)))
        .unwrap()
        .timestamp()
        .as_second()
        + hours * 3600
}

/// Two done tasks and three plans of Track One's own work, and a done task of
/// its epic, from Jan 2 to Jan 8, 2026; and tasks around them that the
/// window leaves out.
async fn january(f: &Fixture) {
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
        f,
        vec![
            row(
                "done-a",
                None,
                "done",
                None,
                Some(tashkent("2026-01-02", 9)),
            ),
            row(
                "done-b",
                None,
                "done",
                None,
                Some(tashkent("2026-01-02", 23)),
            ),
            row(
                "done-epic",
                Some("e1"),
                "done",
                None,
                Some(tashkent("2026-01-05", 1)),
            ),
            row(
                "done-before",
                None,
                "done",
                None,
                Some(tashkent("2025-12-31", 12)),
            ),
            (
                "done-deleted".into(),
                "tr1",
                None,
                "done",
                None,
                Some(tashkent("2026-01-03", 1)),
                true,
            ),
            row("plan-alone", None, "planning", day("2026-01-03"), None),
            row("plan-pair-a", None, "planning", day("2026-01-08"), None),
            row("plan-pair-b", None, "planning", day("2026-01-08"), None),
            row("plan-later", None, "planning", day("2026-02-01"), None),
            row("backlog", None, "planning", None, None),
        ],
    )
    .await;
    block(f, "plan-alone").await;
    block(f, "plan-pair-b").await;
}

#[tokio::test]
async fn the_lanes_count_done_work_and_plans_by_day_and_give_the_task_of_a_day_with_one() {
    let f = fixture().await;
    january(&f).await;
    let query = days_of(RoadmapWindow {
        anchor: Some("2026-01-05".into()),
        ..window("2026-01-01", "2026-01-10")
    });
    let lanes = read_lanes(&f, query).await;
    let days = &lanes.days;
    assert_eq!(
        (days.from.as_str(), days.to.as_str()),
        ("2026-01-01", "2026-01-10")
    );
    // Each list starts on Jan 1 and ends at its last day with any.
    assert_eq!(
        sections(&days.sections),
        [
            (
                "tr1",
                None,
                &[0, 2][..],
                &[0, 0, 1, 0, 0, 0, 0, 2][..],
                &[0, 0, 1, 0, 0, 0, 0, 1][..]
            ),
            ("tr1", Some("e1"), &[0, 0, 0, 0, 1][..], &[][..], &[][..]),
        ]
    );
    // The days with one task give it, in its section.
    let marks = day_marks(days);
    assert_eq!(
        marks
            .iter()
            .map(|(epic, mark)| (*epic, mark.id.as_str()))
            .collect::<Vec<_>>(),
        [(None, "plan-alone"), (Some("e1"), "done-epic")]
    );
    let plan = marks[0].1;
    assert_eq!(
        (
            plan.task_key.as_str(),
            plan.status.as_str(),
            plan.deadline.as_deref(),
            plan.blocked,
            plan.completed_at
        ),
        ("ONE-6", "planning", Some("2026-01-03"), true, None)
    );
    assert_eq!(marks[1].1.completed_at, Some(tashkent("2026-01-05", 1)));
    assert_eq!(
        (lanes.first_day.as_deref(), lanes.last_day.as_deref()),
        (Some("2025-12-31"), Some("2026-02-01"))
    );
    // As many as the read asks for, nearest the anchor, Jan 5, first.
    let one = read_lanes(
        &f,
        days_of(RoadmapWindow {
            anchor: Some("2026-01-05".into()),
            marks: Some(1),
            ..window("2026-01-01", "2026-01-10")
        }),
    )
    .await;
    assert_eq!(day_mark_ids(&one.days), ["done-epic"]);
    // None, for a read of the counts alone.
    let counts = read_lanes(
        &f,
        days_of(RoadmapWindow {
            marks: Some(0),
            ..window("2026-01-01", "2026-01-10")
        }),
    )
    .await;
    assert!(day_marks(&counts.days).is_empty());
    assert_eq!(sections(&counts.days.sections), sections(&days.sections));
    // The same days on their own.
    let alone = f
        .service
        .roadmap_days(
            &f.member,
            "p1".into(),
            RoadmapWindow {
                anchor: Some("2026-01-05".into()),
                ..window("2026-01-01", "2026-01-10")
            },
        )
        .await
        .unwrap();
    assert_eq!(sections(&alone.sections), sections(&days.sections));
    assert_eq!(day_mark_ids(&alone), day_mark_ids(days));

    // Without a window, the lanes hold the days the Roadmap opens with; the
    // Roadmap read of other pages and MCP has no lanes.
    let opening = read_lanes(&f, LanesQuery::default()).await;
    let (from, to): (jiff::civil::Date, jiff::civil::Date) = (
        opening.days.from.parse().unwrap(),
        opening.days.to.parse().unwrap(),
    );
    assert_eq!((to - from).get_days(), 120 + 165);
    let structure = f
        .service
        .roadmap(&f.member, "p1".into(), None)
        .await
        .unwrap();
    assert!(structure.lanes.is_none());
    assert!(structure.epics.iter().all(|epic| epic.summary.is_some()));
}

#[tokio::test]
async fn the_lanes_draw_each_sections_most_urgent_work_count_the_rest_and_step_through_the_late() {
    let f = fixture().await;
    let day = |day: &str| Some(day.to_owned());
    let row = |id: &str, epic, status, deadline| {
        (id.to_owned(), "tr1", epic, status, deadline, None, false)
    };
    insert_tasks(
        &f,
        vec![
            // Started first, without a deadline: least urgent.
            row("idle", None, "in_progress", None),
            row("far", None, "in_review", day("2999-06-01")),
            row("near", None, "in_progress", day("2999-01-01")),
            row("stuck", None, "in_progress", None),
            row("late", None, "in_progress", day("2000-02-01")),
            row("epic-work", Some("e1"), "in_review", None),
            row("late-plan", None, "planning", day("2000-01-01")),
        ],
    )
    .await;
    block(&f, "stuck").await;
    let lanes = read_lanes(&f, LanesQuery::default()).await;
    // Late, then blocked, then the nearest deadline; the epic's one.
    assert_eq!(ids(&lanes.open), ["late", "stuck", "near", "epic-work"]);
    assert_eq!(lanes.overdue, 2);
    // The longest overdue first.
    let late = lanes.late.as_deref().unwrap();
    assert_eq!(mark_ids(late), ["late-plan", "late"]);
    assert_eq!(late[1].mark.started_at, Some(5));
    let mut counts: Vec<_> = lanes
        .sections
        .iter()
        .map(|section| {
            (
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
    counts.sort();
    assert_eq!(counts, [(None, [1, 4, 1, 0]), (Some("e1"), [0, 0, 1, 0])]);
    // The rest of the work in progress, on demand, after the bars.
    let list = f
        .service
        .roadmap_list(
            &f.member,
            RoadmapListQuery {
                project_id: "p1".into(),
                track_id: "tr1".into(),
                epic_id: None,
                kind: ListKind::Open,
                from: None,
                to: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (mark_ids(&list.items), list.total),
        (vec!["late", "stuck", "near", "far", "idle"], 5)
    );
}

#[tokio::test]
async fn a_read_of_named_tasks_gives_them_and_the_work_in_progress_and_days_of_their_sections() {
    let f = fixture().await;
    let row = |id: &str, epic, status, deadline: Option<&str>, completed| {
        (
            id.to_owned(),
            "tr1",
            epic,
            status,
            deadline.map(str::to_owned),
            completed,
            false,
        )
    };
    insert_tasks(
        &f,
        vec![
            row("renamed", None, "planning", Some("2026-01-03"), None),
            row("own-work", None, "in_progress", None, None),
            row(
                "own-done",
                None,
                "done",
                None,
                Some(tashkent("2026-01-02", 9)),
            ),
            row("working", Some("e1"), "in_review", None, None),
            row(
                "epic-done",
                Some("e1"),
                "done",
                None,
                Some(tashkent("2026-01-04", 9)),
            ),
            ("gone".into(), "tr1", None, "planning", None, None, true),
        ],
    )
    .await;
    f.db.transaction(|tx| {
        tx.execute("INSERT INTO tasks(id,project_id,track_id,task_number,task_key,title,status,position,created_at,updated_at) VALUES('elsewhere','p2','tr2',1,'TWO-1','Other','planning',1,1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let query = |named: &[&str], sections: &[&str]| LanesQuery {
        window: window("2026-01-01", "2026-01-10"),
        tasks: Some(named.iter().map(|id| (*id).to_owned()).collect()),
        sections: sections.iter().map(|key| (*key).to_owned()).collect(),
        late: false,
    };
    fn drawn(lanes: &RoadmapTimeline) -> (Vec<&str>, Vec<Option<&str>>, Vec<&str>) {
        let counted = lanes
            .days
            .sections
            .iter()
            .map(|section| section.epic_id.as_deref())
            .collect();
        (
            ids(&lanes.open),
            counted,
            ids(lanes.tasks.as_deref().unwrap()),
        )
    }
    // The epic a named task is in: its work in progress and its days alone.
    let lanes = read_lanes(&f, query(&["working", "gone", "elsewhere", "missing"], &[])).await;
    assert_eq!(drawn(&lanes), (vec!["working"], vec![Some("e1")], vec![]));
    // And the track's own work, where a named task is too, or that the read names.
    let lanes = read_lanes(&f, query(&["working", "renamed"], &[])).await;
    assert_eq!(
        drawn(&lanes),
        (
            vec!["own-work", "working"],
            vec![None, Some("e1")],
            vec!["renamed"]
        ),
        "only those still in the project, and not twice"
    );
    let lanes = read_lanes(&f, query(&["working"], &["tr1/"])).await;
    assert_eq!(drawn(&lanes).1, [None, Some("e1")]);
    // A read of sections alone, naming no task.
    let lanes = read_lanes(&f, query(&[], &["tr1/"])).await;
    assert_eq!(drawn(&lanes), (vec!["own-work"], vec![None], vec![]));
    assert_eq!(lanes.sections.len(), 2, "the counts of every section");
    // The longest overdue, only when a named task is among them, or the read says one was.
    let late = |query: LanesQuery| async {
        let lanes = read_lanes(&f, query).await;
        lanes.late.map(|late| mark_ids(&late).join(" "))
    };
    assert_eq!(late(query(&["working"], &[])).await, None);
    assert_eq!(
        late(query(&["renamed"], &[])).await.as_deref(),
        Some("renamed")
    );
    assert_eq!(
        late(LanesQuery {
            late: true,
            ..query(&["working"], &[])
        })
        .await
        .as_deref(),
        Some("renamed")
    );
    // Of the structure, the epics of the sections it changed alone.
    let view = |named: &[&str]| {
        f.service
            .roadmap(&f.member, "p1".into(), Some(query(named, &[])))
    };
    let changed = view(&["working"]).await.unwrap();
    assert_eq!(
        (
            changed.tracks.len(),
            changed.milestones.len(),
            changed
                .epics
                .iter()
                .map(|epic| epic.id.as_str())
                .collect::<Vec<_>>()
        ),
        (0, 0, vec!["e1"])
    );
    assert!(view(&["renamed"]).await.unwrap().epics.is_empty());
    let many = (0..51).map(|index| format!("t{index}")).collect();
    let error = f
        .service
        .roadmap(
            &f.member,
            "p1".into(),
            Some(LanesQuery {
                tasks: Some(many),
                ..LanesQuery::default()
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "validation_failed");
}

#[tokio::test]
async fn a_list_gives_a_sections_done_tasks_or_plans_of_its_days() {
    let f = fixture().await;
    january(&f).await;
    // Sixty more done on Jan 9: a list gives the first fifty.
    let many = (0..60)
        .map(|index| {
            (
                format!("busy-{index:02}"),
                "tr1",
                None,
                "done",
                None,
                Some(tashkent("2026-01-09", 0) + index),
                false,
            )
        })
        .collect();
    insert_tasks(&f, many).await;
    let list = |kind, from: &str, to: &str| {
        f.service.roadmap_list(
            &f.member,
            RoadmapListQuery {
                project_id: "p1".into(),
                track_id: "tr1".into(),
                epic_id: None,
                kind,
                from: Some(from.into()),
                to: Some(to.into()),
            },
        )
    };
    let done = list(ListKind::Done, "2026-01-01", "2026-01-03")
        .await
        .unwrap();
    assert_eq!(
        (mark_ids(&done.items), done.total),
        (vec!["done-b", "done-a"], 2)
    );
    let plans = list(ListKind::Plans, "2026-01-01", "2026-01-10")
        .await
        .unwrap();
    assert_eq!(
        (mark_ids(&plans.items), plans.total),
        (vec!["plan-alone", "plan-pair-a", "plan-pair-b"], 3)
    );
    let busy = list(ListKind::Done, "2026-01-09", "2026-01-09")
        .await
        .unwrap();
    assert_eq!(
        (busy.items.len(), busy.total, busy.items[0].mark.id.as_str()),
        (50, 60, "busy-59")
    );
    let unbounded = list(ListKind::Done, "2026-01-01", "2027-06-01")
        .await
        .unwrap_err();
    assert_eq!(unbounded.code(), "validation_failed");
}

#[tokio::test]
async fn roadmap_windows_check_their_days() {
    let f = fixture().await;
    let invalid = |error: AppError, field: &str| {
        assert_eq!(error.code(), "validation_failed");
        assert!(format!("{error:?}").contains(field), "{error:?}");
    };
    for (window, field) in [
        (window("2026-02-01", "2026-01-01"), "from"),
        (window("2026-1-1", "2026-02-01"), "from"),
        (window("2026-01-01", "soon"), "to"),
        (window("2026-01-01", "2027-02-05"), "to"),
        (
            RoadmapWindow {
                anchor: Some("now".into()),
                ..window("2026-01-01", "2026-02-01")
            },
            "anchor",
        ),
    ] {
        invalid(
            f.service
                .roadmap(&f.member, "p1".into(), Some(days_of(window.clone())))
                .await
                .unwrap_err(),
            field,
        );
        invalid(
            f.service
                .roadmap_days(&f.member, "p1".into(), window)
                .await
                .unwrap_err(),
            field,
        );
    }
    // A read of days alone names both ends.
    invalid(
        f.service
            .roadmap_days(
                &f.member,
                "p1".into(),
                RoadmapWindow {
                    from: Some("2026-01-01".into()),
                    ..RoadmapWindow::default()
                },
            )
            .await
            .unwrap_err(),
        "to",
    );
    // A read of a change's sections covers every day the page holds: years.
    let named = |to: &str| LanesQuery {
        window: window("2020-01-01", to),
        tasks: Some(Vec::new()),
        sections: vec!["tr1/".into()],
        late: false,
    };
    assert!(
        f.service
            .roadmap(&f.member, "p1".into(), Some(named("2029-12-31")))
            .await
            .is_ok()
    );
    invalid(
        f.service
            .roadmap(&f.member, "p1".into(), Some(named("2030-01-31")))
            .await
            .unwrap_err(),
        "to",
    );
}

#[tokio::test]
async fn the_roadmap_page_reads_its_lanes_days_and_lists_and_its_bootstrap_the_days_it_names() {
    let f = fixture().await;
    january(&f).await;
    let app = router(&f);
    let get = |uri: &str| {
        let app = app.clone();
        let uri = uri.to_owned();
        async move {
            let response = app.oneshot(signed_in_get("u2", &uri)).await.unwrap();
            let status = response.status();
            (
                status,
                serde_json::from_slice::<Value>(&body_bytes(response).await).unwrap_or(Value::Null),
            )
        }
    };
    // Other pages read the tracks, epics and milestones alone.
    let (_, structure) = get("/api/projects/p1/roadmap").await;
    assert_eq!(structure["epics"].as_array().unwrap().len(), 2);
    assert!(structure.get("lanes").is_none());
    let (_, page) = get(
        "/api/projects/p1/roadmap/lanes?from=2026-01-01&to=2026-01-10&anchor=2026-01-05&marks=1",
    )
    .await;
    // The epic's one done task, in its section, which names its track and epic.
    let epic = &page["lanes"]["days"]["sections"][1];
    assert_eq!(
        (
            &page["lanes"]["days"]["from"],
            &epic["epicId"],
            &epic["marks"][0]["id"]
        ),
        (&json!("2026-01-01"), &json!("e1"), &json!("done-epic"))
    );
    // A mark leaves out what it doesn't have, and what its section says.
    let mark = epic["marks"][0].as_object().unwrap();
    assert!(
        ["deadline", "blocked", "trackId", "epicId"]
            .iter()
            .all(|field| !mark.contains_key(*field))
    );
    assert!(page["lanes"]["days"]["sections"][0].get("marks").is_none());
    let (_, days) = get("/api/projects/p1/roadmap/days?from=2026-01-01&to=2026-01-10").await;
    assert_eq!(days["sections"][0]["done"], json!([0, 2]));
    let (_, list) =
        get("/api/projects/p1/roadmap/list?track=tr1&kind=plans&from=2026-01-01&to=2026-01-10")
            .await;
    assert_eq!(list["total"], 3);
    let (_, list) = get(
        "/api/projects/p1/roadmap/list?track=tr1&epic=e1&kind=done&from=2026-01-01&to=2026-01-10",
    )
    .await;
    assert_eq!(list["items"][0]["id"], "done-epic");
    let (_, changed) = get("/api/projects/p1/roadmap/lanes?tasks=plan-alone,done-a&sections=tr1/&late=true&from=2026-01-01&to=2026-01-10").await;
    assert_eq!(changed["lanes"]["tasks"].as_array().unwrap().len(), 2);
    assert!(changed["lanes"]["late"].is_array() && changed["tracks"] == json!([]));
    let (_, bootstrap) = get("/api/bootstrap?projectId=p1&view=roadmap&roadmapFrom=2026-01-01&roadmapTo=2026-02-01&roadmapAnchor=2026-01-05").await;
    assert_eq!(
        (
            &bootstrap["roadmap"]["days"]["from"],
            &bootstrap["roadmap"]["days"]["to"]
        ),
        (&json!("2026-01-01"), &json!("2026-02-01"))
    );
    assert_eq!(
        bootstrap["roadmap"]["days"]["sections"][1]["marks"][0]["id"],
        "done-epic"
    );
    for refused in [
        "/api/projects/p1/roadmap/lanes?days=3",
        "/api/projects/p1/roadmap/lanes?sections=tr1/",
        "/api/projects/p1/roadmap/lanes?late=true",
        "/api/projects/p1/roadmap/days?from=2026-01-01",
        "/api/projects/p1/roadmap/list?track=tr1&kind=all",
    ] {
        assert_eq!(get(refused).await.0, 400, "{refused}");
    }
}
