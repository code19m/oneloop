use super::*;

#[test]
fn epic_summary_uses_covering_index_and_preserves_local_day_boundaries() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let c = crate::db::open_connection(&root.path().join("oneloop.sqlite3")).unwrap();
    c.execute_batch("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p','Project','ONE',1,1);
        INSERT INTO tracks(id,project_id,name,position,created_at,updated_at) VALUES('tr','p','Track',0,1,1);
        INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_at,updated_at) VALUES('e','p','tr','Epic','2026-11-01',0,1,1),('empty','p','tr','Empty','2026-11-02',1,1,1);").unwrap();
    let zone: Tz = "America/New_York".parse().unwrap();
    let sunday = local_midnight(zone, NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()).unwrap();
    let monday = local_midnight(zone, NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()).unwrap();
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
    let result = epics_on(&c, "p", zone, NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()).unwrap();
    let epic = &result[0];
    assert_eq!((epic.task_total, epic.task_done, epic.task_open), (7, 6, 1));
    assert_eq!(
        (epic.completed_this_week, epic.completed_since_start),
        (2, 4)
    );
    assert_eq!(epic.weekly_completions, vec![0, 0, 0, 0, 1, 2, 1]);
    assert_eq!(result[1].task_total, 0);
    assert_eq!(result[1].weekly_completions, vec![0; 7]);
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
            chrono_tz::UTC,
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
        )
        .unwrap();
        let summary_ms = begin.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(rows.len(), 100_000);
        assert_eq!(summaries.len(), 100);
        assert!(summaries.iter().all(|epic| epic.task_done == 1000));
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
        let zone: Tz = "Pacific/Kiritimati".parse().unwrap();
        let monday = NaiveDate::from_ymd_opt(2026, 9, 28).unwrap();
        let boundary = local_midnight(zone, monday).unwrap();
        let connection = fixture(&[boundary - 1, boundary, boundary + 1], "2026-09-01");
        for (offset, weekly, last) in [(-1, 3, 1), (0, 2, 2), (1, 2, 2)] {
            let today = chrono::DateTime::from_timestamp(boundary + offset, 0)
                .unwrap()
                .with_timezone(&zone)
                .date_naive();
            let epic = epics_on(&connection, "p", zone, today).unwrap().remove(0);
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
            let zone: Tz = name.parse().unwrap();
            let date = NaiveDate::from_ymd_opt(year, month, day).unwrap();
            let next = date.succ_opt().unwrap();
            let start = local_midnight(zone, date).unwrap();
            let end = local_midnight(zone, next).unwrap();
            assert_eq!(end - start, hours * 3600, "{name}");
            let connection = fixture(&[start - 1, start, end - 1, end], &date.to_string());
            let epic = epics_on(&connection, "p", zone, next).unwrap().remove(0);
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
}
