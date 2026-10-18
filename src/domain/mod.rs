//! Shared product-domain services used by the browser API and MCP.
//!
//! Transport handlers deliberately do not contain product rules. Every write
//! enters through [`DomainService::execute`], which performs authorization,
//! optimistic concurrency, idempotency, persistence, audit recording and
//! outbox enqueueing in one database transaction.

mod models;
mod reads;
mod service;
mod types;

pub use crate::paging::PageQuery;
pub use models::*;
pub use reads::{
    BoardQuery, BoardViewQuery, BootstrapQuery, LanesQuery, NAMED_TASKS_LIMIT, PoolQuery,
    RoadmapPageQuery, RoadmapWindow, TaskFilter,
};
pub use service::DomainService;
pub use types::*;

pub(crate) use reads::resolve_task_id;
