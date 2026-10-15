//! Extractors for browser JSON and query input. An error names the field and
//! never repeats the value.
use crate::{AppError, AppResult, input::field_error};
use axum::{
    body::Bytes,
    extract::{FromRequest, FromRequestParts, Request},
    http::{StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, de::DeserializeOwned};

pub(crate) struct ApiJson<T>(pub T);
pub(crate) struct ApiQuery<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = Response;
    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json_media_type);
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
            .map_err(|error| field_error(error, "query"))
    }
}

/// Whether a Content-Type names JSON: `application/json` or a
/// `application/*+json` type, with any parameters.
pub(crate) fn is_json_media_type(content_type: &str) -> bool {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    media_type == "application/json"
        || media_type
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype.ends_with("+json"))
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
        .map_err(|error| field_error(error, "body"))?;
    deserializer
        .end()
        .map_err(|_| AppError::validation("body", "must contain one JSON object"))?;
    Ok(result)
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
