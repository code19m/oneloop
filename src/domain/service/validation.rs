//! Date and revision validation, preserving the exact date contract.
use super::*;

pub(super) fn date(value: &str, field: &'static str) -> AppResult<String> {
    // Only the exact form round-trips: no other ISO 8601 spelling.
    let exact = value.len() == 10
        && value
            .parse::<jiff::civil::Date>()
            .is_ok_and(|date| date.to_string() == value);
    if !exact {
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
