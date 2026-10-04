//! Durable discussion, activity, Inbox and live-update services.
//!
//! This module owns the collaboration rules shared by browser and MCP callers.
//! All write entry points authenticate an [`Actor`](crate::auth::Actor) again
//! inside the same SQLite transaction that stores the mutation, audit record,
//! recipient snapshot and outbox message.

mod activity;
mod models;
mod notifications;
mod runtime;
mod service;

pub use activity::{ActivityInput, record_activity_tx, record_system_activity_tx};
pub use models::*;
pub use notifications::{NotificationInput, snapshot_notification_tx};
pub use runtime::{CollaborationRuntime, OutboxWorker};
pub use service::CollaborationService;

pub(crate) use runtime::enqueue_access_change_tx;
pub(crate) use service::{ARCHIVE_RETENTION_SECONDS, enqueue_inbox_change_tx};
