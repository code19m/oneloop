use std::sync::Arc;

use crate::{
    Config, Db,
    auth::AuthService,
    collaboration::{CollaborationRuntime, CollaborationService},
    domain::DomainService,
    files::FileService,
    knowledge::KnowledgeService,
    mcp::client_metadata::ClientDocuments,
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
    pub knowledge: KnowledgeService,
    pub(crate) client_documents: Arc<ClientDocuments>,
}

impl AppState {
    pub fn new(config: Config, db: Db) -> Self {
        Self {
            auth: AuthService::with_password_policy(db.clone(), config.password_policy.clone()),
            domain: DomainService::new(db.clone(), config.timezone.clone()),
            files: FileService::new(
                db.clone(),
                config.storage_limit_bytes,
                config.disk_min_free_bytes,
            ),
            collaboration: CollaborationService::new(db.clone()),
            collaboration_runtime: CollaborationRuntime::new(db.clone()),
            knowledge: KnowledgeService::new(db.clone(), config.disk_min_free_bytes),
            client_documents: Arc::new(ClientDocuments::new(config.mcp_client_metadata_documents)),
            config: Arc::new(config),
            db,
        }
    }
}
