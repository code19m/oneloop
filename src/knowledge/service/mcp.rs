//! Knowledge reads for MCP clients: a folder overview and one file's text,
//! within the response limits.

use super::{
    FileMode, KnowledgeFile, KnowledgeOverview, KnowledgeService, OverviewFile, QUEUE_WAIT,
    ReadmeText, TextFile, catalog::INDEXED_FILE_BYTES, requested_path,
};
use crate::{
    AppError, AppResult,
    auth::Actor,
    files::PreviewKind,
    knowledge::{markdown, source},
};

const OVERVIEW_FILES_MAX: usize = 200;
const OVERVIEW_SECTIONS_MAX: usize = 12;
const README_CHARS_MAX: usize = 20_000;
const FILE_TEXT_CHARS_MAX: usize = 100_000;
const FILE_HEADINGS_MAX: usize = 60;
/// Bytes that always hold `chars` characters, whatever the script.
const fn text_bytes(chars: usize) -> u64 {
    4 * chars as u64
}
/// The part of a Markdown file that MCP reads for its title, headings and
/// sections: as much as search reads, and ten times what a reply holds.
const MARKDOWN_SOURCE_BYTES: u64 = INDEXED_FILE_BYTES as u64;

impl KnowledgeService {
    /// For MCP clients: the README of `folder` and a compact file index.
    pub async fn overview(
        &self,
        actor: &Actor,
        project_id: &str,
        folder: Option<&str>,
    ) -> AppResult<KnowledgeOverview> {
        actor.require_ready()?;
        let folder = source::folder(folder.unwrap_or_default())?;
        let view = self.view(actor, project_id).await?;
        let catalog = self.catalog(actor, project_id).await?;
        let prefix = source::folder_prefix(&folder);
        let inside: Vec<&KnowledgeFile> = view
            .files
            .iter()
            .filter(|file| file.path.starts_with(&prefix))
            .collect();
        if !folder.is_empty() && inside.is_empty() && !view.files.is_empty() {
            return Err(AppError::NotFound { resource: "folder" });
        }
        // A binary file named README.md returns only its details, as in read_text.
        let readme_path = inside
            .iter()
            .find(|file| {
                file.path[prefix.len()..].eq_ignore_ascii_case("readme.md")
                    && matches!(file.kind, Some(PreviewKind::Markdown | PreviewKind::Text))
            })
            .map(|file| file.path.clone());
        let readme = match readme_path {
            Some(path) => {
                let (text, longer) = self
                    .text(actor, project_id, &path, text_bytes(README_CHARS_MAX))
                    .await?;
                let (content, truncated) = cut(&text, README_CHARS_MAX);
                Some(ReadmeText {
                    path,
                    content,
                    truncated: truncated || longer,
                })
            }
            None => None,
        };
        let outline = |path: &str| {
            catalog
                .as_ref()
                .and_then(|catalog| catalog.index.outline(path))
        };
        let files = inside
            .iter()
            .take(OVERVIEW_FILES_MAX)
            .map(|file| OverviewFile {
                path: file.path.clone(),
                kind: file.kind,
                size: file.size,
                updated_at: file.updated_at,
                title: outline(&file.path).and_then(|outline| outline.title.clone()),
                sections: outline(&file.path)
                    .map(|outline| {
                        outline
                            .sections
                            .iter()
                            .take(OVERVIEW_SECTIONS_MAX)
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect();
        Ok(KnowledgeOverview {
            state: view.state,
            checked_at: view.checked_at,
            readme,
            files,
            file_count: inside.len(),
            truncated: inside.len() > OVERVIEW_FILES_MAX,
            partial: catalog
                .as_ref()
                .is_some_and(|catalog| catalog.index.partial()),
        })
    }

    /// For MCP clients: one file's text, or one section of a Markdown file.
    pub async fn read_text(
        &self,
        actor: &Actor,
        project_id: &str,
        path: &str,
        section: Option<&str>,
    ) -> AppResult<TextFile> {
        actor.require_ready()?;
        let path = requested_path(path)?;
        let view = self.view(actor, project_id).await?;
        let file = view
            .files
            .into_iter()
            .find(|file| file.path == path)
            .ok_or(AppError::NotFound { resource: "file" })?;
        let mut result = TextFile {
            path: file.path.clone(),
            kind: file.kind,
            size: file.size,
            updated_at: file.updated_at,
            title: None,
            headings: Vec::new(),
            section: None,
            content: None,
            truncated: false,
            note: None,
        };
        if !file.kind.is_some_and(PreviewKind::has_source) {
            if section.is_some() {
                return Err(AppError::validation(
                    "section",
                    "applies to Markdown files only",
                ));
            }
            result.note = Some("This file is not text. Open it in oneloop to view or download it.");
            return Ok(result);
        }
        let markdown_file = file.kind == Some(PreviewKind::Markdown);
        if section.is_some() && !markdown_file {
            return Err(AppError::validation(
                "section",
                "applies to Markdown files only",
            ));
        }
        let query = section
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        // Only the start of a file can be part of a reply, so only the start
        // is read. One file at a time is read and parsed, off the async
        // workers, so many calls at once can't use up the memory; a read
        // that waits too long is told to try again.
        let turn = self.inner.readers.turn_within(QUEUE_WAIT).await?;
        let limit = if markdown_file {
            MARKDOWN_SOURCE_BYTES
        } else {
            text_bytes(FILE_TEXT_CHARS_MAX)
        };
        let (text, longer) = self.text(actor, project_id, &file.path, limit).await?;
        turn.run(move || {
            let mut content = text.as_str();
            if markdown_file {
                let sections = markdown::outline(&text);
                result.title = markdown::title(&sections);
                result.headings = sections
                    .iter()
                    .filter_map(|section| section.heading.as_ref())
                    .filter(|heading| heading.level <= 3)
                    .take(FILE_HEADINGS_MAX)
                    .map(|heading| format!("{} {}", "#".repeat(heading.level.into()), heading.text))
                    .collect();
                if let Some(query) = query {
                    content = markdown::section_source(&text, &sections, &query).ok_or(
                        AppError::NotFound {
                            resource: "section",
                        },
                    )?;
                    result.section = Some(query);
                }
            }
            // The file goes on past what was read, and so may the content.
            let unfinished = longer
                && content.as_ptr().addr() + content.len() == text.as_ptr().addr() + text.len();
            let (content, truncated) = cut(content, FILE_TEXT_CHARS_MAX);
            result.content = Some(content);
            result.truncated = truncated || unfinished;
            Ok(result)
        })
        .await?
    }

    /// The first `limit` bytes of a text file as text, read after the caller
    /// is authorized, and whether the file is longer.
    async fn text(
        &self,
        actor: &Actor,
        project_id: &str,
        path: &str,
        limit: u64,
    ) -> AppResult<(String, bool)> {
        let read = self
            .file(actor, project_id, path, FileMode::Download, None)
            .await?;
        let Some(body) = read.body else {
            return Ok((String::new(), false));
        };
        let longer = body.len() > limit;
        let mut bytes = body.read_start(limit).await?;
        // A character that the limit splits is left out; other bytes that
        // aren't UTF-8 become U+FFFD. Valid text is not copied.
        if longer
            && let Err(error) = std::str::from_utf8(&bytes)
            && error.error_len().is_none()
        {
            bytes.truncate(error.valid_up_to());
        }
        let text = String::from_utf8(bytes)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
        Ok((text, longer))
    }
}

/// At most `limit` characters, cut at a line break when one is near.
fn cut(text: &str, limit: usize) -> (String, bool) {
    match text.char_indices().nth(limit) {
        None => (text.to_owned(), false),
        Some((end, _)) => {
            let head = &text[..end];
            let end = head
                .rfind('\n')
                .filter(|position| *position >= end / 2)
                .unwrap_or(end);
            (text[..end].to_owned(), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::service::tests::synced_project;

    #[test]
    fn long_text_is_cut_at_a_nearby_line_break() {
        assert_eq!(cut("short", 10), ("short".to_owned(), false));
        let (text, truncated) = cut("first line\nsecond line\nthird", 15);
        assert!(truncated);
        assert_eq!(text, "first line");
        let (text, truncated) = cut("ééééé", 3);
        assert_eq!((text.as_str(), truncated), ("ééé", true));
    }

    #[tokio::test]
    async fn a_reply_holds_only_the_start_of_each_long_heading() {
        let long = "Long words ".repeat(10_000);
        let mut content = format!("# {long}\n\nIntro.\n\n");
        for _ in 0..10 {
            content.push_str(&format!("## {long}\n\nText.\n\n"));
        }
        let files = vec![("long.md".to_owned(), content)];
        let (_root, service, people) = synced_project(files, &["alice"]).await;
        let read = service
            .read_text(&people[0], "p", "long.md", None)
            .await
            .unwrap();
        let title = read.title.unwrap();
        assert!(title.starts_with("Long words Long"));
        assert!(
            title.len() <= markdown::HEADING_BYTES_MAX,
            "{}",
            title.len()
        );
        assert!(read.headings.len() > 1);
        for heading in &read.headings {
            assert!(heading.len() <= markdown::HEADING_BYTES_MAX + "## ".len());
        }
    }

    #[tokio::test]
    async fn a_file_read_waits_at_most_five_seconds_for_the_one_before_it() {
        let files = vec![("note.md".to_owned(), "# Note\n\nWords.\n".to_owned())];
        let (_root, service, people) = synced_project(files, &["alice"]).await;
        tokio::time::pause();
        // Another read holds the one reader.
        let held = service.inner.readers.turn().await;
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            service.read_text(&people[0], "p", "note.md", None),
        )
        .await
        .expect("a read doesn't wait for long");
        assert!(matches!(read, Err(AppError::Unavailable(_))), "{read:?}");
        drop(held);
        let read = service
            .read_text(&people[0], "p", "note.md", None)
            .await
            .unwrap();
        assert_eq!(read.content.as_deref(), Some("# Note\n\nWords.\n"));
    }
}
