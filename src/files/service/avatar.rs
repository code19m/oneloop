//! Account avatars use bounded decoding and shared private-file storage.
use super::*;

const AVATAR_SIDE: u32 = 256;
/// Avatar uploads under way at once; each keeps its image in memory until it
/// is decoded. More are told to retry.
const AVATAR_UPLOADS: usize = 4;
/// How long an avatar upload waits for the decodes before it, thumbnails
/// included. The slowest decode the limits allow takes about a second on a
/// laptop, and a few seconds on a small server.
const AVATAR_DECODE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// A place for one avatar upload, kept from its first byte through its
/// decode, while the upload keeps its image in memory.
pub struct AvatarSlot {
    uploaders: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
    user_id: String,
}

impl Drop for AvatarSlot {
    fn drop(&mut self) {
        self.uploaders
            .lock()
            .expect("avatar uploads lock")
            .remove(&self.user_id);
    }
}

impl FileService {
    /// A place for an avatar upload, taken before its bytes arrive. A
    /// person has one place at most, so no one can take them all. When all
    /// are taken, the upload is told to retry at once.
    pub fn avatar_slot(&self, actor: &Actor) -> AppResult<AvatarSlot> {
        let mut uploaders = self.avatar_uploaders.lock().expect("avatar uploads lock");
        if uploaders.contains(&actor.user_id) {
            return Err(AppError::RateLimited { retry_after: 1 });
        }
        if uploaders.len() >= AVATAR_UPLOADS {
            return Err(AppError::Unavailable(
                "avatar processing is busy; retry shortly".into(),
            ));
        }
        uploaders.insert(actor.user_id.clone());
        Ok(AvatarSlot {
            uploaders: self.avatar_uploaders.clone(),
            user_id: actor.user_id.clone(),
        })
    }

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
        let normalized = self
            .decodes
            .turn_within(AVATAR_DECODE_WAIT)
            .await?
            .run(move || normalize_avatar(&bytes))
            .await??;
        let normalized_size = normalized.len() as u64;
        let non_database_bytes = self.admit(normalized_size).await?;
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
                refresh_actor_connection(tx, &actor_tx)?;
                require_capacity(tx, now, non_database_bytes, normalized_size, storage_limit)?;
                tx.execute(
                    "INSERT INTO file_blobs
                     (id,storage_key,checksum_sha256,size_bytes,media_type,state,created_at)
                     VALUES(?1,?2,?3,?4,'image/png','pending',?5)",
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
                refresh_actor_connection(tx, &actor_tx)?;
                let old: Option<String> = tx
                    .query_row(
                        "SELECT avatar_blob_id FROM users WHERE id=?1",
                        [&user_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                let changed = tx.execute(
                    "UPDATE file_blobs SET state='available' WHERE id=?1 AND state='pending'",
                    [&blob_id_tx],
                )?;
                if changed != 1 {
                    return Err(AppError::Conflict(
                        "avatar upload reservation is unavailable".into(),
                    ));
                }
                tx.execute(
                    "UPDATE users SET avatar_blob_id=?1,updated_at=?2,revision=revision+1 WHERE id=?3",
                    params![blob_id_tx, now, user_id],
                )?;
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
        Ok(crate::auth::avatar_url(&actor.user_id, &blob_id))
    }

    pub async fn remove_avatar(&self, actor: &Actor) -> AppResult<()> {
        actor.require_ready()?;
        let _lease = self.db.acquire_data_lease().await?;
        let user_id = actor.user_id.clone();
        let actor_tx = actor.clone();
        let old = self
            .db
            .transaction(move |tx| {
                refresh_actor_connection(tx, &actor_tx)?;
                let old: Option<String> = tx
                    .query_row(
                        "SELECT avatar_blob_id FROM users WHERE id=?1 AND is_active=1",
                        [&user_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                tx.execute(
                    "UPDATE users SET avatar_blob_id=NULL,updated_at=unixepoch(),revision=revision+1
                     WHERE id=?1",
                    [&user_id],
                )?;
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
        let (row, etag, modified) = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let current_admin = refresh_actor_connection(tx, &actor)?.is_admin;
                let visible: bool = actor.user_id == user_id_tx
                    || current_admin
                    || tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM project_memberships a
                         JOIN project_memberships b ON b.project_id=a.project_id
                         JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL
                         WHERE a.user_id=?1 AND b.user_id=?2)",
                        params![actor.user_id, user_id_tx],
                        |r| r.get(0),
                    )?;
                if !visible {
                    return Err(AppError::NotFound { resource: "avatar" });
                }
                let row = tx
                    .query_row(
                        "SELECT b.storage_key,b.size_bytes,b.checksum_sha256,b.id FROM users u
                         JOIN file_blobs b ON b.id=u.avatar_blob_id
                         WHERE u.id=?1 AND u.is_active=1 AND b.state='available'",
                        [&user_id_tx],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, i64>(1)?,
                                r.get::<_, String>(2)?,
                                r.get::<_, String>(3)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or(AppError::NotFound { resource: "avatar" })?;
                let etag = file_etag(&row.2, false);
                if etag_matches(validator.as_deref(), &etag) {
                    return Ok((row, etag, false));
                }
                tx.execute(
                    "INSERT INTO file_leases(id,blob_id,lease_kind,owner,created_at,expires_at)
                     VALUES(?1,?2,'preview',?3,?4,?5)",
                    params![
                        lease_id_tx,
                        row.3,
                        actor.user_id,
                        now,
                        now + FILE_LEASE_SECONDS
                    ],
                )?;
                Ok((row, etag, true))
            })
            .await?;
        if !modified {
            return Ok(ConditionalRead::NotModified(etag));
        }
        let (key, size, _, _) = row;
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
            name: "avatar.png".into(),
            size: size as u64,
            media_type: "image/png".into(),
            byte_limit: None,
            etag,
        })))
    }
}

fn normalize_avatar(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let format = image::guess_format(bytes)
        .map_err(|_| AppError::validation("avatar", "must be a valid PNG, JPEG or WebP image"))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(AppError::validation(
            "avatar",
            "must be a PNG, JPEG or WebP image",
        ));
    }
    let (image, _) =
        decode::decode_untrusted(Cursor::new(bytes), bytes.len() as u64).map_err(|_| {
            AppError::validation(
                "avatar",
                "image data is invalid, or too large to process safely",
            )
        })?;
    let normalized = image
        .resize_to_fill(
            AVATAR_SIDE,
            AVATAR_SIDE,
            image::imageops::FilterType::Lanczos3,
        )
        .to_rgba8();
    let mut output = Vec::new();
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(
            &normalized,
            AVATAR_SIDE,
            AVATAR_SIDE,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| AppError::validation("avatar", "image could not be normalized"))?;
    Ok(output)
}
