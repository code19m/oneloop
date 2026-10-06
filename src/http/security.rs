use std::net::{IpAddr, SocketAddr};

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, header},
    middleware::Next,
    response::Response,
};
use ipnet::IpNet;
use url::Url;

use crate::{AppError, AppResult, AppState};

pub const HTTPS_SESSION_COOKIE: &str = "__Host-oneloop_session";
pub const DEVELOPMENT_SESSION_COOKIE: &str = "oneloop_session";

/// Validate the authority supplied by HTTP, independently of forwarding headers.
/// In-process router callers have neither a socket peer nor necessarily a Host.
pub(crate) async fn enforce_host(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    use axum::{extract::ConnectInfo, response::IntoResponse};
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0);
    let hosts: Vec<_> = request.headers().get_all(header::HOST).iter().collect();
    let uri_authority = request.uri().authority().map(|value| value.as_str());
    let valid = hosts.len() <= 1
        && hosts.iter().all(|host| {
            host.to_str().is_ok_and(|host| {
                allowed_authority(host, &state.config.public_url, peer, request.uri().path())
            })
        })
        && uri_authority.is_none_or(|host| {
            allowed_authority(host, &state.config.public_url, peer, request.uri().path())
        })
        && (!hosts.is_empty() || uri_authority.is_some() || peer.is_none());
    if !valid {
        // Keep the wrong-address recovery page working without serving the
        // application or forwarding credentials at an untrusted authority.
        let canonical_url = format!(
            "{}/",
            state.config.public_url.origin().ascii_serialization()
        );
        let wants_page = request.method() == Method::GET
            && !request.uri().path().starts_with("/api/")
            && request
                .headers()
                .get(header::ACCEPT)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(',')
                        .any(|part| part.trim().starts_with("text/html"))
                });
        let mut response = if wants_page {
            let escaped = canonical_url
                .replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            axum::response::Html(format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Open oneloop</title><h1>Open oneloop at its configured address</h1><p><a href=\"{escaped}\">{escaped}</a></p></html>")).into_response()
        } else {
            AppError::InvalidOrigin { canonical_url }.into_response()
        };
        *response.status_mut() = axum::http::StatusCode::MISDIRECTED_REQUEST;
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response.headers_mut().insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        response
            .headers_mut()
            .insert("content-security-policy", content_security_policy(None));
        return response;
    }
    next.run(request).await
}

fn allowed_authority(raw: &str, public: &Url, peer: Option<SocketAddr>, path: &str) -> bool {
    let Ok(authority) = raw.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    if raw.contains('@')
        || raw
            .strip_prefix(authority.host())
            .is_some_and(|suffix| !suffix.is_empty() && authority.port_u16().is_none())
    {
        return false;
    }
    let canonical = public[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
    let expected = canonical
        .parse::<axum::http::uri::Authority>()
        .expect("configured URL authority");
    let default_port = match public.scheme() {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    };
    if authority.host().eq_ignore_ascii_case(expected.host())
        && authority.port_u16().or(default_port) == expected.port_u16().or(default_port)
    {
        return true;
    }
    // Local health probes only; a remote/proxied rebinding host gets no exception.
    path == "/healthz"
        && peer.is_some_and(|peer| peer.ip().to_canonical().is_loopback())
        && (authority.host().eq_ignore_ascii_case("localhost")
            || authority
                .host()
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()))
}

pub async fn enforce_browser_origin(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> AppResult<Response> {
    require_canonical_origin(
        request.method(),
        request.headers(),
        &state.config.public_url,
    )?;
    Ok(next.run(request).await)
}

pub async fn add_main_security_headers(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if is_api
        && (response.status().is_client_error() || response.status().is_server_error())
        && !is_json
    {
        // Axum extractor failures occur before handlers/AppError. Normalize them
        // without copying request-derived rejection text or credentials.
        let (code, message) = match response.status().as_u16() {
            400 | 422 => ("invalid_request", "The request is invalid"),
            401 => ("unauthorized", "Authentication is required"),
            403 => (
                "forbidden",
                "You do not have permission to perform this action",
            ),
            404 => ("not_found", "The requested resource was not found"),
            405 => ("method_not_allowed", "This HTTP method is not supported"),
            413 => ("request_too_large", "The request exceeds the size limit"),
            415 => (
                "unsupported_content_type",
                "The request content type is not supported",
            ),
            _ => ("request_failed", "The request could not be completed"),
        };
        let body = serde_json::json!({"error":{"code":code,"message":message}}).to_string();
        *response.body_mut() = Body::from(body);
        response.headers_mut().remove(header::CONTENT_LENGTH);
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
    }
    let headers = response.headers_mut();
    // TLS terminates at the proxy; only the configured public URL is authoritative.
    if state.config.public_url.scheme() == "https" {
        headers
            .entry(header::STRICT_TRANSPORT_SECURITY)
            .or_insert(HeaderValue::from_static("max-age=31536000"));
    }
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    headers
        .entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(HeaderValue::from_static("nosniff"));
    headers
        .entry(header::REFERRER_POLICY)
        .or_insert(HeaderValue::from_static("no-referrer"));
    headers
        .entry(header::X_FRAME_OPTIONS)
        .or_insert(HeaderValue::from_static("DENY"));
    headers
        .entry("permissions-policy")
        .or_insert(HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ));
    headers
        .entry("cross-origin-opener-policy")
        .or_insert(HeaderValue::from_static("same-origin"));
    headers
        .entry("content-security-policy")
        .or_insert_with(|| content_security_policy(None));
    response
}

/// Only validated OAuth callback origins may extend native form navigation.
/// A callback in an app's own scheme, which has no origin, adds that scheme.
///
/// Style elements and stylesheets come only from this origin; the views keep
/// inline style attributes. `style-src` repeats both for browsers without the
/// separate directives. Trusted Types limit HTML and script sinks to the app's
/// own policies and DOMPurify's.
pub fn content_security_policy(callback: Option<&Url>) -> HeaderValue {
    let extra = callback
        .map(|url| match url.scheme() {
            "http" | "https" => format!(" {}", url.origin().ascii_serialization()),
            scheme => format!(" {scheme}:"),
        })
        .unwrap_or_default();
    HeaderValue::from_str(&format!(
        "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; \
         form-action 'self'{extra}; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         style-src-elem 'self'; style-src-attr 'unsafe-inline'; \
         img-src 'self' https: data: blob:; font-src 'self'; connect-src 'self'; \
         frame-src 'self'; worker-src 'self' blob:; \
         require-trusted-types-for 'script'; trusted-types oneloop dompurify default"
    ))
    .expect("URL origins are valid header values")
}

/// The off-screen document where Mermaid lays out diagrams for the app.
/// Mermaid writes inline styles and HTML strings, so this document alone
/// allows inline styles and has no Trusted Types. Only the app may frame it.
pub fn diagram_renderer_policy() -> HeaderValue {
    HeaderValue::from_static(
        "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; \
         form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data:; font-src 'self'",
    )
}

pub fn require_canonical_origin(
    method: &Method,
    headers: &HeaderMap,
    public_url: &Url,
) -> AppResult<()> {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Ok(());
    }
    let rejected = || AppError::InvalidOrigin {
        canonical_url: format!("{}/", public_url.origin().ascii_serialization()),
    };
    let raw = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(rejected)?;
    if raw == "null" || raw.contains(' ') {
        return Err(rejected());
    }
    let origin = Url::parse(raw).map_err(|_| rejected())?;
    if origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
    {
        return Err(rejected());
    }
    if origin.origin() != public_url.origin() {
        return Err(rejected());
    }
    Ok(())
}

pub fn session_cookie_name(public_url: &Url) -> &'static str {
    if public_url.scheme() == "https" {
        HTTPS_SESSION_COOKIE
    } else {
        DEVELOPMENT_SESSION_COOKIE
    }
}

pub fn session_cookie(
    public_url: &Url,
    token: &str,
    max_age_seconds: i64,
) -> AppResult<HeaderValue> {
    if token
        .bytes()
        .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-' && byte != b'_')
    {
        return Err(AppError::Internal(
            "session token contains an unsafe cookie character".into(),
        ));
    }
    let secure = if public_url.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}{secure}",
        session_cookie_name(public_url),
    ))
    .map_err(|error| AppError::Internal(format!("session cookie could not be created: {error}")))
}

pub fn clear_session_cookie(public_url: &Url) -> HeaderValue {
    let secure = if public_url.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}",
        session_cookie_name(public_url),
    ))
    .expect("static cookie attributes must be valid")
}

pub fn session_token(headers: &HeaderMap, public_url: &Url) -> Option<String> {
    let name = session_cookie_name(public_url).as_bytes();
    let mut found = None;
    for value in headers.get_all(header::COOKIE).iter() {
        for part in value.as_bytes().split(|byte| *byte == b';') {
            let part = part.trim_ascii();
            let Some(equals) = part.iter().position(|byte| *byte == b'=') else {
                if part == name {
                    return None;
                }
                continue;
            };
            if &part[..equals] != name {
                continue;
            }
            let value = &part[equals + 1..];
            if found.is_some()
                || value.is_empty()
                || !value
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return None;
            }
            found = Some(String::from_utf8(value.to_vec()).ok()?);
        }
    }
    found
}

pub fn client_ip(
    peer: Option<SocketAddr>,
    headers: &HeaderMap,
    trusted: &[IpNet],
) -> Option<IpAddr> {
    let peer = peer?.ip().to_canonical();
    if !is_trusted(peer, trusted) {
        if headers.contains_key("x-forwarded-for") {
            warn_untrusted_forwarding();
        }
        return Some(peer);
    }
    // Proxies may append a separate field line (HAProxy) or comma-separated
    // hops (nginx). Do not parse attacker-controlled prefixes beyond the first
    // untrusted hop, or skip malformed hops on the trusted side.
    let fields: Vec<_> = headers.get_all("x-forwarded-for").iter().collect();
    let mut address = peer;
    for field in fields.into_iter().rev() {
        for item in field.as_bytes().rsplit(|byte| *byte == b',') {
            address = std::str::from_utf8(item.trim_ascii())
                .ok()?
                .parse::<IpAddr>()
                .ok()?
                .to_canonical();
            if !is_trusted(address, trusted) {
                return Some(address);
            }
        }
    }
    Some(address)
}

fn warn_untrusted_forwarding() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST_WARNING: AtomicU64 = AtomicU64::new(0);
    let now = crate::auth::unix_now().unwrap_or(0) as u64;
    let last = LAST_WARNING.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= 60
        && LAST_WARNING
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        tracing::warn!(
            "ignoring X-Forwarded-For from an untrusted peer; check ONELOOP_TRUSTED_PROXIES"
        );
    }
}

/// Address aggregation is for abuse counters only, never session metadata.
pub fn throttle_bucket(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!(
            "{}/64",
            std::net::Ipv6Addr::from(u128::from(ip) & (u128::MAX << 64))
        ),
    }
}

pub(crate) fn is_trusted(address: IpAddr, trusted: &[IpNet]) -> bool {
    trusted.iter().any(|network| {
        network.contains(&address)
            || match (address, network) {
                // Preserve explicitly configured mapped-IPv6 proxy ranges even
                // though socket peers are now canonical IPv4 addresses.
                (IpAddr::V4(ip), IpNet::V6(network))
                    if network.addr().to_ipv4_mapped().is_some() =>
                {
                    network.contains(&ip.to_ipv6_mapped())
                }
                _ => false,
            }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn unsafe_requests_require_the_canonical_origin() {
        let public = Url::parse("https://tasks.example.test").unwrap();
        let mut headers = HeaderMap::new();
        assert!(require_canonical_origin(&Method::POST, &headers, &public).is_err());
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(require_canonical_origin(&Method::POST, &headers, &public).is_err());
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://tasks.example.test"),
        );
        assert!(require_canonical_origin(&Method::POST, &headers, &public).is_ok());
        assert!(require_canonical_origin(&Method::GET, &HeaderMap::new(), &public).is_ok());
    }

    #[test]
    fn cookies_are_host_only_secure_and_http_only() {
        let public = Url::parse("https://tasks.example.test").unwrap();
        let cookie = session_cookie(&public, "safe_token-123", 60)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.starts_with("__Host-oneloop_session="));
        assert!(cookie.contains("; Secure"));
        assert!(cookie.contains("; HttpOnly"));
        assert!(!cookie.to_ascii_lowercase().contains("domain="));
    }

    #[test]
    fn forwarded_addresses_are_used_only_from_trusted_peers() {
        let trusted = vec!["10.0.0.0/8".parse().unwrap()];
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 10.1.1.1"),
        );
        assert_eq!(
            client_ip(Some("192.0.2.2:9000".parse().unwrap()), &headers, &trusted),
            Some("192.0.2.2".parse().unwrap())
        );
        assert_eq!(
            client_ip(Some("10.2.2.2:9000".parse().unwrap()), &headers, &trusted),
            Some("203.0.113.9".parse().unwrap())
        );
    }
    #[test]
    fn sibling_cookies_do_not_hide_sessions_and_invalid_duplicates_fail_closed() {
        let public = Url::parse("http://localhost").unwrap();
        for sibling in [b"lang=caf\xc3\xa9".as_slice(), b"lang=caf\xe9".as_slice()] {
            for separate in [false, true] {
                let mut headers = HeaderMap::new();
                if separate {
                    headers.append(header::COOKIE, HeaderValue::from_bytes(sibling).unwrap());
                    headers.append(
                        header::COOKIE,
                        HeaderValue::from_static("oneloop_session=abc_123-DEF"),
                    );
                } else {
                    let mut value = sibling.to_vec();
                    value.extend_from_slice(b"; oneloop_session=abc_123-DEF");
                    headers.append(header::COOKIE, HeaderValue::from_bytes(&value).unwrap());
                }
                assert_eq!(
                    session_token(&headers, &public).as_deref(),
                    Some("abc_123-DEF")
                );
                headers.append(header::COOKIE, HeaderValue::from_static("oneloop_session="));
                assert_eq!(session_token(&headers, &public), None);
            }
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_bytes(b"oneloop_session=caf\xe9").unwrap(),
        );
        assert_eq!(session_token(&headers, &public), None);
    }

    #[test]
    fn proxy_chains_walk_all_lines_from_the_trusted_end() {
        let trusted = [
            "127.0.0.1/32".parse().unwrap(),
            "10.0.0.0/8".parse().unwrap(),
        ];
        let peer = Some("[::ffff:127.0.0.1]:9000".parse().unwrap());
        let mut headers = HeaderMap::new();
        assert_eq!(
            client_ip(peer, &headers, &trusted),
            Some("127.0.0.1".parse().unwrap())
        );
        headers.append(
            "x-forwarded-for",
            HeaderValue::from_static("spoofed, 203.0.113.7"),
        );
        headers.append(
            "x-forwarded-for",
            HeaderValue::from_static("::ffff:198.51.100.1, ::ffff:10.0.0.2"),
        );
        assert_eq!(
            client_ip(peer, &headers, &trusted),
            Some("198.51.100.1".parse().unwrap())
        );
        assert_eq!(
            client_ip(
                peer,
                &headers,
                &[
                    "::ffff:127.0.0.1/128".parse().unwrap(),
                    "10.0.0.0/8".parse().unwrap()
                ]
            ),
            Some("198.51.100.1".parse().unwrap())
        );
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("garbage, 198.51.100.44"),
        );
        assert_eq!(
            client_ip(peer, &headers, &trusted),
            Some("198.51.100.44".parse().unwrap())
        );
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("198.51.100.44, garbage"),
        );
        assert_eq!(client_ip(peer, &headers, &trusted), None);
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("10.0.0.3, 10.0.0.2"),
        );
        assert_eq!(
            client_ip(peer, &headers, &trusted),
            Some("10.0.0.3".parse().unwrap())
        );
    }

    #[test]
    fn throttle_buckets_group_only_ipv6_subnets() {
        let bucket = |ip: &str| throttle_bucket(ip.parse().unwrap());
        assert_eq!(bucket("::ffff:198.51.100.7"), bucket("198.51.100.7"));
        assert_ne!(bucket("198.51.100.7"), bucket("198.51.100.8"));
        assert_eq!(bucket("2001:db8:1:2::1"), bucket("2001:db8:1:2::ffff"));
        assert_ne!(bucket("2001:db8:1:2::1"), bucket("2001:db8:1:3::1"));
    }
}

#[cfg(test)]
mod authority_tests {
    use super::*;
    #[test]
    fn authorities_validate_ports_ipv6_and_userinfo() {
        for (public, allowed, rejected) in [
            (
                "https://tasks.example",
                "TASKS.EXAMPLE:443",
                "tasks.example:bad",
            ),
            ("http://127.0.0.1:19100", "127.0.0.1:19100", "127.0.0.1"),
            ("http://[::1]:19100", "[::1]:19100", "[::1]:19101"),
        ] {
            let public = Url::parse(public).unwrap();
            assert!(allowed_authority(allowed, &public, None, "/"));
            assert!(!allowed_authority(rejected, &public, None, "/"));
            assert!(!allowed_authority(
                &format!("evil@{allowed}"),
                &public,
                None,
                "/"
            ));
        }
    }
}
