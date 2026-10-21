//! The lexical pass that HTML previews of attachments and Knowledge files go
//! through before the sandbox of their response headers, and the cleaned
//! pages they send.
use std::{
    io::{self, BufWriter, Seek, Write},
    path::Path,
    pin::Pin,
    sync::LazyLock,
    task::{Context, Poll},
    time::Duration,
};

use tokio::io::{AsyncRead, ReadBuf};

use crate::{
    AppError, AppResult,
    blocking::{Lane, PerPerson, Place, Turn},
    disk::{DiskAdmission, DiskReservation},
};

const NOT_UTF8: &[u8] =
    b"<!doctype html><meta charset=utf-8><p>This HTML file is not valid UTF-8.</p>";

/// Elements that browse or load on their own. `link` also covers hints such
/// as preconnect, which open connections to other sites that the preview's
/// policy may not govern.
const REMOVED: [&str; 9] = [
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "base",
    "link",
    "portal",
    "fencedframe",
];

/// Remove direct-navigation and nested browsing primitives before applying the
/// response-header sandbox. This lexical pass is intentionally conservative;
/// the CSP remains the primary execution boundary. Besides `out`, it needs
/// one byte of memory for each byte of the file.
fn sanitize_html_preview(bytes: &[u8], out: &mut impl Write) -> io::Result<()> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return out.write_all(NOT_UTF8);
    };
    let mut cursor = 0;
    let mut dead_states = vec![0_u8; source.len()];
    while let Some(relative) = source[cursor..].find('<') {
        let start = cursor + relative;
        out.write_all(&bytes[cursor..start])?;
        let Some(tag_end) = find_tag_end(source.as_bytes(), start, &mut dead_states) else {
            out.write_all(b"&lt;")?;
            cursor = start + 1;
            continue;
        };
        let end = tag_end + 1;
        let tag = &source[start + 1..end - 1];
        let normalized = tag.trim_start().trim_start_matches('/').trim_start();
        let name = normalized
            .split(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("");
        let remove = REMOVED
            .iter()
            .any(|removed| name.eq_ignore_ascii_case(removed))
            || (name.eq_ignore_ascii_case("meta")
                && tag
                    .as_bytes()
                    .windows(b"http-equiv".len())
                    .any(|window| window.eq_ignore_ascii_case(b"http-equiv")));
        if !remove {
            out.write_all(&bytes[start..end])?;
        }
        cursor = end;
    }
    out.write_all(&bytes[cursor..])
}

fn find_tag_end(bytes: &[u8], start: usize, dead: &mut [u8]) -> Option<usize> {
    // A failed scan marks the (position, state) pairs it passed as dead, so no
    // later scan passes them again, and successful scans cover disjoint output
    // ranges: total work is O(bytes).
    let mut state = 0;
    let mut stop = bytes.len();
    for (index, &ch) in bytes.iter().enumerate().skip(start + 1) {
        if dead[index] & (1 << state) != 0 {
            stop = index;
            break;
        }
        match next_state(state, ch) {
            Some(next) => state = next,
            None => return Some(index),
        }
    }
    // The scan depends only on the bytes, so a second pass marks the pairs it
    // passed, instead of a list of them that would be as long as the tag. It
    // ends before `stop`, so no byte ends the tag.
    let mut state = 0;
    for (mark, &ch) in dead[start + 1..stop]
        .iter_mut()
        .zip(&bytes[start + 1..stop])
    {
        *mark |= 1 << state;
        state = next_state(state, ch).unwrap_or(state);
    }
    None
}

/// The scanner's state after `ch`, or `None` when `ch` ends the tag. States:
/// attribute/name, after '=', unquoted value, single/double quote.
fn next_state(state: u8, ch: u8) -> Option<u8> {
    Some(match (state, ch) {
        (3, b'\'') | (4, b'"') => 0,
        (3 | 4, _) => state,
        (_, b'>') => return None,
        (1, b'\'') => 3,
        (1, b'"') => 4,
        (1, ch) if ch.is_ascii_whitespace() => 1,
        (1, _) => 2,
        (_, ch) if ch.is_ascii_whitespace() => 0,
        (0, b'=') => 1,
        _ => state,
    })
}

/// A cleaned page for the preview frame, or word that the browser's copy of it
/// is current.
pub enum HtmlPreview {
    NotModified(String),
    Page { page: CleanedPage, etag: String },
}

/// The validator of the cleaned page of a file with this checksum. Another
/// release may clean pages differently, so it doesn't reuse older copies.
pub(crate) fn html_preview_etag(checksum: &str) -> String {
    format!("\"{checksum}-html-{}\"", crate::build_info::VERSION)
}

/// A cleaned page in a file that has no name, so its disk space returns
/// when the page is dropped, however its response ends. A response reads it
/// one buffer at a time, so a slow client holds no more of it in memory. The
/// page keeps its person's place, so no one holds more than one at a time.
pub struct CleanedPage {
    file: tokio::fs::File,
    len: u64,
    _space: DiskReservation,
    _place: Place,
}

impl CleanedPage {
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl AsyncRead for CleanedPage {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_read(context, buffer)
    }
}

/// How long a preview waits for its turn before it is told to try again.
const QUEUE_WAIT: Duration = Duration::from_secs(5);

/// A turn to read and clean one page, and its person's place in the queue.
pub(crate) struct PreviewTurn {
    _place: Place,
    turn: Turn,
}

/// A turn to read and clean a page for `user_id`, one of `previewers`.
/// Attachments and Knowledge files share two turns, so however many previews
/// open at once, at most two pages are in memory. Each person has one
/// preview of each that waits, is cleaned or is being sent, and a preview
/// that waits five seconds is told to try again.
pub(crate) async fn html_preview_turn(
    previewers: &PerPerson,
    user_id: &str,
) -> AppResult<PreviewTurn> {
    static PREVIEWS: LazyLock<Lane> = LazyLock::new(|| Lane::new("HTML preview", 2));
    let place = previewers.claim(user_id).map_err(|_| {
        AppError::Unavailable(
            "your previous HTML preview is still loading; try again shortly".into(),
        )
    })?;
    let turn = PREVIEWS.turn_within(QUEUE_WAIT).await?;
    Ok(PreviewTurn {
        _place: place,
        turn,
    })
}

/// Cleans `bytes`, read in `turn`, into a page in the `folder` for previews.
/// The page takes disk space from `disk` until it is dropped.
pub(crate) async fn cleaned_html_preview(
    turn: PreviewTurn,
    bytes: Vec<u8>,
    folder: std::path::PathBuf,
    disk: DiskAdmission,
) -> AppResult<CleanedPage> {
    let PreviewTurn {
        _place: place,
        turn,
    } = turn;
    let (file, len, space) = turn
        .run(move || clean_into_file(&bytes, &folder, &disk))
        .await??;
    Ok(CleanedPage {
        file: tokio::fs::File::from_std(file),
        len,
        _space: space,
        _place: place,
    })
}

fn clean_into_file(
    bytes: &[u8],
    folder: &Path,
    disk: &DiskAdmission,
) -> AppResult<(std::fs::File, u64, DiskReservation)> {
    // Each escaped `<` grows by three bytes; nothing else grows.
    let brackets = bytes.iter().filter(|byte| **byte == b'<').count();
    let most = bytes.len() + 3 * brackets + NOT_UTF8.len();
    let space = disk.reserve(most as u64)?;
    let mut file = unnamed_file(folder)?;
    let mut out = BufWriter::with_capacity(64 * 1024, &mut file);
    sanitize_html_preview(bytes, &mut out)?;
    out.flush()?;
    drop(out);
    let len = file.stream_position()?;
    file.rewind()?;
    Ok((file, len, space))
}

/// A new private file in `folder` whose name is removed at once. If a crash
/// or a failed removal keeps the name, the hourly scan of the previews folder
/// removes the file, as it isn't a thumbnail.
fn unnamed_file(folder: &Path) -> io::Result<std::fs::File> {
    let path = folder.join(format!("{}.html-preview", uuid::Uuid::now_v7()));
    let file = crate::db::private_file_options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)?;
    // That scan may already have removed it.
    match std::fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(file),
    }
}

#[cfg(test)]
mod tests;
