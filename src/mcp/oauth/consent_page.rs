//! The Connect page, where a person picks the projects and capabilities an
//! app gets, and its script and style.

use super::authorize::ConsentForm;
use super::*;
use crate::access::McpScope;

pub(super) struct ConsentPresentation<'a> {
    pub(super) client_id: &'a str,
    pub(super) redirect: &'a str,
    pub(super) retry: Option<(&'a ConsentForm, &'a str)>,
}

pub(super) fn consent_html(
    request_id: &str,
    client: &str,
    display_name: &str,
    username: &str,
    projects: &[(String, String)],
    scopes: &[McpScope],
    presentation: ConsentPresentation<'_>,
) -> String {
    let project_rows = projects
        .iter()
        .map(|(id, name)| {
            format!(
                "<label><input type=checkbox name=project value=\"{}\"{}> <span>{}</span></label>",
                escape_html(id),
                if presentation
                    .retry
                    .is_some_and(|(form, _)| form.project.contains(id))
                {
                    " checked"
                } else {
                    ""
                },
                escape_html(name)
            )
        })
        .collect::<String>();
    let scope_rows = scopes
        .iter()
        .filter(|scope| **scope != McpScope::ProjectRead)
        .map(|scope| {
            let selected = presentation.retry.map_or_else(
                || scope.off_by_default().is_none(),
                |(form, _)| form.scope.iter().any(|name| name == scope.as_str()),
            );
            let checked = if selected { " checked" } else { "" };
            format!(
                "<label><input type=checkbox name=scope value=\"{}\"{}> <span>{}</span></label>",
                scope.as_str(),
                checked,
                escape_html(scope.label())
            )
        })
        .collect::<String>();
    let callback = Url::parse(presentation.redirect).ok();
    let destination = callback
        .as_ref()
        .map(|url| match url.scheme() {
            "http" if is_loopback(url) => format!(
                "An app on this computer ({})",
                &url[url::Position::BeforeHost..url::Position::AfterPort]
            ),
            "http" | "https" => {
                format!("You will be sent to {}", url.origin().ascii_serialization())
            }
            // These have no origin to show; any app can claim a scheme.
            scheme => format!("An app on this computer that opens {scheme}: links ({url})"),
        })
        .unwrap_or_else(|| presentation.redirect.to_owned());
    let destination = escape_html(&destination);
    let returns_to_this_computer = callback.as_ref().is_some_and(|url| url.scheme() != "https");
    // The whole address: one host can serve documents for many authors.
    let client_source = match client_metadata::document_url(presentation.client_id) {
        Err(_) => "App name supplied by the client; identity is unverified.".to_owned(),
        Ok(url) if returns_to_this_computer => format!(
            "App name from {url}. The app runs on your computer, where another app could use the same name. Continue only if you started this connection."
        ),
        Ok(url) => format!("App name from {url}."),
    };
    let off: Vec<_> = McpScope::ALL
        .into_iter()
        .filter_map(McpScope::off_by_default)
        .collect();
    let (last, rest) = off.split_last().expect("scopes that start unticked");
    let off_by_default = format!("{} and {last} are off by default.", rest.join(", "));
    let error = presentation
        .retry
        .map(|(_, error)| format!("<p class=warning role=alert>{}</p>", escape_html(error)))
        .unwrap_or_default();
    format!(
        include_str!("consent/page.html"),
        destination = destination,
        client_source = escape_html(&client_source),
        error = error,
        project_rows = project_rows,
        scope_rows = scope_rows,
        off_by_default = off_by_default,
        client = escape_html(client),
        display_name = escape_html(display_name),
        username = escape_html(username),
        request_id = escape_html(request_id)
    )
}

pub(super) async fn consent_script() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        include_str!("consent/consent.js"),
    )
}

pub(super) async fn consent_style() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        include_str!("consent/consent.css"),
    )
}
