//! In-memory search over one project's synced files: names and paths for every
//! file, and section text for Markdown and other text files. A query matches
//! when every word appears, ignoring case.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use super::markdown;

const QUERY_MAX: usize = 200;
const TERMS_MAX: usize = 8;
const FILE_HITS_MAX: usize = 100;
const DOCUMENTS_MAX: usize = 50;
const HITS_PER_DOCUMENT_MAX: usize = 5;
const SNIPPET_CHARS: usize = 160;
const TEXT_LINES_MAX: usize = 5_000;
/// Memory one project's index may use, by `Index::bytes`. Once it is full,
/// later files are found by name only, as files over the size limit are.
pub(crate) const INDEX_BYTES_MAX: usize = 64 * 1024 * 1024;
/// What one allocation costs besides its bytes.
const ALLOCATION_BYTES: usize = 32;

pub(crate) struct Index {
    names: Vec<Name>,
    documents: Vec<Document>,
    outlines: HashMap<String, Outline>,
    /// Approximate memory held by the index.
    bytes: usize,
}

/// A Markdown file's title and level-two headings.
#[derive(Default)]
pub(crate) struct Outline {
    pub(crate) title: Option<String>,
    pub(crate) sections: Vec<String>,
}

struct Name {
    path: String,
    lower: String,
    base_lower: String,
    folder: bool,
}

struct Document {
    path: String,
    entries: Vec<Entry>,
}

struct Entry {
    /// Section heading, or `Line N` for plain text files. Documents that start
    /// with text use their title or file name.
    heading: String,
    section: Option<String>,
    heading_lower: String,
    text: String,
    text_lower: String,
}

pub(crate) enum Content<'a> {
    Markdown(&'a str),
    Text(&'a str),
    None,
}

/// The memory a string holds.
fn held(value: &str, capacity: usize) -> usize {
    if value.is_empty() && capacity == 0 {
        0
    } else {
        capacity + ALLOCATION_BYTES
    }
}

impl Index {
    pub(crate) fn build<'a>(files: impl IntoIterator<Item = (&'a str, Content<'a>)>) -> Self {
        let mut folders = BTreeSet::new();
        let mut index = Self {
            names: Vec::new(),
            documents: Vec::new(),
            outlines: HashMap::new(),
            bytes: 0,
        };
        let mut full = false;
        for (path, content) in files {
            let mut parts: Vec<&str> = path.split('/').collect();
            parts.pop();
            for depth in 1..=parts.len() {
                folders.insert(parts[..depth].join("/"));
            }
            index.add_name(path, false);
            if full {
                continue;
            }
            let file_name = path.rsplit('/').next().unwrap_or(path);
            let mut entries = Vec::new();
            let mut add = |index: &mut Self, entry: Entry| {
                let cost = entry.bytes();
                if index.bytes + cost > INDEX_BYTES_MAX {
                    return false;
                }
                index.bytes += cost;
                entries.push(entry);
                true
            };
            match content {
                Content::Markdown(source) => {
                    let sections = markdown::sections(source);
                    let title = markdown::title(&sections);
                    let outline = Outline {
                        title: title.clone(),
                        sections: sections
                            .iter()
                            .filter_map(|section| section.heading.as_ref())
                            .filter(|heading| heading.level == 2)
                            .map(|heading| heading.text.clone())
                            .collect(),
                    };
                    let cost = outline.bytes() + held(path, path.len());
                    if index.bytes + cost > INDEX_BYTES_MAX {
                        full = true;
                        continue;
                    }
                    index.bytes += cost;
                    index.outlines.insert(path.to_owned(), outline);
                    let title = title.unwrap_or_else(|| file_name.to_owned());
                    for section in sections {
                        let (heading, anchor) = section.heading.map_or_else(
                            || (title.clone(), None),
                            |heading| (heading.text, Some(heading.anchor)),
                        );
                        if !add(&mut index, Entry::new(heading, section.text, anchor)) {
                            full = true;
                            break;
                        }
                    }
                }
                Content::Text(source) => {
                    for (number, line) in source.lines().take(TEXT_LINES_MAX).enumerate() {
                        if line.trim().is_empty() {
                            continue;
                        }
                        let entry = Entry::new(
                            format!("Line {}", number + 1),
                            line.trim().to_owned(),
                            None,
                        );
                        if !add(&mut index, entry) {
                            full = true;
                            break;
                        }
                    }
                }
                Content::None => {}
            }
            if !entries.is_empty() {
                entries.shrink_to_fit();
                index.bytes +=
                    std::mem::size_of::<Document>() + held(path, path.len()) + ALLOCATION_BYTES;
                index.documents.push(Document {
                    path: path.to_owned(),
                    entries,
                });
            }
        }
        for folder in &folders {
            index.add_name(folder, true);
        }
        index.names.shrink_to_fit();
        index.documents.shrink_to_fit();
        index
    }

    /// Every file and folder can be found by name, however full the index is.
    fn add_name(&mut self, path: &str, folder: bool) {
        let name = Name::new(path, folder);
        self.bytes += std::mem::size_of::<Name>()
            + held(&name.path, name.path.capacity())
            + held(&name.lower, name.lower.capacity())
            + held(&name.base_lower, name.base_lower.capacity());
        self.names.push(name);
    }

    /// The outline of a Markdown file that the index holds.
    pub(crate) fn outline(&self, path: &str) -> Option<&Outline> {
        self.outlines.get(path)
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn search(&self, query: &str) -> Results {
        let words = terms(query);
        if words.is_empty() {
            return Results::default();
        }
        let mut files: Vec<(u8, &Name)> = self
            .names
            .iter()
            .filter(|name| words.iter().all(|word| name.lower.contains(word.as_str())))
            .map(|name| {
                let score = if name.base_lower.starts_with(words[0].as_str()) {
                    0
                } else if words
                    .iter()
                    .all(|word| name.base_lower.contains(word.as_str()))
                {
                    1
                } else {
                    2
                };
                (score, name)
            })
            .collect();
        files.sort_by(|(a_score, a), (b_score, b)| {
            a_score
                .cmp(b_score)
                .then(b.folder.cmp(&a.folder))
                .then(a.path.len().cmp(&b.path.len()))
                .then(a.path.cmp(&b.path))
        });
        let file_count = files.len();

        // The best hits of each matching document, and how many it has.
        let mut documents: Vec<(u8, &Document, Vec<&Entry>, usize)> = Vec::new();
        let mut hit_count = 0;
        for document in &self.documents {
            let mut hits: Vec<(u8, &Entry)> = document
                .entries
                .iter()
                .filter(|entry| {
                    words.iter().all(|word| {
                        entry.heading_lower.contains(word.as_str())
                            || entry.text_lower.contains(word.as_str())
                    })
                })
                .map(|entry| {
                    let in_heading = words
                        .iter()
                        .all(|word| entry.heading_lower.contains(word.as_str()));
                    (u8::from(!in_heading), entry)
                })
                .collect();
            if hits.is_empty() {
                continue;
            }
            hits.sort_by_key(|(score, _)| *score);
            hit_count += hits.len();
            let (best, total) = (hits[0].0, hits.len());
            let best_hits = hits
                .into_iter()
                .take(HITS_PER_DOCUMENT_MAX)
                .map(|(_, entry)| entry)
                .collect();
            documents.push((best, document, best_hits, total));
        }
        documents.sort_by(|(a_score, a, _, a_total), (b_score, b, _, b_total)| {
            a_score
                .cmp(b_score)
                .then(b_total.cmp(a_total))
                .then(a.path.cmp(&b.path))
        });
        Results {
            files: files
                .into_iter()
                .take(FILE_HITS_MAX)
                .map(|(_, name)| FileHit {
                    path: name.path.clone(),
                    folder: name.folder,
                })
                .collect(),
            // Excerpts are made only for the documents in the reply.
            documents: documents
                .into_iter()
                .take(DOCUMENTS_MAX)
                .map(|(_, document, hits, total)| DocumentHits {
                    path: document.path.clone(),
                    total,
                    hits: hits
                        .into_iter()
                        .map(|entry| Hit {
                            heading: entry.heading.clone(),
                            section: entry.section.clone(),
                            snippet: snippet(&entry.text, &entry.text_lower, &words),
                        })
                        .collect(),
                })
                .collect(),
            file_count,
            hit_count,
        }
    }
}

impl Name {
    fn new(path: &str, folder: bool) -> Self {
        let lower = path.to_lowercase();
        Self {
            base_lower: lower.rsplit('/').next().unwrap_or(&lower).to_owned(),
            lower,
            path: path.to_owned(),
            folder,
        }
    }
}

impl Entry {
    fn new(heading: String, text: String, section: Option<String>) -> Self {
        Self {
            heading_lower: heading.to_lowercase(),
            text_lower: text.to_lowercase(),
            heading,
            section,
            text,
        }
    }

    /// The memory the entry holds, its strings included.
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + [
                &self.heading,
                &self.heading_lower,
                &self.text,
                &self.text_lower,
            ]
            .into_iter()
            .chain(&self.section)
            .map(|value| held(value, value.capacity()))
            .sum::<usize>()
    }
}

impl Outline {
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .title
                .as_ref()
                .map_or(0, |title| held(title, title.capacity()))
            + self.sections.capacity() * std::mem::size_of::<String>()
            + self
                .sections
                .iter()
                .map(|section| held(section, section.capacity()))
                .sum::<usize>()
    }
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub files: Vec<FileHit>,
    pub documents: Vec<DocumentHits>,
    /// All matching names, including those beyond `files`.
    pub file_count: usize,
    /// All matching sections, including those beyond `documents`.
    pub hit_count: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub folder: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentHits {
    pub path: String,
    pub hits: Vec<Hit>,
    /// All matching sections in this file.
    pub total: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub heading: String,
    /// The browser's heading anchor without its `md-` prefix.
    pub section: Option<String>,
    pub snippet: String,
}

fn terms(query: &str) -> Vec<String> {
    let query: String = query.chars().take(QUERY_MAX).collect();
    let mut seen = BTreeSet::new();
    query
        .to_lowercase()
        .split_whitespace()
        .filter(|word| seen.insert(word.to_string()))
        .take(TERMS_MAX)
        .map(str::to_owned)
        .collect()
}

/// A short excerpt around the first matching word, cut at word boundaries.
/// It works on byte offsets in the text, so a long section isn't copied.
fn snippet(text: &str, lower: &str, words: &[String]) -> String {
    let length = text.chars().count();
    if length <= SNIPPET_CHARS {
        return text.to_owned();
    }
    // Case folding rarely changes length; the character position is close
    // enough to center the excerpt.
    let found = words
        .iter()
        .filter_map(|word| lower.find(word.as_str()))
        .min()
        .map_or(0, |byte| lower[..byte].chars().count())
        .min(length);
    let mut start = text
        .char_indices()
        .nth(found.saturating_sub(SNIPPET_CHARS / 3))
        .map_or(text.len(), |(at, _)| at);
    if start > 0 {
        start = text[..start]
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(start, |(at, space)| at + space.len_utf8());
    }
    let mut end = text[start..]
        .char_indices()
        .nth(SNIPPET_CHARS)
        .map_or(text.len(), |(at, _)| start + at);
    if end < text.len() {
        end = text[start..end]
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(end, |(at, _)| start + at);
    }
    let mut excerpt = text[start..end].trim().to_owned();
    if start > 0 {
        excerpt.insert_str(0, "… ");
    }
    if end < text.len() {
        excerpt.push_str(" …");
    }
    excerpt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        Index::build([
            (
                "README.md",
                Content::Markdown(
                    "# Project overview\n\nStart here. Payment schedules explain due dates, short months and rounding.\n",
                ),
            ),
            (
                "product/payment-schedules.md",
                Content::Markdown(
                    "# Payment schedules\n\nA predictable schedule.\n\n## Short months\n\nUse the month's last calendar day.\n\n## Rounding\n\nPut the remainder in the final installment.\n",
                ),
            ),
            (
                "engineering/config.example.json",
                Content::Text(
                    "{\n  \"payments\": {\n    \"timezone\": \"Asia/Tashkent\"\n  }\n}\n",
                ),
            ),
            ("examples/waypoint.pdf", Content::None),
        ])
    }

    #[test]
    fn names_and_folders_rank_best_name_matches_first() {
        let results = index().search("pay");
        assert_eq!(results.file_count, 1);
        assert_eq!(
            results.files,
            [FileHit {
                path: "product/payment-schedules.md".into(),
                folder: false
            }]
        );
        let folders = index().search("prod");
        assert_eq!(
            folders.files[0],
            FileHit {
                path: "product".into(),
                folder: true
            }
        );
        assert_eq!(index().search("engineering/config").files.len(), 1);
        assert_eq!(index().search("waypoint.pdf").files.len(), 1);
    }

    #[test]
    fn every_word_must_match_and_headings_rank_first() {
        let results = index().search("short month");
        assert_eq!(results.hit_count, 2);
        assert_eq!(results.documents[0].path, "product/payment-schedules.md");
        assert_eq!(results.documents[0].hits[0].heading, "Short months");
        assert_eq!(results.documents[1].path, "README.md");
        assert_eq!(results.documents[1].hits[0].heading, "Project overview");
        assert!(index().search("short zebra").documents.is_empty());
    }

    #[test]
    fn text_files_match_by_line_and_pdfs_by_name_only() {
        let results = index().search("tashkent");
        assert_eq!(results.documents.len(), 1);
        assert_eq!(
            results.documents[0].hits[0],
            Hit {
                heading: "Line 3".into(),
                section: None,
                snippet: "\"timezone\": \"Asia/Tashkent\"".into()
            }
        );
        assert!(index().search("waypoint").documents.is_empty());
    }

    #[test]
    fn matching_ignores_case_in_any_script() {
        let index = Index::build([(
            "guide.md",
            Content::Markdown("# Qo‘llanma\n\nТЕКСТ на русском и O‘zbekcha.\n"),
        )]);
        assert_eq!(index.search("текст").hit_count, 1);
        assert_eq!(index.search("o‘zbekcha").hit_count, 1);
    }

    #[test]
    fn repeated_headings_keep_the_section_that_contains_the_hit() {
        let index = Index::build([(
            "guide.md",
            Content::Markdown(
                "# Guide\n\n## Checklist\n\nFirst steps.\n\n## Checklist\n\nSecond steps.\n",
            ),
        )]);
        let result = serde_json::to_value(index.search("second")).unwrap();
        assert_eq!(result["documents"][0]["hits"][0]["heading"], "Checklist");
        assert_eq!(result["documents"][0]["hits"][0]["section"], "checklist-1");
    }

    #[test]
    fn every_search_target_resolves_its_section_even_when_slugs_collide() {
        let source = "## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n\n## Setup-1\n\nThird.\n\n## md-setup\n\nFourth.\n";
        let index = Index::build([("guide.md", Content::Markdown(source))]);
        let sections = markdown::sections(source);
        for word in ["First.", "Second.", "Third.", "Fourth."] {
            let result = index.search(word);
            let target = result.documents[0].hits[0].section.as_deref().unwrap();
            assert!(
                markdown::section_source(source, &sections, target)
                    .unwrap()
                    .contains(word),
                "{target} must select {word}"
            );
        }
    }

    #[test]
    fn excerpts_center_on_the_match_at_word_boundaries() {
        let text = format!(
            "{} the needle sits here {}",
            "word ".repeat(60),
            "tail ".repeat(60)
        );
        let excerpt = snippet(&text, &text.to_lowercase(), &["needle".into()]);
        assert!(excerpt.starts_with("… word"));
        assert!(excerpt.ends_with(" …"));
        assert!(excerpt.contains("needle sits here"));
        assert!(excerpt.chars().count() <= SNIPPET_CHARS + 4);
    }

    #[test]
    fn an_excerpt_of_a_long_section_copies_only_the_excerpt() {
        let text = format!(
            "{} the needle sits here {}",
            "word ".repeat(200_000),
            "tail ".repeat(60)
        );
        let lower = text.to_lowercase();
        let (excerpt, peak) =
            crate::test_memory::peak_heap(|| snippet(&text, &lower, &["needle".into()]));
        assert!(excerpt.contains("the needle sits here"), "{excerpt}");
        assert!(peak < 4096, "{peak} bytes for {} bytes of text", text.len());
    }

    #[test]
    fn the_index_keeps_to_its_budget_and_reports_the_memory_it_holds() {
        use crate::test_memory::{live_heap, peak_heap};
        assert_eq!(Index::build([]).bytes(), 0);
        // 2,000 files of 5,000 one-character lines: 20 MB, 10 million lines.
        let lines = "a\n".repeat(5_000);
        let paths: Vec<String> = (0..2_000).map(|n| format!("notes/n{n:04}.txt")).collect();
        let before = live_heap();
        let (index, peak) = peak_heap(|| {
            Index::build(
                paths
                    .iter()
                    .map(|path| (path.as_str(), Content::Text(&lines))),
            )
        });
        let held = live_heap() - before;
        assert!(peak < INDEX_BYTES_MAX, "{peak} bytes at the peak");
        let bytes = index.bytes();
        assert!(held / 2 <= bytes && bytes <= held * 2, "{bytes} for {held}");
        // Files past the budget are found by name only.
        assert_eq!(index.search("n1999").files.len(), 1);
        let indexed = index.documents.len();
        assert!((1..2_000).contains(&indexed), "{indexed}");
    }

    #[test]
    fn empty_and_oversized_queries_are_bounded() {
        assert_eq!(index().search("   "), Results::default());
        let words: Vec<String> = (0..20).map(|n| format!("w{n}")).collect();
        assert_eq!(terms(&words.join(" ")).len(), TERMS_MAX);
    }
}
