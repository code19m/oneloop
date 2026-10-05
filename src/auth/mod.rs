//! Accounts, browser sessions and app grants share current-actor checks. Password content is preserved; grants never elevate current permissions.

mod accounts;
mod grants;
mod session;
mod throttle;

pub use crate::clock::unix_now;
pub(crate) use grants::{revoke_lost_project_app_access, revoke_project_app_access};
pub use token::hash as token_hash;
pub mod password;
pub(crate) mod token;

use std::sync::{Arc, OnceLock};

use rusqlite::{OptionalExtension, Transaction};
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::{
    db::Db,
    error::{AppError, AppResult},
};

use password::{hash_password, verify_password};

const ACCOUNT_PAGE_SIZE: usize = 50;

pub const SESSION_IDLE_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const SESSION_ABSOLUTE_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const RECENT_AUTH_SECONDS: i64 = 30 * 60;
pub const MAX_BROWSER_SESSIONS: i64 = 10;
const LOGIN_FAILURE_WINDOW_SECONDS: i64 = 15 * 60;
const LOGIN_FAILURES_BEFORE_DELAY: i64 = 5;
const IP_FAILURES_BEFORE_DELAY: i64 = 20;
const ACCOUNT_FAILURES_BEFORE_DELAY: i64 = 15;
const ACCOUNT_DELAY_CAP_SECONDS: i64 = 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub must_change_password: bool,
    pub revision: i64,
}

pub struct NewUser {
    pub username: String,
    pub display_name: String,
    pub password: String,
    pub is_admin: bool,
    pub must_change_password: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActorSource {
    BrowserSession { session_id: String },
    McpGrant { grant_id: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub must_change_password: bool,
    pub authenticated_at: i64,
    pub source: ActorSource,
}

impl Actor {
    pub fn require_ready(&self) -> AppResult<()> {
        if self.must_change_password {
            return Err(AppError::PreconditionFailed(
                "password change required before using oneloop".into(),
            ));
        }
        Ok(())
    }

    pub fn require_admin(&self) -> AppResult<()> {
        self.require_ready()?;
        if !self.is_admin || matches!(self.source, ActorSource::McpGrant { .. }) {
            return Err(AppError::Forbidden);
        }
        Ok(())
    }

    pub fn require_recent_auth(&self, now: i64) -> AppResult<()> {
        if !matches!(self.source, ActorSource::BrowserSession { .. })
            || self.authenticated_at <= now.saturating_sub(RECENT_AUTH_SECONDS)
        {
            return Err(AppError::rule(
                crate::error::RuleKind::RecentAuthRequired,
                "recent authentication required",
            ));
        }
        Ok(())
    }

    pub fn session_id(&self) -> Option<&str> {
        match &self.source {
            ActorSource::BrowserSession { session_id } => Some(session_id),
            ActorSource::McpGrant { .. } => None,
        }
    }

    pub fn mcp_grant_id(&self) -> Option<&str> {
        match &self.source {
            ActorSource::McpGrant { grant_id } => Some(grant_id),
            ActorSource::BrowserSession { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectPermission {
    Board,
    Roadmap,
}

/// Revalidate an operation's actor against current credentials and account state.
/// The boundary's Actor is identity context, never a cached authority grant.
pub(crate) fn refresh_actor_connection(
    connection: &rusqlite::Connection,
    actor: &Actor,
) -> AppResult<Actor> {
    let current = connection.prepare_cached("SELECT username,display_name,is_admin,must_change_password FROM users WHERE id=?1 AND is_active=1")?.query_row(
        [&actor.user_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,bool>(2)?,row.get::<_,bool>(3)?)),
    ).optional()?.ok_or(AppError::Unauthorized)?;
    let now = unix_now()?;
    let mut fresh = actor.clone();
    fresh.username = current.0;
    fresh.display_name = current.1;
    fresh.is_admin = current.2;
    fresh.must_change_password = current.3;
    match &actor.source {
        ActorSource::BrowserSession { session_id } => {
            fresh.authenticated_at = connection.prepare_cached("SELECT authenticated_at FROM sessions WHERE id=?1 AND user_id=?2 AND revoked_at IS NULL \
                     AND idle_expires_at>?3 AND absolute_expires_at>?3")?.query_row(
                rusqlite::params![session_id,actor.user_id,now], |row| row.get(0),
            ).optional()?.ok_or(AppError::Unauthorized)?;
        }
        ActorSource::McpGrant { grant_id } => {
            let valid: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM mcp_grants WHERE id=?1 AND user_id=?2 AND revoked_at IS NULL \
                     AND expires_at>?3 AND COALESCE(last_used_at,created_at)>?4)")?.query_row(
                rusqlite::params![grant_id,actor.user_id,now,now-crate::mcp::REFRESH_IDLE_SECONDS], |row| row.get(0),
            )?;
            if !valid {
                return Err(AppError::Unauthorized);
            }
        }
    }
    fresh.require_ready()?;
    Ok(fresh)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpScope {
    ProjectRead,
    BoardManage,
    RoadmapManage,
    Discussion,
    InboxPrivate,
    MyPoolPrivate,
    Attachments,
    Destructive,
}

impl McpScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProjectRead => "project_read",
            Self::BoardManage => "board_manage",
            Self::RoadmapManage => "roadmap_manage",
            Self::Discussion => "discussion",
            Self::InboxPrivate => "inbox_private",
            Self::MyPoolPrivate => "my_pool_private",
            Self::Attachments => "attachments",
            Self::Destructive => "destructive",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SessionMetadata {
    pub client_name: Option<String>,
    pub client_ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub absolute_expires_at: i64,
    pub client_name: Option<String>,
    pub client_ip: Option<String>,
    pub user_agent: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub must_change_password: bool,
    pub revision: i64,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedAppSummary {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub expires_at: i64,
    pub projects: Vec<String>,
    pub scopes: Vec<String>,
}

pub struct AccountUpdate {
    pub display_name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub expected_revision: i64,
}

pub struct CreatedAccount {
    pub user: AccountSummary,
    pub temporary_password: String,
}

pub struct IssuedSession {
    pub token: String,
    pub absolute_expires_at: i64,
    pub actor: Actor,
}

pub enum LoginResult {
    Authenticated(IssuedSession),
    SessionLimit { sessions: Vec<SessionSummary> },
}

#[derive(Clone)]
pub struct AuthService {
    db: Db,
}

impl AuthService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}

pub fn create_user(tx: &Transaction<'_>, input: NewUser, now: i64) -> AppResult<User> {
    create_user_with_actor(tx, input, now, None)
}

pub fn create_user_with_actor(
    tx: &Transaction<'_>,
    input: NewUser,
    now: i64,
    actor_user_id: Option<&str>,
) -> AppResult<User> {
    let username = normalize_username(&input.username)?;
    let display_name = normalize_display_name(&input.display_name)?;
    let password_hash = hash_password(&input.password)?;
    insert_user(
        tx,
        PreparedUser {
            username,
            display_name,
            password_hash,
            is_admin: input.is_admin,
            must_change_password: input.must_change_password,
        },
        now,
        actor_user_id,
    )
}

struct PreparedUser {
    username: String,
    display_name: String,
    password_hash: String,
    is_admin: bool,
    must_change_password: bool,
}

fn insert_user(
    tx: &Transaction<'_>,
    prepared: PreparedUser,
    now: i64,
    actor_user_id: Option<&str>,
) -> AppResult<User> {
    let user = User {
        id: Uuid::now_v7().to_string(),
        username: prepared.username,
        display_name: prepared.display_name,
        is_admin: prepared.is_admin,
        is_active: true,
        must_change_password: prepared.must_change_password,
        revision: 1,
    };
    tx.execute(
        "INSERT INTO users (id,username,display_name,password_hash,is_admin,is_active,must_change_password,
         password_changed_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,1,?6,?7,?7,?7)",
        rusqlite::params![user.id,user.username,user.display_name,prepared.password_hash,user.is_admin,
            user.must_change_password,now],
    ).map_err(|error| map_user_write_error(error, "username is already in use"))?;
    security_event(
        tx,
        &user.id,
        actor_user_id,
        "account.created",
        serde_json::json!({"isAdmin":user.is_admin}),
        now,
    )?;
    Ok(user)
}

pub fn reset_password(
    tx: &Transaction<'_>,
    username: &str,
    password: &str,
    now: i64,
) -> AppResult<()> {
    reset_password_with_actor(tx, username, password, now, None)
}

pub fn reset_password_with_actor(
    tx: &Transaction<'_>,
    username: &str,
    password: &str,
    now: i64,
    actor_user_id: Option<&str>,
) -> AppResult<()> {
    let username = normalize_username(username)?;
    let password_hash = hash_password(password)?;
    let user_id: String = tx
        .query_row(
            "SELECT id FROM users WHERE username=?1",
            [&username],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(AppError::NotFound { resource: "user" })?;
    reset_password_hash_with_actor(tx, &user_id, password_hash, now, actor_user_id)
}

fn reset_password_hash_with_actor(
    tx: &Transaction<'_>,
    user_id: &str,
    password_hash: String,
    now: i64,
    actor_user_id: Option<&str>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE users SET password_hash=?1,must_change_password=1,password_changed_at=?2,
         updated_at=?2,revision=revision+1 WHERE id=?3",
        rusqlite::params![password_hash, now, user_id],
    )?;
    revoke_user_access(tx, user_id, now)?;
    security_event(
        tx,
        user_id,
        actor_user_id,
        "password.reset",
        serde_json::json!({}),
        now,
    )?;
    Ok(())
}

/// Revoke all browser and connected-app credentials for an account.
/// Deactivation and host recovery call this in the same transaction as the account change.
pub fn revoke_user_access(tx: &Transaction<'_>, user_id: &str, now: i64) -> AppResult<()> {
    tx.execute(
        "UPDATE sessions SET revoked_at=?1 WHERE user_id=?2 AND revoked_at IS NULL",
        rusqlite::params![now, user_id],
    )?;
    revoke_all_app_access(tx, user_id, now)
}

fn revoke_all_app_access(tx: &Transaction<'_>, user_id: &str, now: i64) -> AppResult<()> {
    tx.execute(
        "UPDATE mcp_grants SET revoked_at=?1,updated_at=?1,revision=revision+1
                WHERE user_id=?2 AND revoked_at IS NULL",
        rusqlite::params![now, user_id],
    )?;
    tx.execute(
        "UPDATE mcp_tokens SET revoked_at=?1 WHERE revoked_at IS NULL AND grant_id IN
                (SELECT id FROM mcp_grants WHERE user_id=?2)",
        rusqlite::params![now, user_id],
    )?;
    // Unfinished authorizations must not restore access after revocation.
    tx.execute(
        "DELETE FROM oauth_authorization_requests WHERE user_id=?1 AND consumed_at IS NULL",
        [user_id],
    )?;
    tx.execute(
        "DELETE FROM oauth_authorization_codes WHERE user_id=?1 AND used_at IS NULL",
        [user_id],
    )?;
    Ok(())
}

pub fn normalize_username(value: &str) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    let valid = (3..=32).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    if !valid {
        return Err(AppError::validation(
            "username",
            "must be 3–32 lowercase letters, digits, dots, underscores or hyphens and start with a letter or digit",
        ));
    }
    Ok(value)
}

fn normalize_display_name(value: &str) -> AppResult<String> {
    crate::text::validate(value, "displayName", crate::text::Lines::Single, true)?;
    let value = value.trim();
    if value.is_empty() || value.encode_utf16().count() > 80 {
        return Err(AppError::validation(
            "displayName",
            "must contain 1–80 characters",
        ));
    }
    Ok(value.to_owned())
}

fn random_token() -> crate::AppResult<String> {
    crate::auth::token::random_token(32)
}

pub fn security_event(
    tx: &Transaction<'_>,
    subject_user_id: &str,
    actor_user_id: Option<&str>,
    event_type: &str,
    metadata: serde_json::Value,
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO security_events(id,subject_user_id,actor_user_id,event_type,metadata_json,created_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![Uuid::now_v7().to_string(),subject_user_id,actor_user_id,event_type,
            serde_json::to_string(&metadata).map_err(|error|AppError::Internal(format!("security event serialization failed: {error}")))?,now],
    )?;
    if matches!(
        event_type,
        "session.signed_out"
            | "session.revoked"
            | "sessions.revoked_others"
            | "password.changed"
            | "password.reset"
            | "account.access_changed"
            | "connected_app.revoked"
    ) {
        crate::collaboration::enqueue_access_change_tx(tx, subject_user_id, now)?;
    }
    Ok(())
}

fn login_address_bucket(client_ip: Option<&str>) -> Option<String> {
    client_ip
        .and_then(|ip| ip.parse().ok())
        .map(crate::http::security::throttle_bucket)
}

fn login_throttle_key(username: &str, client_ip: Option<&str>) -> String {
    token_hash(&format!(
        "account\0{}\0{}",
        username,
        login_address_bucket(client_ip)
            .as_deref()
            .unwrap_or("unknown")
    ))
}

fn login_ip_throttle_key(client_ip: Option<&str>) -> Option<String> {
    login_address_bucket(client_ip).map(|bucket| token_hash(&format!("ip\0{bucket}")))
}

// Shared across AuthService instances/routes. Waiting requests do not enqueue
// Argon2 jobs in Tokio's blocking pool. Four workers may overshoot a newly set
// account delay by at most three in-flight attempts; this is not an exact cap.
async fn password_work_permit() -> AppResult<Arc<OwnedSemaphorePermit>> {
    static PERMITS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        PERMITS
            .get_or_init(|| Arc::new(Semaphore::new(4)))
            .clone()
            .acquire_owned(),
    )
    .await
    .map_err(|_| AppError::Unavailable("password workers are busy; try again shortly".into()))?
    .map(Arc::new)
    .map_err(|_| AppError::internal("password worker admission closed"))
}

async fn password_work<T: Send + 'static>(
    permit: &Arc<OwnedSemaphorePermit>,
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let permit = permit.clone();
    tokio::task::spawn_blocking(move || {
        // Cancellation cannot release admission while non-cancellable hash work runs.
        let _permit = permit;
        work()
    })
    .await
    .map_err(|error| AppError::Internal(format!("password worker stopped: {error}")))?
}

fn dummy_password_hash() -> String {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY
        .get_or_init(|| {
            hash_password("not a real account password").expect("dummy password must hash")
        })
        .clone()
}

fn map_user_write_error(error: rusqlite::Error, message: &str) -> AppError {
    if matches!(&error, rusqlite::Error::SqliteFailure(inner, _) if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        AppError::rule(crate::error::RuleKind::UsernameTaken, message)
    } else {
        AppError::from(error)
    }
}

fn map_admin_constraint(error: rusqlite::Error) -> AppError {
    if matches!(&error, rusqlite::Error::SqliteFailure(inner, message)
        if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
            && message.as_deref().is_some_and(|value| value.contains("last active administrator")))
    {
        AppError::rule(
            crate::error::RuleKind::LastAdmin,
            "the last active administrator cannot be deactivated or demoted",
        )
    } else {
        AppError::from(error)
    }
}

fn account_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccountSummary> {
    let id: String = row.get(0)?;
    let avatar_blob: Option<String> = row.get(7)?;
    Ok(AccountSummary {
        avatar_url: avatar_blob.map(|blob| format!("/api/users/{id}/avatar?v={blob}")),
        id,
        username: row.get(1)?,
        display_name: row.get(2)?,
        is_admin: row.get(3)?,
        is_active: row.get(4)?,
        must_change_password: row.get(5)?,
        revision: row.get(6)?,
    })
}

fn account_from_user(user: User) -> AccountSummary {
    AccountSummary {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        is_admin: user.is_admin,
        is_active: user.is_active,
        must_change_password: user.must_change_password,
        revision: user.revision,
        avatar_url: None,
    }
}

fn actor_from_user(user: User, session_id: String, authenticated_at: i64) -> Actor {
    Actor {
        user_id: user.id,
        username: user.username,
        display_name: user.display_name,
        is_admin: user.is_admin,
        must_change_password: user.must_change_password,
        authenticated_at,
        source: ActorSource::BrowserSession { session_id },
    }
}

fn list_sessions_tx(
    tx: &Transaction<'_>,
    user_id: &str,
    current: Option<&str>,
    now: i64,
) -> AppResult<Vec<SessionSummary>> {
    list_sessions_query(tx, user_id, current, now)
}

fn list_sessions_connection(
    connection: &rusqlite::Connection,
    user_id: &str,
    current: Option<&str>,
    now: i64,
) -> AppResult<Vec<SessionSummary>> {
    list_sessions_query(connection, user_id, current, now)
}

fn list_sessions_query(
    connection: &rusqlite::Connection,
    user_id: &str,
    current: Option<&str>,
    now: i64,
) -> AppResult<Vec<SessionSummary>> {
    let mut statement = connection.prepare(
        "SELECT id,created_at,last_activity_at,absolute_expires_at,client_name,client_ip,user_agent
         FROM sessions WHERE user_id=?1 AND revoked_at IS NULL AND idle_expires_at>?2 AND absolute_expires_at>?2
         ORDER BY last_activity_at DESC,id DESC")?;
    let rows = statement.query_map(rusqlite::params![user_id, now], |row| {
        let id: String = row.get(0)?;
        Ok(SessionSummary {
            current: current == Some(id.as_str()),
            id,
            created_at: row.get(1)?,
            last_activity_at: row.get(2)?,
            absolute_expires_at: row.get(3)?,
            client_name: row.get(4)?,
            client_ip: row.get(5)?,
            user_agent: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn values_for_grant(
    connection: &rusqlite::Connection,
    table: &str,
    column: &str,
    grant_id: &str,
) -> AppResult<Vec<String>> {
    // Table/column are private constants chosen by the caller, never request input.
    let mut statement = connection.prepare(&format!(
        "SELECT {column} FROM {table} WHERE grant_id=?1 ORDER BY {column}"
    ))?;
    let rows = statement.query_map([grant_id], |row| row.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

struct LoginUser {
    user: User,
    password_hash: String,
}
enum LoginTransaction {
    Issued,
    Limit(Vec<SessionSummary>),
}
struct SessionAuthentication {
    session_id: String,
    user_id: String,
    authenticated_at: i64,
    last_activity_at: i64,
    absolute_expires_at: i64,
    idle_expires_at: i64,
    revoked_at: Option<i64>,
    username: String,
    display_name: String,
    is_admin: bool,
    is_active: bool,
    must_change_password: bool,
}

struct McpAuthentication {
    grant_id: String,
    user_id: String,
    username: String,
    display_name: String,
    is_admin: bool,
    must_change_password: bool,
    token_last_used: Option<i64>,
    grant_last_used: Option<i64>,
}

/// Shared capability gate for owner-private Pool content, including activity.
/// Callers still enforce current actor and project access separately.
pub(crate) fn can_read_private_pool(
    connection: &rusqlite::Connection,
    actor: &Actor,
) -> AppResult<bool> {
    match &actor.source {
        ActorSource::BrowserSession { .. } => Ok(true),
        ActorSource::McpGrant { grant_id } => Ok(connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM mcp_grant_scopes WHERE grant_id=?1 AND scope='my_pool_private')",
            [grant_id], |row| row.get(0))?),
    }
}

fn project_access_bool(result: AppResult<()>) -> AppResult<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden | AppError::NotFound { .. } | AppError::Unauthorized) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod password_work_tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_request_keeps_its_permit_until_hash_work_stops() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::new(semaphore.clone().acquire_owned().await.unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let request = tokio::spawn(async move {
            password_work(&permit, move || {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            })
            .await
        });
        started_rx.await.unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(semaphore.clone().try_acquire_owned().is_err());
        finish_tx.send(()).unwrap();
        // Completion, rather than request cancellation, makes room for new work.
        let _available = semaphore.acquire_owned().await.unwrap();
    }
}
