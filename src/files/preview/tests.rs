//! The HTML preview sanitizer: output safety, adversarial input cost and
//! agreement with a simple reference implementation.

use super::*;
use proptest::prelude::*;
use scraper::{Html, Selector};

#[test]
fn hostile_megabyte_previews_do_not_take_quadratic_time() {
    // Malformed input once made the scanner rescan the whole suffix for every
    // `<`: hundreds of billions of steps for these inputs, which takes minutes.
    // A linear scan takes well under a second even in a debug build, so the
    // generous bound tolerates a loaded machine.
    let only_brackets = "<".repeat(1024 * 1024);
    assert_eq!(
        sanitized(only_brackets.as_bytes()).len(),
        only_brackets.len() * "&lt;".len(),
        "every unfinished tag is escaped"
    );
    for input in [
        only_brackets,
        format!("<a x=\"{}", "<".repeat(1024 * 1024)),
        "<\"".repeat(512 * 1024),
    ] {
        let start = std::time::Instant::now();
        let result = sanitized(input.as_bytes());
        assert!(!result.is_empty());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            start.elapsed()
        );
    }
}

#[test]
fn cleaning_holds_one_byte_per_byte_of_the_file_whatever_its_tags() {
    // The scanner once kept 16 bytes for each byte of a tag, and the cleaned
    // page, up to four times the file, stayed in memory until it was sent.
    let folder = tempfile::tempdir().unwrap();
    let disk = DiskAdmission::new(folder.path(), 0, Default::default());
    let image = format!(
        "<img src=\"data:image/png;base64,{}\">",
        "A".repeat(1024 * 1024)
    );
    for input in [
        image.clone(),
        image.trim_end_matches(['"', '>']).to_owned(),
        "<".repeat(1024 * 1024),
    ] {
        let (cleaned, peak) = crate::test_memory::peak_heap(|| {
            clean_into_file(input.as_bytes(), folder.path(), &disk).unwrap()
        });
        assert_eq!(cleaned.1, sanitized(input.as_bytes()).len() as u64);
        assert!(
            peak < input.len() + 256 * 1024,
            "{peak} bytes for {}",
            input.len()
        );
    }
}

#[tokio::test]
async fn a_cleaned_page_has_no_name_and_its_disk_space_counts_once() {
    let folder = tempfile::tempdir().unwrap();
    let reservations = crate::disk::Reservations::default();
    let disk = DiskAdmission::new(folder.path(), 0, reservations.clone());
    // A page of `<` grows four times: 4 MiB on disk.
    let source = vec![b'<'; 1024 * 1024];
    let turn = html_preview_turn(&Previewers::default(), "reader")
        .await
        .unwrap();
    let mut page = cleaned_html_preview(turn, source, folder.path().into(), disk)
        .await
        .unwrap();
    assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
    // The written file already lowers the free space that the floor is
    // compared with, so a reservation kept too would count the page again.
    let free = fs4::available_space(folder.path()).unwrap();
    let floor = DiskAdmission::new(folder.path(), free - 2 * 1024 * 1024, reservations);
    assert_eq!(floor.deficit(0).unwrap(), 0);
    let mut text = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut page, &mut text)
        .await
        .unwrap();
    assert_eq!(text, "&lt;".repeat(1024 * 1024).as_bytes());
    assert_eq!(page.len(), text.len() as u64);
}

#[tokio::test]
async fn each_person_has_three_pages_on_the_way_and_a_fourth_is_told_at_once() {
    let folder = tempfile::tempdir().unwrap();
    let disk = DiskAdmission::new(folder.path(), 0, Default::default());
    let previewers = Previewers::default();
    let mut pages = Vec::new();
    for _ in 0..3 {
        let turn = html_preview_turn(&previewers, "reader").await.unwrap();
        let page = cleaned_html_preview(
            turn,
            b"<p>Report</p>".to_vec(),
            folder.path().into(),
            disk.clone(),
        );
        pages.push(page.await.unwrap());
    }
    drop(html_preview_turn(&previewers, "other").await.unwrap());
    let Err(error) = html_preview_turn(&previewers, "reader").await else {
        panic!("a fourth page is refused");
    };
    assert!(html_preview_problem(&error).starts_with("Your other previews are still loading"));
    pages.pop();
    drop(html_preview_turn(&previewers, "reader").await.unwrap());
}

#[tokio::test]
async fn a_persons_next_page_waits_for_the_one_in_the_queue() {
    let previewers = Previewers::default();
    let first = html_preview_turn(&previewers, "reader").await.unwrap();
    let (next, ()) = tokio::join!(html_preview_turn(&previewers, "reader"), async move {
        tokio::task::yield_now().await;
        drop(first);
    });
    assert!(next.is_ok());
}

#[tokio::test(start_paused = true)]
async fn a_page_that_waits_five_seconds_is_told_the_server_is_busy() {
    let previewers = Previewers::default();
    let _first = html_preview_turn(&previewers, "reader").await.unwrap();
    let Err(error) = html_preview_turn(&previewers, "reader").await else {
        panic!("the next page waits five seconds at most");
    };
    assert_eq!(
        html_preview_problem(&error),
        "The server is busy preparing other previews."
    );
}

/// The cleaned page of `bytes`, in memory.
fn sanitized(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    sanitize_html_preview(bytes, &mut out).unwrap();
    out
}

fn assert_no_nested_navigation(source: &[u8]) {
    let cleaned = sanitized(source);
    let text = std::str::from_utf8(&cleaned).unwrap();
    let dom = Html::parse_document(text);
    let forbidden = Selector::parse(
        "iframe,frame,frameset,object,embed,base,portal,fencedframe,meta[http-equiv]",
    )
    .unwrap();
    assert!(
        dom.select(&forbidden).next().is_none(),
        "unsafe output: {text}"
    );
}

#[test]
fn attribute_name_quotes_do_not_hide_nested_browsing_elements() {
    assert_no_nested_navigation(br#"<p b"c> <iframe src=https://example.com></iframe> <meta http-equiv="refresh" content="0;url=https://example.com"> "d>ok</p>"#);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, failure_persistence: None, ..ProptestConfig::default() })]
    #[test]
    fn browsers_find_no_nested_browsing_elements_in_generated_markup(attrs in "[a-zA-Z0-9 =/'\"<>]{0,80}", tag in prop::sample::select(vec!["iframe", "frame", "frameset", "object", "embed", "base", "portal", "fencedframe", "meta"])) {
        assert_no_nested_navigation(format!("<p {attrs}>text</p><{tag} http-equiv=refresh src=https://example.com>ok</{tag}>").as_bytes());
    }
}

#[test]
fn invalid_utf8_gets_a_notice_instead_of_the_bytes() {
    let output = String::from_utf8(sanitized(b"<p>caf\xe9</p>")).unwrap();
    assert!(
        output.contains("This HTML file is not valid UTF-8."),
        "{output}"
    );
}

#[test]
fn unfinished_tags_preserve_later_markup_and_browser_quote_rules() {
    let benign = "<p>if x < y it's fine</p><h1>Title</h1>";
    assert_eq!(sanitized(benign.as_bytes()), benign.as_bytes());
    let malformed = b"<a title=\"unfinished<h1>Title</h1><iframe src=x></iframe><p>end</p>";
    let cleaned = String::from_utf8(sanitized(malformed)).unwrap();
    assert!(cleaned.contains("<h1>Title</h1>"));
    assert!(cleaned.contains("<p>end</p>"));
    assert!(!cleaned.contains("<iframe"));
    for source in [
        br#"<a b'c><iframe src=x></iframe>'>"#.as_slice(),
        br#"<p title=x"y><iframe src=x></iframe>" >"#,
    ] {
        assert!(
            !String::from_utf8(sanitized(source))
                .unwrap()
                .contains("<iframe")
        );
    }
}

#[test]
fn memoized_scanner_matches_unoptimized_reference() {
    // Keep the value-aware pre-optimization scanner as an output oracle.
    // Deliberately small inputs let the reference rescan malformed suffixes.
    // Tag names match in any letter case.
    let alphabet = b"<>='\" /abcxyzAEFIMRT\t\n";
    let endings: [&[u8]; 4] = [
        b"<iframe src=x></iframe><p>ok</p>",
        b"<IFRAME src=x></IfRaMe><p>ok</p>",
        b"<META Http-Equiv=refresh content=0><p>ok</p>",
        b"<Meta charset=utf-8><p>ok</p>",
    ];
    let mut state = 13_u64;
    for round in 0..20_000 {
        let mut source = Vec::new();
        for _ in 0..80 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            source.push(alphabet[(state >> 32) as usize % alphabet.len()]);
        }
        source.extend_from_slice(endings[round % endings.len()]);
        assert_eq!(sanitized(&source), reference_sanitizer(&source));
    }
}

fn reference_sanitizer(bytes: &[u8]) -> Vec<u8> {
    let source = std::str::from_utf8(bytes).unwrap();
    let mut output = String::with_capacity(source.len());
    let lower = source.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find('<') {
        let start = cursor + relative;
        output.push_str(&source[cursor..start]);
        let Some(end_relative) = find_tag_end(&source[start..]) else {
            output.push_str("&lt;");
            cursor = start + 1;
            continue;
        };
        let end = start + end_relative + 1;
        let tag = &lower[start + 1..end - 1];
        let normalized = tag.trim_start().trim_start_matches('/').trim_start();
        let name = normalized
            .split(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("");
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

fn find_tag_end(value: &str) -> Option<usize> {
    // Quotes only delimit attribute VALUES. A quote inside an attribute name
    // is an HTML parse error, not the beginning of a quoted value.
    let mut quote = None;
    let mut after_equals = false;
    let mut unquoted = false;
    for (index, ch) in value.char_indices().skip(1) {
        if let Some(expected) = quote {
            if ch == expected {
                quote = None;
            }
        } else if ch == '>' {
            return Some(index);
        } else if after_equals {
            if ch == '\'' || ch == '"' {
                quote = Some(ch);
                after_equals = false;
            } else if !ch.is_ascii_whitespace() {
                after_equals = false;
                unquoted = true;
            }
        } else if ch.is_ascii_whitespace() {
            unquoted = false;
        } else if ch == '=' && !unquoted {
            after_equals = true;
        }
    }
    None
}
