use std::sync::Arc;

use crate::{
    Config, Db,
    auth::AuthService,
    collaboration::{CollaborationRuntime, CollaborationService},
    domain::DomainService,
    files::FileService,
};

/// Shared service configuration for browser handlers, MCP tools and workers.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub auth: AuthService,
    pub domain: DomainService,
    pub files: FileService,
    pub collaboration: CollaborationService,
    pub collaboration_runtime: CollaborationRuntime,
}

impl AppState {
    pub fn new(config: Config, db: Db) -> Self {
        Self {
            auth: AuthService::new(db.clone()),
            domain: DomainService::new(db.clone(), config.timezone),
            files: FileService::new(
                db.clone(),
                config.storage_limit_bytes,
                config.disk_min_free_bytes,
            ),
            collaboration: CollaborationService::new(db.clone()),
            collaboration_runtime: CollaborationRuntime::new(db.clone()),
            config: Arc::new(config),
            db,
        }
    }
}
