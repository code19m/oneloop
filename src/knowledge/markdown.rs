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
    let lines = lines_with_offsets(source);
    let mut sections = Vec::new();
    let mut current = Section {
        heading: None,
        start: 0,
        end: 0,
        text: String::new(),
    };
    let mut fence: Option<(char, usize)> = None;
    let mut body: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let (offset, line) = lines[index];
        if let Some((marker, length)) = fence {
            if closes_fence(line, marker, length) {
                fence = None;
            } else {
                body.push(line);
            }
            index += 1;
            continue;
        }
        if let Some(opened) = opens_fence(line) {
            fence = Some(opened);
            index += 1;
            continue;
        }
        let setext = lines
            .get(index + 1)
            .and_then(|(_, next)| setext_level(line, next));
        let heading = atx_heading(line).or_else(|| {
            setext.map(|level| Heading {
                level,
                text: inline_text(line.trim()),
                anchor: String::new(),
            })
        });
        if let Some(heading) = heading {
            current.end = offset;
            current.text = plain(&body);
            if current.heading.is_some() || !current.text.is_empty() {
                sections.push(current);
            }
            body.clear();
            current = Section {
                heading: Some(heading),
                start: offset,
                end: source.len(),
                text: String::new(),
            };
            index += if setext.is_some() && atx_heading(line).is_none() {
                2
            } else {
                1
            };
            continue;
        }
        body.push(line);
        index += 1;
    }
    current.end = source.len();
    current.text = plain(&body);
    if current.heading.is_some() || !current.text.is_empty() {
        sections.push(current);
    }
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

fn lines_with_offsets(source: &str) -> Vec<(usize, &str)> {
    let mut lines = Vec::new();
    // A byte order mark is not part of the first line.
    let (mut offset, source) = match source.strip_prefix('\u{feff}') {
        Some(rest) => ('\u{feff}'.len_utf8(), rest),
        None => (0, source),
    };
    for line in source.split_inclusive('\n') {
        lines.push((offset, line.trim_end_matches(['\n', '\r'])));
        offset += line.len();
    }
    lines
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
        text: inline_text(text),
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
    let chars: Vec<char> = value.chars().collect();
    let mut closers = Closers::new(&chars);
    let mut pieces = Vec::with_capacity(chars.len());
    // Where a link's text ends, and where reading resumes after its target.
    let mut link_ends = HashMap::new();
    let mut index = 0;
    while index < chars.len() {
        if let Some(resume) = link_ends.remove(&index) {
            index = resume;
            continue;
        }
        let c = chars[index];
        match c {
            '!' if chars.get(index + 1) == Some(&'[') => index += 1,
            '[' => {
                if let Some(close) = closers.next(index + 1, ']') {
                    let resume = match chars.get(close + 1) {
                        Some('(') => closers
                            .next(close + 2, ')')
                            .map_or(chars.len(), |end| end + 1),
                        Some('[') => closers
                            .next(close + 2, ']')
                            .map_or(chars.len(), |end| end + 1),
                        _ => close + 1,
                    };
                    link_ends.insert(close, resume);
                } else {
                    pieces.push(Piece::Text(c));
                }
                index += 1;
            }
            '<' => {
                let end = closers.next(index + 1, '>');
                match end {
                    Some(end)
                        if chars
                            .get(index + 1)
                            .is_some_and(|next| next.is_ascii_alphabetic() || *next == '/') =>
                    {
                        let inner = &chars[index + 1..end];
                        if inner.contains(&'@') || inner.windows(3).any(|w| w == [':', '/', '/']) {
                            pieces.extend(inner.iter().copied().map(Piece::Text));
                        }
                        index = end + 1;
                    }
                    _ => {
                        pieces.push(Piece::Text(c));
                        index += 1;
                    }
                }
            }
            '`' => index += 1,
            '~' if chars.get(index + 1) == Some(&'~') => index += 2,
            '\\' if chars
                .get(index + 1)
                .is_some_and(|next| next.is_ascii_punctuation()) =>
            {
                pieces.push(Piece::Text(chars[index + 1]));
                index += 2;
            }
            '&' => match entity(&chars[index..]) {
                Some((decoded, length)) => {
                    pieces.push(Piece::Text(decoded));
                    index += length;
                }
                None => {
                    pieces.push(Piece::Text(c));
                    index += 1;
                }
            },
            '*' | '_' => {
                let length = chars[index..].iter().take_while(|next| **next == c).count();
                let (before, after) = (
                    index.checked_sub(1).map(|i| chars[i]),
                    chars.get(index + length).copied(),
                );
                let left = flanking(after, before);
                let right = flanking(before, after);
                let (open, close) = if c == '*' {
                    (left, right)
                } else {
                    (
                        left && (!right || before.is_some_and(is_punctuation)),
                        right && (!left || after.is_some_and(is_punctuation)),
                    )
                };
                pieces.push(Piece::Run {
                    star: c == '*',
                    left: u32::try_from(length).unwrap_or(u32::MAX),
                    open,
                    close,
                });
                index += length;
            }
            _ => {
                pieces.push(Piece::Text(c));
                index += 1;
            }
        }
    }
    drop(closers);
    drop(chars);
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
            Piece::Text(c) => push(c),
            Piece::Run { star, left, .. } => {
                for _ in 0..left {
                    push(if star { '*' } else { '_' });
                }
            }
        }
    }
    out
}

/// One character of a line, or a run of emphasis marks. A long line holds
/// one piece per character, so pieces stay small.
enum Piece {
    Text(char),
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

/// A character reference at the start of `chars`: a decimal or hexadecimal
/// number, or one of the names common in prose. Returns it and its length.
fn entity(chars: &[char]) -> Option<(char, usize)> {
    let end = chars.iter().take(34).position(|c| *c == ';')?;
    let body: String = chars[1..end].iter().collect();
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
        match body.as_str() {
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
    chars: &'a [char],
    memo: Vec<(char, usize, Option<usize>)>,
    #[cfg(test)]
    scanned: usize,
}

impl<'a> Closers<'a> {
    fn new(chars: &'a [char]) -> Self {
        Self {
            chars,
            memo: Vec::with_capacity(3),
            #[cfg(test)]
            scanned: 0,
        }
    }

    fn next(&mut self, from: usize, target: char) -> Option<usize> {
        if let Some((_, start, found)) = self.memo.iter().find(|(c, ..)| *c == target)
            && *start <= from
            && found.is_none_or(|at| at >= from)
        {
            return *found;
        }
        let found = self
            .chars
            .get(from..)?
            .iter()
            .position(|c| *c == target)
            .map(|offset| from + offset);
        #[cfg(test)]
        {
            self.scanned += found.map_or(self.chars.len(), |at| at + 1) - from;
        }
        self.memo.retain(|(c, ..)| *c != target);
        self.memo.push((target, from, found));
        found
    }
}

/// Plain text of block lines: list markers, quotes and table pipes removed.
fn plain(lines: &[&str]) -> String {
    let mut text = String::new();
    let mut previous_row = false;
    for line in lines {
        let mut line = line.trim();
        // Table rows read as one list: cells and rows are both separated by dots.
        let row = line.starts_with('|');
        if line
            .chars()
            .all(|c| matches!(c, '-' | '*' | '_' | '=' | '|' | ':' | ' '))
        {
            continue;
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
        let cells = line.trim_matches('|').replace('|', " · ");
        let inline = inline_text(&cells);
        if !inline.is_empty() {
            if !text.is_empty() {
                text.push_str(if row && previous_row { " · " } else { " " });
            }
            text.push_str(&inline);
            previous_row = row;
        }
    }
    text
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
            let chars: Vec<char> = line.chars().collect();
            let mut closers = Closers::new(&chars);
            for index in 0..chars.len() {
                for target in [']', ')', '>'] {
                    closers.next(index, target);
                }
            }
            assert!(
                closers.scanned <= 3 * (chars.len() + 1),
                "{}",
                closers.scanned
            );
        }
        assert_eq!(inline_text(&"<".repeat(1_000)).len(), 1_000);
        // A long line holds one piece per character.
        assert!(std::mem::size_of::<Piece>() <= 8);
        assert_eq!(inline_text(" \t a \u{2003} *b*\n c \u{3000}"), "a b c");
        assert_eq!(
            inline_text("[a](b) and 2 < 3 [e] <https://f.test>"),
            "a and 2 < 3 e https://f.test"
        );
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
