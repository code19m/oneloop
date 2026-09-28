//! Display-text validation shared by browser and MCP writes. Never used for passwords.
//! Validate without rewriting Unicode or mention offsets; joiners remain supported.
use crate::{AppError, AppResult};

#[derive(Clone, Copy)]
pub(crate) enum Lines {
    Single,
    Multi,
}

pub(crate) fn validate(value: &str, field: &str, lines: Lines, required: bool) -> AppResult<()> {
    if value.chars().any(|c| {
        (c.is_control() && !(matches!(lines, Lines::Multi) && matches!(c, '\n' | '\r' | '\t')))
            || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            || (matches!(lines, Lines::Single) && matches!(c, '\u{2028}' | '\u{2029}'))
    }) {
        return Err(AppError::validation(field, "contains unsupported control or directional characters"));
    }
    if required && is_blank(value) {
        return Err(AppError::validation(field, "must contain visible text"));
    }
    Ok(())
}

pub(crate) fn is_blank(value: &str) -> bool {
    !value
        .chars()
        .any(|c| !c.is_whitespace() && !default_ignorable(c))
}

fn default_ignorable(c: char) -> bool {
    matches!(c, '\u{00ad}' | '\u{034f}' | '\u{061c}' | '\u{115f}'..='\u{1160}' |
        '\u{17b4}'..='\u{17b5}' | '\u{180b}'..='\u{180f}' | '\u{200b}'..='\u{200f}' |
        '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{3164}' |
        '\u{fe00}'..='\u{fe0f}' | '\u{feff}' | '\u{ffa0}' | '\u{fff0}'..='\u{fff8}' |
        '\u{1bca0}'..='\u{1bca3}' | '\u{1d173}'..='\u{1d17a}' | '\u{e0000}'..='\u{e0fff}')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controls_bidi_and_invisible_only_text_are_rejected() {
        for c in (0..=0x9f)
            .filter_map(char::from_u32)
            .filter(|c| c.is_control())
        {
            assert!(validate(&format!("a{c}b"), "name", Lines::Single, true).is_err());
            assert_eq!(
                validate(&format!("a{c}b"), "body", Lines::Multi, true).is_ok(),
                matches!(c, '\n' | '\r' | '\t')
            );
        }
        for c in [
            '\u{061c}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}',
            '\u{202e}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
        ] {
            assert!(validate(&format!("a{c}b"), "name", Lines::Multi, true).is_err());
        }
        for value in [
            " \u{200b}\u{200c}\u{200d}",
            "\u{fe0f}",
            "\u{e0100}",
            "\u{00ad}",
        ] {
            assert!(validate(value, "name", Lines::Single, true).is_err());
        }
        for value in ["👩‍💻", "می‌خواهم", "العربية", "日本語"] {
            validate(value, "name", Lines::Single, true).unwrap();
        }
        validate("\r\n\t @Member 👩‍💻", "content", Lines::Multi, true).unwrap();
    }
}
