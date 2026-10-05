//! Thumbnails of image attachments. Requests only queue work; one background
//! job at a time decodes within the avatar limits and shares their permits.
use super::*;
use std::{collections::VecDeque, sync::Mutex};

use image::{
    DynamicImage,
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
};
use tokio::sync::{Notify, watch};

/// A thumbnail fits in a square of this many pixels. Smaller images keep
/// their size.
pub(crate) const THUMBNAIL_SIDE: u32 = 256;
/// Requests beyond this are dropped; the next view of the file asks again.
const THUMBNAIL_QUEUE_LENGTH: usize = 256;
/// A stored thumbnail larger than this is damaged and made again.
const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;
const THUMBNAIL_JPEG_QUALITY: u8 = 80;

#[derive(Default)]
pub(super) struct ThumbnailQueue {
    keys: Mutex<VecDeque<String>>,
    ready: Notify,
}

impl ThumbnailQueue {
    fn push(&self, key: &str) {
        let mut keys = self.keys.lock().expect("thumbnail queue lock");
        if keys.len() >= THUMBNAIL_QUEUE_LENGTH || keys.iter().any(|queued| queued == key) {
            return;
        }
        keys.push_back(key.to_owned());
        drop(keys);
        self.ready.notify_one();
    }

    fn pop(&self) -> Option<String> {
        self.keys.lock().expect("thumbnail queue lock").pop_front()
    }
}

/// The image types the server can decode. Others, such as GIF and AVIF,
/// always show the original.
pub(super) fn makes_thumbnail(media_type: &str) -> bool {
    matches!(media_type, "image/png" | "image/jpeg" | "image/webp")
}

pub(crate) enum ThumbnailRead {
    Thumbnail {
        bytes: Vec<u8>,
        media_type: &'static str,
        etag: String,
        name: String,
    },
    NotModified(String),
    /// No thumbnail yet, or none possible: the original, as `/content` serves it.
    Original(ConditionalRead),
}

/// The original's checksum and the size decide the thumbnail's bytes.
fn thumbnail_etag(checksum: &str) -> String {
    format!("\"{checksum}-thumbnail-{THUMBNAIL_SIDE}\"")
}

/// A thumbnail file. An empty one records that the original can't be decoded
/// within the limits, so its views show the original without trying again.
enum StoredThumbnail {
    Ready(Vec<u8>, &'static str),
    Impossible,
    Missing,
}

enum RenderError {
    /// Reading the original failed; a later view tries again.
    Io(AppError),
    /// The file isn't an image the decoder accepts within the limits.
    Image,
}

impl FileService {
    /// The thumbnail of an image attachment, with the same access checks and
    /// validators as `/content`. Without a thumbnail it queues one and serves
    /// the original.
    pub(crate) async fn open_thumbnail(
        &self,
        actor: &Actor,
        attachment_id: &str,
        validator: Option<String>,
    ) -> AppResult<ThumbnailRead> {
        let actor_tx = actor.clone();
        let id = attachment_id.to_owned();
        let validator_tx = validator.clone();
        let (stored, unchanged) = self
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                let stored = attachment_by_id(tx, &id)?;
                require_file_access_tx(tx, &actor_tx, &stored.attachment.project_id, false, false, now)?;
                if stored.attachment.state != BlobState::Available
                    || stored.storage_key.is_none()
                    || stored.attachment.preview_kind != Some(PreviewKind::Image)
                {
                    return Err(AppError::NotFound { resource: "preview" });
                }
                // Like opening the image, a thumbnail view keeps a temporary file.
                tx.execute(
                    "UPDATE task_attachments SET last_accessed_at=max(last_accessed_at,?1) WHERE id=?2 AND last_accessed_at<?1",
                    params![now, id],
                )?;
                let etag = thumbnail_etag(&stored.attachment.checksum);
                let unchanged = etag_matches(validator_tx.as_deref(), &etag).then_some(etag);
                Ok((stored, unchanged))
            })
            .await?;
        if let Some(etag) = unchanged {
            return Ok(ThumbnailRead::NotModified(etag));
        }
        let key = stored.storage_key.as_deref().expect("checked storage key");
        if makes_thumbnail(&stored.attachment.media_type) {
            match self.stored_thumbnail(key).await? {
                StoredThumbnail::Ready(bytes, media_type) => {
                    return Ok(ThumbnailRead::Thumbnail {
                        bytes,
                        media_type,
                        etag: thumbnail_etag(&stored.attachment.checksum),
                        name: stored.attachment.name,
                    });
                }
                StoredThumbnail::Impossible => {}
                StoredThumbnail::Missing => self.queue_thumbnail(key),
            }
        }
        let original = self
            .open_for_read_conditional(actor, attachment_id, ReadMode::Content, validator)
            .await?;
        Ok(ThumbnailRead::Original(original))
    }

    async fn stored_thumbnail(&self, key: &str) -> AppResult<StoredThumbnail> {
        let path = self.store.thumbnail_path(key)?;
        let file = match File::open(&path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoredThumbnail::Missing);
            }
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_THUMBNAIL_BYTES + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.is_empty() {
            return Ok(StoredThumbnail::Impossible);
        }
        match detect::signature_image(&bytes) {
            Some(media_type @ ("image/png" | "image/jpeg"))
                if bytes.len() as u64 <= MAX_THUMBNAIL_BYTES =>
            {
                Ok(StoredThumbnail::Ready(bytes, media_type))
            }
            _ => {
                // Not written by oneloop: remove it, so a new one is made.
                self.store.remove_file_if_present(&path).await?;
                Ok(StoredThumbnail::Missing)
            }
        }
    }

    /// Asks the worker for a thumbnail of the original with `storage_key`. It
    /// never waits: when the queue is full, the next view asks again.
    pub(super) fn queue_thumbnail(&self, storage_key: &str) {
        self.thumbnails.push(storage_key);
    }

    /// Makes queued thumbnails one at a time until shutdown.
    pub async fn run_thumbnail_worker(&self, mut shutdown: watch::Receiver<bool>) {
        loop {
            if *shutdown.borrow() {
                break;
            }
            let stopping = shutdown.clone();
            self.make_thumbnails_until(|| *stopping.borrow()).await;
            tokio::select! {
                () = self.thumbnails.ready.notified() => {}
                result = shutdown.changed() => {
                    if result.is_err() || *shutdown.borrow() { break; }
                }
            }
        }
    }

    /// Makes every queued thumbnail now, as the worker would, and returns how
    /// many it wrote.
    pub async fn make_queued_thumbnails(&self) -> u64 {
        self.make_thumbnails_until(|| false).await
    }

    async fn make_thumbnails_until(&self, stop: impl Fn() -> bool) -> u64 {
        let mut made = 0;
        // Usage is measured once per run and then counted up, so a burst of
        // thumbnails doesn't walk the previews folder for each one.
        let mut used = None;
        while !stop() {
            let Some(key) = self.thumbnails.pop() else {
                break;
            };
            match self.make_thumbnail(&key, &mut used).await {
                Ok(true) => made += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%error, "thumbnail not made; views show the original");
                }
            }
        }
        made
    }

    async fn make_thumbnail(&self, key: &str, used: &mut Option<u64>) -> AppResult<bool> {
        let destination = self.store.thumbnail_path(key)?;
        if fs::try_exists(&destination).await? {
            return Ok(false);
        }
        // Thumbnails never take usage to the cleanup threshold, where storage
        // cleanup would only remove them again, so from there nothing is decoded.
        let current = match *used {
            Some(current) => current,
            None => self.capacity_usage().await?.total(),
        };
        *used = Some(current);
        let threshold = self
            .storage_limit_bytes
            .saturating_mul(CLEANUP_HIGH_PERCENT)
            / 100;
        if current >= threshold {
            return Ok(false);
        }
        let original = self.store.file_path(key)?;
        let permit = IMAGE_DECODE_PERMITS
            .acquire()
            .await
            .map_err(|_| AppError::Unavailable("image worker is shutting down".into()))?;
        // The empty marker of an image that can't be decoded goes in first,
        // once the image is known to be still wanted. A decode that ends the
        // process leaves it, so later views show the original instead of
        // decoding the image again.
        if !self.write_thumbnail(key, &[], None).await? {
            return Ok(false);
        }
        let rendered = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            render_thumbnail(&original)
        })
        .await;
        let bytes = match rendered {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(RenderError::Io(error))) => {
                // Reading failed, not decoding: a later view may try again.
                self.remove_thumbnail(key).await;
                return Err(error);
            }
            // A decoder that fails or panics on this file would do so again.
            Ok(Err(RenderError::Image)) | Err(_) => return Ok(false),
        };
        let size = bytes.len() as u64;
        let disk = (current.saturating_add(size) < threshold)
            .then(|| self.disk.reserve(size).ok())
            .flatten();
        let Some(disk) = disk else {
            self.remove_thumbnail(key).await;
            return Ok(false);
        };
        if !self.write_thumbnail(key, &bytes, Some(&disk)).await? {
            return Ok(false);
        }
        disk.published();
        *used = Some(current.saturating_add(size));
        Ok(true)
    }

    /// Writes a thumbnail, or the empty marker, in place of what is there.
    /// When the original went away meanwhile, it removes the marker instead.
    async fn write_thumbnail(
        &self,
        key: &str,
        bytes: &[u8],
        disk: Option<&DiskReservation>,
    ) -> AppResult<bool> {
        let _gate = self.acquire_file_maintenance_gate().await?;
        // Under the gate, a deletion that finished meanwhile is visible here,
        // and orphan cleanup can't remove the file while it is written.
        if !self.wants_thumbnail(key).await? {
            self.remove_thumbnail(key).await;
            return Ok(false);
        }
        let destination = self.store.prepare_thumbnail_parent(key).await?;
        let temporary = destination.with_extension(format!("thumb.{}.tmp", Uuid::now_v7()));
        if let Some(disk) = disk {
            disk.keep_until_removed(temporary.clone());
        }
        let written: AppResult<()> = async {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .await?;
            file.write_all(bytes).await?;
            file.sync_all().await?;
            drop(file);
            fs::rename(&temporary, &destination).await?;
            Ok(())
        }
        .await;
        if let Err(error) = written {
            log_cleanup_failure(self.store.remove_file_if_present(&temporary).await);
            return Err(error);
        }
        Ok(true)
    }

    /// Whether a task that isn't deleted shows the original with `key` in an
    /// attachment that isn't deleted, and the server can decode its type.
    async fn wants_thumbnail(&self, key: &str) -> AppResult<bool> {
        let key = key.to_owned();
        self.db
            .run(move |connection| {
                let media: Option<String> = connection
                    .query_row(
                        "SELECT b.media_type FROM file_blobs b
                         WHERE b.storage_key=?1 AND b.state='available'
                           AND EXISTS(SELECT 1 FROM task_attachments a JOIN tasks t ON t.id=a.task_id
                                      WHERE a.blob_id=b.id AND a.deleted_at IS NULL
                                        AND t.deleted_at IS NULL)",
                        [key],
                        |row| row.get(0),
                    )
                    .optional()?;
                Ok(media.is_some_and(|media| makes_thumbnail(&media)))
            })
            .await
    }

    /// Removes the thumbnail of a deleted or cleaned original. A failure only
    /// leaves an orphan, which reconciliation removes.
    pub(super) async fn remove_thumbnail(&self, key: &str) {
        let removed = match self.store.thumbnail_path(key) {
            Ok(path) => self.store.remove_file_if_present(&path).await,
            Err(error) => Err(error),
        };
        log_cleanup_failure(removed);
    }

    /// Thumbnails whose original is gone, and files in `previews/` that
    /// aren't thumbnails at all, such as an interrupted write.
    pub(super) async fn orphan_thumbnail_candidates(
        &self,
        referenced: &HashSet<String>,
    ) -> AppResult<Vec<PathBuf>> {
        Ok(regular_files(self.store.previews())
            .await?
            .into_iter()
            .map(|(path, _)| path)
            .filter(|path| {
                self.store
                    .thumbnail_key(path)
                    .is_none_or(|key| !referenced.contains(&key))
            })
            .collect())
    }

    /// Rechecks a candidate from an older snapshot under the gate that
    /// thumbnail writes hold, then removes it.
    pub(super) async fn remove_thumbnail_if_orphaned(&self, path: &Path) -> AppResult<bool> {
        let _maintenance_gate = self.acquire_file_maintenance_gate().await?;
        if let Some(key) = self.store.thumbnail_key(path) {
            let referenced_now: bool = self
                .db
                .run(move |connection| {
                    Ok(connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM file_blobs WHERE storage_key=?1)",
                        [key],
                        |row| row.get(0),
                    )?)
                })
                .await?;
            if referenced_now {
                return Ok(false);
            }
        }
        self.store.remove_file_if_present(path).await?;
        Ok(true)
    }
}

/// Decodes the original within the image limits, fits it in the thumbnail
/// square, turns it upright and encodes it: JPEG, or PNG to keep transparency.
fn render_thumbnail(original: &Path) -> Result<Vec<u8>, RenderError> {
    let file = std::fs::File::open(original).map_err(|error| RenderError::Io(error.into()))?;
    let size = file
        .metadata()
        .map_err(|error| RenderError::Io(error.into()))?
        .len();
    let (mut image, orientation) = decode::decode_untrusted(std::io::BufReader::new(file), size)
        .map_err(|failure| match failure {
            decode::DecodeFailure::Io(error) => RenderError::Io(error.into()),
            decode::DecodeFailure::Refused => RenderError::Image,
        })?;
    if image.width() > THUMBNAIL_SIDE || image.height() > THUMBNAIL_SIDE {
        image = image.thumbnail(THUMBNAIL_SIDE, THUMBNAIL_SIDE);
    }
    image.apply_orientation(orientation);
    let rgba = image.to_rgba8();
    let mut output = Vec::new();
    let encoded = if rgba.pixels().all(|pixel| pixel[3] == u8::MAX) {
        let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
        JpegEncoder::new_with_quality(&mut output, THUMBNAIL_JPEG_QUALITY).write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
    } else {
        PngEncoder::new(&mut output).write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgba8,
        )
    };
    encoded.map_err(|_| RenderError::Image)?;
    Ok(output)
}
