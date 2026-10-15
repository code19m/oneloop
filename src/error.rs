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
    #[error("The request took too long to arrive; try again")]
    RequestTimeout,
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
    TemporaryPasswordExpired,
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
            Self::TemporaryPasswordExpired => "temporary_password_expired",
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
            Self::TemporaryPasswordExpired => StatusCode::UNAUTHORIZED,
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
            Self::RequestTimeout => "request_timeout",
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
            Self::RequestTimeout => StatusCode::REQUEST_TIMEOUT,
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

    /// How many seconds a client should wait before it tries again.
    pub(crate) fn retry_after(&self) -> Option<u64> {
        match self {
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
        }
    }

    /// The message for clients. A server fault is logged first, and its
    /// message ends with the log entry's reference, which is also returned.
    pub(crate) fn reported_message(&self) -> (String, Option<String>) {
        let reference = self.log_server_error();
        let mut message = self.client_message();
        if let Some(reference) = &reference {
            message.push_str(&format!(" (reference: {reference})"));
        }
        (message, reference)
    }

    pub(crate) fn client_message(&self) -> String {
        match self {
            Self::NotFound { .. } => "Resource was not found".to_owned(),
            Self::StorageFull(_) => {
                "Server storage is full; ask an administrator to free space".to_owned()
            }
            Self::Unavailable(_) => "The service is busy; try again shortly".to_owned(),
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
        let details = self.client_details();
        let (message, reference) = self.reported_message();
        let body = ErrorBody {
            error: ErrorDetail {
                code: self.code(),
                message,
                details,
                reference,
            },
        };
        let mut response = (self.status(), Json(body)).into_response();
        if let Some(seconds) = self.retry_after() {
            response
                .headers_mut()
                .insert(axum::http::header::RETRY_AFTER, seconds.into());
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{ErrorKind, Write},
        sync::{Arc, Mutex},
    };

    use super::AppError;
    use axum::{body::to_bytes, http::header::RETRY_AFTER, response::IntoResponse};
    use rusqlite::ffi;
    use serde_json::{Value, json};

    /// Each kind of error as a client sees it. A server fault also names the
    /// log entry with its cause, and private text never reaches the client.
    #[tokio::test]
    async fn errors_have_stable_http_responses() {
        let sqlite = |code| {
            AppError::from(rusqlite::Error::SqliteFailure(
                ffi::Error::new(code),
                Some("private database".into()),
            ))
        };
        let io = |kind| AppError::from(std::io::Error::new(kind, "private path"));
        let busy = "The service is busy; try again shortly";
        let full = "Server storage is full; ask an administrator to free space";
        let failed = "The operation could not be completed";
        for (error, status, code, message, retry_after, details) in [
            (
                AppError::validation("title", "must contain 1–140 characters"),
                400,
                "validation_failed",
                "invalid title: must contain 1–140 characters",
                None,
                Some(json!({"field":"title","message":"must contain 1–140 characters"})),
            ),
            (
                AppError::revision(3, 7),
                409,
                "revision_conflict",
                "record changed since revision 3; latest revision is 7",
                None,
                Some(json!({"expectedRevision":3,"currentRevision":7})),
            ),
            (
                AppError::RateLimited { retry_after: 42 },
                429,
                "rate_limited",
                "too many attempts; try again later",
                Some("42"),
                None,
            ),
            (
                sqlite(ffi::SQLITE_BUSY),
                503,
                "unavailable",
                busy,
                Some("1"),
                None,
            ),
            (
                sqlite(ffi::SQLITE_LOCKED),
                503,
                "unavailable",
                busy,
                Some("1"),
                None,
            ),
            (
                io(ErrorKind::StorageFull),
                507,
                "storage_full",
                full,
                None,
                None,
            ),
            (
                io(ErrorKind::QuotaExceeded),
                507,
                "storage_full",
                full,
                None,
                None,
            ),
            (
                sqlite(ffi::SQLITE_FULL),
                507,
                "storage_full",
                full,
                None,
                None,
            ),
            (
                AppError::Database("private database path".into()),
                500,
                "internal_error",
                failed,
                None,
                None,
            ),
            (
                AppError::internal("private detail"),
                500,
                "internal_error",
                failed,
                None,
                None,
            ),
        ] {
            let response = error.into_response();
            assert_eq!(response.status(), status, "{code}");
            let header = response.headers().get(RETRY_AFTER);
            assert_eq!(
                header.map(|value| value.to_str().unwrap()),
                retry_after,
                "{code}"
            );
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let text = std::str::from_utf8(&body).unwrap();
            assert!(!text.contains("private"), "{text}");
            let error = &serde_json::from_str::<Value>(text).unwrap()["error"];
            assert_eq!(error["code"], code);
            assert_eq!(error.get("details"), details.as_ref(), "{code}");
            match error.get("reference").and_then(Value::as_str) {
                Some(reference) => {
                    assert!(status >= 500 && uuid::Uuid::parse_str(reference).is_ok());
                    assert_eq!(
                        error["message"],
                        format!("{message} (reference: {reference})")
                    );
                }
                None => {
                    assert!(status < 500, "{code}");
                    assert_eq!(error["message"], message);
                }
            }
        }
    }

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Self;
        fn make_writer(&'a self) -> Self {
            self.clone()
        }
    }

    #[tokio::test]
    async fn internal_cause_and_reference_are_logged_but_only_reference_reaches_client() {
        // tracing caches per log call site whether any subscriber wants it. While
        // only one subscriber exists, it asks just the current thread's, so a test
        // on another thread could mark these call sites as never wanted. With a
        // second subscriber alive, it asks them all.
        let _second = tracing::Dispatch::new(tracing_subscriber::registry());
        let capture = Capture(Arc::default());
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(capture.clone())
            .finish();
        let responses = tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(
                "request",
                method = "POST",
                route = "/api/test",
                request_id = "request-check"
            );
            let _entered = span.enter();
            [
                (
                    AppError::Io("Permission denied while storing a file".into()).into_response(),
                    "Permission denied",
                ),
                (
                    AppError::Unavailable(
                        "data lease is busy at /private/data/.oneloop-data.lock".into(),
                    )
                    .into_response(),
                    "/private/data/.oneloop-data.lock",
                ),
            ]
        });
        let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        assert!(log.contains("/api/test") && log.contains("request-check"));
        for (response, private) in responses {
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(log.contains(private), "{log}");
            assert!(log.contains(body["error"]["reference"].as_str().unwrap()));
            assert!(!String::from_utf8_lossy(&bytes).contains(private));
        }
    }
}
