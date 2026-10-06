//! Upload admission and durable reservations; streaming never holds a database write transaction.
use super::*;

impl FileService {
    pub async fn begin_attachment_upload(
        &self,
        actor: &Actor,
        task_id: &str,
        original_name: &str,
        claimed_size: u64,
        is_ephemeral: bool,
        idempotency_key: &str,
    ) -> AppResult<UploadStart> {
        actor.require_ready()?;
        validate_original_name(original_name)?;
        validate_idempotency_key(idempotency_key)?;
        if claimed_size == 0 || claimed_size > MAX_ATTACHMENT_BYTES {
            return Err(AppError::validation(
                "file",
                format!(
                    "must contain 1 byte to {} MiB",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                ),
            ));
        }
        let request_hash = upload_request_hash(task_id, original_name, claimed_size, is_ephemeral);
        let replay_task = task_id.to_owned();
        let replay_key = idempotency_key.to_owned();
        let replay_actor = actor.clone();
        let replay_hash = request_hash.clone();
        if let Some(existing) = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let project_id = task_project(tx, &replay_task)?;
                require_file_access_tx(tx, &replay_actor, &project_id, true, false, now)?;
                idempotency_replay(
                    tx,
                    &replay_actor,
                    &replay_key,
                    "attachment.upload",
                    &replay_hash,
                )
            })
            .await?
        {
            return Ok(UploadStart::Replayed(Box::new(existing)));
        }

        self.store.ensure_directories().await?;
        let mut capacity = self.prepare_capacity().await?;
        let deficit = self.disk.deficit(claimed_size)?;
        if deficit > 0 && self.cleanup_for_deficit(deficit).await?.bytes_reclaimed > 0 {
            capacity = self.capacity_usage().await?;
        }

        let non_database_bytes = capacity.non_database_bytes();
        let reservation_id = Uuid::now_v7().to_string();
        let idempotency_id = Uuid::now_v7().to_string();
        let staging_key = self.store.new_staging_key()?;
        let storage_key = self.store.new_storage_key()?;
        let staging_path = self.store.staging_path(&staging_key)?;
        let task_id_owned = task_id.to_owned();
        let pending_task_id = task_id.to_owned();
        let pending_original_name = original_name.to_owned();
        let key_owned = idempotency_key.to_owned();
        let actor_owned = actor.clone();
        let reservation_id_tx = reservation_id.clone();
        let idempotency_id_tx = idempotency_id.clone();
        let staging_key_tx = staging_key.clone();
        let limit = self.storage_limit_bytes;

        let service = self.clone();
        let pending_actor = actor.clone();
        let reservation_task = tokio::spawn(async move {
            let _maintenance_gate = service.acquire_file_maintenance_gate().await?;
            let disk = service.disk.reserve(claimed_size)?;
            disk.keep_until_removed(staging_path.clone());
            disk.keep_until_removed(service.store.file_path(&storage_key)?);
            let outcome = service
                .db
                .transaction(move |tx| {
                    let now = unix_now()?;
                    let project_id = task_project(tx, &task_id_owned)?;
                    require_file_access_tx(tx, &actor_owned, &project_id, true, false, now)?;

                    if let Some(existing) = idempotency_replay(
                        tx,
                        &actor_owned,
                        &key_owned,
                        "attachment.upload",
                        &request_hash,
                    )? {
                        return Ok(ReserveOutcome::Replay(Box::new(existing)));
                    }

                    let occupied: i64 = tx.query_row(
                        "SELECT
                       (SELECT count(*) FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id
                        WHERE a.task_id=?1 AND a.deleted_at IS NULL AND b.state IN ('available','deleting')) +
                       (SELECT count(*) FROM upload_reservations
                        WHERE task_id=?1 AND committed_at IS NULL AND expires_at>?2)",
                        params![task_id_owned, now],
                        |row| row.get(0),
                    )?;
                    if occupied >= MAX_ATTACHMENTS_PER_TASK {
                        return Err(AppError::Conflict(
                            format!("a task can have at most {MAX_ATTACHMENTS_PER_TASK} available attachments"),
                        ));
                    }

                    let used: i64 = tx.query_row(SELECT_FILE_BLOBS_SQL, [now], |row| row.get(0))?;
                    if (used.max(0) as u64)
                        .saturating_add(non_database_bytes)
                        .saturating_add(claimed_size)
                        > limit
                    {
                        return Err(AppError::rule(
                            crate::error::RuleKind::StorageFull,
                            "attachment storage capacity is exhausted",
                        ));
                    }

                    let actual_idempotency_id = upsert_running_idempotency(
                        tx,
                        &actor_owned,
                        &idempotency_id_tx,
                        &key_owned,
                        "attachment.upload",
                        &request_hash,
                        now,
                    )?;
                    tx.execute(
                        "INSERT INTO upload_reservations
                     (id,project_id,task_id,user_id,size_bytes,staging_key,created_at,expires_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![
                            reservation_id_tx,
                            project_id,
                            task_id_owned,
                            actor_owned.user_id,
                            claimed_size as i64,
                            staging_key_tx,
                            now,
                            now + UPLOAD_RESERVATION_SECONDS
                        ],
                    )?;
                    tx.execute(
                        "UPDATE idempotency_keys SET resource_type='upload_reservation',resource_id=?1
                     WHERE id=?2",
                        params![reservation_id_tx, actual_idempotency_id],
                    )?;
                    Ok(ReserveOutcome::Reserved(project_id, actual_idempotency_id))
                })
                .await?;

            match outcome {
                ReserveOutcome::Replay(value) => Ok(UploadStart::Replayed(value)),
                ReserveOutcome::Reserved(project_id, idempotency_id) => {
                    let mut pending = PendingAttachmentUpload {
                        disk: Some(disk),
                        service: service.clone(),
                        actor: pending_actor,
                        reservation_id,
                        idempotency_id,
                        task_id: pending_task_id,
                        project_id,
                        original_name: pending_original_name,
                        is_ephemeral,
                        claimed_size,
                        staging_path,
                        storage_key,
                        file: None,
                        written: 0,
                        hasher: Sha256::new(),
                        inspection: Vec::with_capacity(
                            PREFIX_INSPECTION_BYTES.min(claimed_size as usize),
                        ),
                        finished: false,
                    };
                    match OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&pending.staging_path)
                        .await
                    {
                        Ok(file) => {
                            pending.file = Some(file);
                            Ok(UploadStart::Pending(Box::new(pending)))
                        }
                        Err(error) => {
                            pending.abort().await?;
                            Err(error.into())
                        }
                    }
                }
            }
        });
        reservation_task.await.map_err(|error| {
            AppError::internal(format!("upload reservation worker failed: {error}"))
        })?
    }
}
impl PendingAttachmentUpload {
    pub async fn write_chunk(&mut self, chunk: &[u8]) -> AppResult<()> {
        let next = self.written.saturating_add(chunk.len() as u64);
        if next > self.claimed_size || next > MAX_ATTACHMENT_BYTES {
            return Err(AppError::validation(
                "file",
                "received more bytes than declared",
            ));
        }
        if self.inspection.len() < PREFIX_INSPECTION_BYTES {
            let remaining = PREFIX_INSPECTION_BYTES - self.inspection.len();
            self.inspection
                .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        self.file
            .as_mut()
            .ok_or_else(|| AppError::internal("upload staging file is unavailable"))?
            .write_all(chunk)
            .await?;
        self.hasher.update(chunk);
        self.written = next;
        Ok(())
    }

    pub async fn finish(mut self) -> AppResult<AttachmentView> {
        if self.written != self.claimed_size {
            let got = self.written;
            let expected = self.claimed_size;
            log_cleanup_failure(self.abort().await);
            return Err(AppError::validation(
                "file",
                format!("declared {expected} bytes but received {got}"),
            ));
        }
        let file = self
            .file
            .take()
            .ok_or_else(|| AppError::internal("upload staging file is unavailable"))?;
        let data_lease = match self.service.db.acquire_data_lease().await {
            Ok(data_lease) => data_lease,
            Err(error) => {
                self.finished = true;
                drop(file);
                self.release_without_data_lease().await;
                return Err(error);
            }
        };
        let finalizer = FinalizeAttachmentUpload {
            disk: self.disk.take(),
            service: self.service.clone(),
            actor: self.actor.clone(),
            data_lease,
            reservation_id: self.reservation_id.clone(),
            idempotency_id: self.idempotency_id.clone(),
            task_id: self.task_id.clone(),
            project_id: self.project_id.clone(),
            original_name: self.original_name.clone(),
            is_ephemeral: self.is_ephemeral,
            staging_path: self.staging_path.clone(),
            storage_key: self.storage_key.clone(),
            file: Some(file),
            written: self.written,
            hasher: self.hasher.clone(),
            inspection: self.inspection.clone(),
        };
        self.finished = true;
        tokio::spawn(finalize_attachment_upload(finalizer))
            .await
            .map_err(|error| AppError::internal(format!("upload finalizer failed: {error}")))?
    }

    pub async fn abort(mut self) -> AppResult<()> {
        let data_lease = match self.service.db.acquire_data_lease().await {
            Ok(data_lease) => data_lease,
            Err(error) => {
                self.finished = true;
                self.release_without_data_lease().await;
                return Err(error);
            }
        };
        let file = self.file.take();
        let service = self.service.clone();
        let reservation_id = self.reservation_id.clone();
        let idempotency_id = self.idempotency_id.clone();
        let storage_key = self.storage_key.clone();
        let staging_path = self.staging_path.clone();
        let disk = self.disk.take();
        self.finished = true;
        tokio::spawn(async move {
            let _disk = disk;
            if let Some(mut file) = file {
                // Tokio may still be writing on a blocking worker. Finish that
                // write before unlinking and releasing its disk reservation.
                let _ = file.flush().await;
            }
            service
                .cleanup_upload_attempt(
                    &reservation_id,
                    &idempotency_id,
                    &storage_key,
                    &staging_path,
                    &data_lease,
                )
                .await
        })
        .await
        .map_err(|error| AppError::internal(format!("upload cleanup failed: {error}")))?
    }

    /// Without the data lease, for example during a backup, the attempt still
    /// frees its task slot and retry key at once.
    async fn release_without_data_lease(&self) {
        log_cleanup_failure(
            self.service
                .release_upload_reservation(&self.reservation_id, &self.idempotency_id)
                .await,
        );
    }
}

impl Drop for PendingAttachmentUpload {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let service = self.service.clone();
        let reservation_id = self.reservation_id.clone();
        let idempotency_id = self.idempotency_id.clone();
        let storage_key = self.storage_key.clone();
        let staging_path = self.staging_path.clone();
        let disk = self.disk.take();
        let file = self.file.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _disk = disk;
                if let Some(mut file) = file {
                    let _ = file.flush().await;
                }
                let result = match service.db.acquire_data_lease().await {
                    Ok(data_lease) => {
                        service
                            .cleanup_upload_attempt(
                                &reservation_id,
                                &idempotency_id,
                                &storage_key,
                                &staging_path,
                                &data_lease,
                            )
                            .await
                    }
                    Err(_) => {
                        service
                            .release_upload_reservation(&reservation_id, &idempotency_id)
                            .await
                    }
                };
                log_cleanup_failure(result);
            });
        }
    }
}

async fn finalize_attachment_upload(
    mut upload: FinalizeAttachmentUpload,
) -> AppResult<AttachmentView> {
    let prepared: AppResult<(String, String)> = async {
        let mut file = upload
            .file
            .take()
            .ok_or_else(|| AppError::internal("upload staging file is unavailable"))?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        let name = upload.original_name.clone();
        let path = upload.staging_path.clone();
        let prefix = std::mem::take(&mut upload.inspection);
        let permit = TEXT_INSPECTION_PERMITS
            .acquire()
            .await
            .map_err(|_| AppError::internal("text inspection worker is shutting down"))?;
        let media = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            detect::inspect_file_media(&name, &path, &prefix)
        })
        .await
        .map_err(|error| AppError::internal(format!("text inspection worker failed: {error}")))??;
        let checksum = hex::encode(upload.hasher.finalize());
        Ok((media, checksum))
    }
    .await;
    let (media, checksum) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            log_cleanup_failure(
                upload
                    .service
                    .cleanup_upload_attempt(
                        &upload.reservation_id,
                        &upload.idempotency_id,
                        &upload.storage_key,
                        &upload.staging_path,
                        &upload.data_lease,
                    )
                    .await,
            );
            return Err(error);
        }
    };
    let maintenance_gate = match upload.service.acquire_file_maintenance_gate().await {
        Ok(gate) => gate,
        Err(error) => {
            log_cleanup_failure(
                upload
                    .service
                    .cleanup_upload_attempt(
                        &upload.reservation_id,
                        &upload.idempotency_id,
                        &upload.storage_key,
                        &upload.staging_path,
                        &upload.data_lease,
                    )
                    .await,
            );
            return Err(error);
        }
    };
    let destination = match upload
        .service
        .store
        .prepare_file_parent(&upload.storage_key)
        .await
    {
        Ok(destination) => destination,
        Err(error) => {
            drop(maintenance_gate);
            log_cleanup_failure(
                upload
                    .service
                    .cleanup_upload_attempt(
                        &upload.reservation_id,
                        &upload.idempotency_id,
                        &upload.storage_key,
                        &upload.staging_path,
                        &upload.data_lease,
                    )
                    .await,
            );
            return Err(error);
        }
    };
    let result: AppResult<AttachmentView> = async {
        fs::rename(&upload.staging_path, &destination).await?;
        FileStore::sync_parent(destination.clone()).await?;

        let actor = upload.actor.clone();
        let attachment_id = Uuid::now_v7().to_string();
        let blob_id = Uuid::now_v7().to_string();
        let attachment_id_tx = attachment_id.clone();
        let blob_id_tx = blob_id.clone();
        let reservation_id = upload.reservation_id.clone();
        let idempotency_id = upload.idempotency_id.clone();
        let task_id = upload.task_id.clone();
        let project_id = upload.project_id.clone();
        let name = upload.original_name.clone();
        let storage_key = upload.storage_key.clone();
        let is_ephemeral = upload.is_ephemeral;
        let size = upload.written;
        upload
            .service
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                require_file_access_tx(tx, &actor, &project_id, true, false, now)?;
                // Someone may have deleted the task while the bytes arrived.
                if task_project(tx, &task_id)? != project_id {
                    return Err(AppError::NotFound { resource: "task" });
                }
                let active: bool = tx.query_row(
                    SELECT_UPLOAD_RESERVATIONS_SQL,
                    params![reservation_id, now],
                    |r| r.get(0),
                )?;
                if !active {
                    return Err(AppError::Conflict("upload reservation expired".into()));
                }
                let position: i64 = tx.query_row(
                    "SELECT coalesce(max(position)+1,0) FROM task_attachments WHERE task_id=?1",
                    [&task_id],
                    |r| r.get(0),
                )?;
                tx.execute(
                    INSERT_ATTACHMENT_BLOB_SQL,
                    params![blob_id_tx, storage_key, checksum, size as i64, media, now],
                )?;
                tx.execute(
                    INSERT_TASK_ATTACHMENTS_SQL,
                    params![
                        attachment_id_tx,
                        project_id,
                        task_id,
                        blob_id_tx,
                        name,
                        actor.user_id,
                        is_ephemeral,
                        position,
                        now
                    ],
                )?;
                tx.execute(
                    "DELETE FROM upload_reservations WHERE id=?1",
                    [reservation_id],
                )?;
                let view = attachment_by_id(tx, &attachment_id_tx)?.attachment;
                crate::idempotency::succeed(
                    tx,
                    &idempotency_id,
                    crate::idempotency::Receipt {
                        status: 201,
                        response: &serde_json::to_string(&view)
                            .map_err(|e| AppError::internal(e.to_string()))?,
                        resource_type: Some("attachment"),
                        resource_id: Some(&attachment_id_tx),
                        project_id: Some(&project_id),
                    },
                    now,
                )?;
                record_activity_tx(
                    tx,
                    &actor,
                    ActivityInput {
                        project_id: Some(&project_id),
                        entity_type: "attachment",
                        entity_id: &attachment_id_tx,
                        task_id: Some(&task_id),
                        event_type: "attachment.created",
                        field_key: None,
                        before: None,
                        after: Some(json!({"name":name,"size":size,"temporary":is_ephemeral})),
                        metadata: json!({"name":name,"size":size,"temporary":is_ephemeral}),
                        entity_revision: Some(1),
                    },
                    now,
                )?;
                Ok(view)
            })
            .await
    }
    .await;
    drop(maintenance_gate);
    match result {
        Ok(view) => {
            if let Some(disk) = upload.disk.take() {
                disk.published();
            }
            if view.thumbnail_url.is_some() {
                upload.service.queue_thumbnail(&upload.storage_key);
            }
            Ok(view)
        }
        Err(error) => {
            log_cleanup_failure(
                upload
                    .service
                    .cleanup_upload_attempt(
                        &upload.reservation_id,
                        &upload.idempotency_id,
                        &upload.storage_key,
                        &upload.staging_path,
                        &upload.data_lease,
                    )
                    .await,
            );
            Err(error)
        }
    }
}

static TEXT_INSPECTION_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
