//! Serving file bytes safely. Attachments, avatars, Knowledge files and MCP
//! downloads answer through these helpers, so the type, `nosniff`, download
//! and cache rules and the HTML preview sandbox have one owner.

use std::io::SeekFrom;

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::{
    AppError, AppResult,
    files::{ConditionalRead, FileRead},
};

/// How the browser treats a file.
#[derive(Clone, Copy)]
pub(crate) enum Disposition {
    /// Shown in the page, such as an image or a source view.
    Inline,
    /// Saved as a file.
    Attachment,
}

/// What caches may do with a file.
pub(crate) enum Caching {
    /// Keep nothing. Downloads ignore validators, so they always send bytes.
    NoStore,
    /// Keep it, but check this ETag with the server before each use. A
    /// request's `If-None-Match: *` matches any current file.
    Revalidate(String),
}

/// The `If-None-Match` of a request that may revalidate.
pub(crate) fn validator(request: &HeaderMap) -> Option<String> {
    request
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Refuses requests that would load a file as code or a plugin.
pub(crate) fn require_safe_destination(request: &HeaderMap) -> AppResult<()> {
    if request
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| {
            matches!(
                value,
                "script"
                    | "worker"
                    | "sharedworker"
                    | "serviceworker"
                    | "style"
                    | "object"
                    | "embed"
            )
        })
    {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

/// A 200 response with the whole file in `body`.
pub(crate) fn full(
    body: Body,
    length: u64,
    media_type: &str,
    name: &str,
    disposition: Disposition,
    caching: Caching,
) -> AppResult<Response> {
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(media_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::CONTENT_DISPOSITION,
        content_disposition(name, disposition)?,
    );
    protect(headers, caching);
    Ok(response)
}

/// The answer to a request whose copy is current.
pub(crate) fn not_modified(etag: String) -> Response {
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    protect(response.headers_mut(), Caching::Revalidate(etag));
    response
}

/// A leased attachment or avatar. With the `request`, the response offers
/// byte ranges and sends the one range the request asks for.
pub(crate) async fn leased(
    mut read: FileRead,
    request: Option<&HeaderMap>,
    disposition: Disposition,
    caching: Caching,
) -> AppResult<Response> {
    let size = read
        .byte_limit
        .map_or(read.size, |limit| read.size.min(limit));
    let range = request.map_or(SingleRange::Ignore, |request| {
        requested_range(request, size, &caching)
    });
    let (start, length) = match range {
        SingleRange::Ignore => (0, size),
        SingleRange::Range(start, end) => (start, end - start + 1),
        SingleRange::Unsatisfiable => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{size}")).expect("integer content range"),
            );
            protect(headers, caching);
            return Ok(response);
        }
    };
    if start > 0 {
        read.file.seek(SeekFrom::Start(start)).await?;
    }
    let stream = ReaderStream::with_capacity(read.file.take(length), 64 * 1024);
    let mut response = full(
        Body::from_stream(stream),
        length,
        &read.media_type,
        &read.name,
        disposition,
        caching,
    )?;
    let headers = response.headers_mut();
    if request.is_some() {
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }
    if let SingleRange::Range(start, end) = range {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
                .expect("integer range header"),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}

/// A preview that caches revalidate: the file shown inline, or 304.
pub(crate) async fn conditional(read: ConditionalRead, request: &HeaderMap) -> AppResult<Response> {
    match read {
        ConditionalRead::NotModified(etag) => Ok(not_modified(etag)),
        ConditionalRead::Modified(read) => {
            let caching = Caching::Revalidate(read.etag.clone());
            leased(*read, Some(request), Disposition::Inline, caching).await
        }
    }
}

/// Sanitized HTML for the preview frame of an attachment or Knowledge file.
/// It runs in an opaque origin without scripts, forms, popups or plugins, and
/// loads nothing from other sites: only inline styles, and images and fonts
/// embedded as data. The app's own `frame-src 'self'` stops the framed page
/// from navigating to other sites; without scripts, the page opened on its own
/// navigates only when someone follows a link.
pub(crate) fn html_preview(bytes: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=()",
        ),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; \
             font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        ),
    );
    headers.insert("x-dns-prefetch-control", HeaderValue::from_static("off"));
    response
}

/// The headers that every file response carries, whatever its status.
fn protect(headers: &mut HeaderMap, caching: Caching) {
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    let cache_control = match caching {
        Caching::NoStore => "private, no-store",
        Caching::Revalidate(etag) => {
            headers.insert(
                header::ETAG,
                HeaderValue::from_str(&etag).expect("checksum ETag"),
            );
            "private, no-cache"
        }
    };
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
}

#[derive(Debug, PartialEq, Eq)]
enum SingleRange {
    Ignore,
    Unsatisfiable,
    Range(u64, u64),
}

/// The one byte range of a file of `size` bytes that `request` asks for.
fn requested_range(request: &HeaderMap, size: u64, caching: &Caching) -> SingleRange {
    // A stale If-Range asks for the whole file, not a part of it.
    if let Caching::Revalidate(etag) = caching
        && request
            .get(header::IF_RANGE)
            .is_some_and(|value| value.to_str().ok() != Some(etag))
    {
        return SingleRange::Ignore;
    }
    if request.get_all(header::RANGE).iter().count() > 1 {
        return SingleRange::Ignore;
    }
    parse_single_range(request.get(header::RANGE), size)
}

fn parse_single_range(value: Option<&HeaderValue>, size: u64) -> SingleRange {
    let Some(raw) = value
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
    else {
        return SingleRange::Ignore;
    };
    let Some((start, end)) = raw.split_once('-') else {
        return SingleRange::Ignore;
    };
    if (start.is_empty() && end.is_empty())
        || !start.bytes().chain(end.bytes()).all(|b| b.is_ascii_digit())
    {
        return SingleRange::Ignore;
    }
    // Decimal values larger than u64 are valid syntax. Saturation preserves
    // suffix/end clipping and makes an enormous start unsatisfiable.
    let number = |s: &str| s.parse::<u64>().unwrap_or(u64::MAX);
    if start.is_empty() {
        let suffix = number(end);
        if size == 0 || suffix == 0 {
            return SingleRange::Unsatisfiable;
        }
        return SingleRange::Range(size.saturating_sub(suffix), size - 1);
    }
    let start = number(start);
    let end = if end.is_empty() {
        u64::MAX
    } else {
        number(end)
    };
    if start > end {
        return SingleRange::Ignore;
    }
    if start >= size {
        return SingleRange::Unsatisfiable;
    }
    SingleRange::Range(start, end.min(size - 1))
}

fn content_disposition(name: &str, disposition: Disposition) -> AppResult<HeaderValue> {
    // Old uploads may predate filename validation. Do not propagate directional
    // overrides to download-manager labels; preserve ordinary RTL and joiners.
    let name: String = name
        .chars()
        .filter(|c| {
            !matches!(c,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let fallback: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && !matches!(c, '"' | '\\' | '/' | ';') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if fallback.trim().is_empty() {
        "download"
    } else {
        &fallback
    };
    let encoded = name
        .as_bytes()
        .iter()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric()
                || matches!(
                    *byte,
                    b'!' | b'#'
                        | b'$'
                        | b'&'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
            {
                vec![(*byte as char).to_string()]
            } else {
                vec![format!("%{byte:02X}")]
            }
        })
        .collect::<String>();
    let kind = match disposition {
        Disposition::Inline => "inline",
        Disposition::Attachment => "attachment",
    };
    HeaderValue::from_str(&format!(
        "{kind}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .map_err(|error| AppError::internal(format!("content disposition failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_bounded_and_single() {
        let exact = HeaderValue::from_static("bytes=10-19");
        assert_eq!(
            parse_single_range(Some(&exact), 100),
            SingleRange::Range(10, 19)
        );
        let suffix = HeaderValue::from_static("bytes=-10");
        assert_eq!(
            parse_single_range(Some(&suffix), 100),
            SingleRange::Range(90, 99)
        );
        for raw in [
            "bytes=0-1,4-5",
            "items=0-1",
            "bytes=9-3",
            "bytes=abc",
            "bytes=+1-2",
            "bytes=-",
        ] {
            assert_eq!(
                parse_single_range(Some(&HeaderValue::from_str(raw).unwrap()), 100),
                SingleRange::Ignore
            );
        }
        for raw in ["bytes=100-", "bytes=-0", "bytes=999999999999999999999999-"] {
            assert_eq!(
                parse_single_range(Some(&HeaderValue::from_str(raw).unwrap()), 100),
                SingleRange::Unsatisfiable
            );
        }
        assert_eq!(
            parse_single_range(Some(&HeaderValue::from_bytes(b"bytes=\xff").unwrap()), 100),
            SingleRange::Ignore
        );
        assert_eq!(
            parse_single_range(Some(&exact), 0),
            SingleRange::Unsatisfiable
        );
    }

    #[test]
    fn filenames_are_encoded_in_content_disposition() {
        let value = content_disposition("report \"final\".pdf", Disposition::Attachment)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(value.starts_with("attachment;"));
        assert!(value.contains("report%20%22final%22.pdf"));
        assert!(value.contains("filename=\"report _final_.pdf\""));
        let unicode = content_disposition("Résumé;\\\r\n.pdf", Disposition::Attachment).unwrap();
        assert!(
            unicode
                .to_str()
                .unwrap()
                .contains("filename=\"R_sum_____.pdf\"")
        );
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config { failure_persistence: None, ..proptest::test_runner::Config::default() })]
        #[test]
        fn generated_ranges_are_bounded(size in proptest::prelude::any::<u64>(), start in proptest::prelude::any::<u64>(), end in proptest::prelude::any::<u64>(), form in 0u8..4) {
            let raw = match form { 0 => format!("bytes={start}-{end}"), 1 => format!("bytes=-{end}"), 2 => format!("bytes={start}-"), _ => format!("bytes={start}-{end},0-1") };
            if let SingleRange::Range(s,e) = parse_single_range(Some(&raw.parse().unwrap()), size) {
                proptest::prop_assert!(s <= e && e < size);
            }
        }
    }
}
