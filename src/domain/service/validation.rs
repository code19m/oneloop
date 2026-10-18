//! Calendar dates in commands and reads, which must be exactly `YYYY-MM-DD`.
use super::*;

pub(in crate::domain) fn date(value: &str, field: &'static str) -> AppResult<String> {
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
