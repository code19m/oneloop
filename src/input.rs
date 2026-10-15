//! Typed input from untrusted JSON, shared by every transport. Errors name the
//! field and never echo the value.
use crate::{AppError, AppResult};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Reads a command's payload, which must be a JSON object.
pub(crate) fn parse_payload<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    if !value.is_object() {
        return Err(AppError::validation("payload", "must be an object"));
    }
    serde_path_to_error::deserialize(value).map_err(|error| field_error(error, "payload"))
}

/// The validation error for input that doesn't fit its type: at the field the
/// error names, or at `fallback` when it concerns the input as a whole.
pub(crate) fn field_error<E: std::fmt::Display>(
    error: serde_path_to_error::Error<E>,
    fallback: &str,
) -> AppError {
    let path = error.path().to_string();
    let message = error.inner().to_string();
    let (field, description) = if let Some(rest) = message.strip_prefix("missing field `") {
        (rest.split('`').next(), "is required")
    } else if let Some(rest) = message.strip_prefix("duplicate field `") {
        (rest.split('`').next(), "must occur only once")
    } else if let Some(rest) = message.strip_prefix("unknown field `") {
        (rest.split('`').next(), "is not supported")
    } else {
        (None, "has an invalid value or format")
    };
    let path = path.trim_matches('.');
    let field = match (path.is_empty(), field) {
        (true, Some(field)) => field.to_owned(),
        (false, Some(field))
            if message.starts_with("unknown field `") && path.rsplit('.').next() == Some(field) =>
        {
            path.to_owned()
        }
        (false, Some(field)) => format!("{path}.{field}"),
        (false, None) => path.to_owned(),
        (true, None) => fallback.to_owned(),
    };
    AppError::validation(field, description)
}
