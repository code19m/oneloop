//! Field-aware browser extraction with stable errors and no echoed input values.
use crate::{AppError, AppResult};
use axum::{
    body::Bytes,
    extract::{FromRequest, FromRequestParts, Request},
    http::{StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

pub(crate) struct ApiJson<T>(pub T);
pub(crate) struct ApiQuery<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = Response;
    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .is_some_and(|v| {
                v.eq_ignore_ascii_case("application/json")
                    || (v.starts_with("application/") && v.ends_with("+json"))
            });
        if !json {
            return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response());
        }
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(IntoResponse::into_response)?;
        parse_json(&bytes)
            .map(Self)
            .map_err(IntoResponse::into_response)
    }
}

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for ApiQuery<T> {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> AppResult<Self> {
        let deserializer = serde_urlencoded::Deserializer::new(url::form_urlencoded::parse(
            parts.uri.query().unwrap_or_default().as_bytes(),
        ));
        serde_path_to_error::deserialize(deserializer)
            .map(Self)
            .map_err(|error| input_error(error, "query"))
    }
}

pub(crate) fn parse_json<T: DeserializeOwned>(bytes: &[u8]) -> AppResult<T> {
    if bytes
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        != Some(b'{')
    {
        return Err(AppError::validation("body", "must be a JSON object"));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let result = serde_path_to_error::deserialize(&mut deserializer)
        .map_err(|error| input_error(error, "body"))?;
    deserializer
        .end()
        .map_err(|_| AppError::validation("body", "must contain one JSON object"))?;
    Ok(result)
}

pub(crate) fn parse_payload<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    if !value.is_object() {
        return Err(AppError::validation("payload", "must be an object"));
    }
    serde_path_to_error::deserialize(value).map_err(|error| input_error(error, "payload"))
}

fn input_error<E: std::fmt::Display>(
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

/// Preserve raw payload until the envelope has been validated; serde then
/// rejects duplicate envelope fields instead of silently keeping the last one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommandInput {
    pub operation: String,
    pub payload: Box<serde_json::value::RawValue>,
    pub idempotency_key: String,
    pub expected_revision: Option<i64>,
}
