//! Attachment metadata: the list, retention, order, deletion and Undo.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    ATTACHMENT_COLUMNS, DeleteActivityContext, FileService, attachment_by_id,
    record_attachment_deletion, require_file_access, require_free_slot, require_revision,
    stored_file_row, task_id_or_key, task_project,
};
use crate::{
    AppError, AppResult,
    auth::Actor,
    clock::unix_now,
    collaboration::{ActivityInput, record_activity_tx},
    files::{
        AttachmentList, AttachmentPatch, AttachmentReorder, AttachmentRestore, AttachmentView,
        BlobState, StoredFile,
    },
    idempotency::{Envelope, Resource},
};

impl FileService {
    /// The files of the task that `task` names by its ID or key.
    pub async fn list_attachments(&self, actor: &Actor, task: &str) -> AppResult<AttachmentList> {
        let actor = actor.clone();
        let task = task.to_owned();
        let items = self
            .db
            .run(move |connection| {
                let task_id = task_id_or_key(connection, &task)?;
                let project_id = task_project(connection, &task_id)?;
                require_file_access(connection, &actor, &project_id, false, false)?;
                attachment_views(connection, &task_id)
            })
            .await?;
        Ok(AttachmentList { items })
    }

    /// An attachment the person may read. A connection without the
    /// attachments permission is refused before the attachment is looked up.
    pub(crate) async fn attachment(
        &self,
        actor: &Actor,
        attachment_id: &str,
    ) -> AppResult<AttachmentView> {
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .run(move |connection| {
                crate::access::require_scope(connection, &actor, "attachments", None)?;
                let attachment = attachment_by_id(connection, &attachment_id)?.attachment;
                require_file_access(connection, &actor, &attachment.project_id, false, false)?;
                Ok(attachment)
            })
            .await
    }

    pub async fn set_ephemeral(
        &self,
        actor: &Actor,
        attachment_id: &str,
        patch: AttachmentPatch,
    ) -> AppResult<AttachmentView> {
        require_revision(patch.expected_revision)?;
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                let stored = attachment_by_id(tx, &attachment_id)?;
                require_file_access(tx, &actor, &stored.attachment.project_id, true, false)?;
                // Already set: a retry of an applied change succeeds, while a
                // stale request for the other value still conflicts below.
                if stored.attachment.is_ephemeral == patch.is_ephemeral {
                    return Ok(stored.attachment);
                }
                if stored.attachment.state != BlobState::Available {
                    return Err(AppError::Conflict(
                        "cleaned attachments cannot change retention".into(),
                    ));
                }
                if stored.attachment.revision != patch.expected_revision {
                    return Err(AppError::revision(
                        patch.expected_revision,
                        stored.attachment.revision,
                    ));
                }
                let revision = patch.expected_revision + 1;
                tx.execute(
                    "UPDATE task_attachments SET is_ephemeral=?1,updated_at=?2,revision=?3
                     WHERE id=?4 AND revision=?5",
                    params![
                        patch.is_ephemeral,
                        now,
                        revision,
                        attachment_id,
                        patch.expected_revision
                    ],
                )?;
                record_activity_tx(
                    tx,
                    &actor,
                    ActivityInput {
                        project_id: Some(&stored.attachment.project_id),
                        entity_type: "attachment",
                        entity_id: &attachment_id,
                        task_id: Some(&stored.attachment.task_id),
                        event_type: "attachment.retention.updated",
                        field_key: Some("retention"),
                        before: Some(json!(stored.attachment.is_ephemeral)),
                        after: Some(json!(patch.is_ephemeral)),
                        metadata: json!({"name": stored.attachment.name}),
                        entity_revision: Some(revision),
                    },
                    now,
                )?;
                Ok(attachment_by_id(tx, &attachment_id)?.attachment)
            })
            .await
    }

    /// Moves a file of the task that `task` names by its ID or key.
    pub async fn reorder(
        &self,
        actor: &Actor,
        task: &str,
        input: AttachmentReorder,
    ) -> AppResult<AttachmentList> {
        let envelope = Envelope::request(
            "attachment.reorder",
            &input.idempotency_key,
            &json!({
                "taskId": task,
                "attachmentId": input.attachment_id,
                "targetId": input.target_id,
                "after": input.after,
                "expectedRevision": input.expected_revision,
            }),
        )?;
        require_revision(input.expected_revision)?;
        let actor = actor.clone();
        let task = task.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                let task_id = task_id_or_key(tx, &task)?;
                let project_id = task_project(tx, &task_id)?;
                require_file_access(tx, &actor, &project_id, true, false)?;
                envelope.once(
                    tx,
                    &actor,
                    now,
                    |_, _| Ok(()),
                    |actor| {
                        let resource = Resource {
                            kind: "attachment",
                            id: Some(input.attachment_id.clone()),
                            project_id: Some(project_id.clone()),
                        };
                        let mut current = attachment_views(tx, &task_id)?;
                        let previous_positions = current
                            .iter()
                            .map(|item| (item.id.clone(), (item.position, item.revision)))
                            .collect::<HashMap<_, _>>();
                        let moving = current
                            .iter()
                            .position(|item| item.id == input.attachment_id)
                            .ok_or(AppError::NotFound {
                                resource: "attachment",
                            })?;
                        if current[moving].revision != input.expected_revision {
                            return Err(AppError::revision(
                                input.expected_revision,
                                current[moving].revision,
                            ));
                        }
                        if input.attachment_id == input.target_id {
                            return Ok((AttachmentList { items: current }, resource));
                        }
                        let item = current.remove(moving);
                        let target = current
                            .iter()
                            .position(|entry| entry.id == input.target_id)
                            .ok_or(AppError::NotFound {
                                resource: "attachment",
                            })?;
                        current.insert(target + usize::from(input.after), item);
                        let before = attachment_views(tx, &task_id)?
                            .into_iter()
                            .map(|item| item.id)
                            .collect::<Vec<_>>();
                        let after = current
                            .iter()
                            .map(|item| item.id.clone())
                            .collect::<Vec<_>>();
                        if before == after {
                            return Ok((AttachmentList { items: current }, resource));
                        }
                        // Every file of the task, deleted ones too, first moves to a
                        // negative position, so a new position never meets an old one.
                        tx.execute(
                            "UPDATE task_attachments SET position=-position-1 WHERE task_id=?1",
                            [&task_id],
                        )?;
                        for (position, item) in current.iter().enumerate() {
                            let (old_position, old_revision) =
                                previous_positions.get(&item.id).copied().ok_or_else(|| {
                                    AppError::internal("attachment order changed unexpectedly")
                                })?;
                            let revision =
                                old_revision + i64::from(old_position != position as i64);
                            tx.execute(
                                "UPDATE task_attachments SET position=?1,updated_at=?2,revision=?3
                             WHERE id=?4",
                                params![position as i64, now, revision, item.id],
                            )?;
                        }
                        // Deleted files follow in their order, so Undo puts one after
                        // the others. Their revisions stay, so Undo still applies.
                        let deleted = tx
                            .prepare(
                                "SELECT id FROM task_attachments
                             WHERE task_id=?1 AND deleted_at IS NOT NULL ORDER BY position DESC",
                            )?
                            .query_map([&task_id], |row| row.get::<_, String>(0))?
                            .collect::<Result<Vec<_>, _>>()?;
                        for (offset, id) in deleted.iter().enumerate() {
                            tx.execute(
                                "UPDATE task_attachments SET position=?1 WHERE id=?2",
                                params![(current.len() + offset) as i64, id],
                            )?;
                        }
                        record_activity_tx(
                            tx,
                            actor,
                            ActivityInput {
                                project_id: Some(&project_id),
                                entity_type: "task",
                                entity_id: &task_id,
                                task_id: Some(&task_id),
                                event_type: "attachment.reordered",
                                field_key: Some("attachment-order"),
                                before: Some(json!(before)),
                                after: Some(json!(after)),
                                metadata: json!({}),
                                entity_revision: None,
                            },
                            now,
                        )?;
                        let items = attachment_views(tx, &task_id)?;
                        Ok((AttachmentList { items }, resource))
                    },
                )
            })
            .await
    }

    /// Deletes an attachment for the Undo window: reads hide it at once, and
    /// file maintenance removes its bytes and metadata after the window.
    pub async fn delete_attachment(
        &self,
        actor: &Actor,
        attachment_id: &str,
        expected_revision: i64,
        idempotency_key: &str,
    ) -> AppResult<()> {
        let envelope = Envelope::request(
            "attachment.delete",
            idempotency_key,
            &json!({"attachmentId": attachment_id, "expectedRevision": expected_revision}),
        )?;
        require_revision(expected_revision)?;
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.once(
                    tx,
                    &actor,
                    now,
                    |actor, deleted: &mut DeletedAttachment| {
                        require_file_access(tx, actor, &deleted.project_id, false, true)
                    },
                    |actor| {
                        let stored = attachment_by_id(tx, &attachment_id)?.attachment;
                        require_file_access(tx, actor, &stored.project_id, true, true)?;
                        if stored.revision != expected_revision {
                            return Err(AppError::revision(expected_revision, stored.revision));
                        }
                        if stored.state == BlobState::Deleting {
                            // Cleanup, or a deletion from before Undo, is removing the bytes.
                            return Err(AppError::Conflict(
                                "the attachment is being removed; try again shortly".into(),
                            ));
                        }
                        tx.execute(
                            "UPDATE task_attachments SET deleted_at=?1,updated_at=?1,revision=revision+1
                             WHERE id=?2 AND revision=?3 AND deleted_at IS NULL",
                            params![now, attachment_id, expected_revision],
                        )?;
                        record_attachment_deletion(
                            tx,
                            &DeleteActivityContext {
                                id: attachment_id.clone(),
                                project_id: Some(stored.project_id.clone()),
                                task_id: Some(stored.task_id.clone()),
                                name: stored.name,
                            },
                            Some(actor),
                            now,
                        )?;
                        let resource = Resource {
                            kind: "attachment",
                            id: Some(attachment_id.clone()),
                            project_id: Some(stored.project_id.clone()),
                        };
                        let deleted = DeletedAttachment {
                            project_id: stored.project_id,
                            task_id: stored.task_id,
                        };
                        Ok((deleted, resource))
                    },
                )?;
                Ok(())
            })
            .await
    }

    /// Undoes a deletion within the Undo window, for the people who could
    /// delete the attachment. It returns to its place unless the files were
    /// reordered since.
    pub async fn restore_attachment(
        &self,
        actor: &Actor,
        attachment_id: &str,
        input: AttachmentRestore,
    ) -> AppResult<AttachmentView> {
        let envelope = Envelope::request(
            "attachment.restore",
            &input.idempotency_key,
            &json!({"attachmentId": attachment_id, "expectedRevision": input.expected_revision}),
        )?;
        require_revision(input.expected_revision)?;
        let actor = actor.clone();
        let attachment_id = attachment_id.to_owned();
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                envelope.once(
                    tx,
                    &actor,
                    now,
                    |actor, view: &mut AttachmentView| {
                        require_file_access(tx, actor, &view.project_id, false, true)
                    },
                    |actor| {
                        let (stored, deleted_at) = attachment_with_deletion(tx, &attachment_id)?;
                        let stored = stored.attachment;
                        require_file_access(tx, actor, &stored.project_id, true, true)?;
                        let Some(deleted_at) = deleted_at else {
                            return Err(AppError::Conflict("the attachment is not deleted".into()));
                        };
                        if stored.revision != input.expected_revision {
                            return Err(AppError::revision(
                                input.expected_revision,
                                stored.revision,
                            ));
                        }
                        crate::domain::require_undo_window("attachment", deleted_at, now)?;
                        if stored.state == BlobState::Deleting {
                            return Err(AppError::Conflict(
                                "the attachment is being removed and can no longer be restored"
                                    .into(),
                            ));
                        }
                        if stored.state == BlobState::Available {
                            require_free_slot(tx, &stored.task_id, now)?;
                        }
                        let revision = input.expected_revision + 1;
                        tx.execute(
                            "UPDATE task_attachments SET deleted_at=NULL,updated_at=?1,revision=?2
                             WHERE id=?3 AND revision=?4 AND deleted_at IS NOT NULL",
                            params![now, revision, attachment_id, input.expected_revision],
                        )?;
                        record_activity_tx(
                            tx,
                            actor,
                            ActivityInput {
                                project_id: Some(&stored.project_id),
                                entity_type: "attachment",
                                entity_id: &attachment_id,
                                task_id: Some(&stored.task_id),
                                event_type: "attachment.restored",
                                field_key: None,
                                before: None,
                                after: Some(json!({"name": stored.name})),
                                metadata: json!({"name": stored.name}),
                                entity_revision: Some(revision),
                            },
                            now,
                        )?;
                        let view = attachment_by_id(tx, &attachment_id)?.attachment;
                        let resource = Resource {
                            kind: "attachment",
                            id: Some(attachment_id.clone()),
                            project_id: Some(view.project_id.clone()),
                        };
                        Ok((view, resource))
                    },
                )
            })
            .await
    }
}

/// What a deletion's receipt keeps, so a retry rechecks access to the right
/// project.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletedAttachment {
    project_id: String,
    task_id: String,
}

/// An attachment of a task that isn't deleted, with when it was deleted, if
/// it was.
fn attachment_with_deletion(
    connection: &rusqlite::Connection,
    id: &str,
) -> AppResult<(StoredFile, Option<i64>)> {
    connection
        .query_row(
            &format!(
                "SELECT {ATTACHMENT_COLUMNS},a.deleted_at FROM task_attachments a
                 JOIN file_blobs b ON b.id=a.blob_id JOIN tasks t ON t.id=a.task_id
                 WHERE a.id=?1 AND t.deleted_at IS NULL"
            ),
            [id],
            |row| Ok((stored_file_row(row)?, row.get(16)?)),
        )
        .optional()?
        .ok_or(AppError::NotFound {
            resource: "attachment",
        })
}

fn attachment_views(
    connection: &rusqlite::Connection,
    task_id: &str,
) -> AppResult<Vec<AttachmentView>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {ATTACHMENT_COLUMNS} FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
         WHERE a.task_id=?1 AND a.deleted_at IS NULL ORDER BY a.position,a.id"
    ))?;
    Ok(statement
        .query_map([task_id], stored_file_row)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|x| x.attachment)
        .collect())
}
