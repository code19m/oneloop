//! Conservative preview sniffing and display-safe original filename validation.
use super::*;

pub(super) fn preview_kind_from_metadata(name: &str, media: &str) -> Option<PreviewKind> {
    if media.starts_with("image/") {
        Some(PreviewKind::Image)
    } else if media == "application/pdf" {
        Some(PreviewKind::Pdf)
    } else if media == "text/html" {
        Some(PreviewKind::Html)
    } else {
        let ext = extension(name);
        if matches!(ext.as_str(), "md" | "markdown") {
            Some(PreviewKind::Markdown)
        } else if media.starts_with("text/") {
            Some(PreviewKind::Text)
        } else {
            None
        }
    }
}
pub(super) fn detect_preview(name: &str, bytes: &[u8]) -> Option<PreviewKind> {
    if signature_image(bytes).is_some() {
        return Some(PreviewKind::Image);
    }
    if bytes.starts_with(b"%PDF-") {
        return Some(PreviewKind::Pdf);
    }
    let text = std::str::from_utf8(bytes).ok()?;
    if text
        .chars()
        .any(|character| character < ' ' && !matches!(character, '\t' | '\n' | '\u{000c}' | '\r'))
    {
        return None;
    }
    let ext = extension(name);
    if matches!(ext.as_str(), "html" | "htm") {
        Some(PreviewKind::Html)
    } else if matches!(ext.as_str(), "md" | "markdown") {
        Some(PreviewKind::Markdown)
    } else if is_text_name(name, &ext) {
        Some(PreviewKind::Text)
    } else {
        None
    }
}
pub(super) fn detected_media_type(bytes: &[u8], preview: Option<PreviewKind>) -> String {
    if let Some(kind) = signature_image(bytes) {
        return kind.into();
    }
    if bytes.starts_with(b"%PDF-") {
        return "application/pdf".into();
    }
    match preview {
        Some(PreviewKind::Html) => "text/html".into(),
        Some(PreviewKind::Markdown | PreviewKind::Text) => "text/plain".into(),
        Some(PreviewKind::Image | PreviewKind::Pdf) => "application/octet-stream".into(),
        // Unknown and damaged originals remain downloadable, without granting
        // execution rights based on a client-controlled filename.
        None => "application/octet-stream".into(),
    }
}
pub(super) fn signature_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}
pub(super) fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .filter(|(base, ext)| !base.is_empty() && !ext.is_empty())
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}
pub(super) fn is_text_name(name: &str, ext: &str) -> bool {
    // Kept in parity with uploads.js by frontend/tests/views/uploads.test.cjs.
    matches!(
        ext,
        "txt"
            | "log"
            | "md"
            | "markdown"
            | "mdx"
            | "json"
            | "jsonc"
            | "jsonl"
            | "ndjson"
            | "csv"
            | "tsv"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "ini"
            | "cfg"
            | "conf"
            | "config"
            | "properties"
            | "sql"
            | "graphql"
            | "gql"
            | "js"
            | "mjs"
            | "cjs"
            | "jsx"
            | "ts"
            | "mts"
            | "cts"
            | "tsx"
            | "py"
            | "pyi"
            | "rs"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hpp"
            | "cs"
            | "php"
            | "rb"
            | "swift"
            | "kt"
            | "kts"
            | "scala"
            | "dart"
            | "lua"
            | "pl"
            | "pm"
            | "r"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "bat"
            | "cmd"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "svelte"
            | "vue"
            | "astro"
            | "diff"
            | "patch"
            | "gitignore"
            | "gitattributes"
            | "editorconfig"
            | "env"
            | "dockerfile"
            | "makefile"
            | "cmake"
            | "tex"
            | "rst"
            | "adoc"
            | "svg"
    ) || matches!(
        name.to_ascii_lowercase().as_str(),
        ".dockerignore"
            | ".editorconfig"
            | ".env"
            | ".gitattributes"
            | ".gitignore"
            | ".npmrc"
            | ".nvmrc"
            | "authors"
            | "changelog"
            | "containerfile"
            | "dockerfile"
            | "gemfile"
            | "gnumakefile"
            | "justfile"
            | "licence"
            | "license"
            | "makefile"
            | "notice"
            | "procfile"
            | "rakefile"
            | "readme"
    )
}
pub(super) fn may_be_text(name: &str) -> bool {
    let ext = extension(name);
    matches!(ext.as_str(), "html" | "htm" | "md" | "markdown") || is_text_name(name, &ext)
}

pub(crate) fn validate_original_name(value: &str) -> AppResult<()> {
    crate::text::validate(value, "fileName", crate::text::Lines::Single, true)?;
    let count = value.chars().count();
    if count == 0
        || count > 255
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(|c| c == '\0' || c.is_control())
    {
        return Err(AppError::validation(
            "fileName",
            "must be a plain filename of 1–255 characters",
        ));
    }
    Ok(())
}

// Whole-file UTF-8/control validation on a blocking worker, with bounded memory.
// Keep up to three trailing bytes between reads for a split Unicode scalar.
pub(super) fn inspect_file_media(name: &str, path: &Path, prefix: &[u8]) -> AppResult<String> {
    let preview = if may_be_text(name)
        && signature_image(prefix).is_none()
        && !prefix.starts_with(b"%PDF-")
    {
        if valid_text_reader(std::fs::File::open(path)?)? {
            detect_preview(name, b"")
        } else {
            None
        }
    } else {
        detect_preview(name, prefix)
    };
    Ok(detected_media_type(prefix, preview))
}

pub(super) fn valid_text_reader(mut reader: impl std::io::Read) -> std::io::Result<bool> {
    let mut buffer = [0_u8; 64 * 1024 + 3];
    let mut carry = 0;
    loop {
        let read = match reader.read(&mut buffer[carry..]) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if read == 0 {
            return Ok(carry == 0);
        }
        let len = carry + read;
        let bytes = &buffer[..len];
        if bytes
            .iter()
            .any(|b| *b < b' ' && !matches!(*b, b'\t' | b'\n' | 12 | b'\r'))
        {
            return Ok(false);
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => carry = 0,
            Err(error) if error.error_len().is_none() => {
                let valid = error.valid_up_to();
                carry = len - valid;
                buffer.copy_within(valid..len, 0);
            }
            Err(_) => return Ok(false),
        }
    }
}
