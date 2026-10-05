//! Thumbnails of image attachments: made in the background, served in place
//! of the original, and removed with it.

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, Request, StatusCode, header},
};
use image::{ImageEncoder, codecs::jpeg::JpegEncoder};
use oneloop::files::AttachmentView;
use tower::ServiceExt;

use super::http::Fixture;
use crate::support::{self, http::body_bytes};

fn png(width: u32, height: u32, transparent: bool) -> Vec<u8> {
    let pixels = (0..width * height)
        .flat_map(|index| {
            [
                (index % 251) as u8,
                90,
                160,
                if transparent { 128 } else { 255 },
            ]
        })
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&pixels, width, height, image::ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

/// A JPEG whose left half is red and right half blue, stored with `exif`.
fn jpeg(width: u32, height: u32, exif: Option<Vec<u8>>) -> Vec<u8> {
    let pixels = (0..width * height)
        .flat_map(|index| {
            if index % width < width / 2 {
                [220, 20, 20]
            } else {
                [20, 20, 220]
            }
        })
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 90);
    if let Some(exif) = exif {
        encoder.set_exif_metadata(exif).unwrap();
    }
    encoder
        .write_image(&pixels, width, height, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}

/// Exif data whose only entry is the orientation: 6 means "turn 90 degrees
/// clockwise to show it upright", as phones store portrait photos.
fn exif_orientation(value: u8) -> Vec<u8> {
    let mut exif = b"II*\0\x08\0\0\0\x01\0".to_vec();
    exif.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, value, 0, 0, 0]);
    exif.extend_from_slice(&[0, 0, 0, 0]);
    exif
}

impl Fixture {
    async fn attach(&self, key: &str, name: &str, bytes: &[u8]) -> AttachmentView {
        let (status, body) = self.upload(key, name, bytes).await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&body)
        );
        serde_json::from_slice(&body).unwrap()
    }

    async fn get(&self, uri: &str, validator: Option<&str>) -> (StatusCode, HeaderMap, Bytes) {
        let mut request = Request::builder()
            .uri(uri)
            .header(header::COOKIE, &self.manager_cookie);
        if let Some(validator) = validator {
            request = request.header(header::IF_NONE_MATCH, validator);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        (status, headers, body_bytes(response).await)
    }

    fn thumbnail_file(&self, attachment: &AttachmentView) -> std::path::PathBuf {
        let id = attachment.id.clone();
        let key: String = rusqlite::Connection::open(self.db.layout().database())
            .unwrap()
            .query_row(
                "SELECT b.storage_key FROM task_attachments a JOIN file_blobs b ON b.id=a.blob_id WHERE a.id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        self.files.store().thumbnail_path(&key).unwrap()
    }
}

fn decoded(bytes: &[u8]) -> image::DynamicImage {
    image::load_from_memory(bytes).unwrap()
}

#[tokio::test]
async fn uploaded_images_get_thumbnails_that_fit_the_square() {
    let fixture = Fixture::new().await;
    let photo = fixture
        .attach("photo", "photo.png", &png(600, 300, false))
        .await;
    let logo = fixture
        .attach("logo", "logo.png", &png(300, 600, true))
        .await;
    let small = fixture
        .attach("small", "small.jpg", &jpeg(100, 50, None))
        .await;
    assert_eq!(
        photo.thumbnail_url.as_deref(),
        Some(format!("/api/attachments/{}/thumbnail", photo.id).as_str())
    );
    // The upload queued the work; nothing has asked for a thumbnail yet.
    assert_eq!(fixture.files.make_queued_thumbnails().await, 3);

    for (attachment, media_type, size) in [
        (&photo, "image/jpeg", (256, 128)),
        (&logo, "image/png", (128, 256)),
        (&small, "image/jpeg", (100, 50)),
    ] {
        let url = attachment.thumbnail_url.as_deref().unwrap();
        let (status, headers, body) = fixture.get(url, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], media_type);
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
        let etag = headers[header::ETAG].to_str().unwrap().to_owned();
        assert_eq!(etag, format!("\"{}-thumbnail-256\"", attachment.checksum));
        let image = decoded(&body);
        assert_eq!((image.width(), image.height()), size, "{}", attachment.name);
        assert_eq!(image.color().has_alpha(), media_type == "image/png");

        let (status, headers, body) = fixture.get(url, Some(&etag)).await;
        assert_eq!(status, StatusCode::NOT_MODIFIED);
        assert_eq!(headers[header::ETAG], etag.as_str());
        assert!(body.is_empty());
    }
}

#[tokio::test]
async fn a_thumbnail_view_serves_the_original_until_the_thumbnail_is_ready() {
    let fixture = Fixture::new().await;
    let original = png(400, 400, false);
    let attachment = fixture.attach("early", "early.png", &original).await;
    let url = attachment.thumbnail_url.clone().unwrap();
    let (status, headers, body) = fixture.get(&url, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        headers[header::ETAG],
        format!("\"{}\"", attachment.checksum).as_str()
    );
    assert_eq!(body.as_ref(), original.as_slice());

    assert_eq!(fixture.files.make_queued_thumbnails().await, 1);
    // A browser that cached the original gets the thumbnail, not "unchanged".
    let (status, headers, body) = fixture
        .get(&url, Some(&format!("\"{}\"", attachment.checksum)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(decoded(&body).width(), 256);
}

#[tokio::test]
async fn portrait_photos_turned_by_their_exif_data_come_out_upright() {
    let fixture = Fixture::new().await;
    // Stored landscape with red on the left; shown upright, red is on top.
    let attachment = fixture
        .attach(
            "portrait",
            "portrait.jpg",
            &jpeg(600, 300, Some(exif_orientation(6))),
        )
        .await;
    fixture.files.make_queued_thumbnails().await;
    let (status, _, body) = fixture
        .get(attachment.thumbnail_url.as_deref().unwrap(), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let image = decoded(&body).to_rgb8();
    assert_eq!(image.dimensions(), (128, 256));
    let top = image.get_pixel(64, 32);
    let bottom = image.get_pixel(64, 224);
    assert!(top[0] > 150 && top[2] < 100, "top is red: {top:?}");
    assert!(
        bottom[2] > 150 && bottom[0] < 100,
        "bottom is blue: {bottom:?}"
    );
}

#[tokio::test]
async fn images_without_a_thumbnail_show_the_original() {
    let fixture = Fixture::new().await;
    let gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;".to_vec();
    let gif = fixture.attach("gif", "spinner.gif", &gif).await;
    assert_eq!(gif.media_type, "image/gif");
    assert_eq!(gif.thumbnail_url, None);

    let mut damaged = jpeg(64, 64, None);
    damaged.truncate(200);
    let damaged = fixture.attach("damaged", "damaged.jpg", &damaged).await;
    // Wider than the 8192 px decode limit.
    let wide = png(9000, 1, false);
    let wide = fixture.attach("wide", "wide.png", &wide).await;
    assert_eq!(fixture.files.make_queued_thumbnails().await, 0);

    for (attachment, original) in [
        (&gif, None),
        (&damaged, Some("image/jpeg")),
        (&wide, Some("image/png")),
    ] {
        let url = format!("/api/attachments/{}/thumbnail", attachment.id);
        let (status, headers, body) = fixture.get(&url, None).await;
        assert_eq!(status, StatusCode::OK, "{}", attachment.name);
        assert_eq!(
            headers[header::CONTENT_TYPE],
            original.unwrap_or("image/gif"),
            "{}",
            attachment.name
        );
        assert_eq!(body.len() as u64, attachment.size, "{}", attachment.name);
        if original.is_some() {
            // An empty file records that this original can't be decoded, so
            // later views don't queue the work again.
            let marker = fixture.thumbnail_file(attachment);
            assert_eq!(std::fs::metadata(&marker).unwrap().len(), 0);
        }
    }
    assert_eq!(fixture.files.make_queued_thumbnails().await, 0);
}

#[tokio::test]
async fn deleting_an_image_removes_its_thumbnail() {
    let fixture = Fixture::new().await;
    let attachment = fixture
        .attach("deleted", "deleted.png", &png(300, 300, false))
        .await;
    fixture.files.make_queued_thumbnails().await;
    let thumbnail = fixture.thumbnail_file(&attachment);
    assert!(thumbnail.is_file());
    let response = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!(
                    "/api/attachments/{}?expectedRevision={}",
                    attachment.id, attachment.revision
                ))
                .header(header::ORIGIN, "https://tasks.example.test")
                .header(header::COOKIE, &fixture.manager_cookie)
                .header("idempotency-key", "delete-image")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(!thumbnail.exists());
}

#[tokio::test]
async fn thumbnails_count_as_previews_and_come_back_after_storage_cleanup() {
    let fixture = Fixture::new().await;
    let admin = support::add_user(&fixture.db, "admin", true).await;
    let attachment = fixture
        .attach("counted", "counted.png", &png(500, 500, false))
        .await;
    fixture.files.make_queued_thumbnails().await;
    let thumbnail = fixture.thumbnail_file(&attachment);
    let size = std::fs::metadata(&thumbnail).unwrap().len();
    let usage = fixture.files.storage_usage(&admin.actor).await.unwrap();
    assert_eq!(usage.preview_bytes, size);
    assert_eq!(usage.used_bytes, attachment.size + size);

    // Storage cleanup removes every preview first.
    fixture.files.cleanup_to_low_watermark().await.unwrap();
    assert!(!thumbnail.exists());
    let url = attachment.thumbnail_url.as_deref().unwrap();
    let (status, headers, _) = fixture.get(url, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(fixture.files.make_queued_thumbnails().await, 1);
    let (_, headers, _) = fixture.get(url, None).await;
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
}

#[tokio::test]
async fn reconciliation_removes_thumbnails_without_an_original() {
    let fixture = Fixture::new().await;
    let attachment = fixture
        .attach("kept", "kept.png", &png(300, 300, false))
        .await;
    fixture.files.make_queued_thumbnails().await;
    let kept = fixture.thumbnail_file(&attachment);
    let store = fixture.files.store();
    let orphan = store
        .prepare_thumbnail_parent(&store.new_storage_key().unwrap())
        .await
        .unwrap();
    std::fs::write(&orphan, b"old").unwrap();
    let interrupted = kept.with_extension("thumb.write.tmp");
    std::fs::write(&interrupted, b"half").unwrap();

    let report = fixture.files.reconcile().await.unwrap();
    assert_eq!(report.orphan_files_removed, 2);
    assert!(kept.is_file());
    assert!(!orphan.exists());
    assert!(!interrupted.exists());
}
