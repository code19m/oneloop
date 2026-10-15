//! Commands: the one request shape of every write family, the rules each
//! operation declares, and how a command runs once through the retry ledger.
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppError, AppResult,
    auth::Actor,
    collaboration::ActivityEvent,
    idempotency::{Envelope, Resource},
};

/// Declares the operations of one command family: an enum whose variants
/// carry their wire names and their [`RevisionRule`], so each is written once.
/// It adds `ALL` and `parse`, and implements [`Operation`].
macro_rules! operations {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $($variant:ident = $wire:literal => $rule:ident,)+
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        $vis enum $name {
            $($variant,)+
        }

        impl $name {
            /// Every operation, in declaration order.
            $vis const ALL: &'static [Self] = &[$(Self::$variant),+];

            $vis fn parse(name: &str) -> Option<Self> {
                use $crate::command::Operation as _;
                Self::ALL.iter().copied().find(|operation| operation.as_str() == name)
            }
        }

        impl $crate::command::Operation for $name {
            fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            fn revision_rule(self) -> $crate::command::RevisionRule {
                match self {
                    $(Self::$variant => $crate::command::RevisionRule::$rule,)+
                }
            }
        }
    };
}
pub(crate) use operations;

/// An operation of a command family, declared with `operations!`.
pub trait Operation: Copy {
    /// The name clients send.
    fn as_str(self) -> &'static str;
    fn revision_rule(self) -> RevisionRule;
}

/// What a command says about `expectedRevision`.
#[derive(Clone, Copy)]
pub enum RevisionRule {
    /// It creates a record, so a revision is refused.
    Create,
    /// It changes a record, so a revision is required. A missing one fails the
    /// precondition (412).
    Existing,
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

/// Refuses an edit based on revision `expected` of a record that is now at
/// `current`.
pub(crate) fn check_revision(expected: i64, current: i64) -> AppResult<()> {
    if expected != current {
        return Err(AppError::revision(expected, current));
    }
    Ok(())
}

/// A request to change data, from the browser or MCP. The actor always comes
/// from authentication, never from the request.
#[derive(Clone, Debug)]
pub struct Command<O> {
    pub operation: O,
    pub payload: Value,
    /// Makes a retry of the same request safe.
    pub idempotency_key: String,
    /// The revision an edit was based on.
    pub expected_revision: Option<i64>,
}

impl<O: Operation> Command<O> {
    /// Checks the key and the revision and hashes the request, before the
    /// command waits for the database.
    pub(crate) fn envelope(&self) -> AppResult<Envelope> {
        let operation = self.operation.as_str();
        let envelope = Envelope::request(
            operation,
            &self.idempotency_key,
            &json!({
                "operation": operation,
                "payload": self.payload,
                "expectedRevision": self.expected_revision,
            }),
        )?;
        self.operation
            .revision_rule()
            .check(self.expected_revision)?;
        Ok(envelope)
    }

    /// The revision an edit was based on. The revision rule has required one
    /// for every operation that reads it.
    pub(crate) fn revision(&self) -> i64 {
        self.expected_revision.unwrap_or_default()
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

impl Envelope {
    /// Runs a command once in `tx`, like `once`, and records its result.
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
}
