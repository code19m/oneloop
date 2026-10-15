//! The authorization endpoint: checks a request, asks the signed-in person on
//! the Connect page, and sends the app an authorization code.

use axum::{
    extract::{Query, RawForm},
    http::{HeaderMap, Method},
    response::Redirect,
};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;

use super::consent_page::{ConsentPresentation, consent_html};
use super::*;
use crate::{
    auth::{Actor, token::random_token},
    http::{auth::authenticate_headers, security::require_canonical_origin},
    mcp::client_metadata::ClientDocument,
};

const AUTHORIZATION_REQUEST_SECONDS: i64 = 10 * 60;

/// Authorization requests one person may have waiting for consent; a new one
/// replaces the oldest.
const MAX_PENDING_REQUESTS_PER_PERSON: i64 = 10;

/// The `state` an app may ask oneloop to keep and return, in bytes.
const MAX_STATE_BYTES: usize = 4096;

const AUTHORIZATION_CODE_SECONDS: i64 = 5 * 60;

/// Clients described by metadata documents that no app has used yet, at
/// most, besides those with a sign-in under way. Each new authorization
/// makes its client the newest.
const MAX_UNUSED_DESCRIBED_CLIENTS: i64 = 1_000;

#[derive(Deserialize)]
struct AuthorizationQuery {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    #[serde(default)]
    state: Option<String>,
    resource: String,
    #[serde(default)]
    scope: String,
}

/// Shows the Connect page for a valid request. A refused request gets a page
/// that names only the protocol error, such as "invalid request".
pub(super) async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let result = match query {
        Ok(Query(pairs)) => match resource_parameters(&state, pairs) {
            Ok(query) => authorize_inner(&state, &headers, query).await,
            Err(error) => Err(error.into()),
        },
        Err(_) => Err(OAuthError::invalid("invalid_request")),
    };
    result.unwrap_or_else(OAuthError::page)
}

async fn authorize_inner(
    state: &AppState,
    headers: &HeaderMap,
    query: AuthorizationQuery,
) -> Result<Response, OAuthError> {
    validate_authorization_query(state, &query).await?;
    let scopes = parse_requested_scopes(&query.scope)?;
    let actor = match authenticate_headers(state, headers, true).await {
        Ok(actor) if !actor.must_change_password => actor,
        Ok(_) | Err(AppError::Unauthorized) => return Ok(authorization_login_redirect(&query)),
        Err(error) => return Err(error.into()),
    };
    // Only someone signed in can make oneloop fetch a metadata document.
    let document = described_client(state, &actor, &query).await?;
    let projects = accessible_projects(state, &actor).await?;
    let request_id = random_token(24)?;
    let stored_id = hash_token(&request_id);
    let user_id = actor.user_id.clone();
    let client_id = query.client_id.clone();
    let redirect_uri = query.redirect_uri.clone();
    let state_value = query.state.clone();
    let resource = query.resource.clone();
    let requested_scopes = serde_json::to_string(&scopes)
        .map_err(|error| AppError::internal(format!("serialize scopes: {error}")))?;
    let challenge = query.code_challenge.clone();
    let now = unix_now()?;
    state
        .db
        .transaction(move |tx| {
            tx.execute(
                "DELETE FROM oauth_authorization_requests
                 WHERE expires_at<=?1 OR consumed_at IS NOT NULL",
                [now],
            )?;
            if let Some(document) = &document {
                remember_described_client(tx, document, now)?;
            }
            tx.execute(
                "INSERT INTO oauth_authorization_requests
                 (id,user_id,client_id,redirect_uri,state,resource,requested_scopes_json,
                  code_challenge,created_at,expires_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    stored_id,
                    user_id,
                    client_id,
                    redirect_uri,
                    state_value,
                    resource,
                    requested_scopes,
                    challenge,
                    now,
                    now + AUTHORIZATION_REQUEST_SECONDS
                ],
            )?;
            // Expired and used requests are gone now. A new row's rowid is above
            // every row there is, so rowids give the order of requests even when
            // the clock steps back.
            tx.execute(
                "DELETE FROM oauth_authorization_requests WHERE user_id=?1 AND rowid NOT IN
                 (SELECT rowid FROM oauth_authorization_requests
                  WHERE user_id=?1 ORDER BY rowid DESC LIMIT ?2)",
                params![user_id, MAX_PENDING_REQUESTS_PER_PERSON],
            )?;
            Ok(())
        })
        .await?;
    let client_name = client_name(state, &query.client_id).await?;
    let page = Html(consent_html(
        &request_id,
        &client_name,
        &actor.display_name,
        &actor.username,
        &projects,
        &scopes,
        ConsentPresentation {
            client_id: &query.client_id,
            redirect: &query.redirect_uri,
            retry: None,
        },
    ));
    Ok(consent_response(page.into_response(), &query.redirect_uri)?)
}

/// The metadata document of a client whose ID is the document's URL, with
/// the requested callback checked against the callbacks it lists.
async fn described_client(
    state: &AppState,
    actor: &Actor,
    query: &AuthorizationQuery,
) -> AppResult<Option<ClientDocument>> {
    if !client_metadata::is_document_client_id(&query.client_id) {
        return Ok(None);
    }
    let schemes = &state.config.mcp_redirect_schemes;
    let document = state
        .client_documents
        .document(&actor.user_id, &query.client_id, |value| {
            validate_redirect_uri(value, schemes)
        })
        .await
        .inspect_err(|error| {
            // The page says only "invalid request", so that it can't be used
            // to probe the server's network; the log tells the admin why.
            if let AppError::Validation { message, .. } = error {
                tracing::info!(
                    user_id = %actor.user_id,
                    client_id = %query.client_id,
                    %message,
                    "client metadata document refused"
                );
            }
        })?;
    let redirect = validate_redirect_uri(&query.redirect_uri, schemes)?;
    if !document
        .redirect_uris
        .iter()
        .any(|listed| redirect_matches(listed, &redirect))
    {
        return Err(AppError::validation(
            "redirect_uri",
            "is not listed in the client metadata document",
        ));
    }
    Ok(Some(document))
}

/// Stores a described client like a registered one, so that consent, codes
/// and tokens work the same. An unused row is removed after a day, as for
/// registrations; each new authorization request starts that day again.
/// Beyond `MAX_UNUSED_DESCRIBED_CLIENTS` unused rows, the oldest go. A client
/// with an unexpired authorization request or code stays: deleting it would
/// also delete those, and end a sign-in under way.
fn remember_described_client(
    tx: &rusqlite::Transaction<'_>,
    document: &ClientDocument,
    now: i64,
) -> AppResult<()> {
    let redirects = serde_json::to_string(&document.redirect_uris)
        .map_err(|error| AppError::internal(format!("serialize redirect URIs: {error}")))?;
    tx.execute(
        "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,client_uri,created_at)
         VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(client_id) DO UPDATE SET client_name=excluded.client_name,
           redirect_uris_json=excluded.redirect_uris_json,client_uri=excluded.client_uri,
           created_at=CASE WHEN last_used_at IS NULL THEN excluded.created_at
                           ELSE oauth_clients.created_at END",
        params![
            document.client_id,
            document.client_name,
            redirects,
            document.client_uri,
            now
        ],
    )?;
    tx.execute(
        "DELETE FROM oauth_clients WHERE client_id IN (
         SELECT client_id FROM oauth_clients
         WHERE client_id LIKE 'https://%' AND last_used_at IS NULL AND client_id<>?1
           AND client_id NOT IN (
             SELECT client_id FROM oauth_authorization_requests
             WHERE consumed_at IS NULL AND expires_at>?3
             UNION SELECT client_id FROM oauth_authorization_codes
             WHERE used_at IS NULL AND expires_at>?3)
         ORDER BY created_at DESC,client_id DESC LIMIT -1 OFFSET ?2)",
        params![document.client_id, MAX_UNUSED_DESCRIBED_CLIENTS - 1, now],
    )?;
    Ok(())
}

fn consent_response(mut response: Response, redirect: &str) -> AppResult<Response> {
    let callback =
        Url::parse(redirect).map_err(|_| AppError::internal("invalid stored callback"))?;
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("same-origin"),
    );
    // CSP host-sources cannot express IPv6 literals. Those callbacks use a
    // local continuation response after the canonical-origin form POST.
    let callback = (!matches!(callback.host(), Some(url::Host::Ipv6(_)))).then_some(&callback);
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        crate::http::security::content_security_policy(callback),
    );
    Ok(response)
}

fn authorization_login_redirect(query: &AuthorizationQuery) -> Response {
    let target = authorization_return_target(query);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("oauth_return", &target)
        .finish();
    Redirect::to(&format!("/?{query}")).into_response()
}

fn authorization_return_target(query: &AuthorizationQuery) -> String {
    let mut parameters = url::form_urlencoded::Serializer::new(String::new());
    parameters
        .append_pair("response_type", &query.response_type)
        .append_pair("client_id", &query.client_id)
        .append_pair("redirect_uri", &query.redirect_uri)
        .append_pair("code_challenge", &query.code_challenge)
        .append_pair("code_challenge_method", &query.code_challenge_method)
        .append_pair("resource", &query.resource)
        .append_pair("scope", &query.scope);
    if let Some(state) = &query.state {
        parameters.append_pair("state", state);
    }
    format!("/oauth/authorize?{}", parameters.finish())
}

pub(super) struct ConsentForm {
    request_id: String,
    decision: String,
    pub(super) project: Vec<String>,
    pub(super) scope: Vec<String>,
}

#[derive(Clone, Debug)]
struct StoredAuthorizationRequest {
    user_id: String,
    client_id: String,
    client_name: String,
    redirect_uri: String,
    state: Option<String>,
    resource: String,
    requested_scopes: Vec<String>,
    challenge: String,
}

pub(super) async fn consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawForm(raw): RawForm,
) -> AppResult<Response> {
    let form = parse_consent_form(&raw)?;
    require_canonical_origin(&Method::POST, &headers, &state.config.public_url)?;
    let actor = authenticate_headers(&state, &headers, true).await?;
    actor.require_ready()?;
    let request_hash = hash_token(&form.request_id);
    let user_id = actor.user_id.clone();
    let now = unix_now()?;
    let stored = state
        .db
        .run(move |tx| {
            let row = tx
                .query_row(
                    "SELECT r.user_id,r.client_id,c.client_name,r.redirect_uri,r.state,r.resource,
                            r.requested_scopes_json,r.code_challenge
                     FROM oauth_authorization_requests r
                     JOIN oauth_clients c ON c.client_id=r.client_id
                     WHERE r.id=?1 AND r.user_id=?2 AND r.consumed_at IS NULL AND r.expires_at>?3",
                    params![request_hash, user_id, now],
                    |row| {
                        Ok(StoredAuthorizationRequest {
                            user_id: row.get(0)?,
                            client_id: row.get(1)?,
                            client_name: row.get(2)?,
                            redirect_uri: row.get(3)?,
                            state: row.get(4)?,
                            resource: row.get(5)?,
                            requested_scopes: serde_json::from_str::<Vec<String>>(
                                &row.get::<_, String>(6)?,
                            )
                            .map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    6,
                                    rusqlite::types::Type::Text,
                                    Box::new(e),
                                )
                            })?,
                            challenge: row.get(7)?,
                        })
                    },
                )
                .optional()?
                .ok_or(AppError::PreconditionFailed(
                    "authorization request expired or was already used".into(),
                ))?;
            Ok(row)
        })
        .await?;

    let request_hash = hash_token(&form.request_id);
    let user_id = actor.user_id.clone();
    if form.decision == "deny" {
        state
            .db
            .transaction(move |tx| consume_request(tx, &request_hash, &user_id, unix_now()?))
            .await?;
        return oauth_redirect(
            &issuer(&state),
            &stored.redirect_uri,
            [("error", "access_denied")],
            stored.state.as_deref(),
        );
    }
    let result = approve_consent(&state, &actor, &form, &stored).await;
    match result {
        Ok(code) => oauth_redirect(
            &issuer(&state),
            &stored.redirect_uri,
            [("code", code.as_str())],
            stored.state.as_deref(),
        ),
        Err(error @ AppError::Validation { .. }) => {
            let projects = accessible_projects(&state, &actor).await?;
            consent_response(
                (
                    StatusCode::BAD_REQUEST,
                    Html(consent_html(
                        &form.request_id,
                        &stored.client_name,
                        &actor.display_name,
                        &actor.username,
                        &projects,
                        &stored.requested_scopes,
                        ConsentPresentation {
                            client_id: &stored.client_id,
                            redirect: &stored.redirect_uri,
                            retry: Some((&form, &error.client_message())),
                        },
                    )),
                )
                    .into_response(),
                &stored.redirect_uri,
            )
        }
        Err(error) => Err(error),
    }
}

fn consume_request(
    tx: &rusqlite::Transaction<'_>,
    hash: &str,
    user: &str,
    now: i64,
) -> AppResult<()> {
    if tx.execute(
        "UPDATE oauth_authorization_requests SET consumed_at=?1 WHERE id=?2 AND user_id=?3 AND \
                     consumed_at IS NULL AND expires_at>?1",
        params![now, hash, user],
    )? != 1
    {
        return Err(AppError::PreconditionFailed(
            "authorization request expired or was already used".into(),
        ));
    }
    Ok(())
}

async fn approve_consent(
    state: &AppState,
    actor: &Actor,
    form: &ConsentForm,
    stored: &StoredAuthorizationRequest,
) -> AppResult<String> {
    if form.project.is_empty() {
        return Err(AppError::validation(
            "project",
            "select at least one project",
        ));
    }
    let requested = stored
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut selected_scopes = form.scope.iter().cloned().collect::<BTreeSet<_>>();
    selected_scopes.insert("project_read".to_owned());
    if selected_scopes
        .iter()
        .any(|scope| !requested.contains(scope.as_str()) || !SCOPES.contains(&scope.as_str()))
    {
        return Err(AppError::validation(
            "scope",
            "contains an unrequested capability",
        ));
    }
    if selected_scopes.contains("destructive")
        && !selected_scopes
            .iter()
            .any(|v| v == "board_manage" || v == "roadmap_manage" || v == "attachments")
    {
        return Err(AppError::validation(
            "scope",
            "destructive access requires a management capability",
        ));
    }
    let projects = form
        .project
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let scopes = selected_scopes.into_iter().collect::<Vec<_>>();
    let code = random_token(32)?;
    let code_hash = hash_token(&code);
    let projects_json =
        serde_json::to_string(&projects).map_err(|e| AppError::internal(e.to_string()))?;
    let scopes_json =
        serde_json::to_string(&scopes).map_err(|e| AppError::internal(e.to_string()))?;
    let issued_at = unix_now()?;
    let stored = stored.clone();
    let request_hash = hash_token(&form.request_id);
    let actor = actor.clone();
    state
        .db
        .transaction(move |connection| {
            // The session may have been revoked since this request was authenticated.
            let actor = crate::auth::refresh_actor_connection(connection, &actor)?;
            validate_selected_projects(connection, &actor, &projects)?;
            consume_request(connection, &request_hash, &actor.user_id, unix_now()?)?;
            connection.execute(
                "INSERT INTO oauth_authorization_codes
                 (code_hash,user_id,client_id,client_name,redirect_uri,resource,projects_json,
                  scopes_json,code_challenge,issued_at,expires_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    code_hash,
                    stored.user_id,
                    stored.client_id,
                    stored.client_name,
                    stored.redirect_uri,
                    stored.resource,
                    projects_json,
                    scopes_json,
                    stored.challenge,
                    issued_at,
                    issued_at + AUTHORIZATION_CODE_SECONDS
                ],
            )?;
            Ok(())
        })
        .await?;
    Ok(code)
}

fn parse_consent_form(raw: &[u8]) -> AppResult<ConsentForm> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| AppError::validation("form", "must be valid UTF-8"))?;
    let mut request_id = None;
    let mut decision = None;
    let mut project = Vec::new();
    let mut scope = Vec::new();
    for (key, value) in url::form_urlencoded::parse(text.as_bytes()) {
        match key.as_ref() {
            "request_id" => request_id = Some(value.into_owned()),
            "decision" => decision = Some(value.into_owned()),
            "project" => project.push(value.into_owned()),
            "scope" => scope.push(value.into_owned()),
            _ => {}
        }
    }
    Ok(ConsentForm {
        request_id: request_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::validation("request_id", "is required"))?,
        decision: decision
            .filter(|value| value == "allow" || value == "deny")
            .ok_or_else(|| AppError::validation("decision", "must be allow or deny"))?,
        project,
        scope,
    })
}

async fn validate_authorization_query(
    state: &AppState,
    query: &AuthorizationQuery,
) -> Result<(), OAuthError> {
    let invalid_request = Err(OAuthError::invalid("invalid_request"));
    if query.response_type != "code"
        || query.code_challenge_method != "S256"
        || !is_challenge(&query.code_challenge)
        || query
            .state
            .as_ref()
            .is_some_and(|value| value.len() > MAX_STATE_BYTES)
    {
        return invalid_request;
    }
    if query.resource != resource_url(state) {
        return Err(OAuthError::invalid("invalid_target"));
    }
    let redirect = validate_redirect_uri(&query.redirect_uri, &state.config.mcp_redirect_schemes)?;
    if client_metadata::is_document_client_id(&query.client_id) {
        if !state.client_documents.enabled() {
            return invalid_request;
        }
        // The callback is checked against the document after sign-in.
        client_metadata::document_url(&query.client_id)?;
        return Ok(());
    }
    let client = query.client_id.clone();
    let valid = state
        .db
        .run(move |connection| {
            let json: Option<String> = connection
                .query_row(
                    "SELECT redirect_uris_json FROM oauth_clients WHERE client_id=?1",
                    [client],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(json) = json else { return Ok(false) };
            let values: Vec<String> =
                serde_json::from_str(&json).map_err(|e| AppError::internal(e.to_string()))?;
            Ok(values
                .iter()
                .any(|value| redirect_matches(value, &redirect)))
        })
        .await?;
    if !valid {
        return invalid_request;
    }
    Ok(())
}

fn parse_requested_scopes(raw: &str) -> Result<Vec<String>, OAuthError> {
    let mut set = raw
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    if set.is_empty() {
        set.insert("project_read".into());
    }
    if set.iter().any(|v| !SCOPES.contains(&v.as_str())) {
        return Err(OAuthError::invalid("invalid_scope"));
    }
    set.insert("project_read".into());
    Ok(set.into_iter().collect())
}

async fn accessible_projects(state: &AppState, actor: &Actor) -> AppResult<Vec<(String, String)>> {
    let actor = actor.clone();
    state
        .db
        .run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT p.id,p.name FROM projects p WHERE p.deleted_at IS NULL
                   AND (?1=1 OR EXISTS(SELECT 1 FROM project_memberships m
                                       WHERE m.project_id=p.id AND m.user_id=?2))
                 ORDER BY p.name,p.id",
            )?;
            Ok(statement
                .query_map(params![actor.is_admin, actor.user_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?)
        })
        .await
}

fn validate_selected_projects(
    connection: &rusqlite::Connection,
    actor: &Actor,
    projects: &[String],
) -> AppResult<()> {
    for id in projects {
        let allowed: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects p JOIN users u ON u.id=?2
             WHERE p.id=?1 AND p.deleted_at IS NULL AND u.is_active=1
               AND (u.is_admin=1 OR EXISTS(SELECT 1 FROM project_memberships m
                                          WHERE m.project_id=p.id AND m.user_id=u.id)))",
            params![id, actor.user_id],
            |row| row.get(0),
        )?;
        if !allowed {
            return Err(AppError::validation(
                "project",
                "contains an inaccessible project",
            ));
        }
    }
    Ok(())
}

async fn client_name(state: &AppState, id: &str) -> AppResult<String> {
    let id = id.to_owned();
    state
        .db
        .run(move |c| {
            c.query_row(
                "SELECT client_name FROM oauth_clients WHERE client_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(AppError::NotFound {
                resource: "OAuth client",
            })
        })
        .await
}

/// Whether `v` looks like a base64url SHA-256 challenge.
fn is_challenge(v: &str) -> bool {
    v.len() == 43
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn oauth_redirect<const N: usize>(
    issuer: &str,
    base: &str,
    pairs: [(&str, &str); N],
    state: Option<&str>,
) -> AppResult<Response> {
    let mut url =
        Url::parse(base).map_err(|_| AppError::internal("stored redirect URI is invalid"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("iss", issuer);
        for (k, v) in pairs {
            q.append_pair(k, v);
        }
        if let Some(state) = state {
            q.append_pair("state", state);
        }
    }
    if matches!(url.host(), Some(url::Host::Ipv6(_))) {
        let target = escape_html(url.as_str());
        return Ok(Html(format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url={target}\"><title>Continue to app</title></head><body><a href=\"{target}\">Continue to app</a></body></html>"
        )).into_response());
    }
    Ok(Redirect::to(url.as_str()).into_response())
}

#[cfg(test)]
mod tests;
