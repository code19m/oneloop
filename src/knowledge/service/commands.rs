//! Administrators' Knowledge commands: connecting, changing and
//! disconnecting a source, asking for a sync, and creating a deploy key.

use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{Inner, KnowledgeService, load_source, source_activity, source_view};
use crate::{
    AppError, AppResult,
    access::{Need, require_project},
    auth::Actor,
    clock::unix_now,
    collaboration::{ActivityEvent, ActivityInput, record_activity_tx},
    command::{Command, CommandResult, Mutation},
    knowledge::{
        secrets::{Purpose, generate_deploy_key},
        source::{self, GitUrl, Transport},
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connect {
    project_id: String,
    url: String,
    branch: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    project_id: String,
    url: String,
    branch: String,
    #[serde(default)]
    folder: String,
    token_action: TokenAction,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TokenAction {
    Keep,
    Replace,
    Remove,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectOnly {
    project_id: String,
}

impl KnowledgeService {
    pub async fn execute(
        &self,
        actor: &Actor,
        command: Command<KnowledgeOperation>,
    ) -> AppResult<CommandResult> {
        actor.require_ready()?;
        let operation = command.operation;
        let envelope = command.envelope()?;
        let actor = actor.clone();
        let inner = self.inner.clone();
        let (result, applied) = self
            .inner
            .db
            .transaction(move |tx| {
                let now = unix_now()?;
                // The project of a command that ran now, not of a retry.
                let mut applied = None;
                // Every knowledge command is an administrator's, including replays.
                let result = envelope.run(
                    tx,
                    &actor,
                    now,
                    |actor, _| actor.require_admin(),
                    |actor| {
                        actor.require_admin()?;
                        let mutation = dispatch(tx, &inner, actor, &command, now)?;
                        applied = mutation.resource_id.clone();
                        Ok(mutation)
                    },
                )?;
                Ok((result, applied))
            })
            .await?;
        if let Some(project_id) = applied {
            // A sync that is still running works for the old source.
            if operation.replaces_source() {
                self.inner.stop_sync(&project_id);
            }
            // An administrator's change or retry syncs at once.
            self.inner.stop_waiting(&project_id);
            self.inner.wake.notify_one();
        }
        Ok(result)
    }
}

crate::command::operations! {
    /// Knowledge commands. Changes to a connected source name the revision
    /// they were based on.
    pub enum KnowledgeOperation {
        Connect = "knowledge.connect" => Create,
        Update = "knowledge.update" => Existing,
        Disconnect = "knowledge.disconnect" => Existing,
        Sync = "knowledge.sync" => None,
        CreateDeployKey = "knowledge.deploy-key.create" => None,
    }
}

impl KnowledgeOperation {
    /// The source changes or goes, so a running sync works for the old one.
    fn replaces_source(self) -> bool {
        matches!(self, Self::Update | Self::Disconnect)
    }
}

fn dispatch(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    command: &Command<KnowledgeOperation>,
    now: i64,
) -> AppResult<Mutation> {
    match command.operation {
        KnowledgeOperation::Connect => connect(tx, inner, actor, payload(command)?, now),
        KnowledgeOperation::Update => {
            update(tx, inner, actor, payload(command)?, command.revision(), now)
        }
        KnowledgeOperation::Disconnect => {
            disconnect(tx, inner, actor, payload(command)?, command.revision(), now)
        }
        KnowledgeOperation::Sync => request_sync(tx, actor, payload(command)?, now),
        KnowledgeOperation::CreateDeployKey => {
            create_deploy_key(tx, inner, actor, payload(command)?, now)
        }
    }
}

fn payload<T: DeserializeOwned>(command: &Command<KnowledgeOperation>) -> AppResult<T> {
    crate::input::parse_payload(&command.payload)
}

struct Location {
    url: GitUrl,
    branch: String,
    folder: String,
}

fn location(inner: &Inner, url: &str, branch: &str, folder: &str) -> AppResult<Location> {
    Ok(Location {
        url: GitUrl::parse(url, inner.allow_file)?,
        branch: source::branch(branch)?,
        folder: source::folder(folder)?,
    })
}

fn connect(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: Connect,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    if load_source(tx, &input.project_id)?.is_some() {
        return Err(AppError::Conflict(
            "a repository is already connected to this project".into(),
        ));
    }
    let place = location(inner, &input.url, &input.branch, &input.folder)?;
    let token = input
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(source::token)
        .transpose()?;
    if token.is_some() && place.url.transport() != Transport::Https {
        return Err(AppError::validation(
            "token",
            "is used only with HTTPS URLs",
        ));
    }
    let token_ciphertext = token
        .map(|token| {
            inner
                .secrets()?
                .seal(Purpose::Token, &input.project_id, token.as_bytes())
        })
        .transpose()?;
    let mut events = Vec::new();
    if place.url.transport() == Transport::Ssh {
        events.extend(ensure_deploy_key(tx, inner, actor, &input.project_id, now)?);
    }
    // The audit history outlives a disconnected source. Continue from its
    // highest revision, so a command for an earlier source never matches.
    let revision: i64 = tx.query_row(
        "SELECT COALESCE(MAX(entity_revision),0)+1 FROM activity_events
         WHERE entity_type='knowledge_source' AND entity_id=?1",
        [&input.project_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO knowledge_sources
         (project_id,url,branch,folder,token_ciphertext,state,requested_at,created_by,created_at,updated_by,updated_at,generation,revision)
         VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?6,?7,?6,?8,?9)",
        params![
            input.project_id,
            place.url.as_str(),
            place.branch,
            place.folder,
            token_ciphertext,
            now,
            actor.user_id,
            uuid::Uuid::now_v7().to_string(),
            revision
        ],
    )?;
    events.push(record_activity_tx(
        tx,
        actor,
        ActivityInput {
            after: Some(described(&place.url, &place.branch, &place.folder)),
            entity_revision: Some(revision),
            ..source_activity(&input.project_id, "knowledge.connected")
        },
        now,
    )?);
    let entity = source_entity(tx, &input.project_id)?;
    Ok(source_mutation(entity, events, &input.project_id))
}

fn update(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: Update,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    let before = load_source(tx, &input.project_id)?.ok_or(AppError::NotFound {
        resource: "knowledge source",
    })?;
    if before.revision != expected {
        return Err(AppError::revision(expected, before.revision));
    }
    let place = location(inner, &input.url, &input.branch, &input.folder)?;
    let https = place.url.transport() == Transport::Https;
    let previous_url = GitUrl::parse(&before.url, true)?;
    // A saved token only ever goes to the host it was entered for.
    if input.token_action == TokenAction::Keep
        && before.token_ciphertext.is_some()
        && https
        && place.url.origin() != previous_url.origin()
    {
        return Err(AppError::validation(
            "token",
            "belongs to the previous host; replace or remove it",
        ));
    }
    let token = match input.token_action {
        TokenAction::Replace => {
            let value = input.token.as_deref().unwrap_or_default();
            if value.trim().is_empty() {
                return Err(AppError::validation("token", "enter the new token"));
            }
            if !https {
                return Err(AppError::validation(
                    "token",
                    "is used only with HTTPS URLs",
                ));
            }
            Some(inner.secrets()?.seal(
                Purpose::Token,
                &input.project_id,
                source::token(value)?.as_bytes(),
            )?)
        }
        TokenAction::Keep if https => before.token_ciphertext.clone(),
        TokenAction::Keep | TokenAction::Remove => None,
    };
    let moved = place.url.as_str() != before.url
        || place.branch != before.branch
        || place.folder != before.folder;
    let credentials_changed = input.token_action == TokenAction::Replace
        || token.is_some() != before.token_ciphertext.is_some();
    if !moved && !credentials_changed {
        return Err(AppError::validation(
            "payload",
            "no knowledge base fields changed",
        ));
    }
    let mut events = Vec::new();
    if place.url.transport() == Transport::Ssh {
        events.extend(ensure_deploy_key(tx, inner, actor, &input.project_id, now)?);
    }
    tx.execute(
        "UPDATE knowledge_sources SET url=?2,branch=?3,folder=?4,token_ciphertext=?5,requested_at=?6,
         updated_by=?7,updated_at=?6,revision=revision+1,generation=?8 WHERE project_id=?1",
        params![
            input.project_id,
            place.url.as_str(),
            place.branch,
            place.folder,
            token,
            now,
            actor.user_id,
            uuid::Uuid::now_v7().to_string()
        ],
    )?;
    inner.forget(&input.project_id);
    if moved {
        // Files from the old location never show under the new one.
        tx.execute(
            "UPDATE knowledge_sources SET state='pending',commit_id=NULL,checked_at=NULL,
             attempted_at=NULL,error_code=NULL,skipped_files=0 WHERE project_id=?1",
            [&input.project_id],
        )?;
        tx.execute(
            "DELETE FROM knowledge_files WHERE project_id=?1",
            [&input.project_id],
        )?;
    }
    events.push(record_activity_tx(
        tx,
        actor,
        ActivityInput {
            before: Some(described(&previous_url, &before.branch, &before.folder)),
            after: Some(described(&place.url, &place.branch, &place.folder)),
            metadata: json!({"credentialsChanged": credentials_changed}),
            entity_revision: Some(before.revision + 1),
            ..source_activity(&input.project_id, "knowledge.updated")
        },
        now,
    )?);
    let entity = source_entity(tx, &input.project_id)?;
    Ok(source_mutation(entity, events, &input.project_id))
}

fn disconnect(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: ProjectOnly,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    let before = load_source(tx, &input.project_id)?.ok_or(AppError::NotFound {
        resource: "knowledge source",
    })?;
    if before.revision != expected {
        return Err(AppError::revision(expected, before.revision));
    }
    let url = GitUrl::parse(&before.url, true)?;
    for table in [
        "knowledge_files",
        "knowledge_deploy_keys",
        "knowledge_sources",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE project_id=?1"),
            [&input.project_id],
        )?;
    }
    inner.forget(&input.project_id);
    let event = record_activity_tx(
        tx,
        actor,
        ActivityInput {
            before: Some(described(&url, &before.branch, &before.folder)),
            entity_revision: Some(before.revision + 1),
            ..source_activity(&input.project_id, "knowledge.disconnected")
        },
        now,
    )?;
    let entity = json!({
        "entityType": "knowledgeSource",
        "id": input.project_id,
        "projectId": input.project_id,
        "deleted": true,
        "revision": before.revision + 1,
    });
    Ok(source_mutation(entity, vec![event], &input.project_id))
}

fn request_sync(
    tx: &Transaction<'_>,
    actor: &Actor,
    input: ProjectOnly,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    if load_source(tx, &input.project_id)?.is_none() {
        return Err(AppError::NotFound {
            resource: "knowledge source",
        });
    }
    tx.execute(
        "UPDATE knowledge_sources SET requested_at=?2 WHERE project_id=?1",
        params![input.project_id, now],
    )?;
    let entity = source_entity(tx, &input.project_id)?;
    Ok(source_mutation(entity, Vec::new(), &input.project_id))
}

fn create_deploy_key(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    input: ProjectOnly,
    now: i64,
) -> AppResult<Mutation> {
    require_project(tx, actor, &input.project_id, Need::Read, false)?;
    let events = ensure_deploy_key(tx, inner, actor, &input.project_id, now)?
        .into_iter()
        .collect();
    let public_key: String = tx.query_row(
        "SELECT public_key FROM knowledge_deploy_keys WHERE project_id=?1",
        [&input.project_id],
        |row| row.get(0),
    )?;
    let entity = json!({
        "entityType": "knowledgeDeployKey",
        "id": input.project_id,
        "projectId": input.project_id,
        "publicKey": public_key,
    });
    Ok(source_mutation(entity, events, &input.project_id))
}

/// Create the project's deploy key unless it has one.
fn ensure_deploy_key(
    tx: &Transaction<'_>,
    inner: &Inner,
    actor: &Actor,
    project_id: &str,
    now: i64,
) -> AppResult<Option<ActivityEvent>> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM knowledge_deploy_keys WHERE project_id=?1)",
        [project_id],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(None);
    }
    let key = generate_deploy_key("oneloop")?;
    let sealed = inner
        .secrets()?
        .seal(Purpose::DeployKey, project_id, key.private.as_bytes())?;
    tx.execute(
        "INSERT INTO knowledge_deploy_keys (project_id,public_key,private_key_ciphertext,created_at)
         VALUES (?1,?2,?3,?4)",
        params![project_id, key.public, sealed, now],
    )?;
    Ok(Some(record_activity_tx(
        tx,
        actor,
        source_activity(project_id, "knowledge.deploy_key.created"),
        now,
    )?))
}

/// A change to a project's Knowledge source, whose receipt names the project.
fn source_mutation(entity: Value, events: Vec<ActivityEvent>, project_id: &str) -> Mutation {
    Mutation::new(entity, events, "knowledge_source", project_id)
}

/// The source as a command returns it.
fn source_entity(connection: &Connection, project_id: &str) -> AppResult<Value> {
    let row = load_source(connection, project_id)?
        .ok_or_else(|| AppError::internal("the knowledge source is missing"))?;
    serde_json::to_value(source_view(connection, project_id, &row)?)
        .map_err(|error| AppError::internal(error.to_string()))
}

/// The repository as activity records it: never a credential.
fn described(url: &GitUrl, branch: &str, folder: &str) -> Value {
    json!({"repository": url.display_name(), "branch": branch, "folder": folder})
}
