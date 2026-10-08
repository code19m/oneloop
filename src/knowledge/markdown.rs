//! A small reading of Markdown structure for search and MCP: headings,
//! sections and plain text. Rendering stays in the browser, which gives
//! headings the same anchors with a port of these rules (`file-views.js`).

use std::collections::HashMap;

use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Heading {
    pub(crate) level: u8,
    pub(crate) text: String,
    pub(crate) anchor: String,
}

/// Text under one heading, down to the next heading of any level. The first
/// section has no heading when the document starts with text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Section {
    pub(crate) heading: Option<Heading>,
    /// Byte range of the section in the source, heading line included.
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) text: String,
}

/// Split a document into sections. Fenced code belongs to its section's text
/// but never starts a section.
pub(crate) fn sections(source: &str) -> Vec<Section> {
    split(source, true)
}

/// The sections of a document without their text, for readers that need only
/// the headings and where each section is.
pub(crate) fn outline(source: &str) -> Vec<Section> {
    split(source, false)
}

/// Sections read from one document. Each costs some memory however short it
/// is, so a document of nothing but headings stops here; the rest of it is
/// left out.
const SECTIONS_MAX: usize = 5_000;

/// Bytes of a heading that are read. Each mark in them costs memory while
/// they are read, and headings go into search results and MCP replies, so a
/// long heading line is read only up to here.
pub(crate) const HEADING_BYTES_MAX: usize = 1_024;

/// The start of a heading's source, cut at a character boundary.
fn heading_source(text: &str) -> &str {
    let mut end = text.len().min(HEADING_BYTES_MAX);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Reads the document a line at a time, so a long document costs memory for
/// its sections, not for its lines.
fn split(source: &str, with_text: bool) -> Vec<Section> {
    let mut lines = lines_with_offsets(source).peekable();
    let mut sections = Vec::new();
    let mut current = Section {
        heading: None,
        start: 0,
        end: 0,
        text: String::new(),
    };
    let mut fence: Option<(char, usize)> = None;
    let mut body = Plain::default();
    while let Some((offset, line)) = lines.next() {
        if let Some((marker, length)) = fence {
            if closes_fence(line, marker, length) {
                fence = None;
            } else if with_text {
                body.push(line);
            }
            continue;
        }
        if let Some(opened) = opens_fence(line) {
            fence = Some(opened);
            continue;
        }
        let setext = lines.peek().and_then(|(_, next)| setext_level(line, next));
        let atx = atx_heading(line);
        let underlined = atx.is_none() && setext.is_some();
        let heading = atx.or_else(|| {
            setext.map(|level| Heading {
                level,
                text: inline_text(heading_source(line.trim())),
                anchor: String::new(),
            })
        });
        if let Some(heading) = heading {
            current.end = offset;
            current.text = body.take();
            if current.heading.is_some() || !current.text.is_empty() {
                sections.push(current);
            }
            if sections.len() == SECTIONS_MAX {
                return anchored(sections);
            }
            current = Section {
                heading: Some(heading),
                start: offset,
                end: source.len(),
                text: String::new(),
            };
            if underlined {
                lines.next();
            }
            continue;
        }
        if with_text {
            body.push(line);
        }
    }
    current.end = source.len();
    current.text = body.take();
    if current.heading.is_some() || !current.text.is_empty() {
        sections.push(current);
    }
    anchored(sections)
}

/// Gives each heading its link anchor, made unique within the document.
fn anchored(mut sections: Vec<Section>) -> Vec<Section> {
    let mut occurrences = std::collections::HashMap::new();
    let mut used = std::collections::HashSet::new();
    for heading in sections
        .iter_mut()
        .filter_map(|section| section.heading.as_mut())
    {
        let base = slug(&heading.text);
        let count = occurrences.entry(base.clone()).or_insert(0);
        loop {
            let anchor = if *count == 0 {
                base.clone()
            } else {
                format!("{base}-{count}")
            };
            *count += 1;
            if used.insert(anchor.clone()) {
                heading.anchor = anchor;
                break;
            }
        }
    }
    sections
}

/// The document title: its first level-one heading.
pub(crate) fn title(sections: &[Section]) -> Option<String> {
    sections
        .iter()
        .filter_map(|section| section.heading.as_ref())
        .find(|heading| heading.level == 1)
        .map(|heading| heading.text.clone())
        .filter(|text| !text.is_empty())
}

/// The source of the section whose heading matches `query`, case-insensitively
/// or by its link anchor, through the end of its subsections.
pub(crate) fn section_source<'a>(
    source: &'a str,
    sections: &[Section],
    query: &str,
) -> Option<&'a str> {
    let query = query.trim().to_lowercase();
    let anchor_position = |anchor: &str| {
        sections.iter().position(|section| {
            section
                .heading
                .as_ref()
                .is_some_and(|heading| heading.anchor == anchor)
        })
    };
    let position = if let Some(fragment) = query.strip_prefix("#md-") {
        // An explicit browser fragment includes the DOM's namespace prefix.
        anchor_position(fragment)
    } else {
        let wanted = query.trim_start_matches('#').trim();
        anchor_position(wanted)
            .or_else(|| wanted.strip_prefix("md-").and_then(anchor_position))
            .or_else(|| {
                sections.iter().position(|section| {
                    section
                        .heading
                        .as_ref()
                        .is_some_and(|heading| heading.text.to_lowercase() == wanted)
                })
            })
    }?;
    let level = sections[position].heading.as_ref()?.level;
    let end = sections[position + 1..]
        .iter()
        .find(|section| {
            section
                .heading
                .as_ref()
                .is_some_and(|heading| heading.level <= level)
        })
        .map_or(source.len(), |section| section.start);
    source.get(sections[position].start..end)
}

/// A heading's anchor, by the rules the browser applies too (`file-views.js`):
/// lower case; letters, marks, numbers, connector punctuation such as `_`, and
/// `-` kept; each whitespace character turned into `-`; everything else left
/// out.
pub(crate) fn slug(text: &str) -> String {
    let categories = CodePointMapData::<GeneralCategory>::new();
    let kept = GeneralCategoryGroup::Letter
        .union(GeneralCategoryGroup::Mark)
        .union(GeneralCategoryGroup::Number)
        .union(GeneralCategoryGroup::ConnectorPunctuation);
    text.to_lowercase()
        .chars()
        .filter_map(|c| {
            if c.is_whitespace() {
                Some('-')
            } else {
                (c == '-' || kept.contains(categories.get(c))).then_some(c)
            }
        })
        .collect()
}

fn lines_with_offsets(source: &str) -> impl Iterator<Item = (usize, &str)> {
    // A byte order mark is not part of the first line.
    let (mut offset, source) = match source.strip_prefix('\u{feff}') {
        Some(rest) => ('\u{feff}'.len_utf8(), rest),
        None => (0, source),
    };
    source.split_inclusive('\n').map(move |line| {
        let start = offset;
        offset += line.len();
        (start, line.trim_end_matches(['\n', '\r']))
    })
}

fn indent(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3).then_some(trimmed)
}

fn opens_fence(line: &str) -> Option<(char, usize)> {
    let trimmed = indent(line)?;
    let marker = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let length = trimmed.chars().take_while(|c| *c == marker).count();
    (length >= 3 && !(marker == '`' && trimmed[length..].contains('`'))).then_some((marker, length))
}

fn closes_fence(line: &str, marker: char, length: usize) -> bool {
    indent(line).is_some_and(|trimmed| {
        let run = trimmed.chars().take_while(|c| *c == marker).count();
        run >= length && trimmed[run * marker.len_utf8()..].trim().is_empty()
    })
}

fn atx_heading(line: &str) -> Option<Heading> {
    let trimmed = indent(line)?;
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let mut text = rest.trim();
    let without_closing = text.trim_end_matches('#');
    if without_closing.len() != text.len()
        && (without_closing.is_empty() || without_closing.ends_with([' ', '\t']))
    {
        text = without_closing.trim_end();
    }
    Some(Heading {
        level: level as u8,
        text: inline_text(heading_source(text)),
        anchor: String::new(),
    })
}

fn setext_level(line: &str, next: &str) -> Option<u8> {
    let text = indent(line)?;
    if text.trim().is_empty()
        || text.starts_with(['#', '>', '-', '*', '+', '|', '`', '~', '<'])
        || text.chars().next().is_some_and(|c| c.is_ascii_digit()) && text.contains(". ")
    {
        return None;
    }
    let underline = indent(next)?.trim_end();
    if underline.is_empty() {
        return None;
    }
    if underline.chars().all(|c| c == '=') {
        Some(1)
    } else if underline.chars().all(|c| c == '-') {
        Some(2)
    } else {
        None
    }
}

/// Text a reader sees in one line of inline Markdown, by the rules the
/// browser applies too (`file-views.js`): links and images keep their text,
/// tags and code marks go, emphasis marks go when they pair up, escapes and
/// common entities are decoded, and runs of whitespace become one space.
pub(crate) fn inline_text(value: &str) -> String {
    let mut pieces = pieces(value);
    pair_emphasis(&mut pieces);
    // Runs of whitespace become one space, and none is left at either end.
    let mut out = String::with_capacity(value.len());
    let mut space = false;
    let mut push = |c: char| {
        if c.is_whitespace() {
            space = !out.is_empty();
        } else {
            if std::mem::take(&mut space) {
                out.push(' ');
            }
            out.push(c);
        }
    };
    for piece in pieces {
        match piece {
            Piece::Source(start, end) => value[start..end].chars().for_each(&mut push),
            Piece::Decoded(c) => push(c),
            Piece::Run { star, left, .. } => {
                for _ in 0..left {
                    push(if star { '*' } else { '_' });
                }
            }
        }
    }
    out
}

/// The pieces of one line of inline Markdown, in order. Text between marks is
/// one piece, so a long line of prose holds a few pieces, not one for each
/// character. Every mark is ASCII, so the line is read by bytes, and an index
/// where a mark is found is always a character boundary.
fn pieces(value: &str) -> Vec<Piece> {
    let bytes = value.as_bytes();
    let mut closers = Closers::new(bytes);
    let mut pieces = Vec::new();
    // Where a link's text ends, and where reading resumes after its target.
    let mut link_ends = HashMap::new();
    // Where the text not yet in a piece starts.
    let mut text = 0;
    let mut index = 0;
    // Ends the text before `index`, which the mark there replaces.
    let flush = |pieces: &mut Vec<Piece>, text: usize, index: usize| {
        if text < index {
            pieces.push(Piece::Source(text, index));
        }
    };
    while index < bytes.len() {
        if let Some(resume) = link_ends.remove(&index) {
            flush(&mut pieces, text, index);
            index = resume;
            text = index;
            continue;
        }
        let c = bytes[index];
        match c {
            b'!' if bytes.get(index + 1) == Some(&b'[') => {
                flush(&mut pieces, text, index);
                index += 1;
                text = index;
            }
            b'[' => {
                if let Some(close) = closers.next(index + 1, b']') {
                    let resume = match bytes.get(close + 1) {
                        Some(b'(') => closers
                            .next(close + 2, b')')
                            .map_or(bytes.len(), |end| end + 1),
                        Some(b'[') => closers
                            .next(close + 2, b']')
                            .map_or(bytes.len(), |end| end + 1),
                        _ => close + 1,
                    };
                    link_ends.insert(close, resume);
                    flush(&mut pieces, text, index);
                    text = index + 1;
                }
                index += 1;
            }
            b'<' => match closers.next(index + 1, b'>') {
                Some(end)
                    if bytes
                        .get(index + 1)
                        .is_some_and(|next| next.is_ascii_alphabetic() || *next == b'/') =>
                {
                    flush(&mut pieces, text, index);
                    let inner = &value[index + 1..end];
                    if inner.contains('@') || inner.contains("://") {
                        pieces.push(Piece::Source(index + 1, end));
                    }
                    index = end + 1;
                    text = index;
                }
                _ => index += 1,
            },
            b'`' => {
                flush(&mut pieces, text, index);
                index += 1;
                text = index;
            }
            b'~' if bytes.get(index + 1) == Some(&b'~') => {
                flush(&mut pieces, text, index);
                index += 2;
                text = index;
            }
            b'\\'
                if bytes
                    .get(index + 1)
                    .is_some_and(|next| next.is_ascii_punctuation()) =>
            {
                flush(&mut pieces, text, index);
                pieces.push(Piece::Source(index + 1, index + 2));
                index += 2;
                text = index;
            }
            b'&' => {
                if let Some((decoded, length)) = entity(&bytes[index..]) {
                    flush(&mut pieces, text, index);
                    pieces.push(Piece::Decoded(decoded));
                    index += length;
                    text = index;
                } else {
                    index += 1;
                }
            }
            b'*' | b'_' => {
                flush(&mut pieces, text, index);
                let length = bytes[index..].iter().take_while(|next| **next == c).count();
                let (before, after) = (
                    value[..index].chars().next_back(),
                    value[index + length..].chars().next(),
                );
                let left = flanking(after, before);
                let right = flanking(before, after);
                let (open, close) = if c == b'*' {
                    (left, right)
                } else {
                    (
                        left && (!right || before.is_some_and(is_punctuation)),
                        right && (!left || after.is_some_and(is_punctuation)),
                    )
                };
                pieces.push(Piece::Run {
                    star: c == b'*',
                    left: u32::try_from(length).unwrap_or(u32::MAX),
                    open,
                    close,
                });
                index += length;
                text = index;
            }
            _ => index += 1,
        }
    }
    flush(&mut pieces, text, bytes.len());
    pieces
}

/// Part of a line as the reader sees it.
enum Piece {
    /// The source bytes from one offset to another, as written.
    Source(usize, usize),
    /// A character written as an entity.
    Decoded(char),
    /// A run of `*` (or `_`), with the marks not yet paired.
    Run {
        star: bool,
        left: u32,
        open: bool,
        close: bool,
    },
}

/// A delimiter run is left-flanking when `next` is not whitespace and is not
/// punctuation unless `previous` is whitespace or punctuation; swap the two for
/// right-flanking. Line ends count as whitespace.
fn flanking(next: Option<char>, previous: Option<char>) -> bool {
    next.is_some_and(|next| {
        !next.is_whitespace()
            && (!is_punctuation(next)
                || previous
                    .is_none_or(|previous| previous.is_whitespace() || is_punctuation(previous)))
    })
}

fn is_punctuation(c: char) -> bool {
    let category = CodePointMapData::<GeneralCategory>::new().get(c);
    GeneralCategoryGroup::Punctuation
        .union(GeneralCategoryGroup::Symbol)
        .contains(category)
}

/// Remove emphasis marks that pair up, nearest opener first, as CommonMark
/// does without its finer rules. Unpaired marks stay as text. Each opener is
/// paired or dropped once, so this is linear.
fn pair_emphasis(pieces: &mut [Piece]) {
    let mut openers: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
    for index in 0..pieces.len() {
        let Piece::Run {
            star, open, close, ..
        } = pieces[index]
        else {
            continue;
        };
        let (same, other) = if star { (0, 1) } else { (1, 0) };
        if close {
            while let Some(&opener) = openers[same].last() {
                let (Piece::Run { left: before, .. }, Piece::Run { left: after, .. }) =
                    (&pieces[opener], &pieces[index])
                else {
                    unreachable!("openers are runs");
                };
                let used = (*before).min(*after);
                if used == 0 {
                    break;
                }
                for at in [opener, index] {
                    if let Piece::Run { left, .. } = &mut pieces[at] {
                        *left -= used;
                    }
                }
                // Openers of the other mark inside the pair can't close anymore.
                while openers[other].last().is_some_and(|inner| *inner > opener) {
                    openers[other].pop();
                }
                if matches!(pieces[opener], Piece::Run { left: 0, .. }) {
                    openers[same].pop();
                }
            }
        }
        if open && matches!(pieces[index], Piece::Run { left: 1.., .. }) {
            openers[same].push(index);
        }
    }
}

/// A character reference at the start of `bytes`: a decimal or hexadecimal
/// number, or one of the names common in prose. Returns it and its length.
/// A reference is ASCII, so its length in bytes is its length in characters.
fn entity(bytes: &[u8]) -> Option<(char, usize)> {
    let end = bytes.iter().take(34).position(|c| *c == b';')?;
    let body = std::str::from_utf8(&bytes[1..end]).ok()?;
    let decoded = if let Some(number) = body.strip_prefix('#') {
        let (digits, radix) = match number.strip_prefix(['x', 'X']) {
            Some(hex) if (1..=6).contains(&hex.len()) => (hex, 16),
            None if (1..=7).contains(&number.len()) => (number, 10),
            _ => return None,
        };
        if !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        u32::from_str_radix(digits, radix)
            .ok()
            .filter(|code| *code != 0)
            .and_then(char::from_u32)
            .unwrap_or('\u{fffd}')
    } else {
        match body {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            "nbsp" => '\u{a0}',
            _ => return None,
        }
    };
    Some((decoded, end + 1))
}

/// The next closing character at or after a position. Each answer is
/// remembered, and the scan only moves forward, so a line full of unclosed
/// brackets still takes linear time.
struct Closers<'a> {
    bytes: &'a [u8],
    memo: Vec<(u8, usize, Option<usize>)>,
    #[cfg(test)]
    scanned: usize,
}

impl<'a> Closers<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            memo: Vec::with_capacity(3),
            #[cfg(test)]
            scanned: 0,
        }
    }

    fn next(&mut self, from: usize, target: u8) -> Option<usize> {
        if let Some((_, start, found)) = self.memo.iter().find(|(c, ..)| *c == target)
            && *start <= from
            && found.is_none_or(|at| at >= from)
        {
            return *found;
        }
        let found = self
            .bytes
            .get(from..)?
            .iter()
            .position(|c| *c == target)
            .map(|offset| from + offset);
        #[cfg(test)]
        {
            self.scanned += found.map_or(self.bytes.len(), |at| at + 1) - from;
        }
        self.memo.retain(|(c, ..)| *c != target);
        self.memo.push((target, from, found));
        found
    }
}

/// Plain text of block lines, added one line at a time: list markers, quotes
/// and table pipes removed.
#[derive(Default)]
struct Plain {
    text: String,
    previous_row: bool,
}

impl Plain {
    fn push(&mut self, line: &str) {
        let mut line = line.trim();
        // Table rows read as one list: cells and rows are both separated by dots.
        let row = line.starts_with('|');
        if line
            .chars()
            .all(|c| matches!(c, '-' | '*' | '_' | '=' | '|' | ':' | ' '))
        {
            return;
        }
        while let Some(rest) = line.strip_prefix('>') {
            line = rest.trim_start();
        }
        for marker in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ "] {
            if let Some(rest) = line.strip_prefix(marker) {
                line = rest;
                break;
            }
        }
        if let Some((number, rest)) = line.split_once(". ")
            && !number.is_empty()
            && number.len() <= 9
            && number.chars().all(|c| c.is_ascii_digit())
        {
            line = rest;
        }
        let cells = line.trim_matches('|');
        let inline = if cells.contains('|') {
            inline_text(&cells.replace('|', " · "))
        } else {
            inline_text(cells)
        };
        if !inline.is_empty() {
            if self.text.is_empty() {
                self.text = inline;
            } else {
                self.text.push_str(if row && self.previous_row {
                    " · "
                } else {
                    " "
                });
                self.text.push_str(&inline);
            }
            self.previous_row = row;
        }
    }

    /// The text so far, leaving the builder empty for the next section.
    fn take(&mut self) -> String {
        self.previous_row = false;
        std::mem::take(&mut self.text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# Payment schedules\n\nA predictable schedule.\n\n## Short months\n\nUse the **last** day.\n\n```text\n# not a heading\n10,000,000 UZS\n```\n\n### Leap years\n\nFebruary 29.\n\nRounding\n--------\n\nSee [the decision](../decisions/004.md).\n";

    #[test]
    fn sections_follow_headings_and_ignore_fenced_code() {
        let sections = sections(DOC);
        let headings: Vec<_> = sections
            .iter()
            .map(|section| section.heading.as_ref().map(|h| (h.level, h.text.as_str())))
            .collect();
        assert_eq!(
            headings,
            [
                Some((1, "Payment schedules")),
                Some((2, "Short months")),
                Some((3, "Leap years")),
                Some((2, "Rounding"))
            ]
        );
        assert_eq!(
            sections[1].text,
            "Use the last day. # not a heading 10,000,000 UZS"
        );
        assert_eq!(sections[3].text, "See the decision.");
        assert_eq!(title(&sections).as_deref(), Some("Payment schedules"));
    }

    #[test]
    fn a_section_includes_its_subsections() {
        let sections = sections(DOC);
        let source = section_source(DOC, &sections, "short months").unwrap();
        assert!(source.starts_with("## Short months"));
        assert!(source.contains("February 29."));
        assert!(!source.contains("Rounding"));
        assert!(
            section_source(DOC, &sections, "#leap-years")
                .unwrap()
                .starts_with("### Leap years")
        );
        assert!(section_source(DOC, &sections, "missing").is_none());
    }

    #[test]
    fn inline_markup_becomes_reader_text() {
        assert_eq!(
            inline_text("**Paid** `rows` and [links](x.md) ![alt](i.png)"),
            "Paid rows and links alt"
        );
        assert_eq!(
            inline_text("snake_case stays, _emphasis_ goes"),
            "snake_case stays, emphasis goes"
        );
        assert_eq!(
            inline_text("<span>tag</span> <https://example.com>"),
            "tag https://example.com"
        );
        assert_eq!(inline_text(r"\*literal\*"), "*literal*");
    }

    #[test]
    fn unclosed_brackets_are_scanned_once() {
        for line in [
            "<".repeat(10_000),
            "[".repeat(10_000),
            "x>[y](".repeat(2_000),
        ] {
            let mut closers = Closers::new(line.as_bytes());
            for index in 0..line.len() {
                for target in [b']', b')', b'>'] {
                    closers.next(index, target);
                }
            }
            assert!(
                closers.scanned <= 3 * (line.len() + 1),
                "{}",
                closers.scanned
            );
        }
        assert_eq!(inline_text(&"<".repeat(1_000)).len(), 1_000);
        assert_eq!(inline_text(" \t a \u{2003} *b*\n c \u{3000}"), "a b c");
        assert_eq!(
            inline_text("[a](b) and 2 < 3 [e] <https://f.test>"),
            "a and 2 < 3 e https://f.test"
        );
    }

    #[test]
    fn reading_costs_memory_for_the_text_not_for_each_character_or_line() {
        use crate::test_memory::peak_heap;
        // A quarter megabyte of prose on one line, as generated pages and
        // tables have.
        let line = "Plain words, and more words. ".repeat(9_000);
        let (text, peak) = peak_heap(|| inline_text(&line));
        assert_eq!(text.len(), line.len() - 1);
        assert!(peak < 2 * line.len(), "{peak} bytes for {}", line.len());
        let (parsed, peak) = peak_heap(|| sections(&line));
        assert_eq!(parsed[0].text, text);
        assert!(peak < 2 * line.len(), "{peak} bytes for {}", line.len());
        // A quarter megabyte of empty lines.
        let blank = "\n".repeat(256 * 1024);
        let (parsed, peak) = peak_heap(|| sections(&blank));
        assert!(parsed.is_empty());
        assert!(peak < 64 * 1024, "{peak} bytes for {}", blank.len());
        // An outline leaves the text out.
        let document = format!("# Title\n\n{line}");
        let (parsed, peak) = peak_heap(|| outline(&document));
        assert_eq!(parsed[0].heading.as_ref().unwrap().text, "Title");
        assert!(parsed[0].text.is_empty());
        assert!(peak < 64 * 1024, "{peak} bytes for {}", document.len());
    }

    #[test]
    fn a_long_heading_is_read_up_to_its_limit() {
        use crate::test_memory::peak_heap;
        // A megabyte of emphasis marks, each of which costs memory to pair.
        let marks = "*a".repeat(512 * 1024);
        for document in [format!("# {marks}\n\nText.\n"), format!("a{marks}\n===\n")] {
            let (parsed, peak) = peak_heap(|| outline(&document));
            let heading = parsed[0].heading.as_ref().unwrap();
            assert!((1..=HEADING_BYTES_MAX).contains(&heading.text.len()));
            assert!(peak < 128 * 1024, "{peak} bytes");
        }
        // A cut never splits a character.
        let wide = format!("# a{}\n", "é".repeat(HEADING_BYTES_MAX));
        let heading = outline(&wide).remove(0).heading.unwrap();
        assert_eq!(heading.text.len(), HEADING_BYTES_MAX - 1);
    }

    #[test]
    fn a_document_of_headings_is_read_up_to_its_section_limit() {
        let headings = "# Title\n\n".to_owned() + &"## Step\nDone.\n".repeat(200_000);
        let (parsed, peak) = crate::test_memory::peak_heap(|| outline(&headings));
        assert_eq!(parsed.len(), SECTIONS_MAX);
        let last = &parsed[SECTIONS_MAX - 1];
        assert_eq!(last.heading.as_ref().unwrap().anchor, "step-4998");
        assert_eq!(&headings[last.start..last.end], "## Step\nDone.\n");
        assert!(peak < 2 * 1024 * 1024, "{peak} bytes");
    }

    #[test]
    fn table_cells_and_rows_read_as_one_list() {
        let text = "| Day | Due |\n| --- | --- |\n| 31 | 30 |\n| 30 | 28 |\n\nAfter the table.\n";
        assert_eq!(
            sections(text)[0].text,
            "Day · Due · 31 · 30 · 30 · 28 After the table."
        );
    }

    #[test]
    fn anchors_match_the_browser() {
        assert_eq!(slug("Short months"), "short-months");
        assert_eq!(slug("What’s next? (v2)"), "whats-next-v2");
        assert_eq!(slug("To‘lov jadvali"), "tolov-jadvali");
        assert_eq!(slug("Оплата и сроки"), "оплата-и-сроки");
        for (source, expected) in [
            (
                "## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n\n## Setup-1\n\nThird.\n",
                vec!["setup", "setup-1", "setup-1-1"],
            ),
            (
                "## Setup-1\n\nFirst.\n\n## Setup\n\nSecond.\n\n## Setup\n\nThird.\n",
                vec!["setup-1", "setup", "setup-2"],
            ),
        ] {
            let parsed = sections(source);
            assert_eq!(
                parsed
                    .iter()
                    .filter_map(|s| s.heading.as_ref().map(|h| h.anchor.as_str()))
                    .collect::<Vec<_>>(),
                expected
            );
            for (section, anchor) in parsed.iter().zip(expected) {
                assert_eq!(
                    section_source(source, &parsed, anchor),
                    Some(&source[section.start..section.end])
                );
            }
        }
    }

    #[test]
    fn anchors_match_the_shared_browser_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../frontend/tests/support/fixtures/heading-anchors.json"
        ))
        .unwrap();
        let source = fixture["source"].as_str().unwrap();
        let anchors: Vec<String> = sections(source)
            .into_iter()
            .filter_map(|section| section.heading.map(|heading| heading.anchor))
            .collect();
        assert_eq!(
            anchors,
            fixture["anchors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|anchor| anchor.as_str().unwrap())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn headings_read_as_rendered_text() {
        let sections =
            sections("\u{feff}# Q&amp;A\n\n## _config.yml and __init__.py\n\n## 5 \\* 3\n");
        let headings: Vec<_> = sections
            .iter()
            .filter_map(|section| {
                section
                    .heading
                    .as_ref()
                    .map(|heading| heading.text.as_str())
            })
            .collect();
        assert_eq!(headings, ["Q&A", "_config.yml and init.py", "5 * 3"]);
        assert_eq!(
            sections[0].start, 3,
            "a byte order mark is not part of the heading"
        );
    }

    #[test]
    fn exact_targets_precede_browser_aliases_in_either_heading_order() {
        for source in [
            "## Setup\n\nPlain.\n\n## md-setup\n\nPrefixed.\n",
            "## md-setup\n\nPrefixed.\n\n## Setup\n\nPlain.\n",
        ] {
            let parsed = sections(source);
            for query in ["md-setup", "#md-md-setup"] {
                assert!(
                    section_source(source, &parsed, query)
                        .unwrap()
                        .contains("Prefixed."),
                    "{query}: {source}"
                );
            }
            for query in ["Setup", "#setup", "#md-setup"] {
                assert!(
                    section_source(source, &parsed, query)
                        .unwrap()
                        .contains("Plain."),
                    "{query}: {source}"
                );
            }
        }
        let parsed = sections(DOC);
        assert!(
            section_source(DOC, &parsed, "md-short-months")
                .unwrap()
                .contains("Use the **last** day.")
        );
    }

    #[test]
    fn documents_without_headings_have_one_text_section() {
        let sections = sections("Plain notes\n- one\n- two\n");
        assert_eq!(sections.len(), 1);
        assert!(sections[0].heading.is_none());
        assert_eq!(sections[0].text, "Plain notes one two");
        assert_eq!(title(&sections), None);
    }
}
