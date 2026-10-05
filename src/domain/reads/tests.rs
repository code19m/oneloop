use super::*;
use jiff::civil::date;

#[test]
fn epic_summary_uses_covering_index_and_preserves_local_day_boundaries() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let c = crate::db::open_connection(&root.path().join("oneloop.sqlite3")).unwrap();
    c.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-11-01',0,1,1),('empty','p','tr','Empty','2026-11-02',1,1,1);").unwrap();
    let zone = TimeZone::built_in("America/New_York").unwrap();
    let sunday = local_midnight(&zone, date(2026, 11, 1)).unwrap();
    let monday = local_midnight(&zone, date(2026, 11, 2)).unwrap();
    assert_eq!(monday - sunday, 25 * 3600);
    for (id, status, completed, deleted) in [
        (1, "done", None, None),
        (2, "done", Some(sunday - 1), None),
        (3, "done", Some(sunday), None),
        (4, "done", Some(monday - 1), None),
        (5, "done", Some(monday), None),
        (6, "done", Some(monday + 86400), None),
        (7, "planning", Some(monday), None),
        (8, "done", Some(monday), Some(1)),
    ] {
        c.execute("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at,deleted_at) VALUES(?1,'p','e',?2,?1,'Task',?3,?2,1,1,?4,?5)",params![format!("t{id}"),id,status,completed,deleted]).unwrap();
    }
    let result = epics_on(&c, "p", &zone, date(2026, 11, 2)).unwrap();
    let epic = result[0].summary.as_ref().unwrap();
    assert_eq!((epic.task_total, epic.task_done, epic.task_open), (7, 6, 1));
    assert_eq!(
        (epic.completed_this_week, epic.completed_since_start),
        (2, 4)
    );
    assert_eq!(epic.weekly_completions, vec![0, 0, 0, 0, 1, 2, 1]);
    let empty = result[1].summary.as_ref().unwrap();
    assert_eq!(empty.task_total, 0);
    assert_eq!(empty.weekly_completions, vec![0; 7]);
    let mut explain = c
        .prepare(&format!("EXPLAIN QUERY PLAN {EPIC_SUMMARY_SQL}"))
        .unwrap();
    let plan = explain
        .query_map(
            params!["p", "[[\"e\",0]]", 0, 0, 1, 2, 3, 4, 5, 6, 7],
            |r| r.get::<_, String>(3),
        )
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    assert!(
        !plan.contains("TEMP B-TREE") && plan.contains("COVERING INDEX tasks_project_summary_idx"),
        "{plan}"
    );
}

#[test]
fn newest_done_pages_read_the_partial_index_in_order() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let c = crate::db::open_connection(&root.path().join("oneloop.sqlite3")).unwrap();
    for (sql, values) in [
        (NEWEST_DONE_SQL, params!["p", 51]),
        (NEWEST_DONE_AFTER_SQL, params!["p", 1_800_000_000, "t", 51]),
        (UNDATED_DONE_SQL, params!["p", "t", 51]),
    ] {
        let mut explain = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plan = explain
            .query_map(values, |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        assert!(
            !plan.contains("TEMP B-TREE") && plan.contains("tasks_project_done_completed_idx"),
            "{sql}\n{plan}"
        );
    }
    let mut explain = c
        .prepare(&format!("EXPLAIN QUERY PLAN {NEWEST_DONE_AFTER_SQL}"))
        .unwrap();
    let plan: String = explain
        .query_row(params!["p", 1_800_000_000, "t", 51], |r| r.get(3))
        .unwrap();
    assert!(plan.contains("(completed_at,id)<(?,?)"), "{plan}");
}

#[test]
#[ignore = "manual 100,000-task summary timing probe"]
fn epic_summary_scale_probe() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let c = crate::db::open_connection(&root.path().join("oneloop.sqlite3")).unwrap();
    c.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99)
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) SELECT 'e'||x,'p','tr','Epic','2026-11-01',x,1,1 FROM n;
        WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99999)
        INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_at,updated_at,completed_at) SELECT 't'||x,'p','e'||(x%100),x+1,'ONE-'||x,'Task','done',x,1,1,1793491200+x FROM n;").unwrap();
    let mut old = c.prepare_cached("SELECT epic_id,status,completed_at,COUNT(*) FROM tasks WHERE project_id=?1 AND deleted_at IS NULL GROUP BY epic_id,status,completed_at").unwrap();
    for round in 0..3 {
        let begin = std::time::Instant::now();
        let rows = old
            .query_map(["p"], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let previous_ms = begin.elapsed().as_secs_f64() * 1000.0;
        let begin = std::time::Instant::now();
        let summaries = epics_on(
            &c,
            "p",
            &TimeZone::built_in("UTC").unwrap(),
            date(2026, 11, 2),
        )
        .unwrap();
        let summary_ms = begin.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(rows.len(), 100_000);
        assert_eq!(summaries.len(), 100);
        assert!(
            summaries
                .iter()
                .all(|epic| epic.summary.as_ref().unwrap().task_done == 1000)
        );
        eprintln!(
            "round {round}: old grouped row decoding {previous_ms:.3}ms (100000 rows); complete epic summaries {summary_ms:.3}ms (100 rows)"
        );
    }
}

mod epic_date_tests {
    use super::*;

    fn fixture(completed: &[i64], start: &str) -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE epics(id TEXT,project_id TEXT,track_id TEXT,title TEXT,description TEXT,start_date TEXT,end_date TEXT,state TEXT,position INTEGER,revision INTEGER,deleted_at INTEGER);
            CREATE TABLE tasks(epic_id TEXT,project_id TEXT,status TEXT,completed_at INTEGER,deleted_at INTEGER);").unwrap();
        connection
            .execute(
                "INSERT INTO epics VALUES('e','p','t','Epic','',?1,NULL,'active',0,1,NULL)",
                [start],
            )
            .unwrap();
        for instant in completed {
            connection
                .execute(
                    "INSERT INTO tasks VALUES('e','p','done',?1,NULL)",
                    [instant],
                )
                .unwrap();
        }
        connection
    }

    #[test]
    fn throughput_uses_instance_midnight_and_monday_boundaries() {
        let zone = TimeZone::built_in("Pacific/Kiritimati").unwrap();
        let monday = date(2026, 9, 28);
        let boundary = local_midnight(&zone, monday).unwrap();
        let connection = fixture(&[boundary - 1, boundary, boundary + 1], "2026-09-01");
        for (offset, weekly, last) in [(-1, 3, 1), (0, 2, 2), (1, 2, 2)] {
            let instant = Timestamp::from_second(boundary + offset).unwrap();
            let today = zone.rules().to_datetime(instant).date();
            let epic = epics_on(&connection, "p", &zone, today)
                .unwrap()
                .remove(0)
                .summary
                .unwrap();
            assert_eq!(epic.completed_this_week, weekly);
            assert_eq!(epic.weekly_completions[6], last);
            assert_eq!(epic.completed_since_start, 3);
        }
    }

    #[test]
    fn throughput_buckets_cover_dst_midnight_gaps_and_skipped_dates() {
        for (name, year, month, day, hours) in [
            ("Pacific/Auckland", 2026, 9, 27, 23),
            ("America/Santiago", 2026, 9, 6, 23),
            ("Pacific/Apia", 2011, 12, 30, 0),
        ] {
            let zone = TimeZone::built_in(name).unwrap();
            let day = date(year, month, day);
            let next = day.tomorrow().unwrap();
            let start = local_midnight(&zone, day).unwrap();
            let end = local_midnight(&zone, next).unwrap();
            assert_eq!(end - start, hours * 3600, "{name}");
            let connection = fixture(&[start - 1, start, end - 1, end], &day.to_string());
            let epic = epics_on(&connection, "p", &zone, next)
                .unwrap()
                .remove(0)
                .summary
                .unwrap();
            assert_eq!(
                epic.weekly_completions[5],
                if hours == 0 { 0 } else { 2 },
                "{name}"
            );
            assert_eq!(
                epic.weekly_completions[6],
                if hours == 0 { 2 } else { 1 },
                "{name}"
            );
            assert_eq!(
                epic.completed_since_start,
                if hours == 0 { 2 } else { 3 },
                "{name}"
            );
        }
    }

    #[test]
    fn day_boundaries_follow_rule_changes_since_tzdb_2025b() {
        // British Columbia and Alberta stop falling back on 2026-11-01 (IANA
        // 2026b and 2026c), and Morocco moves from +01 to +00 on 2026-09-20
        // (2026c). With 2025b data these days were 25, 25 and 24 hours long.
        for (name, day, hours) in [
            ("America/Vancouver", date(2026, 11, 1), 24),
            ("America/Edmonton", date(2026, 11, 1), 24),
            ("Africa/Casablanca", date(2026, 9, 20), 25),
        ] {
            let zone = TimeZone::built_in(name).unwrap();
            let start = local_midnight(&zone, day).unwrap();
            let end = local_midnight(&zone, day.tomorrow().unwrap()).unwrap();
            assert_eq!(end - start, hours * 3600, "{name}");
        }
    }
}
