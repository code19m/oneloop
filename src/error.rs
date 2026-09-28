use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("record changed since revision {expected}; latest revision is {current}")]
    RevisionConflict { expected: i64, current: i64 },
    #[error("{message}")]
    Rule { kind: RuleKind, message: String },
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("invalid {field}: {message}")]
    Validation { field: String, message: String },
    #[error("The request exceeds the size limit")]
    RequestTooLarge,
    #[error("authentication is required")]
    Unauthorized,
    #[error("Incorrect username or password.")]
    InvalidCredentials,
    #[error("Incorrect current password.")]
    IncorrectPassword { field: &'static str },
    #[error("you do not have permission to perform this action")]
    Forbidden,
    #[error("Open oneloop at {canonical_url} and try again.")]
    InvalidOrigin { canonical_url: String },
    #[error("{resource} was not found")]
    NotFound { resource: &'static str },
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PreconditionFailed(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("too many attempts; try again later")]
    RateLimited { retry_after: u64 },
    #[error("database error: {0}")]
    Database(String),
    #[error("server storage is full: {0}")]
    StorageFull(String),
    #[error("filesystem error: {0}")]
    Io(String),
    #[error("internal error: {0}")]
    Internal(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleKind {
    IdempotencyKeyReused,
    PrefixReserved,
    CursorStale,
    UsernameTaken,
    LastAdmin,
    AlreadyMember,
    MemberHasOpenTasks,
    RecentAuthRequired,
    BroadcastCooldown,
    StorageFull,
}
impl RuleKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::IdempotencyKeyReused => "idempotency_key_reused",
            Self::PrefixReserved => "prefix_reserved",
            Self::CursorStale => "cursor_stale",
            Self::UsernameTaken => "username_taken",
            Self::LastAdmin => "last_admin",
            Self::AlreadyMember => "already_member",
            Self::MemberHasOpenTasks => "member_has_open_tasks",
            Self::RecentAuthRequired => "recent_auth_required",
            Self::BroadcastCooldown => "broadcast_cooldown",
            Self::StorageFull => "storage_full",
        }
    }
    fn status(self) -> StatusCode {
        match self {
            Self::IdempotencyKeyReused => StatusCode::CONFLICT,
            Self::PrefixReserved => StatusCode::CONFLICT,
            Self::CursorStale => StatusCode::CONFLICT,
            Self::UsernameTaken => StatusCode::CONFLICT,
            Self::LastAdmin => StatusCode::CONFLICT,
            Self::AlreadyMember => StatusCode::CONFLICT,
            Self::MemberHasOpenTasks => StatusCode::PRECONDITION_FAILED,
            Self::RecentAuthRequired => StatusCode::PRECONDITION_FAILED,
            Self::BroadcastCooldown => StatusCode::TOO_MANY_REQUESTS,
            Self::StorageFull => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}
impl AppError {
    pub fn rule(kind: RuleKind, message: impl Into<String>) -> Self {
        Self::Rule {
            kind,
            message: message.into(),
        }
    }
    pub fn revision(expected: i64, current: i64) -> Self {
        Self::RevisionConflict { expected, current }
    }

    pub fn validation(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Validation {
            field: field.into(),
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Config(_) | Self::Validation { .. } => 2,
            _ => 1,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::RevisionConflict { .. } => "revision_conflict",
            Self::Rule { kind, .. } => kind.code(),
            Self::Config(_) => "invalid_configuration",
            Self::Validation { .. } => "validation_failed",
            Self::RequestTooLarge => "request_too_large",
            Self::Unauthorized => "unauthorized",
            Self::InvalidCredentials => "invalid_credentials",
            Self::IncorrectPassword { .. } => "incorrect_password",
            Self::Forbidden => "forbidden",
            Self::InvalidOrigin { .. } => "invalid_origin",
            Self::NotFound { .. } => "not_found",
            Self::Conflict(_) => "conflict",
            Self::PreconditionFailed(_) => "precondition_failed",
            Self::Unavailable(_) => "unavailable",
            Self::RateLimited { .. } => "rate_limited",
            Self::StorageFull(_) => "storage_full",
            Self::Database(_) | Self::Io(_) | Self::Internal(_) => "internal_error",
        }
    }

    pub(crate) fn log_server_error(&self) -> Option<String> {
        if !self.status().is_server_error() {
            return None;
        }
        let reference = uuid::Uuid::now_v7().to_string();
        if self.status() == StatusCode::SERVICE_UNAVAILABLE {
            tracing::warn!(%reference, code = self.code(), error = %self, "application request unavailable");
        } else {
            tracing::error!(%reference, code = self.code(), error = %self, "application request failed");
        }
        Some(reference)
    }

    pub fn status(&self) -> StatusCode {
        match self {
            Self::RevisionConflict { .. } => StatusCode::CONFLICT,
            Self::Rule { kind, .. } => kind.status(),
            Self::Config(_) | Self::Validation { .. } | Self::IncorrectPassword { .. } => {
                StatusCode::BAD_REQUEST
            }
            Self::RequestTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Unauthorized | Self::InvalidCredentials => StatusCode::UNAUTHORIZED,
            Self::Forbidden | Self::InvalidOrigin { .. } => StatusCode::FORBIDDEN,
            Self::NotFound { .. } => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::PreconditionFailed(_) => StatusCode::PRECONDITION_FAILED,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::StorageFull(_) => StatusCode::INSUFFICIENT_STORAGE,
            Self::Database(_) | Self::Io(_) | Self::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    pub(crate) fn client_message(&self) -> String {
        match self {
            Self::NotFound { .. } => "Resource was not found".to_owned(),
            Self::StorageFull(_) => {
                "Server storage is full; ask an administrator to free space".to_owned()
            }
            Self::Database(_) | Self::Io(_) | Self::Internal(_) => {
                "The operation could not be completed".to_owned()
            }
            _ => self.to_string(),
        }
    }

    pub(crate) fn client_details(&self) -> Option<Value> {
        match self {
            Self::RevisionConflict { expected, current } => {
                Some(json!({"expectedRevision":expected,"currentRevision":current}))
            }
            Self::IncorrectPassword { field } => Some(json!({
                "field": field,
                "message": "Incorrect current password.",
            })),
            Self::InvalidOrigin { canonical_url } => Some(json!({"canonicalUrl": canonical_url})),
            Self::Validation { field, message } => Some(json!({
                "field": field,
                "message": message,
            })),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull) {
            Self::StorageFull(error.to_string())
        } else if matches!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        ) {
            Self::Unavailable("database is busy; try again shortly".into())
        } else if matches!(&error, rusqlite::Error::SqliteFailure(inner, _) if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_CHECK)
        {
            Self::validation("payload", "does not satisfy the data constraints")
        } else {
            Self::Database(error.to_string())
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        if matches!(
            error.kind(),
            std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
        ) {
            Self::StorageFull(error.to_string())
        } else {
            Self::Io(error.to_string())
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference: Option<String>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let retry_after = match &self {
            Self::RateLimited { retry_after } => Some(*retry_after),
            Self::Unavailable(_)
            | Self::Rule {
                kind: RuleKind::StorageFull,
                ..
            } => Some(1),
            Self::Rule {
                kind: RuleKind::BroadcastCooldown,
                ..
            } => Some(60),
            _ => None,
        };
        let details = self.client_details();
        let reference = self.log_server_error();
        let mut message = self.client_message();
        if let Some(reference) = &reference {
            message.push_str(&format!(" (reference: {reference})"));
        }
        let body = ErrorBody {
            error: ErrorDetail {
                code: self.code(),
                message,
                details,
                reference,
            },
        };
        let mut response = (status, Json(body)).into_response();
        if let Some(seconds) = retry_after
            && let Ok(value) = axum::http::HeaderValue::from_str(&seconds.to_string())
        {
            response
                .headers_mut()
                .insert(axum::http::header::RETRY_AFTER, value);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;
    use axum::{body::to_bytes, response::IntoResponse};
    use serde_json::json;

    #[test]
    fn validation_errors_expose_structured_field_details() {
        let error = AppError::validation("title", "must contain 1–140 characters");
        assert_eq!(
            error.client_details(),
            Some(json!({"field":"title","message":"must contain 1–140 characters"}))
        );
    }

    #[test]
    fn non_validation_errors_do_not_expose_internal_details() {
        assert_eq!(
            AppError::internal("database exploded").client_details(),
            None
        );
    }

    #[tokio::test]
    async fn validation_http_response_keeps_message_and_adds_machine_readable_details() {
        let response =
            AppError::validation("title", "must contain 1–140 characters").into_response();
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "validation_failed");
        assert_eq!(
            value["error"]["message"],
            "invalid title: must contain 1–140 characters"
        );
        assert_eq!(
            value["error"]["details"],
            json!({"field":"title","message":"must contain 1–140 characters"})
        );
    }
}
