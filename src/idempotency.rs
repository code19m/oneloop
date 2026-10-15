//! One retry ledger for browser and MCP writes, and the command envelope around
//! it. A key belongs to its actor or grant and to one exact request for 24
//! hours. A failed attempt may run again, a running one conflicts, and a
//! retry of a successful one returns its stored result after the service
//! rechecks current access.
use crate::{
    AppError, AppResult,
    auth::{Actor, refresh_actor_connection},
    collaboration::ActivityEvent,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(crate) const TTL_SECONDS: i64 = 24 * 60 * 60;

/// Declares the operations of one command family: an enum whose variants carry
/// their wire names, with `ALL`, `as_str` and `parse`, so each name is written
/// once.
macro_rules! operations {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $($variant:ident = $wire:literal,)+
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
        $vis enum $name {
            $(#[serde(rename = $wire)] $variant,)+
        }

        impl $name {
            /// Every operation, in declaration order.
            $vis const ALL: &'static [Self] = &[$(Self::$variant),+];

            $vis fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            $vis fn parse(name: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|operation| operation.as_str() == name)
            }
        }
    };
}
pub(crate) use operations;

/// What a command says about `expectedRevision`.
#[derive(Clone, Copy)]
pub(crate) enum RevisionRule {
    /// It creates a record, so a revision is refused.
    Create,
    /// It changes a record, so a revision is required. A missing one fails the
    /// precondition (412).
    Existing,
    /// A revision is optional.
    Optional,
    /// It changes no record that has a revision, so a revision is refused.
    None,
}

impl RevisionRule {
    fn check(self, revision: Option<i64>) -> AppResult<()> {
        match (self, revision) {
            (Self::Existing, None) => Err(AppError::PreconditionFailed(
                "expectedRevision is required for changes to existing records".into(),
            )),
            (Self::Create, Some(_)) => Err(AppError::validation(
                "expectedRevision",
                "must be omitted when creating a new record",
            )),
            (Self::None, Some(_)) => Err(AppError::validation(
                "expectedRevision",
                "is not accepted for this operation",
            )),
            (_, Some(value)) if value < 1 => Err(AppError::validation(
                "expectedRevision",
                "must be a positive integer",
            )),
            _ => Ok(()),
        }
    }
}

/// The response of every command. A retry returns the stored one, with
/// `replayed` set.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub entities: Vec<Value>,
    pub events: Vec<ActivityEvent>,
    pub replayed: bool,
}

/// What a command changed, and the record its receipt names.
pub(crate) struct Mutation {
    pub(crate) entities: Vec<Value>,
    pub(crate) events: Vec<ActivityEvent>,
    pub(crate) resource_type: &'static str,
    pub(crate) resource_id: Option<String>,
}

impl Mutation {
    pub(crate) fn new(
        entity: Value,
        events: Vec<ActivityEvent>,
        resource_type: &'static str,
        resource_id: &str,
    ) -> Self {
        Self {
            entities: vec![entity],
            events,
            resource_type,
            resource_id: Some(resource_id.to_owned()),
        }
    }

    pub(crate) fn one(
        entity: Value,
        event: ActivityEvent,
        resource_type: &'static str,
        resource_id: &str,
    ) -> Self {
        Self::new(entity, vec![event], resource_type, resource_id)
    }
}

/// A write whose key is checked and whose request is hashed before it waits
/// for the database.
pub(crate) struct Envelope {
    operation: &'static str,
    key: String,
    hash: String,
}

impl Envelope {
    /// A command: its revision is checked against `rule`, and the operation,
    /// payload and revision are hashed.
    pub(crate) fn new(
        operation: &'static str,
        payload: &Value,
        key: &str,
        expected_revision: Option<i64>,
        rule: RevisionRule,
    ) -> AppResult<Self> {
        validate_key(key)?;
        rule.check(expected_revision)?;
        Self::hashed(
            operation,
            key,
            &json!({
                "operation": operation,
                "payload": payload,
                "expectedRevision": expected_revision,
            }),
        )
    }

    /// A write with its own route, such as a file change, whose whole
    /// `request` is hashed.
    pub(crate) fn request(operation: &'static str, key: &str, request: &Value) -> AppResult<Self> {
        validate_key(key)?;
        Self::hashed(operation, key, request)
    }

    fn hashed(operation: &'static str, key: &str, request: &Value) -> AppResult<Self> {
        Ok(Self {
            operation,
            key: key.to_owned(),
            hash: request_hash(request)?,
        })
    }

    /// Runs the command once in `tx`, like `once`, and records its result.
    pub(crate) fn run(
        &self,
        tx: &Transaction<'_>,
        actor: &Actor,
        now: i64,
        authorize_replay: impl FnOnce(&Actor, &mut CommandResult) -> AppResult<()>,
        apply: impl FnOnce(&Actor) -> AppResult<Mutation>,
    ) -> AppResult<CommandResult> {
        self.once(
            tx,
            actor,
            now,
            |actor, stored: &mut CommandResult| {
                authorize_replay(actor, stored)?;
                stored.replayed = true;
                Ok(())
            },
            |actor| {
                let mutation = apply(actor)?;
                let resource = Resource {
                    kind: mutation.resource_type,
                    id: mutation.resource_id,
                    project_id: mutation
                        .events
                        .iter()
                        .find_map(|event| event.project_id.clone()),
                };
                let result = CommandResult {
                    entities: mutation.entities,
                    events: mutation.events,
                    replayed: false,
                };
                Ok((result, resource))
            },
        )
    }

    /// Runs the write once in `tx`, for the actor as the database knows it
    /// now. A retry of a finished write gets its stored result after
    /// `authorize_replay` rechecks today's access (it may also bring the
    /// result up to date). Otherwise `apply` makes the change, and its result
    /// becomes the receipt, which names `Resource`.
    pub(crate) fn once<T: Serialize + DeserializeOwned>(
        &self,
        tx: &Transaction<'_>,
        actor: &Actor,
        now: i64,
        authorize_replay: impl FnOnce(&Actor, &mut T) -> AppResult<()>,
        apply: impl FnOnce(&Actor) -> AppResult<(T, Resource)>,
    ) -> AppResult<T> {
        let actor = refresh_actor_connection(tx, actor)?;
        if let Some(mut stored) =
            replay::<T>(tx, &actor, &self.key, self.operation, &self.hash, now)?
        {
            authorize_replay(&actor, &mut stored)?;
            return Ok(stored);
        }
        let id = start(
            tx,
            &actor,
            &Uuid::now_v7().to_string(),
            &self.key,
            self.operation,
            &self.hash,
            now,
        )?;
        let (result, resource) = apply(&actor)?;
        let response = serde_json::to_string(&result)
            .map_err(|error| AppError::internal(format!("serialize write response: {error}")))?;
        succeed(tx, &id, &response, &resource, now)?;
        Ok(result)
    }
}

/// The record a receipt names.
pub(crate) struct Resource {
    pub(crate) kind: &'static str,
    pub(crate) id: Option<String>,
    pub(crate) project_id: Option<String>,
}

pub(crate) fn validate_key(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(AppError::validation(
            "idempotencyKey",
            "must contain 1–128 visible ASCII characters",
        ));
    }
    Ok(())
}

pub(crate) fn request_hash(value: &impl Serialize) -> AppResult<String> {
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<_> = map.into_iter().collect();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(k, v)| (k, canonical(v)))
                        .collect(),
                )
            }
            Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
            other => other,
        }
    }
    let value = serde_json::to_value(value).map_err(|e| AppError::internal(e.to_string()))?;
    let bytes =
        serde_json::to_vec(&canonical(value)).map_err(|e| AppError::internal(e.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(crate) fn replay<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    actor: &Actor,
    key: &str,
    operation: &str,
    hash: &str,
    now: i64,
) -> AppResult<Option<T>> {
    tx.execute("DELETE FROM idempotency_keys WHERE expires_at<=?1", [now])?;
    let row = tx
        .query_row(
            &format!(
                "SELECT operation,request_hash,state,response_json FROM idempotency_keys
         WHERE {}",
                key_predicate(actor)
            ),
            params![actor.user_id, key, actor.mcp_grant_id()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, IdempotencyState>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((stored_operation, stored_hash, state, response)) = row else {
        return Ok(None);
    };
    if operation != stored_operation || hash != stored_hash {
        return Err(AppError::rule(
            crate::error::RuleKind::IdempotencyKeyReused,
            "idempotency key was already used for a different request",
        ));
    }
    match (state, response) {
        (IdempotencyState::Succeeded, Some(response)) => serde_json::from_str(&response)
            .map(crate::legacy_values::payload)
            .and_then(serde_json::from_value)
            .map(Some)
            .map_err(|e| AppError::internal(format!("read retry receipt: {e}"))),
        (IdempotencyState::Failed, _) => Ok(None),
        (IdempotencyState::Running, _) => Err(AppError::Conflict(
            "this operation is already being processed".into(),
        )),
        _ => Err(AppError::internal("invalid retry ledger state")),
    }
}

/// Called in the same transaction after replay and current authorization.
pub(crate) fn start(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    key: &str,
    operation: &str,
    hash: &str,
    now: i64,
) -> AppResult<String> {
    let changed = tx.execute(
        &format!("UPDATE idempotency_keys SET state='running',response_json=NULL,
         updated_at=?4,expires_at=?5 WHERE {} AND state='failed' AND operation=?6 AND request_hash=?7", key_predicate(actor)),
        params![actor.user_id, key, actor.mcp_grant_id(), now, now+TTL_SECONDS, operation, hash],
    )?;
    if changed > 0 {
        return tx
            .query_row(
                &format!(
                    "SELECT id FROM idempotency_keys WHERE {}",
                    key_predicate(actor)
                ),
                params![actor.user_id, key, actor.mcp_grant_id()],
                |row| row.get(0),
            )
            .map_err(Into::into);
    }
    tx.execute("INSERT INTO idempotency_keys
        (id,actor_user_id,actor_mcp_grant_id,idempotency_key,operation,request_hash,state,created_at,updated_at,expires_at)
        VALUES (?1,?2,?3,?4,?5,?6,'running',?7,?7,?8)",
        params![id, actor.user_id, actor.mcp_grant_id(), key, operation, hash, now, now+TTL_SECONDS],
    ).map_err(|error| {
        if matches!(&error, rusqlite::Error::SqliteFailure(inner, _) if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE) {
            AppError::rule(crate::error::RuleKind::IdempotencyKeyReused, "idempotency key is already in use")
        } else { error.into() }
    })?;
    Ok(id.to_owned())
}

pub(crate) fn succeed(
    tx: &Transaction<'_>,
    id: &str,
    response: &str,
    resource: &Resource,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "UPDATE idempotency_keys SET state='succeeded',response_json=?1,
        resource_type=?2,resource_id=?3,project_id=?4,updated_at=?5 WHERE id=?6",
        params![
            response,
            resource.kind,
            resource.id,
            resource.project_id,
            now,
            id
        ],
    )?;
    Ok(())
}

// Literal NULL/equality predicates let SQLite use its partial unique indexes.
pub(crate) fn key_predicate(actor: &Actor) -> &'static str {
    if actor.mcp_grant_id().is_some() {
        "actor_user_id=?1 AND idempotency_key=?2 AND actor_mcp_grant_id=?3"
    } else {
        "actor_user_id=?1 AND idempotency_key=?2 AND actor_mcp_grant_id IS NULL AND ?3 IS NULL"
    }
}

#[cfg(test)]
mod tests;

enum IdempotencyState {
    Running,
    Succeeded,
    Failed,
}

impl rusqlite::types::FromSql for IdempotencyState {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        match value.as_str()? {
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}
