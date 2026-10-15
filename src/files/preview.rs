//! The lexical pass that HTML previews of attachments and Knowledge files go
//! through before the sandbox of their response headers.
use std::sync::LazyLock;

use crate::{AppResult, blocking::Lane};

/// Remove direct-navigation and nested browsing primitives before applying the
/// response-header sandbox. This lexical pass is intentionally conservative;
/// the CSP remains the primary execution boundary.
pub fn sanitize_html_preview(bytes: &[u8]) -> Vec<u8> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return b"<!doctype html><meta charset=utf-8><p>This HTML file is not valid UTF-8.</p>"
            .to_vec();
    };
    let mut output = String::with_capacity(source.len());
    let lower = source.to_ascii_lowercase();
    let mut cursor = 0;
    let mut dead_states = vec![0_u8; source.len()];
    let mut visited = Vec::new();
    while let Some(relative) = lower[cursor..].find('<') {
        let start = cursor + relative;
        output.push_str(&source[cursor..start]);
        let Some(tag_end) = find_tag_end(source.as_bytes(), start, &mut dead_states, &mut visited)
        else {
            output.push_str("&lt;");
            cursor = start + 1;
            continue;
        };
        let end = tag_end + 1;
        let tag = &lower[start + 1..end - 1];
        let normalized = tag.trim_start().trim_start_matches('/').trim_start();
        let name = normalized
            .split(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("");
        // `link` also covers hints such as preconnect, which open connections
        // to other sites that the preview's policy may not govern.
        let remove = matches!(
            name,
            "iframe"
                | "frame"
                | "frameset"
                | "object"
                | "embed"
                | "base"
                | "link"
                | "portal"
                | "fencedframe"
        ) || (name == "meta" && tag.contains("http-equiv"));
        if !remove {
            output.push_str(&source[start..end]);
        }
        cursor = end;
    }
    output.push_str(&source[cursor..]);
    output.into_bytes()
}

fn find_tag_end(
    bytes: &[u8],
    start: usize,
    dead: &mut [u8],
    visited: &mut Vec<(usize, u8)>,
) -> Option<usize> {
    // States: attribute/name, after '=', unquoted value, single/double quote.
    // Failed (position, state) pairs are visited at most once across all tags.
    // Successful scans cover disjoint output ranges, so total work is O(bytes).
    let mut state = 0;
    visited.clear();
    for (index, &ch) in bytes.iter().enumerate().skip(start + 1) {
        let bit = 1 << state;
        if dead[index] & bit != 0 {
            break;
        }
        visited.push((index, bit));
        state = match (state, ch) {
            (3, b'\'') | (4, b'"') => 0,
            (3 | 4, _) => state,
            (_, b'>') => return Some(index),
            (1, b'\'') => 3,
            (1, b'"') => 4,
            (1, ch) if ch.is_ascii_whitespace() => 1,
            (1, _) => 2,
            (_, ch) if ch.is_ascii_whitespace() => 0,
            (0, b'=') => 1,
            _ => state,
        };
    }
    for &(index, bit) in visited.iter() {
        dead[index] |= bit;
    }
    None
}

/// Sanitize HTML for the sandboxed preview frame, at most two files at once,
/// attachments and Knowledge files together.
pub(crate) async fn sanitized_html_preview(bytes: Vec<u8>) -> AppResult<Vec<u8>> {
    static PREVIEWS: LazyLock<Lane> = LazyLock::new(|| Lane::new("HTML preview", 2));
    PREVIEWS.run(move || sanitize_html_preview(&bytes)).await
}
