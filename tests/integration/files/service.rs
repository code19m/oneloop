use std::{sync::mpsc, time::Duration};

use image::ImageEncoder;
use oneloop::{
    AppError, Db,
    auth::Actor,
    db,
    files::{
        AttachmentPatch, AttachmentReorder, AttachmentRestore, FileService, ReadMode, UploadStart,
    },
};
use tempfile::TempDir;
use tokio::io::AsyncReadExt;
use tokio::time::{sleep, timeout};

use crate::support::{browser_actor, eventually, now};

struct Fixture {
    _root: TempDir,
    db: Db,
    manager: Actor,
    viewer: Actor,
    outsider: Actor,
}

impl Fixture {
    async fn new() -> Self {
        let (root, db) = crate::support::database();
        let now = now();
        db.run(move |connection| {
            connection.execute_batch(&format!(r#"
                INSERT INTO users(id,username,display_name,password_hash,password_changed_at,created_at,updated_at)
                    VALUES ('manager','manager','Manager','x',{now},{now},{now}),
                           ('viewer','viewer','Viewer','x',{now},{now},{now}),
                           ('outsider','outsider','Outsider','x',{now},{now},{now});
                INSERT INTO sessions(id,user_id,token_hash,created_at,last_activity_at,authenticated_at,idle_expires_at,absolute_expires_at)
                    VALUES ('sm','manager','hm',{now},{now},{now},{expiry},{expiry}),
                           ('sv','viewer','hv',{now},{now},{now},{expiry},{expiry}),
                           ('so','outsider','ho',{now},{now},{now},{expiry},{expiry});
                INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at)
                    VALUES ('p1','Project','PRJ','manager',{now},{now});
                INSERT INTO project_prefixes(prefix,project_id,reserved_at) VALUES ('PRJ','p1',{now});
                INSERT INTO project_sequences(project_id,next_task_number) VALUES ('p1',2);
                INSERT INTO project_memberships(project_id,user_id,manage_board,created_at,updated_at)
                    VALUES ('p1','manager',1,{now},{now}),('p1','viewer',0,{now},{now});
                INSERT INTO tracks(id,project_id,name,position,created_by,created_at,updated_at)
                    VALUES ('track','p1','Track',0,'manager',{now},{now});
                INSERT INTO epics(id,project_id,track_id,title,start_date,position,created_by,created_at,updated_at)
                    VALUES ('epic','p1','track','Epic','2026-01-01',0,'manager',{now},{now});
                INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                    VALUES ('task','p1','epic',1,'PRJ-001','Task','planning',0,'manager',{now},{now});
            "#, expiry=now+86_400))?;
            Ok(())
        }).await.unwrap();
        Self {
            _root: root,
            db,
            manager: browser_actor("manager", "manager", "sm", now),
            viewer: browser_actor("viewer", "viewer", "sv", now),
            outsider: browser_actor("outsider", "outsider", "so", now),
        }
    }

    fn service(&self, limit: u64) -> FileService {
        FileService::new(self.db.clone(), limit, 0)
    }
}

fn stored_file_count(root: &std::path::Path) -> usize {
    std::fs::read_dir(root)
        .unwrap()
        .flat_map(|entry| walkdir::WalkDir::new(entry.unwrap().path()))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .count()
}

/// Moves every deletion back past the Undo window, as if it had passed.
async fn end_undo_window(db: &Db) {
    db.run(|connection| {
        for table in ["tasks", "task_attachments"] {
            connection.execute(
                &format!(
                    "UPDATE {table} SET deleted_at=deleted_at-?1 WHERE deleted_at IS NOT NULL"
                ),
                [oneloop::domain::UNDO_WINDOW_SECONDS],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
}

async fn upload(
    service: &FileService,
    actor: &Actor,
    key: &str,
    name: &str,
    bytes: &[u8],
    temporary: bool,
) -> oneloop::files::AttachmentView {
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(actor, "task", name, bytes.len() as u64, temporary, key)
        .await
        .unwrap()
    else {
        panic!("new upload must not replay")
    };
    // Small fixtures exercise split writes; large content checks need not make
    // hundreds of thousands of blocking-pool filesystem round trips.
    let chunk_size = if bytes.len() > 64 * 1024 {
        64 * 1024
    } else {
        3
    };
    for chunk in bytes.chunks(chunk_size) {
        pending.write_chunk(chunk).await.unwrap();
    }
    pending.finish().await.unwrap()
}

#[tokio::test]
async fn opaque_uploads_are_durable_replayable_and_member_readable() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let bytes = b"PK\x03\x04 arbitrary archive bytes";
    let file = upload(
        &service,
        &fixture.manager,
        "upload-one",
        "work.rar",
        bytes,
        false,
    )
    .await;
    assert_eq!(file.state, oneloop::files::BlobState::Available);
    assert_eq!(file.preview_kind, None);
}

#[tokio::test]
async fn names_permissions_streaming_and_replay_are_enforced() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let invalid = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "../escape.txt",
            4,
            false,
            "bad-name",
        )
        .await;
    assert!(matches!(invalid, Err(AppError::Validation { .. })));
    let denied = service
        .begin_attachment_upload(
            &fixture.viewer,
            "task",
            "read-only.txt",
            4,
            false,
            "viewer-write",
        )
        .await;
    assert!(matches!(denied, Err(AppError::Forbidden)));
    let hidden = service.list_attachments(&fixture.outsider, "task").await;
    assert!(matches!(hidden, Err(AppError::NotFound { .. })));

    let bytes = b"hello durable world";
    let created = upload(
        &service,
        &fixture.manager,
        "same-upload",
        "notes.txt",
        bytes,
        false,
    )
    .await;
    let replay = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "notes.txt",
            bytes.len() as u64,
            false,
            "same-upload",
        )
        .await
        .unwrap();
    let UploadStart::Replayed(replayed) = replay else {
        panic!("expected idempotent replay")
    };
    assert_eq!(replayed.id, created.id);
    let mismatch = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "different.txt",
            bytes.len() as u64,
            false,
            "same-upload",
        )
        .await;
    assert_eq!(mismatch.err().unwrap().code(), "idempotency_key_reused");

    let listed = service
        .list_attachments(&fixture.viewer, "task")
        .await
        .unwrap();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].name, "notes.txt");
    assert!(listed.items[0].storage_safe());
    let mut read = service
        .open_for_read(&fixture.viewer, &created.id, ReadMode::Download)
        .await
        .unwrap();
    let mut downloaded = Vec::new();
    read.file.read_to_end(&mut downloaded).await.unwrap();
    assert_eq!(downloaded, bytes);
}

#[tokio::test]
async fn count_reservations_close_the_concurrent_twenty_fifth_slot() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let mut pending = Vec::new();
    for index in 0..25 {
        let UploadStart::Pending(upload) = service
            .begin_attachment_upload(
                &fixture.manager,
                "task",
                &format!("{index}.bin"),
                1,
                false,
                &format!("reserve-{index}"),
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        pending.push(upload);
    }
    let overflow = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "overflow.bin",
            1,
            false,
            "reserve-overflow",
        )
        .await;
    assert!(matches!(overflow, Err(AppError::Conflict(_))));
    for upload in pending {
        upload.abort().await.unwrap();
    }
}

#[tokio::test]
async fn temporary_cleanup_keeps_metadata_while_permanent_bytes_survive() {
    let fixture = Fixture::new().await;
    let roomy = fixture.service(100 * 1024 * 1024);
    let temporary = upload(
        &roomy,
        &fixture.manager,
        "temp",
        "temporary.bin",
        b"temporary-content",
        true,
    )
    .await;
    let permanent = upload(
        &roomy,
        &fixture.manager,
        "perm",
        "permanent.bin",
        b"permanent-content",
        false,
    )
    .await;
    let old = now() - 2 * 24 * 60 * 60;
    let temp_id = temporary.id.clone();
    fixture
        .db
        .run(move |connection| {
            connection.execute(
                "UPDATE task_attachments SET created_at=?1,last_accessed_at=?1 WHERE id=?2",
                rusqlite::params![old, temp_id],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let constrained = fixture.service(20);
    let report = constrained.cleanup_to_low_watermark().await.unwrap();
    assert_eq!(report.temporary_files_cleaned, 1);
    let listed = roomy
        .list_attachments(&fixture.manager, "task")
        .await
        .unwrap();
    assert_eq!(
        listed
            .items
            .iter()
            .find(|item| item.id == temporary.id)
            .unwrap()
            .state,
        oneloop::files::BlobState::Cleaned
    );
    assert_eq!(
        listed
            .items
            .iter()
            .find(|item| item.id == permanent.id)
            .unwrap()
            .state,
        oneloop::files::BlobState::Available
    );
    assert!(
        roomy
            .open_for_read(&fixture.manager, &temporary.id, ReadMode::Download)
            .await
            .is_err()
    );
    assert!(
        roomy
            .open_for_read(&fixture.manager, &permanent.id, ReadMode::Download)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn failed_deletion_of_a_cleaned_attachment_can_retry_with_its_key() {
    let fixture = Fixture::new().await;
    let roomy = fixture.service(100 * 1024 * 1024);
    let temporary = upload(&roomy, &fixture.manager, "temp", "old.bin", b"old", true).await;
    let old = now() - 2 * 24 * 60 * 60;
    fixture
        .db
        .run(move |connection| {
            connection.execute(
                "UPDATE task_attachments SET created_at=?1,last_accessed_at=?1",
                [old],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    fixture.service(1).cleanup_to_low_watermark().await.unwrap();
    let cleaned = roomy
        .list_attachments(&fixture.manager, "task")
        .await
        .unwrap()
        .items
        .remove(0);
    assert_eq!(cleaned.state, oneloop::files::BlobState::Cleaned);
    let set_failure = |sql: &'static str| {
        fixture.db.run(move |connection| {
            connection.execute_batch(sql)?;
            Ok(())
        })
    };
    set_failure(
        "CREATE TRIGGER fail_once BEFORE UPDATE OF deleted_at ON task_attachments
         BEGIN SELECT RAISE(ABORT, 'disk error'); END",
    )
    .await
    .unwrap();
    let delete =
        || roomy.delete_attachment(&fixture.manager, &temporary.id, cleaned.revision, "gone");
    assert!(delete().await.is_err());
    set_failure("DROP TRIGGER fail_once").await.unwrap();
    delete().await.unwrap();
    let remaining = roomy
        .list_attachments(&fixture.manager, "task")
        .await
        .unwrap();
    assert!(remaining.items.is_empty());
}

#[tokio::test]
async fn soft_deleted_tasks_are_reconciled_to_byte_and_metadata_removal() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "delete-parent",
        "payload.bin",
        b"payload",
        false,
    )
    .await;
    fixture
        .db
        .run(|connection| {
            connection.execute(
                "UPDATE tasks SET deleted_at=unixepoch() WHERE id='task'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    for mode in [
        ReadMode::Download,
        ReadMode::Content,
        ReadMode::Source,
        ReadMode::HtmlPreview,
    ] {
        assert!(matches!(
            service.open_for_read(&fixture.viewer, &file.id, mode).await,
            Err(AppError::NotFound { .. })
        ));
    }
    assert!(matches!(
        service
            .set_ephemeral(
                &fixture.manager,
                &file.id,
                AttachmentPatch {
                    is_ephemeral: true,
                    expected_revision: file.revision
                }
            )
            .await,
        Err(AppError::NotFound { .. })
    ));
    assert!(matches!(
        service
            .delete_attachment(
                &fixture.manager,
                &file.id,
                file.revision,
                "deleted-parent-delete"
            )
            .await,
        Err(AppError::NotFound { .. })
    ));
    // The files stay for the Undo window.
    let report = service.reconcile().await.unwrap();
    assert_eq!(report.deletion_jobs_completed, 0);
    assert_eq!(stored_file_count(&fixture.db.layout().files()), 1);
    fixture
        .db
        .run(|connection| {
            connection.execute(
                "UPDATE tasks SET deleted_at=deleted_at-?1 WHERE id='task'",
                [oneloop::domain::UNDO_WINDOW_SECONDS],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let report = service.reconcile().await.unwrap();
    assert_eq!(report.deletion_jobs_completed, 1);
    let id = file.id;
    let exists: bool = fixture
        .db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM task_attachments WHERE id=?1)",
                [id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn a_restored_task_keeps_its_files() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "restored-parent",
        "notes.txt",
        b"notes",
        false,
    )
    .await;
    let domain = oneloop::domain::DomainService::new(fixture.db.clone(), crate::support::utc());
    for (operation, key, revision) in [
        (
            oneloop::domain::DomainOperation::DeleteTask,
            "delete-parent",
            1,
        ),
        (
            oneloop::domain::DomainOperation::RestoreTask,
            "restore-parent",
            2,
        ),
    ] {
        domain
            .execute(
                &fixture.manager,
                oneloop::domain::CommandEnvelope {
                    operation,
                    payload: serde_json::json!({"id":"task"}),
                    idempotency_key: key.into(),
                    expected_revision: Some(revision),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            service.reconcile().await.unwrap().deletion_jobs_completed,
            0
        );
    }
    let mut read = service
        .open_for_read(&fixture.viewer, &file.id, ReadMode::Download)
        .await
        .unwrap();
    let mut bytes = Vec::new();
    read.file.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"notes");
}

#[tokio::test]
async fn deletion_is_byte_complete_and_safe_to_replay() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "delete-upload",
        "delete-me.txt",
        b"delete me",
        false,
    )
    .await;
    service
        .delete_attachment(&fixture.manager, &file.id, file.revision, "delete-request")
        .await
        .unwrap();
    service
        .delete_attachment(&fixture.manager, &file.id, file.revision, "delete-request")
        .await
        .unwrap();
    assert!(
        service
            .list_attachments(&fixture.manager, "task")
            .await
            .unwrap()
            .items
            .is_empty()
    );
    // The bytes stay for the Undo window.
    let files = fixture.db.layout().files();
    assert_eq!(
        service.reconcile().await.unwrap().deletion_jobs_completed,
        0
    );
    assert_eq!(stored_file_count(&files), 1);
    end_undo_window(&fixture.db).await;
    assert_eq!(
        service.reconcile().await.unwrap().deletion_jobs_completed,
        1
    );
    assert_eq!(stored_file_count(&files), 0);
    let rows: (i64, i64) = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT count(*) FROM task_attachments),(SELECT count(*) FROM file_blobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(rows, (0, 0));
    // The receipt still answers a retry after the purge.
    service
        .delete_attachment(&fixture.manager, &file.id, file.revision, "delete-request")
        .await
        .unwrap();
}

#[tokio::test]
async fn delayed_deletion_keeps_attribution_after_receipt_expiry_and_pruning() {
    for via_mcp in [false, true] {
        let f = Fixture::new().await;
        let service = f.service(100 * 1024 * 1024);
        let mut actor = f.manager.clone();
        if via_mcp {
            f.db.run(|c| {
                let now = now();
                c.execute("INSERT INTO mcp_grants(id,user_id,client_id,client_name,created_at,updated_at,expires_at,last_used_at) VALUES('delete-grant','manager','files-client','Files app',?1,?1,?2,?1)", rusqlite::params![now, now+86400])?;
                c.execute("INSERT INTO mcp_grant_projects(grant_id,project_id) VALUES('delete-grant','p1')", [])?;
                for scope in ["project_read", "attachments", "board_manage", "destructive"] {
                    c.execute("INSERT INTO mcp_grant_scopes(grant_id,scope) VALUES('delete-grant',?1)", [scope])?;
                }
                Ok(())
            }).await.unwrap();
            actor.source = oneloop::auth::ActorSource::McpGrant {
                grant_id: "delete-grant".into(),
            };
        }
        let attachment = upload(
            &service,
            &f.manager,
            "pending-file",
            "pending.txt",
            b"data",
            false,
        )
        .await;
        let id = attachment.id.clone();
        let key: String = f.db.run(move |c| Ok(c.query_row("SELECT b.storage_key FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id WHERE a.id=?1", [id], |r| r.get(0))?)).await.unwrap();
        let path = service.store().file_path(&key).unwrap();
        service
            .delete_attachment(
                &actor,
                &attachment.id,
                attachment.revision,
                "pending-delete",
            )
            .await
            .unwrap();
        // A folder in the file's place makes the first removal fail.
        let held = f._root.path().join("held-original");
        std::fs::rename(&path, &held).unwrap();
        std::fs::create_dir(&path).unwrap();
        end_undo_window(&f.db).await;
        assert_eq!(
            service.reconcile().await.unwrap().deletion_jobs_completed,
            0
        );
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(held, &path).unwrap();
        f.db.run(|c| {
            c.execute(
                "UPDATE idempotency_keys SET expires_at=0 WHERE operation='attachment.delete'",
                [],
            )?;
            c.execute("UPDATE file_deletion_jobs SET available_at=0", [])?;
            Ok(())
        })
        .await
        .unwrap();
        upload(
            &service,
            &f.manager,
            "prune-expired",
            "another.txt",
            b"other",
            false,
        )
        .await;
        let receipts: i64 =
            f.db.run(|c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM idempotency_keys WHERE operation='attachment.delete'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(receipts, 0, "ordinary writes really pruned the receipt");
        f.db.run(|c| {
            c.execute(
                "UPDATE users SET display_name='Renamed' WHERE id='manager'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            service.reconcile().await.unwrap().deletion_jobs_completed,
            1
        );
        assert_eq!(
            service.reconcile().await.unwrap().deletion_jobs_completed,
            0
        );
        assert!(!path.exists());
        let id = attachment.id.clone();
        let (events, projections, outbox, attachments): (i64, i64, i64, i64) = f.db.run(move |c| Ok((
            c.query_row("SELECT count(*) FROM activity_events WHERE entity_id=?1 AND event_type='attachment.deleted'", [&id], |r| r.get(0))?,
            c.query_row("SELECT count(*) FROM activity_projection WHERE entity_id=?1 AND event_type='attachment.deleted'", [&id], |r| r.get(0))?,
            c.query_row("SELECT count(*) FROM outbox_messages WHERE json_extract(payload_json,'$.activityEventId') IN (SELECT id FROM activity_events WHERE entity_id=?1 AND event_type='attachment.deleted')", [&id], |r| r.get(0))?,
            c.query_row("SELECT count(*) FROM task_attachments WHERE id=?1", [&id], |r| r.get(0))?,
        ))).await.unwrap();
        assert_eq!((events, projections, outbox, attachments), (1, 1, 1, 0));
        let id = attachment.id;
        let provenance: (String, Option<String>, String) = f.db.run(move |c| Ok(c.query_row(
            "SELECT actor_user_id,actor_mcp_grant_id,(SELECT actor_name_snapshot FROM activity_projection WHERE entity_id=?1 AND event_type='attachment.deleted') FROM activity_events WHERE entity_id=?1 AND event_type='attachment.deleted'",
            [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?)).await.unwrap();
        assert_eq!(
            provenance,
            (
                "manager".into(),
                via_mcp.then(|| "delete-grant".into()),
                actor.display_name
            )
        );
    }
}

#[tokio::test]
async fn an_unattributed_deletion_from_a_deleted_project_is_audited_but_not_delivered() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let attachment = upload(
        &service,
        &f.manager,
        "lost-file",
        "lost.txt",
        b"data",
        false,
    )
    .await;
    let id = attachment.id.clone();
    f.db.transaction(move |tx| {
        // A deletion from before Undo that an upgrade left in progress, whose
        // retry receipt had already expired: the job knows the file, not who
        // asked for it.
        tx.execute(
            "UPDATE file_blobs SET state='deleting' WHERE id=(SELECT blob_id FROM task_attachments WHERE id=?1)",
            [&id],
        )?;
        tx.execute(
            "INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at,
               project_id,task_id,attachment_id,attachment_name)
             SELECT 'legacy-job',b.id,b.storage_key,'manual',1,0,a.project_id,a.task_id,a.id,a.original_name
             FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id WHERE a.id=?1",
            [&id],
        )?;
        tx.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at)
            VALUES('keep-project','Keep project','KEEP','manager',1,1)", [])?;
        Ok(())
    }).await.unwrap();
    let mut admin = f.manager.clone();
    admin.is_admin = true;
    oneloop::domain::DomainService::new(f.db.clone(), crate::support::utc())
        .execute(
            &admin,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::DeleteProject,
                payload: serde_json::json!({"projectId":"p1","confirmedName":"Project"}),
                idempotency_key: "delete-project".into(),
                expected_revision: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service.reconcile().await.unwrap().deletion_jobs_completed,
        1
    );
    // Nobody can be told about the deletion, so nothing waits for delivery.
    let runtime = oneloop::collaboration::CollaborationRuntime::new(f.db.clone());
    while runtime.worker().run_once().await.unwrap() {}
    let id = attachment.id;
    let (events, undelivered): (i64, i64) = f.db.run(move |c| Ok((
        c.query_row("SELECT count(*) FROM activity_events WHERE entity_id=?1 AND event_type='attachment.deleted'
            AND project_id IS NULL AND actor_user_id IS NULL AND json_extract(metadata_json,'$.attributionUnavailable')", [id], |r| r.get(0))?,
        c.query_row("SELECT count(*) FROM outbox_messages WHERE delivered_at IS NULL", [], |r| r.get(0))?,
    ))).await.unwrap();
    assert_eq!((events, undelivered), (1, 0));
}

#[tokio::test]
async fn retention_and_deletion_require_current_revisions_but_replay_safely() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "revision-upload",
        "revision.txt",
        b"revision",
        false,
    )
    .await;
    let changed = service
        .set_ephemeral(
            &fixture.manager,
            &file.id,
            AttachmentPatch {
                is_ephemeral: true,
                expected_revision: file.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(changed.revision, file.revision + 1);
    let retried = service
        .set_ephemeral(
            &fixture.manager,
            &file.id,
            AttachmentPatch {
                is_ephemeral: true,
                expected_revision: file.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(retried, changed);
    assert!(matches!(
        service
            .set_ephemeral(
                &fixture.manager,
                &file.id,
                AttachmentPatch {
                    is_ephemeral: false,
                    expected_revision: file.revision,
                },
            )
            .await,
        Err(AppError::RevisionConflict { .. })
    ));
    assert!(matches!(
        service
            .delete_attachment(&fixture.manager, &file.id, file.revision, "stale-delete")
            .await,
        Err(AppError::RevisionConflict { .. })
    ));
    service
        .delete_attachment(
            &fixture.manager,
            &file.id,
            changed.revision,
            "current-delete",
        )
        .await
        .unwrap();
    service
        .delete_attachment(
            &fixture.manager,
            &file.id,
            changed.revision,
            "current-delete",
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn retried_cleanup_uses_the_same_activity_projection_path() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "cleanup-retry-upload",
        "retry.tmp",
        b"cleanup retry bytes",
        true,
    )
    .await;
    let attachment_id = file.id.clone();
    fixture
        .db
        .transaction(move |tx| {
            let (blob, key): (String, String) = tx.query_row(
                "SELECT b.id,b.storage_key FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id WHERE a.id=?1",
                [&attachment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            tx.execute("UPDATE file_blobs SET state='deleting' WHERE id=?1", [&blob])?;
            tx.execute("INSERT INTO storage_cleanup_runs(id,started_at,trigger) VALUES('retry-run',1,'watermark')", [])?;
            tx.execute(
                "INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at,cleanup_run_id)
                 VALUES('cleanup-retry-job',?1,?2,'cleanup',unixepoch(),unixepoch(),'retry-run')",
                rusqlite::params![blob, key],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let (first, second) = tokio::join!(service.reconcile(), service.reconcile());
    assert_eq!(
        first.unwrap().deletion_jobs_completed + second.unwrap().deletion_jobs_completed,
        1
    );
    let listed = service
        .list_attachments(&fixture.manager, "task")
        .await
        .unwrap();
    assert_eq!(listed.items[0].revision, 2);
    let attachment_id = file.id.clone();
    let (events, projections, metadata): (i64, i64, String) = fixture
        .db
        .run(move |connection| {
            Ok(connection.query_row(
                "SELECT
                    (SELECT count(*) FROM activity_events WHERE entity_id=?1 AND event_type='attachment.cleaned'),
                    (SELECT count(*) FROM activity_projection WHERE entity_id=?1 AND event_type='attachment.cleaned'),
                    (SELECT metadata_json FROM activity_events WHERE entity_id=?1 AND event_type='attachment.cleaned')",
                [&attachment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!((events, projections), (1, 1));
    let run: (i64, i64) = fixture
        .db
        .run(|c| {
            Ok(c.query_row(
                "SELECT files,bytes FROM storage_cleanup_runs WHERE id='retry-run'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(run, (1, b"cleanup retry bytes".len() as i64));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["size"],
        b"cleanup retry bytes".len()
    );
}

#[tokio::test]
async fn capacity_counts_reservations_without_double_counting_partial_staging() {
    let fixture = Fixture::new().await;
    fixture
        .db
        .run(|connection| {
            connection.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
            Ok(())
        })
        .await
        .unwrap();
    let mut admin = fixture.manager.clone();
    admin.is_admin = true;
    let service = fixture.service(100);
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(&admin, "task", "partial.bin", 10, false, "partial")
        .await
        .unwrap()
    else {
        panic!()
    };
    pending.write_chunk(b"four").await.unwrap();
    // Tokio may return after buffering the write, before filesystem metadata
    // reflects it. Reservation accounting must hold throughout that transition.
    let usage = eventually(
        "staging metadata reflects the buffered upload",
        async || {
            let usage = service.storage_usage(&admin).await.unwrap();
            assert_eq!(usage.reserved_bytes, 10);
            assert_eq!(usage.used_bytes, 10);
            (usage.staging_bytes == 4).then_some(usage)
        },
    )
    .await;
    assert_eq!(usage.staging_bytes, 4);
    assert_eq!(usage.projects.len(), 0);
    pending.abort().await.unwrap();
}

#[tokio::test]
async fn attachment_order_replays_without_a_second_revision_or_activity_change() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let first = upload(
        &service,
        &fixture.manager,
        "order-first",
        "first.txt",
        b"first",
        false,
    )
    .await;
    let second = upload(
        &service,
        &fixture.manager,
        "order-second",
        "second.txt",
        b"second",
        false,
    )
    .await;
    let input = AttachmentReorder {
        attachment_id: second.id.clone(),
        target_id: first.id.clone(),
        after: false,
        expected_revision: second.revision,
        idempotency_key: "same-order".into(),
    };
    let changed = service
        .reorder(&fixture.manager, "task", input.clone())
        .await
        .unwrap();
    let replayed = service
        .reorder(&fixture.manager, "task", input)
        .await
        .unwrap();
    assert_eq!(
        changed
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        replayed
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>()
    );
    assert_eq!(changed.items[0].revision, second.revision + 1);
    assert_eq!(changed.items[1].revision, first.revision + 1);
    let events: i64 = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM activity_events WHERE event_type='attachment.reordered'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(events, 1);
}

#[tokio::test]
async fn text_detection_checks_the_whole_file_and_oversized_html_is_download_only() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let mut disguised_binary = vec![b'a'; 1024 * 1024 + 32];
    *disguised_binary.last_mut().unwrap() = 0xff;
    for name in [
        "looks-readable.txt",
        "looks-readable.md",
        "looks-readable.markdown",
    ] {
        let binary = upload(
            &service,
            &fixture.manager,
            name,
            name,
            &disguised_binary,
            false,
        )
        .await;
        assert_eq!(binary.preview_kind, None);
        assert_eq!(binary.source_url, None);
    }

    let mut large_html = b"<!doctype html><p>safe</p>".to_vec();
    large_html.resize(1024 * 1024 + 1, b' ');
    let html = upload(
        &service,
        &fixture.manager,
        "large-html",
        "large.html",
        &large_html,
        false,
    )
    .await;
    assert_eq!(html.preview_kind, None);
    assert_eq!(html.html_preview_url, None);
    assert!(html.download_url.is_some());
}

#[tokio::test]
async fn completed_reads_release_their_cleanup_and_deletion_lease() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "lease-upload",
        "lease.txt",
        b"lease",
        false,
    )
    .await;
    let read = service
        .open_for_read(&fixture.manager, &file.id, ReadMode::Download)
        .await
        .unwrap();
    drop(read);
    eventually("the read lease is released", async || {
        let leases: i64 = fixture
            .db
            .run(|connection| {
                Ok(connection
                    .query_row("SELECT count(*) FROM file_leases", [], |row| row.get(0))?)
            })
            .await
            .unwrap();
        (leases == 0).then_some(())
    })
    .await;
    service
        .delete_attachment(
            &fixture.manager,
            &file.id,
            file.revision,
            "delete-after-read",
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn interrupted_uploads_release_their_slot_and_retry_identity() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "interrupted.bin",
            8,
            false,
            "interrupted-upload",
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    pending.write_chunk(b"half").await.unwrap();
    drop(pending);
    eventually(
        "the abandoned upload releases its reservation",
        async || {
            let state: (i64, Option<String>) = fixture
                .db
                .run(|connection| {
                    Ok(connection.query_row(
                        "SELECT
                           (SELECT count(*) FROM upload_reservations
                            WHERE committed_at IS NULL),
                           (SELECT state FROM idempotency_keys
                            WHERE actor_user_id='manager'
                              AND idempotency_key='interrupted-upload')",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?)
                })
                .await
                .unwrap();
            if state.0 == 0 {
                assert_eq!(
                    state.1.as_deref(),
                    Some("failed"),
                    "reservation release and retry state must commit atomically"
                );
            }
            (state.0 == 0).then_some(())
        },
    )
    .await;
    let retry = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "interrupted.bin",
            8,
            false,
            "interrupted-upload",
        )
        .await
        .unwrap();
    let UploadStart::Pending(retry) = retry else {
        panic!("an interrupted upload must be retryable")
    };
    retry.abort().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn upload_that_fails_during_a_backup_can_retry_with_its_key() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let begin =
        || service.begin_attachment_upload(&fixture.manager, "task", "late.txt", 4, false, "late");
    let UploadStart::Pending(mut pending) = begin().await.unwrap() else {
        panic!("new upload must not replay")
    };
    pending.write_chunk(b"late").await.unwrap();
    // A backup holds the data lock while it copies the database, here for
    // longer than any request waits for it.
    let backup = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.db.layout().data_lock())
        .unwrap();
    backup.try_lock().unwrap();
    let finished = timeout(Duration::from_secs(10), pending.finish())
        .await
        .expect("the data lease wait is bounded");
    assert!(
        matches!(finished, Err(AppError::Unavailable(_))),
        "{finished:?}"
    );
    sleep(Duration::from_secs(10)).await;
    drop(backup);
    let UploadStart::Pending(mut retry) = begin().await.unwrap() else {
        panic!("a failed upload must not replay")
    };
    retry.write_chunk(b"late").await.unwrap();
    retry.finish().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_finish_during_reconcile_preserves_the_durable_upload() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let bytes = b"cancellation-safe upload";
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "cancel-safe.txt",
            bytes.len() as u64,
            false,
            "cancel-during-commit",
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    pending.write_chunk(bytes).await.unwrap();

    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let blocker_db = fixture.db.clone();
    let blocker = tokio::spawn(async move {
        blocker_db
            .transaction(move |_tx| {
                locked_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                Ok(())
            })
            .await
    });
    tokio::task::spawn_blocking(move || locked_rx.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("write lock should be acquired");

    let stored_root = fixture.db.layout().files();
    let finish = tokio::spawn(pending.finish());
    eventually(
        "the finalizer moves bytes before waiting for the database lock",
        async || (stored_file_count(&stored_root) == 1).then_some(()),
    )
    .await;

    let reconcile_service = service.clone();
    let reconciliation = tokio::spawn(async move { reconcile_service.reconcile().await });
    finish.abort();
    assert!(finish.await.unwrap_err().is_cancelled());
    release_tx.send(()).unwrap();
    blocker.await.unwrap().unwrap();

    eventually(
        "the detached finalizer commits after its caller is cancelled",
        async || {
            let state: (Option<String>, i64, i64) = fixture
                .db
                .run(|connection| {
                    Ok(connection.query_row(
                        "SELECT
                           (SELECT state FROM idempotency_keys
                            WHERE actor_user_id='manager'
                              AND idempotency_key='cancel-during-commit'),
                           (SELECT count(*) FROM upload_reservations
                            WHERE committed_at IS NULL),
                           (SELECT count(*) FROM task_attachments
                            WHERE task_id='task')",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )?)
                })
                .await
                .unwrap();
            (state == (Some("succeeded".to_owned()), 0, 1)).then_some(())
        },
    )
    .await;
    let report = timeout(Duration::from_secs(10), reconciliation)
        .await
        .expect("reconciliation should finish after the promotion commits")
        .unwrap()
        .unwrap();
    assert_eq!(report.orphan_files_removed, 0);

    let replay = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "cancel-safe.txt",
            bytes.len() as u64,
            false,
            "cancel-during-commit",
        )
        .await
        .unwrap();
    let UploadStart::Replayed(file) = replay else {
        panic!("completed upload must replay after request cancellation")
    };
    let mut read = service
        .open_for_read(&fixture.manager, &file.id, ReadMode::Download)
        .await
        .unwrap();
    let mut downloaded = Vec::new();
    read.file.read_to_end(&mut downloaded).await.unwrap();
    assert_eq!(downloaded, bytes);
    assert_eq!(stored_file_count(&fixture.db.layout().files()), 1);
}

#[tokio::test]
async fn avatar_changes_succeed_when_the_old_file_cannot_be_queued_for_deletion() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    service
        .upload_avatar(&fixture.manager, png.clone())
        .await
        .unwrap();
    let deletion_queue = |sql: &'static str| {
        fixture.db.run(move |connection| {
            connection.execute_batch(sql)?;
            Ok(())
        })
    };
    deletion_queue(
        "CREATE TRIGGER queue_fails BEFORE INSERT ON file_deletion_jobs
         BEGIN SELECT RAISE(ABORT, 'disk error'); END",
    )
    .await
    .unwrap();
    service.upload_avatar(&fixture.manager, png).await.unwrap();
    service.remove_avatar(&fixture.manager).await.unwrap();
    deletion_queue("DROP TRIGGER queue_fails").await.unwrap();
    // Nothing refers to the replaced files, so reconciliation deletes both.
    let report = service.reconcile().await.unwrap();
    assert_eq!(report.deletion_jobs_completed, 2);
    let blobs: i64 = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row("SELECT count(*) FROM file_blobs", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(blobs, 0);
}

#[tokio::test]
async fn avatars_reserve_the_shared_storage_budget_before_writing() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100);
    let pixels = [255_u8, 0, 0, 255];
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&pixels, 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    assert!(matches!(
        service.upload_avatar(&fixture.manager, png).await,
        Err(AppError::Rule {
            kind: oneloop::error::RuleKind::StorageFull,
            ..
        })
    ));
    let blobs: i64 = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row("SELECT count(*) FROM file_blobs", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(blobs, 0);
}

#[tokio::test]
async fn malformed_text_is_download_only_and_avatars_are_normalized() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    for name in ["broken.txt", "broken.md", "broken.markdown"] {
        let binary = upload(
            &service,
            &fixture.manager,
            name,
            name,
            &[0xff, 0xfe, 0, 1],
            false,
        )
        .await;
        assert_eq!(binary.media_type, "application/octet-stream");
        assert_eq!(binary.preview_kind, None);
        assert!(
            service
                .open_for_read(&fixture.manager, &binary.id, ReadMode::Source)
                .await
                .is_err()
        );
    }

    let pixels = [255_u8, 0, 0, 255];
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&pixels, 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let url = service.upload_avatar(&fixture.manager, png).await.unwrap();
    assert!(url.starts_with("/api/users/manager/avatar?v="));
    let mut avatar = service
        .open_avatar(&fixture.manager, "manager")
        .await
        .unwrap();
    let mut normalized = Vec::new();
    avatar.file.read_to_end(&mut normalized).await.unwrap();
    let decoded = image::load_from_memory(&normalized).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (256, 256));
    assert!(
        service
            .upload_avatar(&fixture.manager, b"not an image".to_vec())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn avatars_that_need_too_much_memory_to_decode_are_refused() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    // 27 megapixels of lossless WebP need over 200 MiB to decode, though the
    // file is a few bytes.
    let refused = service
        .upload_avatar(&fixture.manager, super::flat_webp(6000, 4500))
        .await;
    assert!(
        matches!(&refused, Err(AppError::Validation { field, .. }) if field == "avatar"),
        "{refused:?}"
    );
    service
        .upload_avatar(&fixture.manager, super::flat_webp(600, 450))
        .await
        .unwrap();
}

#[test]
fn html_preview_removes_direct_navigation_primitives() {
    let source=br#"<!doctype html><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><iframe src="https://evil.test"></iframe><object data="x"></object><script>document.body.dataset.ok='yes'</script><p>Kept</p>"#;
    let sanitized = String::from_utf8(oneloop::files::sanitize_html_preview(source))
        .unwrap()
        .to_ascii_lowercase();
    assert!(!sanitized.contains("<base"));
    assert!(!sanitized.contains("http-equiv"));
    assert!(!sanitized.contains("<iframe"));
    assert!(!sanitized.contains("<object"));
    assert!(sanitized.contains("<script>"));
    assert!(sanitized.contains("<p>kept</p>"));
}

trait AttachmentAssertions {
    fn storage_safe(&self) -> bool;
}

impl AttachmentAssertions for oneloop::files::AttachmentView {
    fn storage_safe(&self) -> bool {
        !self
            .download_url
            .as_deref()
            .unwrap_or_default()
            .contains(&self.name)
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "opt-in large file-library scheduler workload"]
async fn large_library_reconciliation_keeps_the_async_executor_responsive() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Instant;
    let f = Fixture::new().await;
    let service = f.service(u64::MAX / 2);
    let store = oneloop::files::FileStore::new(f.db.layout().clone());
    let count: usize = std::env::var("ONELOOP_TEST_FILE_COUNT")
        .ok()
        .map(|v| v.parse().unwrap())
        .unwrap_or(20_000);
    let mut keys = Vec::with_capacity(count);
    for _ in 0..count {
        let key = store.new_storage_key().unwrap();
        let path = store.file_path(&key).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
        keys.push(key);
    }
    f.db.transaction(move |tx| {
        let mut task = tx.prepare("INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
            VALUES(?1,'p1','epic',?2,?1,'Scale task','planning',?2,'manager',?3,?3)")?;
        let mut blob = tx.prepare("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
            VALUES(?1,?2,?3,1,'application/octet-stream','available',?4)")?;
        let mut attachment = tx.prepare("INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,is_ephemeral,position,created_at,last_accessed_at,updated_at)
            VALUES(?1,'p1',?2,?1,'scale.bin','manager',0,?3,?4,?4,?4)")?;
        for (index,key) in keys.into_iter().enumerate() {
            let task_id = format!("scale-task-{}", index/25);
            if index%25 == 0 { task.execute(rusqlite::params![task_id, (index/25+2) as i64, now()])?; }
            let id = format!("scan-{index}");
            blob.execute(rusqlite::params![id,key,"0".repeat(64),now()])?;
            attachment.execute(rusqlite::params![id,task_id,(index%25) as i64,now()])?;
        }
        Ok(())
    }).await.unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let heartbeat = running.clone();
    let ticks = tokio::spawn(async move {
        let mut gaps = Vec::new();
        let mut previous = Instant::now();
        while heartbeat.load(Ordering::Relaxed) {
            sleep(Duration::from_millis(1)).await;
            gaps.push(previous.elapsed().as_secs_f64() * 1000.0);
            previous = Instant::now();
        }
        gaps
    });
    let started = Instant::now();
    let report = service.reconcile().await.unwrap();
    let elapsed = started.elapsed();
    running.store(false, Ordering::Relaxed);
    let mut gaps = ticks.await.unwrap();
    gaps.sort_by(f64::total_cmp);
    assert_eq!(report.orphan_files_removed, 0);
    assert!(!gaps.is_empty());
    assert_eq!(report.deletion_jobs_completed, 0);
    assert_eq!(stored_file_count(&f.db.layout().files()), count);
    let constrained = f.service((count as u64) * 100 / 85);
    let started_uploads = Instant::now();
    for index in 0..4 {
        let UploadStart::Pending(pending) = constrained
            .begin_attachment_upload(
                &f.manager,
                "task",
                "scale-upload.bin",
                1,
                false,
                &format!("scale-admit-{index}"),
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        pending.abort().await.unwrap();
    }
    eprintln!(
        "FILE_ADMISSION files={count} four_starts_and_aborts_ms={:.1}",
        started_uploads.elapsed().as_secs_f64() * 1000.0
    );
    f.db.run(|c| {
        let query = "SELECT coalesce(sum(size_bytes),0) FROM file_blobs WHERE state IN ('pending','available','deleting')";
        for indexed in [true,false] {
            if !indexed {c.execute("DROP INDEX file_blobs_state_size_idx",[])?;}
            let started=Instant::now();
            for _ in 0..20 {let _:i64=c.query_row(query,[],|r|r.get(0))?;}
            eprintln!("CAPACITY_SUM covering_index={indexed} mean_ms={:.3}",started.elapsed().as_secs_f64()*1000.0/20.0);
        }
        c.execute("CREATE INDEX file_blobs_state_size_idx ON file_blobs(state,size_bytes)",[])?;
        Ok(())
    }).await.unwrap();
    eprintln!(
        "FILE_SCAN files={count} duration_ms={:.1} heartbeat_ticks={} max_gap_ms={:.1}",
        elapsed.as_secs_f64() * 1000.0,
        gaps.len(),
        gaps.last().unwrap()
    );
}

#[tokio::test]
async fn stalled_upload_does_not_hold_back_a_complete_backup() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let saved = upload(
        &service,
        &fixture.manager,
        "saved",
        "saved.txt",
        b"saved",
        false,
    )
    .await;
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "stalled.txt",
            100,
            false,
            "stalled",
        )
        .await
        .unwrap()
    else {
        panic!("expected upload");
    };
    pending.write_chunk(b"part").await.unwrap();
    let root = fixture.db.layout().root().to_path_buf();
    let backup_parent = crate::support::scratch_dir();
    let destination = backup_parent.path().join("backup-test");
    let backup = timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(move || db::create_backup(root, destination)),
    )
    .await
    .expect("body streaming must not block backups")
    .unwrap()
    .unwrap();
    db::validate_backup(backup).unwrap();
    pending.abort().await.unwrap();
    assert!(
        service
            .open_for_read(&fixture.manager, &saved.id, ReadMode::Download)
            .await
            .is_ok()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capacity_scans_tolerate_staging_and_preview_churn() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let mut admin = fixture.manager.clone();
    admin.is_admin = true;
    fixture
        .db
        .transaction(|tx| {
            tx.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
            Ok(())
        })
        .await
        .unwrap();
    service.store().ensure_directories().await.unwrap();
    let staging = service.store().layout().staging();
    let previews = service.store().previews();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_stop = stop.clone();
    let churn = std::thread::spawn(move || {
        while !thread_stop.load(std::sync::atomic::Ordering::Relaxed) {
            for root in [&staging, &previews] {
                for i in 0..16 {
                    let path = root.join(format!("churn-{i}"));
                    std::fs::write(&path, b"transient").unwrap();
                    std::fs::remove_file(path).unwrap();
                }
            }
        }
    });
    let mut errors = Vec::new();
    for _ in 0..100 {
        if let Err(error) = service.storage_usage(&admin).await {
            errors.push(error);
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    churn.join().unwrap();
    assert!(errors.is_empty(), "scan errors: {errors:?}");
}

#[tokio::test]
async fn unrecoverable_disk_floor_preserves_eligible_temporary_files() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "temp-floor",
        "temp.bin",
        b"temporary",
        true,
    )
    .await;
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE task_attachments SET created_at=1,last_accessed_at=1",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    // Deterministically larger than the entire backing volume; no deletion can help.
    let full = FileService::new(fixture.db.clone(), 100 * 1024 * 1024, u64::MAX);
    assert!(
        full.begin_attachment_upload(&fixture.manager, "task", "new.bin", 1, false, "floor")
            .await
            .is_err()
    );
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[0, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    assert!(full.upload_avatar(&fixture.viewer, png).await.is_err());
    let listed = service
        .list_attachments(&fixture.manager, "task")
        .await
        .unwrap();
    assert_eq!(listed.items[0].state, oneloop::files::BlobState::Available);
    assert_eq!(listed.items[0].revision, 1);
    assert!(
        service
            .open_for_read(&fixture.manager, &file.id, ReadMode::Download)
            .await
            .is_ok()
    );
    let cleaned: i64 = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM activity_events WHERE event_type='attachment.cleaned'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(cleaned, 0);
}

#[tokio::test]
async fn cleanup_stops_at_watermark_and_respects_lru_and_active_leases() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let mut ids = Vec::new();
    for i in 0..10 {
        ids.push(
            upload(
                &service,
                &fixture.manager,
                &format!("lru-{i}"),
                "temp.bin",
                &[42; 100],
                true,
            )
            .await
            .id,
        );
    }
    let lease = service
        .open_for_read(&fixture.manager, &ids[0], ReadMode::Download)
        .await
        .unwrap();
    for (i, id) in ids.iter().enumerate() {
        let id = id.clone();
        fixture
            .db
            .transaction(move |tx| {
                tx.execute(
                    "UPDATE task_attachments SET created_at=1,last_accessed_at=?1 WHERE id=?2",
                    rusqlite::params![i as i64 + 1, id],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }
    let report = fixture
        .service(1000)
        .cleanup_to_low_watermark()
        .await
        .unwrap();
    assert_eq!(
        (report.temporary_files_cleaned, report.bytes_reclaimed),
        (3, 300)
    );
    let listed = service
        .list_attachments(&fixture.manager, "task")
        .await
        .unwrap();
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(
            listed
                .items
                .iter()
                .find(|item| &item.id == id)
                .unwrap()
                .state,
            if (1..=3).contains(&i) {
                oneloop::files::BlobState::Cleaned
            } else {
                oneloop::files::BlobState::Available
            }
        );
    }
    drop(lease);
}

#[tokio::test]
async fn deleted_parent_discovery_uses_the_small_deleted_task_index() {
    let fixture = Fixture::new().await;
    let plan: Vec<String> = fixture
        .db
        .run(|connection| {
            let mut query = connection.prepare(
                "EXPLAIN QUERY PLAN SELECT b.id,b.storage_key FROM tasks t
             CROSS JOIN task_attachments a ON a.task_id=t.id
             JOIN file_blobs b ON b.id=a.blob_id
             WHERE t.deleted_at IS NOT NULL AND t.deleted_at<=?1 AND b.state='available'",
            )?;
            Ok(query
                .query_map([0], |r| r.get(3))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert!(
        plan.iter().any(|step| step.contains("tasks_deleted_idx")),
        "{plan:?}"
    );
    assert!(
        !plan
            .iter()
            .any(|step| step.contains("file_blobs_cleanup_idx")),
        "{plan:?}"
    );
}

#[tokio::test]
async fn cleanup_crosses_claim_batches_without_recounting_the_library() {
    let fixture = Fixture::new().await;
    let service = fixture.service(1);
    service.store().ensure_directories().await.unwrap();
    // A valid large fixture spans tasks so the 25-attachment product limit holds.
    let mut keys = Vec::new();
    for _ in 0..425 {
        let key = service.store().new_storage_key().unwrap();
        let path = service.store().file_path(&key).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, [42; 100]).unwrap();
        keys.push(key);
    }
    fixture.db.transaction(move |tx| {
        for i in 0..17 {
            tx.execute(
                "INSERT INTO tasks(id,project_id,epic_id,task_number,task_key,title,status,position,created_by,created_at,updated_at)
                 VALUES(?1,'p1','epic',?2,?3,'Storage fixture','planning',?2,'manager',1,1)",
                rusqlite::params![format!("batch-task-{i}"),i+2,format!("PRJ-{:03}",i+2)],
            )?;
        }
        for (i,key) in keys.iter().enumerate() {
            let id = format!("batch-blob-{i}");
            tx.execute(
                "INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                 VALUES(?1,?2,?3,100,'application/octet-stream','available',1)",
                rusqlite::params![id,key,"0".repeat(64)],
            )?;
            tx.execute(
                "INSERT INTO task_attachments(id,project_id,task_id,blob_id,original_name,uploaded_by,is_ephemeral,position,created_at,last_accessed_at,updated_at)
                 VALUES(?1,'p1',?2,?1,'fixture.bin','manager',1,?3,1,1,1)",
                rusqlite::params![id,format!("batch-task-{}",i/25),(i%25) as i64],
            )?;
        }
        Ok(())
    }).await.unwrap();
    let start = std::time::Instant::now();
    let report = service.cleanup_to_low_watermark().await.unwrap();
    eprintln!("425 files cleaned in {:?}", start.elapsed());
    assert_eq!(
        (report.temporary_files_cleaned, report.bytes_reclaimed),
        (425, 42_500)
    );
    let (cleaned, events, jobs): (i64, i64, i64) = fixture
        .db
        .run(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT count(*) FROM file_blobs WHERE state='cleaned'),
                    (SELECT count(*) FROM activity_events WHERE event_type='attachment.cleaned'),
                    (SELECT count(*) FROM file_deletion_jobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!((cleaned, events, jobs), (425, 425, 0));
    fixture.db.transaction(|tx| {
        tx.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_by,created_at,updated_at)
            VALUES('keep-project','Keep project','KEEP','manager',1,1)", [])?;
        // Deliberately span activity timestamps: history must use the run, not seconds.
        tx.execute("UPDATE activity_events SET created_at=created_at + rowid WHERE event_type='attachment.cleaned'", [])?;
        Ok(())
    }).await.unwrap();
    let mut admin = fixture.manager.clone();
    admin.is_admin = true;
    let usage = service.storage_usage(&admin).await.unwrap();
    assert_eq!(usage.recent_cleanup.len(), 1);
    assert_eq!(
        (
            usage.recent_cleanup[0].file_count,
            usage.recent_cleanup[0].bytes
        ),
        (425, 42_500)
    );
    // A no-op pass must not invent another run.
    service.cleanup_to_low_watermark().await.unwrap();
    assert_eq!(
        service
            .storage_usage(&admin)
            .await
            .unwrap()
            .recent_cleanup
            .len(),
        1
    );
    oneloop::domain::DomainService::new(fixture.db.clone(), crate::support::utc())
        .execute(
            &admin,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::DeleteProject,
                payload: serde_json::json!({"projectId":"p1","confirmedName":"Project"}),
                idempotency_key: "delete-cleaned-project".into(),
                expected_revision: Some(1),
            },
        )
        .await
        .unwrap();
    service.reconcile().await.unwrap();
    let remaining: i64 = fixture
        .db
        .run(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM file_blobs WHERE state='cleaned'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    assert_eq!(
        service.storage_usage(&admin).await.unwrap().recent_cleanup[0].file_count,
        425
    );
}

#[tokio::test]
async fn startup_recovers_unexpired_crash_reservations_and_same_key_retry() {
    let fixture = Fixture::new().await;
    let service = fixture.service(1024 * 1024);
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(
            &fixture.manager,
            "task",
            "crash.txt",
            10,
            false,
            "crash-retry",
        )
        .await
        .unwrap()
    else {
        panic!("new upload")
    };
    pending.write_chunk(b"partial").await.unwrap();
    // Save durable rows, then close the live writer cleanly before restoring the
    // exact state a killed process leaves (no destructors are leaked in the test).
    fixture
        .db
        .run(|connection| {
            connection.execute_batch(
                "CREATE TABLE crash_reservation AS SELECT * FROM upload_reservations;
            CREATE TABLE crash_receipt AS SELECT * FROM idempotency_keys;",
            )?;
            Ok(())
        })
        .await
        .unwrap();
    pending.abort().await.unwrap();
    let staging: String = fixture.db.transaction(|tx| {
        tx.execute_batch("INSERT INTO upload_reservations SELECT * FROM crash_reservation;
            DELETE FROM idempotency_keys; INSERT INTO idempotency_keys SELECT * FROM crash_receipt;")?;
        Ok(tx.query_row("SELECT staging_key FROM upload_reservations", [], |r| r.get(0))?)
    }).await.unwrap();
    let path = service.store().staging_path(&staging).unwrap();
    tokio::fs::write(&path, b"partial").await.unwrap();
    let expires: i64 = fixture
        .db
        .run(|connection| {
            Ok(
                connection.query_row("SELECT expires_at FROM upload_reservations", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert!(expires > now() + 3000);
    let _server_guard = fixture.db.layout().try_server_lock().unwrap();
    oneloop::runtime::prepare_files(&service).await.unwrap();
    oneloop::runtime::prepare_files(&service).await.unwrap();
    assert!(!path.exists());
    let (reservations, state): (i64, String) = fixture
        .db
        .run(|connection| {
            Ok((
                connection
                    .query_row("SELECT count(*) FROM upload_reservations", [], |r| r.get(0))?,
                connection.query_row("SELECT state FROM idempotency_keys", [], |r| r.get(0))?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(reservations, 0);
    assert_eq!(state, "failed");
    let value = upload(
        &service,
        &fixture.manager,
        "crash-retry",
        "crash.txt",
        b"0123456789",
        false,
    )
    .await;
    assert_eq!(value.state, oneloop::files::BlobState::Available);
    // Completed uploads and successful receipts survive another startup.
    oneloop::runtime::prepare_files(&service).await.unwrap();
    assert!(matches!(
        service
            .begin_attachment_upload(
                &fixture.manager,
                "task",
                "crash.txt",
                10,
                false,
                "crash-retry"
            )
            .await
            .unwrap(),
        UploadStart::Replayed(_)
    ));
}

#[tokio::test]
async fn high_watermark_admission_does_not_walk_originals() {
    let f = Fixture::new().await;
    let service = f.service(100);
    upload(
        &service,
        &f.manager,
        "permanent",
        "permanent.bin",
        &[0; 85],
        false,
    )
    .await;
    let orphan = f.db.layout().files().join("unreferenced");
    std::fs::write(&orphan, b"orphan").unwrap();
    assert_eq!(
        service
            .cleanup_if_needed()
            .await
            .unwrap()
            .orphan_files_removed,
        0
    );
    let UploadStart::Pending(pending) = service
        .begin_attachment_upload(&f.manager, "task", "next.bin", 1, false, "next")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(
        orphan.exists(),
        "upload admission must not run recovery's full tree walk"
    );
    pending.abort().await.unwrap();
    assert_eq!(service.reconcile().await.unwrap().orphan_files_removed, 1);
}

#[tokio::test]
async fn deletion_backlog_drains_in_multiple_bounded_batches_per_pass() {
    let f = Fixture::new().await;
    let store = oneloop::files::FileStore::new(f.db.layout().clone());
    let mut keys = Vec::new();
    for _ in 0..650 {
        let key = store.new_storage_key().unwrap();
        let path = store.file_path(&key).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
        keys.push(key);
    }
    f.db.transaction(move |tx| {
        for (index,key) in keys.iter().enumerate() {
            tx.execute("INSERT INTO file_blobs(id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                VALUES(?1,?2,?3,1,'application/octet-stream','available',1)",
                rusqlite::params![format!("orphan-{index}"),key,"0".repeat(64)])?;
        }
        Ok(())
    }).await.unwrap();
    let service = f.service(10000);
    let first = service.reconcile().await.unwrap();
    assert!(
        first.deletion_jobs_completed >= 200,
        "at least one complete batch"
    );
    let mut completed = first.deletion_jobs_completed;
    for _ in 0..4 {
        completed += service.reconcile().await.unwrap().deletion_jobs_completed;
    }
    assert_eq!(completed, 650);
    assert_eq!(stored_file_count(&f.db.layout().files()), 0);
}

#[tokio::test]
async fn startup_releases_crashed_reads_and_preserves_backup_leases() {
    let f = Fixture::new().await;
    let service = f.service(1000);
    let file = upload(
        &service,
        &f.manager,
        "crash-read",
        "read.txt",
        b"read",
        false,
    )
    .await;
    let attachment_id = file.id.clone();
    f.db.transaction(move |tx| {
        for (id,kind) in [("dead-read","download"),("backup-pin","backup")] {
            tx.execute("INSERT INTO file_leases(id,blob_id,lease_kind,owner,created_at,expires_at)
                SELECT ?1,blob_id,?2,'owner',unixepoch(),unixepoch()+600 FROM task_attachments WHERE id=?3",
                rusqlite::params![id,kind,attachment_id])?;
        }
        Ok(())
    }).await.unwrap();
    oneloop::runtime::prepare_files(&service).await.unwrap();
    let leases: Vec<String> =
        f.db.run(|c| {
            Ok(c.prepare("SELECT id FROM file_leases")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    assert_eq!(leases, vec!["backup-pin"]);
    f.db.transaction(|tx| {
        tx.execute("DELETE FROM file_leases", [])?;
        Ok(())
    })
    .await
    .unwrap();
    service
        .delete_attachment(&f.manager, &file.id, file.revision, "after-restart")
        .await
        .unwrap();
}

#[tokio::test]
async fn avatar_cleanup_preserves_primary_error_and_startup_recovers_pending_row() {
    let f = Fixture::new().await;
    let service = f.service(1000000);
    f.db.transaction(|tx| {
        tx.execute_batch("CREATE TRIGGER reject_publish BEFORE UPDATE OF state ON file_blobs
            WHEN NEW.state='available' BEGIN SELECT RAISE(ABORT,'original avatar commit failure'); END;
            CREATE TRIGGER reject_cleanup BEFORE DELETE ON file_blobs
            BEGIN SELECT RAISE(ABORT,'secondary cleanup failure'); END;")?; Ok(())
    }).await.unwrap();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let error = service.upload_avatar(&f.manager, png).await.unwrap_err();
    assert!(
        error.to_string().contains("original avatar commit failure"),
        "{error}"
    );
    assert_eq!(stored_file_count(&f.db.layout().files()), 0);
    f.db.transaction(|tx| {
        tx.execute_batch("DROP TRIGGER reject_publish; DROP TRIGGER reject_cleanup;")?;
        Ok(())
    })
    .await
    .unwrap();
    oneloop::runtime::prepare_files(&service).await.unwrap();
    let rows: i64 =
        f.db.run(|c| Ok(c.query_row("SELECT count(*) FROM file_blobs", [], |r| r.get(0))?))
            .await
            .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn capacity_queries_use_covering_index() {
    let f = Fixture::new().await;
    let plan: Vec<String> = f.db.run(|c| Ok(c.prepare(
        "EXPLAIN QUERY PLAN SELECT coalesce(sum(size_bytes),0) FROM file_blobs WHERE state IN ('pending','available','deleting')")?
        .query_map([],|r|r.get(3))?.collect::<Result<_,_>>()?)).await.unwrap();
    assert!(
        plan.iter()
            .any(|line| line.contains("COVERING INDEX file_blobs_state_size_idx")),
        "{plan:?}"
    );
}

#[tokio::test]
async fn storage_accounts_for_pending_deletion_separately() {
    let f = Fixture::new().await;
    let service = f.service(1000);
    upload(
        &service,
        &f.manager,
        "pending-usage",
        "pending.bin",
        b"pending",
        false,
    )
    .await;
    f.db.transaction(|tx| {
        tx.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
        tx.execute("UPDATE file_blobs SET state='deleting'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let mut admin = f.manager.clone();
    admin.is_admin = true;
    let usage = service.storage_usage(&admin).await.unwrap();
    assert_eq!(usage.used_bytes, 7);
    assert_eq!(usage.pending_deletion_bytes, 7);
    assert_eq!(usage.permanent_bytes, 0);
    assert_eq!(usage.temporary_bytes, 0);
}

#[tokio::test]
async fn the_files_of_a_deleted_task_count_as_pending_deletion_at_once() {
    let f = Fixture::new().await;
    let service = f.service(1000);
    upload(
        &service,
        &f.manager,
        "kept-usage",
        "kept.bin",
        b"kept",
        false,
    )
    .await;
    upload(
        &service,
        &f.manager,
        "temporary-usage",
        "temporary.bin",
        b"temporary",
        true,
    )
    .await;
    f.db.run(|connection| {
        connection.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let mut admin = f.manager.clone();
    admin.is_admin = true;
    let domain = oneloop::domain::DomainService::new(f.db.clone(), crate::support::utc());
    domain
        .execute(
            &admin,
            oneloop::domain::CommandEnvelope {
                operation: oneloop::domain::DomainOperation::DeleteTask,
                payload: serde_json::json!({"id":"task"}),
                idempotency_key: "delete-usage-parent".into(),
                expected_revision: Some(1),
            },
        )
        .await
        .unwrap();
    let usage = service.storage_usage(&admin).await.unwrap();
    assert_eq!(
        (
            usage.permanent_bytes,
            usage.temporary_bytes,
            usage.pending_deletion_bytes
        ),
        (0, 0, 13)
    );
}

#[tokio::test]
async fn oversized_chunk_is_rejected_without_changing_the_upload() {
    let f = Fixture::new().await;
    let service = f.service(1000000);
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(&f.manager, "task", "size.bin", 4, false, "chunk-limit")
        .await
        .unwrap()
    else {
        panic!()
    };
    pending.write_chunk(b"ab").await.unwrap();
    assert!(matches!(
        pending.write_chunk(b"cde").await,
        Err(AppError::Validation { .. })
    ));
    pending.write_chunk(b"cd").await.unwrap();
    let file = pending.finish().await.unwrap();
    assert_eq!(file.size, 4);
    let mut read = service
        .open_for_read(&f.manager, &file.id, ReadMode::Download)
        .await
        .unwrap();
    let mut body = Vec::new();
    read.file.read_to_end(&mut body).await.unwrap();
    assert_eq!(body, b"abcd");
}

#[tokio::test]
async fn concurrent_upload_reservations_protect_the_disk_floor() {
    let f = Fixture::new().await;
    let ordinary = f.service(100 * 1024 * 1024);
    ordinary.store().ensure_directories().await.unwrap();
    let free = fs4::available_space(f.db.layout().root()).unwrap();
    let service = FileService::new(
        f.db.clone(),
        100 * 1024 * 1024,
        free.saturating_sub(35 * 1024 * 1024),
    );
    let size = oneloop::files::MAX_ATTACHMENT_BYTES;
    let (a, b) = tokio::join!(
        service.begin_attachment_upload(&f.manager, "task", "a.bin", size, false, "floor-a"),
        service.begin_attachment_upload(&f.manager, "task", "b.bin", size, false, "floor-b"),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    for result in [a, b] {
        match result {
            Ok(UploadStart::Pending(upload)) => upload.abort().await.unwrap(),
            Err(AppError::Rule {
                kind: oneloop::error::RuleKind::StorageFull,
                ..
            }) => {}
            _ => panic!("unexpected reservation outcome"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "local 25 MiB download measurement with four CPU workers"]
async fn download_buffer_measurement_under_cpu_load() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio_stream::StreamExt;
    struct CpuLoad {
        stop: Arc<AtomicBool>,
        workers: Vec<std::thread::JoinHandle<()>>,
    }
    impl Drop for CpuLoad {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            for worker in self.workers.drain(..) {
                worker.join().unwrap();
            }
        }
    }
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let size = oneloop::files::MAX_ATTACHMENT_BYTES;
    let UploadStart::Pending(mut pending) = service
        .begin_attachment_upload(
            &f.manager,
            "task",
            "bench.bin",
            size,
            false,
            "buffer-measurement",
        )
        .await
        .unwrap()
    else {
        panic!()
    };
    pending
        .write_chunk(&vec![0x5a; size as usize])
        .await
        .unwrap();
    let file = pending.finish().await.unwrap();
    let mut load = CpuLoad {
        stop: Arc::new(AtomicBool::new(false)),
        workers: Vec::new(),
    };
    for _ in 0..4 {
        let stop = load.stop.clone();
        load.workers.push(std::thread::spawn(move || {
            let mut value = 1_u64;
            while !stop.load(Ordering::Relaxed) {
                for _ in 0..1000 {
                    value = std::hint::black_box(
                        value.wrapping_mul(6364136223846793005).wrapping_add(1),
                    );
                }
            }
        }));
    }
    for sample in 1..=3 {
        for capacity in [4096, 65536] {
            let read = service
                .open_for_read(&f.manager, &file.id, ReadMode::Download)
                .await
                .unwrap();
            let mut stream = tokio_util::io::ReaderStream::with_capacity(read.file, capacity);
            let start = std::time::Instant::now();
            let (mut total, mut chunks) = (0_u64, 0);
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.unwrap();
                assert_eq!(chunk[0], 0x5a);
                total += chunk.len() as u64;
                chunks += 1;
            }
            assert_eq!(total, size);
            eprintln!(
                "sample={sample} capacity={capacity} chunks={chunks} elapsed_ms={:.2}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}

fn restore(key: &str, expected_revision: i64) -> AttachmentRestore {
    AttachmentRestore {
        expected_revision,
        idempotency_key: key.into(),
    }
}

async fn listed_names(service: &FileService, actor: &oneloop::auth::Actor) -> Vec<String> {
    service
        .list_attachments(actor, "task")
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.name)
        .collect()
}

#[tokio::test]
async fn undo_brings_a_deleted_attachment_back_with_its_bytes() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let first = upload(&service, &f.manager, "first", "first.txt", b"first", false).await;
    upload(
        &service,
        &f.manager,
        "second",
        "second.txt",
        b"second",
        false,
    )
    .await;
    service
        .delete_attachment(&f.manager, &first.id, first.revision, "delete-first")
        .await
        .unwrap();
    assert_eq!(listed_names(&service, &f.viewer).await, ["second.txt"]);
    assert!(matches!(
        service
            .open_for_read(&f.viewer, &first.id, ReadMode::Download)
            .await,
        Err(AppError::NotFound { .. })
    ));
    assert!(matches!(
        service
            .set_ephemeral(
                &f.manager,
                &first.id,
                AttachmentPatch {
                    is_ephemeral: true,
                    expected_revision: first.revision + 1
                }
            )
            .await,
        Err(AppError::NotFound { .. })
    ));

    let restored = service
        .restore_attachment(
            &f.manager,
            &first.id,
            restore("undo-first", first.revision + 1),
        )
        .await
        .unwrap();
    assert_eq!(restored.revision, first.revision + 2);
    assert_eq!(restored.state, oneloop::files::BlobState::Available);
    let replayed = service
        .restore_attachment(
            &f.manager,
            &first.id,
            restore("undo-first", first.revision + 1),
        )
        .await
        .unwrap();
    assert_eq!(replayed, restored);
    assert_eq!(
        listed_names(&service, &f.viewer).await,
        ["first.txt", "second.txt"]
    );
    let mut read = service
        .open_for_read(&f.viewer, &first.id, ReadMode::Download)
        .await
        .unwrap();
    let mut bytes = Vec::new();
    read.file.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"first");

    let id = first.id.clone();
    let history: Vec<(String, Option<String>)> = f
        .db
        .run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT event_type,actor_user_id FROM activity_events WHERE entity_id=?1 ORDER BY created_at,id",
            )?;
            Ok(statement
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    let manager = Some("manager".to_owned());
    assert_eq!(
        history,
        [
            ("attachment.created".to_owned(), manager.clone()),
            ("attachment.deleted".to_owned(), manager.clone()),
            ("attachment.restored".to_owned(), manager),
        ]
    );
}

#[tokio::test]
async fn only_people_who_could_delete_an_attachment_restore_it_in_time() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let file = upload(&service, &f.manager, "kept", "kept.txt", b"kept", false).await;
    assert!(matches!(
        service
            .restore_attachment(&f.manager, &file.id, restore("live", file.revision))
            .await,
        Err(AppError::Conflict(_))
    ));
    service
        .delete_attachment(&f.manager, &file.id, file.revision, "delete-kept")
        .await
        .unwrap();
    let deleted = file.revision + 1;
    assert!(matches!(
        service
            .restore_attachment(&f.viewer, &file.id, restore("viewer", deleted))
            .await,
        Err(AppError::Forbidden)
    ));
    assert!(matches!(
        service
            .restore_attachment(&f.outsider, &file.id, restore("outsider", deleted))
            .await,
        Err(AppError::NotFound { .. })
    ));
    assert!(matches!(
        service
            .restore_attachment(&f.manager, &file.id, restore("stale", file.revision))
            .await,
        Err(AppError::RevisionConflict { .. })
    ));
    end_undo_window(&f.db).await;
    let late = service
        .restore_attachment(&f.manager, &file.id, restore("late", deleted))
        .await;
    assert!(
        matches!(&late, Err(AppError::PreconditionFailed(message)) if message.contains("5 minutes")),
        "{late:?}"
    );
}

#[tokio::test]
async fn an_attachment_already_being_removed_cannot_be_restored() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let file = upload(&service, &f.manager, "going", "going.txt", b"going", false).await;
    service
        .delete_attachment(&f.manager, &file.id, file.revision, "delete-going")
        .await
        .unwrap();
    // The purge claimed the bytes, as after the clock stepped back.
    let id = file.id.clone();
    f.db.run(move |connection| {
        connection.execute(
            "UPDATE file_blobs SET state='deleting'
             WHERE id=(SELECT blob_id FROM task_attachments WHERE id=?1)",
            [id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let restored = service
        .restore_attachment(
            &f.manager,
            &file.id,
            restore("undo-going", file.revision + 1),
        )
        .await;
    assert!(
        matches!(&restored, Err(AppError::Conflict(message)) if message.contains("being removed")),
        "{restored:?}"
    );
}

#[tokio::test]
async fn a_task_whose_files_are_already_being_removed_stays_deleted() {
    let fixture = Fixture::new().await;
    let service = fixture.service(100 * 1024 * 1024);
    let file = upload(
        &service,
        &fixture.manager,
        "claimed-parent",
        "notes.txt",
        b"notes",
        false,
    )
    .await;
    let domain = oneloop::domain::DomainService::new(fixture.db.clone(), crate::support::utc());
    let envelope = |operation, key: &str, revision| oneloop::domain::CommandEnvelope {
        operation,
        payload: serde_json::json!({"id":"task"}),
        idempotency_key: key.into(),
        expected_revision: Some(revision),
    };
    domain
        .execute(
            &fixture.manager,
            envelope(
                oneloop::domain::DomainOperation::DeleteTask,
                "delete-claimed",
                1,
            ),
        )
        .await
        .unwrap();
    // A deletion job for its file is pending, as one from before an upgrade
    // or after the clock stepped back would be.
    let id = file.id.clone();
    fixture
        .db
        .run(move |connection| {
            connection.execute(
                "UPDATE file_blobs SET state='deleting'
                 WHERE id=(SELECT blob_id FROM task_attachments WHERE id=?1)",
                [&id],
            )?;
            connection.execute(
                "INSERT INTO file_deletion_jobs(id,blob_id,storage_key,reason,scheduled_at,available_at)
                 SELECT 'claimed-job',b.id,b.storage_key,'manual',unixepoch(),unixepoch()
                 FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id WHERE a.id=?1",
                [&id],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let restored = domain
        .execute(
            &fixture.manager,
            envelope(
                oneloop::domain::DomainOperation::RestoreTask,
                "restore-claimed",
                2,
            ),
        )
        .await;
    assert!(
        matches!(&restored, Err(AppError::Conflict(message)) if message.contains("being removed")),
        "{restored:?}"
    );
    // The job then finishes with the task still deleted.
    assert_eq!(
        service.reconcile().await.unwrap().deletion_jobs_completed,
        1
    );
}

#[tokio::test]
async fn a_deleted_attachment_frees_its_slot_until_it_is_restored() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let mut files = Vec::new();
    for index in 0..25 {
        let name = format!("file-{index}.txt");
        files.push(upload(&service, &f.manager, &name, &name, b"x", false).await);
    }
    service
        .delete_attachment(&f.manager, &files[0].id, files[0].revision, "free-slot")
        .await
        .unwrap();
    upload(&service, &f.manager, "replacement", "new.txt", b"y", false).await;
    let full = service
        .restore_attachment(
            &f.manager,
            &files[0].id,
            restore("full", files[0].revision + 1),
        )
        .await;
    assert!(
        matches!(&full, Err(AppError::Conflict(message)) if message.contains("25")),
        "{full:?}"
    );
}

#[tokio::test]
async fn a_restored_attachment_keeps_its_place_unless_the_files_were_reordered() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let mut files = Vec::new();
    for name in ["a.txt", "b.txt", "c.txt"] {
        files.push(upload(&service, &f.manager, name, name, name.as_bytes(), false).await);
    }
    let (a, b, c) = (&files[0], &files[1], &files[2]);
    service
        .delete_attachment(&f.manager, &b.id, b.revision, "delete-b")
        .await
        .unwrap();
    let b = service
        .restore_attachment(&f.manager, &b.id, restore("restore-b", b.revision + 1))
        .await
        .unwrap();
    assert_eq!(
        listed_names(&service, &f.viewer).await,
        ["a.txt", "b.txt", "c.txt"]
    );

    service
        .delete_attachment(&f.manager, &b.id, b.revision, "delete-b-again")
        .await
        .unwrap();
    service
        .reorder(
            &f.manager,
            "task",
            AttachmentReorder {
                attachment_id: c.id.clone(),
                target_id: a.id.clone(),
                after: false,
                expected_revision: c.revision,
                idempotency_key: "c-first".into(),
            },
        )
        .await
        .unwrap();
    service
        .restore_attachment(
            &f.manager,
            &b.id,
            restore("restore-b-again", b.revision + 1),
        )
        .await
        .unwrap();
    assert_eq!(
        listed_names(&service, &f.viewer).await,
        ["c.txt", "a.txt", "b.txt"]
    );
}

#[tokio::test]
async fn deleted_attachments_wait_out_the_undo_window_across_restarts() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let kept = upload(&service, &f.manager, "kept", "kept.txt", b"kept", false).await;
    let purged = upload(
        &service,
        &f.manager,
        "purged",
        "purged.txt",
        b"purged",
        false,
    )
    .await;
    for (file, key) in [(&kept, "delete-kept"), (&purged, "delete-purged")] {
        service
            .delete_attachment(&f.manager, &file.id, file.revision, key)
            .await
            .unwrap();
    }
    // A restart reconciles before it serves, and keeps both for Undo.
    let restarted = f.service(100 * 1024 * 1024);
    oneloop::runtime::prepare_files(&restarted).await.unwrap();
    assert_eq!(stored_file_count(&f.db.layout().files()), 2);
    restarted
        .restore_attachment(
            &f.manager,
            &kept.id,
            restore("undo-kept", kept.revision + 1),
        )
        .await
        .unwrap();

    end_undo_window(&f.db).await;
    let restarted = f.service(100 * 1024 * 1024);
    oneloop::runtime::prepare_files(&restarted).await.unwrap();
    assert_eq!(listed_names(&restarted, &f.viewer).await, ["kept.txt"]);
    assert_eq!(stored_file_count(&f.db.layout().files()), 1);
    let id = purged.id.clone();
    let remaining: i64 =
        f.db.run(move |connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM task_attachments WHERE id=?1",
                [id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    assert!(matches!(
        restarted
            .restore_attachment(
                &f.manager,
                &purged.id,
                restore("too-late", purged.revision + 1)
            )
            .await,
        Err(AppError::NotFound { .. })
    ));
}

#[tokio::test]
async fn deleted_files_wait_for_removal_instead_of_temporary_file_cleanup() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    let temporary = upload(
        &service,
        &f.manager,
        "temporary",
        "old.tmp",
        b"temporary",
        true,
    )
    .await;
    f.db.run(|connection| {
        connection.execute(
            "UPDATE task_attachments SET created_at=1,last_accessed_at=1",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    service
        .delete_attachment(
            &f.manager,
            &temporary.id,
            temporary.revision,
            "delete-temporary",
        )
        .await
        .unwrap();
    let admin = {
        let mut admin = f.manager.clone();
        admin.is_admin = true;
        admin
    };
    f.db.run(|connection| {
        connection.execute("UPDATE users SET is_admin=1 WHERE id='manager'", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let usage = service.storage_usage(&admin).await.unwrap();
    assert_eq!(
        (usage.temporary_bytes, usage.pending_deletion_bytes),
        (0, temporary.size)
    );
    let report = f.service(1).cleanup_to_low_watermark().await.unwrap();
    assert_eq!(report.temporary_files_cleaned, 0);
    let restored = service
        .restore_attachment(
            &f.manager,
            &temporary.id,
            restore("undo-temporary", temporary.revision + 1),
        )
        .await
        .unwrap();
    assert_eq!(restored.state, oneloop::files::BlobState::Available);
    let usage = service.storage_usage(&admin).await.unwrap();
    assert_eq!(
        (usage.temporary_bytes, usage.pending_deletion_bytes),
        (temporary.size, 0)
    );
}

#[tokio::test]
async fn a_deleted_cleaned_attachment_is_restorable_and_then_forgotten() {
    let f = Fixture::new().await;
    let service = f.service(100 * 1024 * 1024);
    upload(
        &service,
        &f.manager,
        "cleaned",
        "cleaned.tmp",
        b"cleaned",
        true,
    )
    .await;
    f.db.run(|connection| {
        connection.execute(
            "UPDATE task_attachments SET created_at=1,last_accessed_at=1",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    f.service(1).cleanup_to_low_watermark().await.unwrap();
    let cleaned = service
        .list_attachments(&f.manager, "task")
        .await
        .unwrap()
        .items
        .remove(0);
    assert_eq!(cleaned.state, oneloop::files::BlobState::Cleaned);
    service
        .delete_attachment(&f.manager, &cleaned.id, cleaned.revision, "delete-cleaned")
        .await
        .unwrap();
    let restored = service
        .restore_attachment(
            &f.manager,
            &cleaned.id,
            restore("undo-cleaned", cleaned.revision + 1),
        )
        .await
        .unwrap();
    assert_eq!(restored.state, oneloop::files::BlobState::Cleaned);
    service
        .delete_attachment(
            &f.manager,
            &cleaned.id,
            restored.revision,
            "delete-cleaned-again",
        )
        .await
        .unwrap();
    end_undo_window(&f.db).await;
    service.reconcile().await.unwrap();
    let rows: (i64, i64) =
        f.db.run(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT count(*) FROM task_attachments),(SELECT count(*) FROM file_blobs)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(rows, (0, 0));
}
