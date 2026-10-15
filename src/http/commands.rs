//! `POST /api/commands`: the one browser endpoint for domain, comment, Inbox
//! and Knowledge writes.
use super::input::{ApiJson, CommandInput};
use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    collaboration::CollaborationOperation,
    command::{Command, CommandResult},
    domain::DomainOperation,
    knowledge::KnowledgeOperation,
};
use axum::{Extension, Json, extract::State};
use serde_json::Value;

/// Hands the command to the service that owns its operation.
pub(crate) async fn execute(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    ApiJson(input): ApiJson<CommandInput>,
) -> AppResult<Json<CommandResult>> {
    let name = input.operation.as_str();
    let result = if let Some(operation) = DomainOperation::parse(name) {
        state
            .domain
            .execute(&actor, input.command(operation)?)
            .await
    } else if let Some(operation) = CollaborationOperation::parse(name) {
        state
            .collaboration
            .execute(&actor, input.command(operation)?)
            .await
    } else if let Some(operation) = KnowledgeOperation::parse(name) {
        state
            .knowledge
            .execute(&actor, input.command(operation)?)
            .await
    } else {
        Err(AppError::validation(
            "operation",
            "is not a supported operation",
        ))
    };
    result.map(Json)
}

impl CommandInput {
    fn command<O>(self, operation: O) -> AppResult<Command<O>> {
        // The services check that the payload is an object, for MCP calls too.
        let payload: Value = serde_json::from_str(self.payload.get())
            .map_err(|_| AppError::validation("payload", "must be an object"))?;
        Ok(Command {
            operation,
            payload,
            idempotency_key: self.idempotency_key,
            expected_revision: self.expected_revision,
        })
    }
}
