//! A small, dependency-free reading of Markdown structure for search and MCP:
//! headings, sections and plain text. Rendering stays in the browser.

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
    for heading in sections
        .iter_mut()
        .filter_map(|section| section.heading.as_mut())
    {
        let base = slug(&heading.text);
        let count = occurrences.entry(base.clone()).or_insert(0);
        heading.anchor = if *count == 0 {
            base
        } else {
            format!("{base}-{count}")
        };
        *count += 1;
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
    let wanted = query.trim().trim_start_matches('#').trim();
    let lowered = wanted.to_lowercase();
    let position = sections
        .iter()
        .position(|section| {
            section.heading.as_ref().is_some_and(|heading| {
                heading.anchor == lowered || format!("md-{}", heading.anchor) == lowered
            })
        })
        .or_else(|| {
            sections.iter().position(|section| {
                section
                    .heading
                    .as_ref()
                    .is_some_and(|heading| heading.text.to_lowercase() == lowered)
            })
        })?;
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

/// The anchor a browser gives a heading: lower case, letters, numbers, marks,
/// `_` and `-` kept, spaces turned into hyphens.
pub(crate) fn slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| {
            c.is_alphanumeric() || matches!(c, '_' | '-') || c.is_whitespace() || is_mark(*c)
        })
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect()
}

fn is_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

fn lines_with_offsets(source: &str) -> Vec<(usize, &str)> {
    let mut lines = Vec::new();
    let mut offset = 0;
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

/// Text a reader sees in one line of inline Markdown.
pub(crate) fn inline_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let chars: Vec<char> = value.chars().collect();
    let mut closers = Closers::new(&chars);
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        match c {
            '!' if chars.get(index + 1) == Some(&'[') => index += 1,
            '[' => {
                if let Some(close) = closers.next(index + 1, ']') {
                    out.extend(&chars[index + 1..close]);
                    index = close + 1;
                    if chars.get(index) == Some(&'(') {
                        index = closers
                            .next(index + 1, ')')
                            .map_or(chars.len(), |end| end + 1);
                    } else if chars.get(index) == Some(&'[') {
                        index = closers
                            .next(index + 1, ']')
                            .map_or(chars.len(), |end| end + 1);
                    }
                    continue;
                }
                out.push(c);
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
                        let inner: String = chars[index + 1..end].iter().collect();
                        if inner.contains("://") || inner.contains('@') {
                            out.push_str(&inner);
                        }
                        index = end + 1;
                    }
                    _ => {
                        out.push(c);
                        index += 1;
                    }
                }
            }
            '`' | '*' => index += 1,
            '~' if chars.get(index + 1) == Some(&'~') => index += 2,
            '_' if chars.get(index + 1) == Some(&'_') => index += 2,
            '_' if word_edge(&chars, index) => index += 1,
            '\\' if chars
                .get(index + 1)
                .is_some_and(|next| next.is_ascii_punctuation()) =>
            {
                out.push(chars[index + 1]);
                index += 2;
            }
            _ => {
                out.push(c);
                index += 1;
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
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

fn word_edge(chars: &[char], index: usize) -> bool {
    let before = index
        .checked_sub(1)
        .and_then(|i| chars.get(i))
        .is_some_and(|c| c.is_alphanumeric());
    let after = chars.get(index + 1).is_some_and(|c| c.is_alphanumeric());
    !(before && after)
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
