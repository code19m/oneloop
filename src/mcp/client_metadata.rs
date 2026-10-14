//! OAuth Client ID Metadata Documents: an MCP client may use an HTTPS URL as
//! its client ID, and the document at that URL names the client and lists
//! its callbacks. Anyone can name any URL, so oneloop fetches with care:
//!
//! - only `https` URLs with a path, on the default port, at a domain name;
//! - every address the name resolves to must be public, and oneloop connects
//!   to one of those exact addresses, so a second lookup can't redirect it;
//! - no redirects, at most 5 KiB and 5 seconds for the whole exchange;
//! - a bounded cache, at most four fetches at a time and 30 a minute.
//!
//! Only signed-in people reach a fetch, through the authorization page.

use std::{
    collections::{BTreeSet, HashMap},
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::{Arc, LazyLock, Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::http::{HeaderMap, StatusCode, header};
use http_body_util::BodyExt;
use ipnet::{Ipv4Net, Ipv6Net};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::Semaphore,
};
use url::Url;

use crate::{AppError, AppResult};

/// The largest document oneloop reads, as the specification recommends.
pub(crate) const MAX_DOCUMENT_BYTES: usize = 5 * 1024;
/// Resolving, connecting, TLS and the whole response together.
const FETCH_TIME: Duration = Duration::from_secs(5);
/// One connection attempt, so that another address can still be tried.
const CONNECT_TIME: Duration = Duration::from_secs(2);
const MAX_CLIENT_ID_BYTES: usize = 512;
const CACHE_ENTRIES: usize = 256;
const SHORTEST_CACHE: Duration = Duration::from_secs(60);
const DEFAULT_CACHE: Duration = Duration::from_secs(10 * 60);
const LONGEST_CACHE: Duration = Duration::from_secs(60 * 60);
const PARALLEL_FETCHES: usize = 4;
const FETCHES_PER_MINUTE: u32 = 30;
/// One person's share of `FETCHES_PER_MINUTE`, so that one person can't
/// keep everyone else from connecting.
pub(super) const FETCHES_PER_PERSON_MINUTE: u32 = 10;

/// A client described by its metadata document, checked and normalized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClientDocument {
    pub(crate) client_id: String,
    pub(crate) client_name: String,
    pub(crate) redirect_uris: Vec<String>,
    pub(crate) client_uri: Option<String>,
}

/// Fetched documents, shared by the server's requests.
pub(crate) struct ClientDocuments {
    enabled: bool,
    cache: Mutex<HashMap<String, (ClientDocument, Instant)>>,
    parallel: Semaphore,
    window: Mutex<FetchWindow>,
}

/// The fetches of the current minute, in all and for each person.
struct FetchWindow {
    started: Instant,
    total: u32,
    people: HashMap<String, u32>,
}

impl FetchWindow {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            total: 0,
            people: HashMap::new(),
        }
    }
}

impl ClientDocuments {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            cache: Mutex::new(HashMap::new()),
            parallel: Semaphore::new(PARALLEL_FETCHES),
            window: Mutex::new(FetchWindow::new()),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// The document of `client_id`, from the cache or fetched now for
    /// `person`, a user ID. `redirect_uri` checks each callback it lists.
    pub(crate) async fn document(
        &self,
        person: &str,
        client_id: &str,
        redirect_uri: impl Fn(&str) -> AppResult<String>,
    ) -> AppResult<ClientDocument> {
        if !self.enabled {
            return Err(unknown_client());
        }
        let url = document_url(client_id)?;
        if let Some(document) = self.cached(client_id) {
            return Ok(document);
        }
        let _permit = self.parallel.try_acquire().map_err(|_| busy())?;
        self.spend_fetch(person)?;
        let (bytes, lifetime) = tokio::time::timeout(FETCH_TIME, fetch(&url))
            .await
            .map_err(|_| refused("did not answer within 5 seconds"))??;
        let document = parse_document(client_id, &bytes, redirect_uri)?;
        self.remember(document.clone(), lifetime);
        Ok(document)
    }

    fn cached(&self, client_id: &str) -> Option<ClientDocument> {
        let cache = self.cache.lock().ok()?;
        cache
            .get(client_id)
            .filter(|(_, expires)| *expires > Instant::now())
            .map(|(document, _)| document.clone())
    }

    fn remember(&self, document: ClientDocument, lifetime: Duration) {
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        let now = Instant::now();
        if cache.len() >= CACHE_ENTRIES {
            cache.retain(|_, (_, expires)| *expires > now);
        }
        if cache.len() >= CACHE_ENTRIES
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (_, expires))| *expires)
                .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
        cache.insert(document.client_id.clone(), (document, now + lifetime));
    }

    fn spend_fetch(&self, person: &str) -> AppResult<()> {
        let mut window = self.window.lock().map_err(|_| busy())?;
        let elapsed = window.started.elapsed();
        if elapsed >= Duration::from_secs(60) {
            *window = FetchWindow::new();
        }
        if window.people.get(person).copied().unwrap_or(0) >= FETCHES_PER_PERSON_MINUTE {
            return Err(AppError::RateLimited {
                retry_after: 60_u64.saturating_sub(elapsed.as_secs()).max(1),
            });
        }
        if window.total >= FETCHES_PER_MINUTE {
            return Err(busy());
        }
        window.total += 1;
        *window.people.entry(person.to_owned()).or_default() += 1;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn insert_for_test(&self, document: ClientDocument) {
        self.remember(document, LONGEST_CACHE);
    }
}

/// Whether a client ID names a metadata document rather than a registration.
pub(crate) fn is_document_client_id(client_id: &str) -> bool {
    client_id.starts_with("https://")
}

/// Checks the form of a document client ID: `https`, a domain name, the
/// default port, a path, and nothing that a canonical URL would change.
pub(crate) fn document_url(client_id: &str) -> AppResult<Url> {
    let invalid = |reason: &str| AppError::validation("client_id", reason.to_owned());
    if client_id.len() > MAX_CLIENT_ID_BYTES {
        return Err(invalid("must be at most 512 bytes"));
    }
    let url = Url::parse(client_id).map_err(|_| invalid("must be an absolute URL"))?;
    if url.scheme() != "https" {
        return Err(invalid("must use https"));
    }
    if !matches!(url.host(), Some(url::Host::Domain(_))) {
        return Err(invalid("must name a host, not an address"));
    }
    if url.port().is_some() {
        return Err(invalid("must use the default port"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("must not contain a query or fragment"));
    }
    if url.path() == "/" {
        return Err(invalid("must contain a path"));
    }
    // Dot segments, letter case and escapes all change in the canonical form.
    if url.as_str() != client_id {
        return Err(invalid("must be written in canonical form"));
    }
    Ok(url)
}

/// Whether oneloop may connect to an address for a document: a global
/// unicast address, never a private, shared, loopback, link-local,
/// documentation, multicast or other special-purpose one.
pub(crate) fn public_address(address: IpAddr) -> bool {
    static V4: LazyLock<Vec<Ipv4Net>> = LazyLock::new(|| {
        [
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.88.99.0/24",
            "192.168.0.0/16",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "224.0.0.0/4",
            "240.0.0.0/4",
        ]
        .into_iter()
        .map(|net| Ipv4Net::from_str(net).expect("valid network"))
        .collect()
    });
    // Global unicast is 2000::/3. Inside it, the IETF protocol space (which
    // holds Teredo), documentation and 6to4, which embeds IPv4 addresses.
    static V6: LazyLock<(Ipv6Net, Vec<Ipv6Net>)> = LazyLock::new(|| {
        (
            Ipv6Net::from_str("2000::/3").expect("valid network"),
            ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"]
                .into_iter()
                .map(|net| Ipv6Net::from_str(net).expect("valid network"))
                .collect(),
        )
    });
    match address {
        IpAddr::V4(address) => !V4.iter().any(|net| net.contains(&address)),
        IpAddr::V6(address) => {
            V6.0.contains(&address) && !V6.1.iter().any(|net| net.contains(&address))
        }
    }
}

fn trust_roots() -> AppResult<Arc<rustls::RootCertStore>> {
    static ROOTS: OnceLock<Result<Arc<rustls::RootCertStore>, String>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let found = rustls_native_certs::load_native_certs();
            let mut roots = rustls::RootCertStore::empty();
            let (added, _) = roots.add_parsable_certificates(found.certs);
            if added == 0 {
                Err(format!(
                    "{} is true, but this computer has no trusted certificate authorities to check documents with",
                    crate::config::MCP_CLIENT_METADATA_ENV
                ))
            } else {
                Ok(Arc::new(roots))
            }
        })
        .clone()
        .map_err(AppError::Config)
}

/// Loads the system's certificate authorities, so that `serve` can refuse
/// to start when documents are turned on but can't be fetched.
pub(crate) fn check_trust_roots() -> AppResult<()> {
    trust_roots().map(|_| ())
}

async fn fetch(url: &Url) -> AppResult<(Vec<u8>, Duration)> {
    let host = url
        .host_str()
        .ok_or_else(|| refused("has no host"))?
        .to_owned();
    let addresses = tokio::net::lookup_host((host.as_str(), 443))
        .await
        .map_err(|_| refused("its host name could not be resolved"))?
        .collect::<Vec<SocketAddr>>();
    if addresses.is_empty() || !addresses.iter().all(|address| public_address(address.ip())) {
        return Err(refused(
            "its host name resolves to an address that isn't public",
        ));
    }
    let mut connected = None;
    for address in &addresses {
        let attempt = tokio::time::timeout(CONNECT_TIME, tokio::net::TcpStream::connect(address));
        if let Ok(Ok(stream)) = attempt.await {
            connected = Some(stream);
            break;
        }
    }
    let stream = connected.ok_or_else(|| refused("could not be reached"))?;
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| AppError::internal(format!("TLS setup failed: {error}")))?
    .with_root_certificates(trust_roots()?)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|_| refused("has an invalid host name"))?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|_| refused("failed the TLS handshake"))?;
    exchange(stream, url).await
}

/// One HTTP/1.1 GET on an open connection, with the response checks.
async fn exchange<T>(io: T, url: &Url) -> AppResult<(Vec<u8>, Duration)>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(16 * 1024)
        .handshake(hyper_util::rt::TokioIo::new(io))
        .await
        .map_err(|_| refused("did not answer HTTP"))?;
    let driver = tokio::spawn(connection);
    let result = async {
        let target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        let request = axum::http::Request::get(target)
            .header(header::HOST, url.host_str().unwrap_or_default())
            .header(header::ACCEPT, "application/json")
            .header(
                header::USER_AGENT,
                format!("oneloop/{}", crate::build_info::VERSION),
            )
            .body(http_body_util::Empty::<axum::body::Bytes>::new())
            .map_err(|error| AppError::internal(format!("document request: {error}")))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| refused("did not answer HTTP"))?;
        let lifetime = check_response(response.status(), response.headers())?;
        let body = http_body_util::Limited::new(response.into_body(), MAX_DOCUMENT_BYTES)
            .collect()
            .await
            .map_err(|_| refused("is larger than 5 KiB, or its answer broke off"))?
            .to_bytes();
        Ok((body.to_vec(), lifetime))
    }
    .await;
    driver.abort();
    result
}

/// Checks the status and headers of a document response, and returns how
/// long to keep the document.
fn check_response(status: StatusCode, headers: &HeaderMap) -> AppResult<Duration> {
    if status.is_redirection() {
        return Err(refused("redirects elsewhere; redirects are not followed"));
    }
    if status != StatusCode::OK {
        return Err(refused(&format!("answered HTTP {}", status.as_u16())));
    }
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(crate::http::input::is_json_media_type);
    if !json {
        return Err(refused("is not JSON"));
    }
    let length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if length.is_some_and(|length| length > MAX_DOCUMENT_BYTES as u64) {
        return Err(refused("is larger than 5 KiB"));
    }
    Ok(cache_lifetime(headers))
}

/// `Cache-Control: max-age`, within one minute and one hour.
fn cache_lifetime(headers: &HeaderMap) -> Duration {
    let mut lifetime = None;
    for value in headers.get_all(header::CACHE_CONTROL) {
        let Ok(value) = value.to_str() else { continue };
        for directive in value.split(',').map(str::trim) {
            let lower = directive.to_ascii_lowercase();
            if lower == "no-store" || lower == "no-cache" {
                lifetime = Some(Duration::ZERO);
            } else if let Some(seconds) = lower.strip_prefix("max-age=")
                && let Ok(seconds) = seconds.trim_matches('"').parse::<u64>()
            {
                lifetime = Some(
                    lifetime.map_or(Duration::from_secs(seconds), |current: Duration| {
                        current.min(Duration::from_secs(seconds))
                    }),
                );
            }
        }
    }
    lifetime
        .unwrap_or(DEFAULT_CACHE)
        .clamp(SHORTEST_CACHE, LONGEST_CACHE)
}

/// What a client says about itself, in a registration request or in its
/// metadata document. Other fields are ignored.
#[derive(Deserialize)]
pub(crate) struct ClientMetadata {
    #[serde(default)]
    pub(crate) client_name: Option<String>,
    redirect_uris: Vec<String>,
    #[serde(default)]
    client_uri: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    grant_types: Vec<String>,
    #[serde(default)]
    response_types: Vec<String>,
}

/// Client metadata that passed the checks, with normalized callbacks.
pub(crate) struct ValidClient {
    pub(crate) client_name: String,
    pub(crate) redirect_uris: Vec<String>,
    pub(crate) client_uri: Option<String>,
}

impl ClientMetadata {
    /// Checks the rules that registered and described clients share: a name
    /// that can be shown, 1 to 10 callbacks that `redirect_uri` accepts, a
    /// public client, and only the authorization code flow.
    pub(crate) fn validate(
        self,
        redirect_uri: impl Fn(&str) -> AppResult<String>,
    ) -> AppResult<ValidClient> {
        let name = self
            .client_name
            .as_deref()
            .ok_or_else(|| AppError::validation("client_name", "is required"))?;
        crate::text::validate(name, "client_name", crate::text::Lines::Single, true)?;
        let name = name.trim();
        if name.chars().count() > 100 {
            return Err(AppError::validation(
                "client_name",
                "must contain 1 to 100 characters",
            ));
        }
        if !(1..=10).contains(&self.redirect_uris.len()) {
            return Err(AppError::validation(
                "redirect_uris",
                "must contain 1 to 10 redirect URIs",
            ));
        }
        if self
            .token_endpoint_auth_method
            .is_some_and(|method| method != "none")
        {
            return Err(AppError::validation(
                "token_endpoint_auth_method",
                "only public clients using none are supported",
            ));
        }
        if self
            .grant_types
            .iter()
            .any(|value| value != "authorization_code" && value != "refresh_token")
        {
            return Err(AppError::validation(
                "grant_types",
                "only authorization_code and refresh_token are supported",
            ));
        }
        if self.response_types.iter().any(|value| value != "code") {
            return Err(AppError::validation(
                "response_types",
                "only code is supported",
            ));
        }
        let redirect_uris = self
            .redirect_uris
            .iter()
            .map(|value| redirect_uri(value))
            .collect::<AppResult<BTreeSet<_>>>()?;
        Ok(ValidClient {
            client_name: name.to_owned(),
            redirect_uris: redirect_uris.into_iter().collect(),
            client_uri: self
                .client_uri
                .as_deref()
                .map(super::oauth::validate_client_uri)
                .transpose()?,
        })
    }
}

/// Checks a fetched document against the client ID it was fetched for.
fn parse_document(
    client_id: &str,
    bytes: &[u8],
    redirect_uri: impl Fn(&str) -> AppResult<String>,
) -> AppResult<ClientDocument> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| refused("is not valid JSON"))?;
    let object = value
        .as_object()
        .ok_or_else(|| refused("is not a JSON object"))?;
    if object.get("client_id").and_then(Value::as_str) != Some(client_id) {
        return Err(refused("names another client_id"));
    }
    if object.contains_key("client_secret") || object.contains_key("client_secret_expires_at") {
        return Err(refused("contains a client secret"));
    }
    let metadata: ClientMetadata = serde_path_to_error::deserialize(value)
        .map_err(|error| refused(&format!("can't be read: {error}")))?;
    let client = metadata
        .validate(redirect_uri)
        .map_err(|error| match error {
            AppError::Validation { field, message } => {
                refused(&format!("has an unacceptable {field}: {message}"))
            }
            error => error,
        })?;
    Ok(ClientDocument {
        client_id: client_id.to_owned(),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        client_uri: client.client_uri,
    })
}

fn refused(reason: &str) -> AppError {
    AppError::validation(
        "client_id",
        format!("the client metadata document {reason}"),
    )
}

fn unknown_client() -> AppError {
    AppError::validation("client_id", "is not registered")
}

fn busy() -> AppError {
    AppError::Unavailable(
        "too many client metadata documents are being fetched; try again shortly".into(),
    )
}

#[cfg(test)]
mod tests;
