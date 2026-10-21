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
    disk::DiskAdmission,
    error::RuleKind,
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
/// page keeps one of its person's places for pages being sent.
pub struct CleanedPage {
    file: tokio::fs::File,
    len: u64,
    _sending: Place,
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

/// Pages one person may have being sent at once: enough for a second tab or
/// device, and for an old connection that stalled.
const PAGES_SENT_EACH: usize = 3;

/// What a person hears when all their pages are on the way.
const STILL_LOADING: &str = "your other HTML previews are still loading; try again shortly";
/// What a person hears when a page waited too long, as the lane says it.
const BUSY: &str = "HTML preview is busy; try again shortly";

/// The people with HTML previews under way, of attachments or of Knowledge
/// files.
#[derive(Clone)]
pub(crate) struct Previewers {
    /// One page each that waits for its turn or is cleaned.
    preparing: PerPerson,
    /// Pages from their first wait until their response ends.
    sending: PerPerson,
}

impl Default for Previewers {
    fn default() -> Self {
        Self {
            preparing: PerPerson::new(usize::MAX),
            sending: PerPerson::with_places(PAGES_SENT_EACH, usize::MAX),
        }
    }
}

/// A turn to read and clean one page, and its person's places.
pub(crate) struct PreviewTurn {
    preparing: Place,
    sending: Place,
    turn: Turn,
}

/// A turn to read and clean a page for `user_id`, one of `previewers`.
/// Attachments and Knowledge files share two turns, so however many previews
/// open at once, at most two pages are in memory. Each person has one page of
/// each in the queue or being cleaned, and their next one waits for it; they
/// have at most three on the way, and another is told at once to try again.
/// A page that waits five seconds in all is told the server is busy.
pub(crate) async fn html_preview_turn(
    previewers: &Previewers,
    user_id: &str,
) -> AppResult<PreviewTurn> {
    static PREVIEWS: LazyLock<Lane> = LazyLock::new(|| Lane::new("HTML preview", 2));
    let deadline = tokio::time::Instant::now() + QUEUE_WAIT;
    let sending = previewers
        .sending
        .claim(user_id)
        .map_err(|_| AppError::Unavailable(STILL_LOADING.into()))?;
    let preparing = previewers
        .preparing
        .claim_by(user_id, deadline)
        .await
        .map_err(|_| AppError::Unavailable(BUSY.into()))?;
    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
    let turn = PREVIEWS.turn_within(left).await?;
    Ok(PreviewTurn {
        preparing,
        sending,
        turn,
    })
}

/// Cleans `bytes`, read in `turn`, into a page in the `folder` for previews,
/// if `disk` has room for it.
pub(crate) async fn cleaned_html_preview(
    turn: PreviewTurn,
    bytes: Vec<u8>,
    folder: std::path::PathBuf,
    disk: DiskAdmission,
) -> AppResult<CleanedPage> {
    let PreviewTurn {
        preparing,
        sending,
        turn,
    } = turn;
    let (file, len) = turn
        .run(move || clean_into_file(&bytes, &folder, &disk))
        .await??;
    drop(preparing);
    Ok(CleanedPage {
        file: tokio::fs::File::from_std(file),
        len,
        _sending: sending,
    })
}

fn clean_into_file(
    bytes: &[u8],
    folder: &Path,
    disk: &DiskAdmission,
) -> AppResult<(std::fs::File, u64)> {
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
    // The written file now takes its space, which the free-space floor sees,
    // so keeping the reservation would count the page twice.
    drop(space);
    Ok((file, len))
}

/// What the preview frame says when `error` stops a preview, in plain words.
pub(crate) fn html_preview_problem(error: &AppError) -> &'static str {
    match error {
        AppError::Unavailable(message) if message == STILL_LOADING => {
            "Your other previews are still loading, maybe in another tab or window."
        }
        AppError::Unavailable(_) => "The server is busy preparing other previews.",
        AppError::StorageFull(_)
        | AppError::Rule {
            kind: RuleKind::StorageFull,
            ..
        } => "The server doesn't have enough free disk space to prepare this preview.",
        AppError::NotFound { .. } => {
            "This file is no longer available. It may have been deleted or changed."
        }
        AppError::Unauthorized => "Your session has ended. Sign in to oneloop again.",
        _ => "This preview can't be shown.",
    }
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
