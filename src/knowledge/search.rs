//! In-memory search over one project's synced files: names and paths for every
//! file, and section text for Markdown and other text files. A query matches
//! when every word appears, ignoring case.

use std::collections::BTreeSet;

use serde::Serialize;

use super::markdown;

const QUERY_MAX: usize = 200;
const TERMS_MAX: usize = 8;
const FILE_HITS_MAX: usize = 100;
const DOCUMENTS_MAX: usize = 50;
const HITS_PER_DOCUMENT_MAX: usize = 5;
const SNIPPET_CHARS: usize = 160;
const TEXT_LINES_MAX: usize = 5_000;

pub(crate) struct Index {
    names: Vec<Name>,
    documents: Vec<Document>,
    /// Approximate memory held by the index.
    bytes: usize,
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

impl Index {
    pub(crate) fn build<'a>(files: impl IntoIterator<Item = (&'a str, Content<'a>)>) -> Self {
        let mut folders = BTreeSet::new();
        let mut names = Vec::new();
        let mut documents = Vec::new();
        for (path, content) in files {
            let mut parts: Vec<&str> = path.split('/').collect();
            parts.pop();
            for depth in 1..=parts.len() {
                folders.insert(parts[..depth].join("/"));
            }
            names.push(Name::new(path, false));
            let file_name = path.rsplit('/').next().unwrap_or(path);
            let entries = match content {
                Content::Markdown(source) => {
                    let sections = markdown::sections(source);
                    let title = markdown::title(&sections).unwrap_or_else(|| file_name.to_owned());
                    sections
                        .into_iter()
                        .map(|section| {
                            let (heading, anchor) = section.heading.map_or_else(
                                || (title.clone(), None),
                                |heading| (heading.text, Some(heading.anchor)),
                            );
                            Entry::new(heading, section.text, anchor)
                        })
                        .collect()
                }
                Content::Text(source) => source
                    .lines()
                    .take(TEXT_LINES_MAX)
                    .enumerate()
                    .filter(|(_, line)| !line.trim().is_empty())
                    .map(|(number, line)| {
                        Entry::new(format!("Line {}", number + 1), line.trim().to_owned(), None)
                    })
                    .collect(),
                Content::None => Vec::new(),
            };
            if !entries.is_empty() {
                documents.push(Document {
                    path: path.to_owned(),
                    entries,
                });
            }
        }
        names.extend(folders.iter().map(|folder| Name::new(folder, true)));
        let bytes = names.iter().map(|name| name.path.len() * 3).sum::<usize>()
            + documents
                .iter()
                .flat_map(|document| &document.entries)
                .map(|entry| {
                    (entry.heading.len() + entry.text.len()) * 2
                        + entry.section.as_ref().map_or(0, String::len)
                })
                .sum::<usize>();
        Self {
            names,
            documents,
            bytes,
        }
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

        let mut documents: Vec<(u8, DocumentHits)> = Vec::new();
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
            let best = hits[0].0;
            documents.push((
                best,
                DocumentHits {
                    path: document.path.clone(),
                    total: hits.len(),
                    hits: hits
                        .into_iter()
                        .take(HITS_PER_DOCUMENT_MAX)
                        .map(|(_, entry)| Hit {
                            heading: entry.heading.clone(),
                            section: entry.section.clone(),
                            snippet: snippet(&entry.text, &entry.text_lower, &words),
                        })
                        .collect(),
                },
            ));
        }
        documents.sort_by(|(a_score, a), (b_score, b)| {
            a_score
                .cmp(b_score)
                .then(b.total.cmp(&a.total))
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
            documents: documents
                .into_iter()
                .take(DOCUMENTS_MAX)
                .map(|(_, hits)| hits)
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
fn snippet(text: &str, lower: &str, words: &[String]) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return text.to_owned();
    }
    // Case folding rarely changes length; the character position is close
    // enough to center the excerpt.
    let found = words
        .iter()
        .filter_map(|word| lower.find(word.as_str()))
        .min()
        .map_or(0, |byte| lower[..byte].chars().count())
        .min(chars.len());
    let mut start = found.saturating_sub(SNIPPET_CHARS / 3);
    if start > 0 {
        start = chars[..start]
            .iter()
            .rposition(|c| c.is_whitespace())
            .map_or(start, |space| space + 1);
    }
    let mut end = (start + SNIPPET_CHARS).min(chars.len());
    if end < chars.len() {
        end = chars[start..end]
            .iter()
            .rposition(|c| c.is_whitespace())
            .map_or(end, |space| start + space);
    }
    let mut excerpt: String = chars[start..end]
        .iter()
        .collect::<String>()
        .trim()
        .to_owned();
    if start > 0 {
        excerpt.insert_str(0, "… ");
    }
    if end < chars.len() {
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
    fn the_index_reports_the_memory_it_holds() {
        assert_eq!(Index::build([]).bytes(), 0);
        let small = Index::build([("a.md", Content::Markdown("# A\n\nshort\n"))]);
        assert!(index().bytes() > small.bytes() && small.bytes() > 0);
    }

    #[test]
    fn empty_and_oversized_queries_are_bounded() {
        assert_eq!(index().search("   "), Results::default());
        let words: Vec<String> = (0..20).map(|n| format!("w{n}")).collect();
        assert_eq!(terms(&words.join(" ")).len(), TERMS_MAX);
    }
}
