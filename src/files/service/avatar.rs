//! Account avatars use bounded decoding and shared private-file storage.
use super::*;

impl FileService {
    pub async fn upload_avatar(
        &self,
        actor: &Actor,
        slot: AvatarSlot,
        bytes: Vec<u8>,
    ) -> AppResult<String> {
        let _slot = slot;
        actor.require_ready()?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_AVATAR_BYTES {
            return Err(AppError::validation(
                "avatar",
                format!(
                    "must contain 1 byte to {} MiB",
                    MAX_AVATAR_BYTES / (1024 * 1024)
                ),
            ));
        }
        let permit = avatar_decode_permit().await?;
        let normalized = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            normalize_avatar(&bytes)
        })
        .await
        .map_err(|error| AppError::internal(format!("avatar worker failed: {error}")))??;
        self.store.ensure_directories().await?;
        let mut capacity = self.prepare_capacity().await?;
        let normalized_size = normalized.len() as u64;
        let deficit = self.disk.deficit(normalized_size)?;
        if deficit > 0 && self.cleanup_for_deficit(deficit).await?.bytes_reclaimed > 0 {
            capacity = self.capacity_usage().await?;
        }

        let non_database_bytes = capacity.non_database_bytes();
        let _lease = self.db.acquire_data_lease().await?;
        let maintenance_gate = self.acquire_file_maintenance_gate().await?;
        let disk = self.disk.reserve(normalized_size)?;
        let storage_key = self.store.new_storage_key()?;
        let blob_id = Uuid::now_v7().to_string();
        let blob_id_tx = blob_id.clone();
        let storage_key_tx = storage_key.clone();
        let checksum_tx = hex::encode(Sha256::digest(&normalized));
        let actor_tx = actor.clone();
        let storage_limit = self.storage_limit_bytes;
        self.db
            .transaction(move |tx| {
                let now = unix_now()?;
                require_actor_identity_raw(tx, &actor_tx, now)?;
                let used: i64 = tx.query_row(SELECT_FILE_BLOBS_3_SQL, [now], |row| row.get(0))?;
                if (used.max(0) as u64)
                    .saturating_add(non_database_bytes)
                    .saturating_add(normalized_size)
                    > storage_limit
                {
                    return Err(AppError::rule(
                        crate::error::RuleKind::StorageFull,
                        "attachment storage capacity is exhausted",
                    ));
                }
                tx.execute(
                    INSERT_FILE_BLOBS_SQL,
                    params![
                        blob_id_tx,
                        storage_key_tx,
                        checksum_tx,
                        normalized_size as i64,
                        now
                    ],
                )?;
                Ok(())
            })
            .await?;
        let destination = match self.store.prepare_file_parent(&storage_key).await {
            Ok(path) => path,
            Err(error) => {
                log_cleanup_failure(self.remove_pending_blob(&blob_id).await);
                return Err(error);
            }
        };
        let temporary = match self.store.staging_path(&format!("{blob_id}.upload")) {
            Ok(path) => path,
            Err(error) => {
                log_cleanup_failure(self.remove_pending_blob(&blob_id).await);
                return Err(error);
            }
        };
        let write_result: AppResult<()> = async {
            disk.keep_until_removed(temporary.clone());
            disk.keep_until_removed(destination.clone());
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .await?;
            file.write_all(&normalized).await?;
            file.flush().await?;
            file.sync_all().await?;
            drop(file);
            fs::rename(&temporary, &destination).await?;
            FileStore::sync_parent(destination.clone()).await
        }
        .await;
        if let Err(error) = write_result {
            log_cleanup_failure(self.store.remove_file_if_present(&temporary).await);
            log_cleanup_failure(self.store.remove_file_if_present(&destination).await);
            log_cleanup_failure(self.remove_pending_blob(&blob_id).await);
            return Err(error);
        }
        let user_id = actor.user_id.clone();
        let blob_id_tx = blob_id.clone();
        let actor_tx = actor.clone();
        let result = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                require_actor_identity_raw(tx, &actor_tx, now)?;
                let old: Option<String> = tx
                    .query_row(
                        "SELECT avatar_blob_id FROM users WHERE id=?1",
                        [&user_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                let changed = tx.execute(UPDATE_FILE_BLOBS_SQL, [&blob_id_tx])?;
                if changed != 1 {
                    return Err(AppError::Conflict(
                        "avatar upload reservation is unavailable".into(),
                    ));
                }
                tx.execute(UPDATE_USERS_SQL, params![blob_id_tx, now, user_id])?;
                Ok(old)
            })
            .await;
        let old_blob = match result {
            Ok(old_blob) => old_blob,
            Err(error) => {
                log_cleanup_failure(self.store.remove_file_if_present(&destination).await);
                log_cleanup_failure(self.remove_pending_blob(&blob_id).await);
                return Err(error);
            }
        };
        disk.published();
        drop(maintenance_gate);
        if let Some(old_blob) = old_blob {
            self.forget_old_avatar(&old_blob).await;
        }
        Ok(format!("/api/users/{}/avatar?v={}", actor.user_id, blob_id))
    }

    pub async fn remove_avatar(&self, actor: &Actor) -> AppResult<()> {
        actor.require_ready()?;
        let _lease = self.db.acquire_data_lease().await?;
        let user_id = actor.user_id.clone();
        let actor_tx = actor.clone();
        let old = self
            .db
            .transaction(move |tx| {
                require_actor_identity_raw(tx, &actor_tx, unix_now()?)?;
                let old: Option<String> = tx
                    .query_row(
                        "SELECT avatar_blob_id FROM users WHERE id=?1 AND is_active=1",
                        [&user_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                tx.execute(UPDATE_USERS_2_SQL, [&user_id])?;
                Ok(old)
            })
            .await?;
        if let Some(blob) = old {
            self.forget_old_avatar(&blob).await;
        }
        Ok(())
    }

    /// The change is saved, so a failure here must not report it as failed:
    /// reconciliation deletes files that nothing refers to.
    async fn forget_old_avatar(&self, blob_id: &str) {
        log_cleanup_failure(self.schedule_blob_deletion(blob_id, "rollback").await);
    }

    pub async fn open_avatar(&self, actor: &Actor, user_id: &str) -> AppResult<FileRead> {
        match self.open_avatar_conditional(actor, user_id, None).await? {
            ConditionalRead::Modified(read) => Ok(*read),
            ConditionalRead::NotModified(_) => unreachable!("unconditional read"),
        }
    }

    pub(crate) async fn open_avatar_conditional(
        &self,
        actor: &Actor,
        user_id: &str,
        validator: Option<String>,
    ) -> AppResult<ConditionalRead> {
        actor.require_ready()?;
        let _lease = self.db.acquire_data_lease().await?;
        let actor = actor.clone();
        let user_id = user_id.to_owned();
        let user_id_tx = user_id.clone();
        let lease_id = Uuid::now_v7().to_string();
        let lease_id_tx = lease_id.clone();
        let (row, unchanged) = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let current_admin = require_actor_identity_raw(tx, &actor, now)?;
                let visible: bool = actor.user_id == user_id_tx
                    || current_admin
                    || tx.query_row(
                        SELECT_PROJECT_MEMBERSHIPS_SQL,
                        params![actor.user_id, user_id_tx],
                        |r| r.get(0),
                    )?;
                if !visible {
                    return Err(AppError::NotFound { resource: "avatar" });
                }
                let row = tx
                    .query_row(SELECT_USERS_SQL, [&user_id_tx], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })
                    .optional()?
                    .ok_or(AppError::NotFound { resource: "avatar" })?;
                let etag = file_etag(&row.2, false);
                if etag_matches(validator.as_deref(), &etag) {
                    return Ok((row, Some(etag)));
                }
                tx.execute(
                    INSERT_FILE_LEASES_SQL,
                    params![
                        lease_id_tx,
                        row.3,
                        actor.user_id,
                        now,
                        now + FILE_LEASE_SECONDS
                    ],
                )?;
                Ok((row, None))
            })
            .await?;
        if let Some(etag) = unchanged {
            return Ok(ConditionalRead::NotModified(etag));
        }
        let (key, size, checksum, blob_id) = row;
        let file = match File::open(self.store.file_path(&key)?).await {
            Ok(file) => file,
            Err(_) => {
                self.release_file_lease(lease_id).await?;
                return Err(AppError::NotFound { resource: "avatar" });
            }
        };
        Ok(ConditionalRead::Modified(Box::new(FileRead {
            file: LeasedFile {
                file,
                db: self.db.clone(),
                lease_id: Some(lease_id),
            },
            attachment: AttachmentView {
                id: blob_id,
                project_id: String::new(),
                task_id: String::new(),
                name: "avatar.png".into(),
                size: size as u64,
                media_type: "image/png".into(),
                checksum,
                is_ephemeral: false,
                position: 0,
                uploaded_by: user_id,
                uploaded_at: 0,
                last_accessed_at: 0,
                state: BlobState::Available,
                revision: 1,
                preview_kind: Some(PreviewKind::Image),
                download_url: None,
                content_url: None,
                thumbnail_url: None,
                source_url: None,
                html_preview_url: None,
            },
            media_type: "image/png".into(),
            byte_limit: None,
        })))
    }
}
