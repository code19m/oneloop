use super::input::{ApiJson, CommandInput};
use crate::{
    AppError, AppResult, AppState,
    auth::Actor,
    collaboration::{CollaborationCommand, CollaborationService},
    domain::{CommandEnvelope, DomainOperation},
};
use axum::{Extension, Json, extract::State};
use serde_json::Value;

/// One browser dispatcher over independently owned, shared product services.
pub(crate) async fn execute(
    State(state): State<AppState>,
    Extension(actor): Extension<Actor>,
    ApiJson(input): ApiJson<CommandInput>,
) -> AppResult<Json<Value>> {
    let collaboration = CollaborationService::supports(&input.operation);
    let operation =
        serde_json::from_value::<DomainOperation>(Value::String(input.operation.clone())).ok();
    if !collaboration && operation.is_none() {
        return Err(AppError::validation(
            "operation",
            "is not a supported operation",
        ));
    }
    let payload: Value = serde_json::from_str(input.payload.get())
        .map_err(|_| AppError::validation("payload", "must be an object"))?;
    if !payload.is_object() {
        return Err(AppError::validation("payload", "must be an object"));
    }
    let result = if collaboration {
        serde_json::to_value(
            state
                .collaboration
                .execute(
                    &actor,
                    CollaborationCommand {
                        operation: input.operation,
                        payload,
                        idempotency_key: input.idempotency_key,
                        expected_revision: input.expected_revision,
                    },
                )
                .await?,
        )
    } else {
        serde_json::to_value(
            state
                .domain
                .execute(
                    &actor,
                    CommandEnvelope {
                        operation: operation.expect("checked operation"),
                        payload,
                        idempotency_key: input.idempotency_key,
                        expected_revision: input.expected_revision,
                    },
                )
                .await?,
        )
    }
    .map_err(|error| AppError::internal(format!("serialize command response: {error}")))?;
    Ok(Json(result))
}
