//! The HTML preview sanitizer: output safety, adversarial input cost and
//! agreement with a simple reference implementation.

use oneloop::files::sanitize_html_preview;
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
        sanitize_html_preview(only_brackets.as_bytes()).len(),
        only_brackets.len() * "&lt;".len(),
        "every unfinished tag is escaped"
    );
    for input in [
        only_brackets,
        format!("<a x=\"{}", "<".repeat(1024 * 1024)),
        "<\"".repeat(512 * 1024),
    ] {
        let start = std::time::Instant::now();
        let result = sanitize_html_preview(input.as_bytes());
        assert!(!result.is_empty());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            start.elapsed()
        );
    }
}

fn assert_no_nested_navigation(source: &[u8]) {
    let sanitized = sanitize_html_preview(source);
    let text = std::str::from_utf8(&sanitized).unwrap();
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
    #[test]
    fn arbitrary_bytes_produce_bounded_utf8(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
        let output = sanitize_html_preview(&bytes);
        prop_assert!(std::str::from_utf8(&output).is_ok());
        prop_assert!(output.len() <= bytes.len().saturating_mul(4).max(128));
    }
}

#[test]
fn unfinished_tags_preserve_later_markup_and_browser_quote_rules() {
    let benign = "<p>if x < y it's fine</p><h1>Title</h1>";
    assert_eq!(sanitize_html_preview(benign.as_bytes()), benign.as_bytes());
    let malformed = b"<a title=\"unfinished<h1>Title</h1><iframe src=x></iframe><p>end</p>";
    let sanitized = String::from_utf8(sanitize_html_preview(malformed)).unwrap();
    assert!(sanitized.contains("<h1>Title</h1>"));
    assert!(sanitized.contains("<p>end</p>"));
    assert!(!sanitized.contains("<iframe"));
    for source in [
        br#"<a b'c><iframe src=x></iframe>'>"#.as_slice(),
        br#"<p title=x"y><iframe src=x></iframe>" >"#,
    ] {
        assert!(
            !String::from_utf8(sanitize_html_preview(source))
                .unwrap()
                .contains("<iframe")
        );
    }
}

#[test]
fn memoized_scanner_matches_unoptimized_reference() {
    // Keep the value-aware pre-optimization scanner as an output oracle.
    // Deliberately small inputs let the reference rescan malformed suffixes.
    let alphabet = b"<>='\" /abcxyz\t\n";
    let mut state = 13_u64;
    for _ in 0..20_000 {
        let mut source = Vec::new();
        for _ in 0..80 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            source.push(alphabet[(state >> 32) as usize % alphabet.len()]);
        }
        source.extend_from_slice(b"<iframe src=x></iframe><p>ok</p>");
        assert_eq!(sanitize_html_preview(&source), reference_sanitizer(&source));
    }
}

fn reference_sanitizer(bytes: &[u8]) -> Vec<u8> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return b"<!doctype html><meta charset=utf-8><p>This HTML file is not valid UTF-8.</p>"
            .to_vec();
    };
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
