//! Field and revision validation, preserving exact date and UTF-16 length contracts.
use super::*;

pub(super) fn text(value: &str, field: &'static str, max: usize) -> AppResult<String> {
    crate::text::validate(value, field, crate::text::Lines::Single, true)?;
    let value = value.trim();
    let count = value.encode_utf16().count();
    if count == 0 || count > max {
        return Err(AppError::validation(
            field,
            format!("must contain 1–{max} characters"),
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn optional_text(value: &str, field: &'static str, max: usize) -> AppResult<String> {
    crate::text::validate(value, field, crate::text::Lines::Multi, false)?;
    let value = value.trim();
    if value.encode_utf16().count() > max {
        return Err(AppError::validation(
            field,
            format!("must contain at most {max} characters"),
        ));
    }
    Ok(if crate::text::is_blank(value) {
        String::new()
    } else {
        value.to_owned()
    })
}

pub(super) fn date(value: &str, field: &'static str) -> AppResult<String> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::validation(field, "must be a valid date in YYYY-MM-DD format"))?;
    if value.len() != 10 || parsed.format("%Y-%m-%d").to_string() != value {
        return Err(AppError::validation(
            field,
            "must be a valid date in YYYY-MM-DD format",
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn optional_date(
    value: Option<String>,
    field: &'static str,
) -> AppResult<Option<String>> {
    value.map(|value| date(&value, field)).transpose()
}

pub(super) fn ensure_revision(actual: i64, expected: i64) -> AppResult<()> {
    if actual != expected {
        return Err(AppError::revision(expected, actual));
    }
    Ok(())
}
