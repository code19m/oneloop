use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::{OsStr, OsString},
    fs, io,
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    str::FromStr,
};

use ipnet::IpNet;
use tracing::Level;
use url::{Host, Url};

use crate::auth::password::{
    Blocklist, MAX_MIN_PASSWORD_CHARACTERS, MIN_PASSWORD_CHARACTERS, PasswordPolicy,
};
use crate::error::{AppError, AppResult};
use crate::timezone::TimeZone;

pub(crate) const PUBLIC_URL_ENV: &str = "ONELOOP_PUBLIC_URL";
pub(crate) const LISTEN_ENV: &str = "ONELOOP_LISTEN";
pub(crate) const DATA_DIR_ENV: &str = "ONELOOP_DATA_DIR";
pub(crate) const TIMEZONE_ENV: &str = "ONELOOP_TIMEZONE";
pub(crate) const STORAGE_LIMIT_ENV: &str = "ONELOOP_STORAGE_LIMIT";
pub(crate) const DISK_MIN_FREE_ENV: &str = "ONELOOP_DISK_MIN_FREE";
pub(crate) const TRUSTED_PROXIES_ENV: &str = "ONELOOP_TRUSTED_PROXIES";
pub(crate) const LOG_LEVEL_ENV: &str = "ONELOOP_LOG_LEVEL";
pub(crate) const PASSWORD_MIN_LENGTH_ENV: &str = "ONELOOP_PASSWORD_MIN_LENGTH";
pub(crate) const ADMIN_PASSWORD_MIN_LENGTH_ENV: &str = "ONELOOP_ADMIN_PASSWORD_MIN_LENGTH";
pub(crate) const PASSWORD_BLOCKLIST_ENV: &str = "ONELOOP_PASSWORD_BLOCKLIST";
pub(crate) const TEMPORARY_PASSWORD_LIFETIME_ENV: &str = "ONELOOP_TEMPORARY_PASSWORD_LIFETIME";
pub(crate) const MCP_REDIRECT_SCHEMES_ENV: &str = "ONELOOP_MCP_REDIRECT_SCHEMES";
pub(crate) const MCP_ALLOWED_ORIGINS_ENV: &str = "ONELOOP_MCP_ALLOWED_ORIGINS";
pub(crate) const MCP_CLIENT_METADATA_ENV: &str = "ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS";

const KNOWN_ENV: [&str; 15] = [
    PUBLIC_URL_ENV,
    LISTEN_ENV,
    DATA_DIR_ENV,
    TIMEZONE_ENV,
    STORAGE_LIMIT_ENV,
    DISK_MIN_FREE_ENV,
    TRUSTED_PROXIES_ENV,
    LOG_LEVEL_ENV,
    PASSWORD_MIN_LENGTH_ENV,
    ADMIN_PASSWORD_MIN_LENGTH_ENV,
    PASSWORD_BLOCKLIST_ENV,
    TEMPORARY_PASSWORD_LIFETIME_ENV,
    MCP_REDIRECT_SCHEMES_ENV,
    MCP_ALLOWED_ORIGINS_ENV,
    MCP_CLIENT_METADATA_ENV,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub public_url: Url,
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub timezone: TimeZone,
    pub storage_limit_bytes: u64,
    pub disk_min_free_bytes: u64,
    pub trusted_proxies: Vec<IpNet>,
    pub log_level: Level,
    pub password_policy: PasswordPolicy,
    /// Link schemes, such as `cursor`, that MCP clients may use for callbacks.
    pub mcp_redirect_schemes: Vec<String>,
    /// Origins of browser-based MCP clients, as browsers send them.
    pub mcp_allowed_origins: Vec<String>,
    /// Whether MCP clients may identify themselves with metadata documents.
    pub mcp_client_metadata_documents: bool,
}

impl Config {
    /// The public URL without its trailing slash, to append paths to.
    pub fn base_url(&self) -> &str {
        self.public_url.as_str().trim_end_matches('/')
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataConfig {
    pub data_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> AppResult<Self> {
        Self::from_os_iter(env::vars_os())
    }

    pub fn from_os_iter<I, K, V>(values: I) -> AppResult<Self>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let env = Environment::collect(values)?;
        let public_url = parse_public_url(env.required(PUBLIC_URL_ENV)?)?;
        let listen = env
            .get(LISTEN_ENV)
            .unwrap_or("127.0.0.1:8080")
            .parse::<SocketAddr>()
            .map_err(|_| invalid_env(LISTEN_ENV, "expected an IP address and port"))?;
        let data_dir = resolve_data_dir(env.get(DATA_DIR_ENV).unwrap_or("./data"))?;
        let timezone = TimeZone::load(
            env.get(TIMEZONE_ENV).unwrap_or("UTC"),
            env.zoneinfo.as_deref(),
        )
        .ok_or_else(|| invalid_env(TIMEZONE_ENV, "unknown IANA timezone"))?;
        let storage_limit_bytes = parse_size(
            STORAGE_LIMIT_ENV,
            env.get(STORAGE_LIMIT_ENV).unwrap_or("10GiB"),
        )?;
        let disk_min_free_bytes = parse_size(
            DISK_MIN_FREE_ENV,
            env.get(DISK_MIN_FREE_ENV).unwrap_or("1GiB"),
        )?;
        let trusted_proxies =
            parse_trusted_proxies(env.get(TRUSTED_PROXIES_ENV).unwrap_or_default())?;
        let log_level = parse_log_level(env.get(LOG_LEVEL_ENV).unwrap_or("info"))?;
        let password_policy = parse_password_policy(&env)?;
        let mcp_redirect_schemes =
            parse_redirect_schemes(env.get(MCP_REDIRECT_SCHEMES_ENV).unwrap_or_default())?;
        let mcp_allowed_origins =
            parse_allowed_origins(env.get(MCP_ALLOWED_ORIGINS_ENV).unwrap_or_default())?;
        let mcp_client_metadata_documents = match env.get(MCP_CLIENT_METADATA_ENV) {
            None | Some("false") => false,
            Some("true") => true,
            Some(_) => {
                return Err(invalid_env(
                    MCP_CLIENT_METADATA_ENV,
                    "expected true or false",
                ));
            }
        };

        Ok(Self {
            public_url,
            listen,
            data_dir,
            timezone,
            storage_limit_bytes,
            disk_min_free_bytes,
            trusted_proxies,
            log_level,
            password_policy,
            mcp_redirect_schemes,
            mcp_allowed_origins,
            mcp_client_metadata_documents,
        })
    }
}

/// Schemes that browsers handle themselves, or that carry content or
/// commands, never name an app that receives a sign-in.
const RESERVED_SCHEMES: &[&str] = &[
    "about",
    "blob",
    "chrome",
    "chrome-extension",
    "data",
    "file",
    "filesystem",
    "ftp",
    "http",
    "https",
    "intent",
    "jar",
    "javascript",
    "mailto",
    "moz-extension",
    "resource",
    "sms",
    "tel",
    "vbscript",
    "view-source",
    "ws",
    "wss",
];

/// The items of a setting separated by commas, without the spaces around
/// them. Empty items, such as after a trailing comma, are skipped.
fn comma_list(raw: &str) -> impl Iterator<Item = &str> {
    raw.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

fn parse_redirect_schemes(raw: &str) -> AppResult<Vec<String>> {
    let mut schemes = Vec::new();
    for item in comma_list(raw) {
        let scheme = item.to_ascii_lowercase();
        let mut characters = scheme.chars();
        let valid = characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
            && characters.all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '-' | '.')
            });
        if !valid {
            return Err(invalid_env(
                MCP_REDIRECT_SCHEMES_ENV,
                format!("{item} is not a URL scheme; write it without :// "),
            ));
        }
        // Websites register handlers for web+ schemes, so their callbacks
        // need not reach an app on the person's computer.
        if RESERVED_SCHEMES.contains(&scheme.as_str()) || scheme.starts_with("web+") {
            return Err(invalid_env(
                MCP_REDIRECT_SCHEMES_ENV,
                format!("{scheme} can't be used for app callbacks"),
            ));
        }
        if !schemes.contains(&scheme) {
            schemes.push(scheme);
        }
    }
    Ok(schemes)
}

fn parse_allowed_origins(raw: &str) -> AppResult<Vec<String>> {
    let mut origins = Vec::new();
    for item in comma_list(raw) {
        let invalid = || {
            invalid_env(
                MCP_ALLOWED_ORIGINS_ENV,
                format!("{item} must be https:// or loopback http://, a host and an optional port"),
            )
        };
        let url = Url::parse(item).map_err(|_| invalid())?;
        let allowed_scheme =
            url.scheme() == "https" || (url.scheme() == "http" && is_loopback(&url));
        if !allowed_scheme
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        let origin = url.origin().ascii_serialization();
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Ok(origins)
}

/// The password settings, for the commands that set passwords.
pub fn password_policy_from_env() -> AppResult<PasswordPolicy> {
    password_policy_from_os_iter(env::vars_os())
}

pub fn password_policy_from_os_iter<I, K, V>(values: I) -> AppResult<PasswordPolicy>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<OsString>,
    V: Into<OsString>,
{
    parse_password_policy(&Environment::collect(values)?)
}

fn parse_password_policy(env: &Environment) -> AppResult<PasswordPolicy> {
    let length = |variable: &'static str, raw: &str| {
        raw.parse::<usize>()
            .ok()
            .filter(|value| (MIN_PASSWORD_CHARACTERS..=MAX_MIN_PASSWORD_CHARACTERS).contains(value))
            .ok_or_else(|| {
                invalid_env(
                    variable,
                    format!(
                        "expected a whole number from {MIN_PASSWORD_CHARACTERS} to {MAX_MIN_PASSWORD_CHARACTERS}"
                    ),
                )
            })
    };
    let min_length = match env.get(PASSWORD_MIN_LENGTH_ENV) {
        Some(raw) => length(PASSWORD_MIN_LENGTH_ENV, raw)?,
        None => MIN_PASSWORD_CHARACTERS,
    };
    let admin_min_length = match env.get(ADMIN_PASSWORD_MIN_LENGTH_ENV) {
        Some(raw) => length(ADMIN_PASSWORD_MIN_LENGTH_ENV, raw)?,
        None => min_length,
    };
    if admin_min_length < min_length {
        return Err(invalid_env(
            ADMIN_PASSWORD_MIN_LENGTH_ENV,
            format!("must be at least {PASSWORD_MIN_LENGTH_ENV}"),
        ));
    }
    let blocklist = match env.get(PASSWORD_BLOCKLIST_ENV) {
        Some(raw) if !raw.trim().is_empty() => {
            let path = Path::new(raw);
            let list = Blocklist::load(path).map_err(|error| {
                invalid_env(
                    PASSWORD_BLOCKLIST_ENV,
                    format!("cannot read {}: {error}", path.display()),
                )
            })?;
            Some(std::sync::Arc::new(list))
        }
        _ => None,
    };
    let temporary_lifetime_seconds = env
        .get(TEMPORARY_PASSWORD_LIFETIME_ENV)
        .map(parse_lifetime)
        .transpose()?;
    Ok(PasswordPolicy {
        min_length,
        admin_min_length,
        blocklist,
        temporary_lifetime_seconds,
    })
}

/// Whole hours (`36h`) or days (`7d`), from one hour to a year.
fn parse_lifetime(raw: &str) -> AppResult<i64> {
    let invalid = || {
        invalid_env(
            TEMPORARY_PASSWORD_LIFETIME_ENV,
            "expected hours or days, such as 36h or 7d, from 1h to 365d",
        )
    };
    let (number, unit) = match (raw.strip_suffix('h'), raw.strip_suffix('d')) {
        (Some(hours), _) => (hours, 60 * 60),
        (_, Some(days)) => (days, 24 * 60 * 60),
        _ => return Err(invalid()),
    };
    let seconds = number
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .and_then(|value| value.checked_mul(unit))
        .ok_or_else(invalid)?;
    if seconds > 365 * 24 * 60 * 60 {
        return Err(invalid());
    }
    Ok(seconds)
}

impl DataConfig {
    pub fn from_env() -> AppResult<Self> {
        Self::from_os_iter(env::vars_os())
    }

    pub fn from_os_iter<I, K, V>(values: I) -> AppResult<Self>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let env = Environment::collect(values)?;
        Ok(Self {
            data_dir: resolve_data_dir(env.get(DATA_DIR_ENV).unwrap_or("./data"))?,
        })
    }
}

struct Environment {
    values: BTreeMap<String, String>,
    /// `TZDIR`, the folder with the server's zoneinfo, as jiff and the C
    /// library read it.
    zoneinfo: Option<PathBuf>,
}

impl Environment {
    fn collect<I, K, V>(values: I) -> AppResult<Self>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let mut found = BTreeMap::new();
        let mut zoneinfo = None;
        let known = KNOWN_ENV.into_iter().collect::<BTreeSet<_>>();

        for (raw_key, raw_value) in values {
            let raw_key = raw_key.into();
            let Some(key) = raw_key.to_str() else {
                continue;
            };
            if key == "TZDIR" {
                zoneinfo = Some(PathBuf::from(raw_value.into()))
                    .filter(|path| !path.as_os_str().is_empty());
                continue;
            }
            if !key.starts_with("ONELOOP_") {
                continue;
            }
            if !known.contains(key) {
                return Err(AppError::Config(format!(
                    "unknown environment variable {key}"
                )));
            }
            let value = os_value(key, &raw_value.into())?;
            found.insert(key.to_owned(), value);
        }
        Ok(Self {
            values: found,
            zoneinfo,
        })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn required(&self, key: &'static str) -> AppResult<&str> {
        self.get(key)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Config(format!("{key} is required")))
    }
}

fn os_value(key: &str, value: &OsStr) -> AppResult<String> {
    value
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::Config(format!("{key} must be valid UTF-8")))
}

fn parse_public_url(raw: &str) -> AppResult<Url> {
    let mut url =
        Url::parse(raw).map_err(|_| invalid_env(PUBLIC_URL_ENV, "expected an absolute URL"))?;
    if url.username() != "" || url.password().is_some() {
        return Err(invalid_env(PUBLIC_URL_ENV, "credentials are not allowed"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid_env(
            PUBLIC_URL_ENV,
            "query strings and fragments are not allowed",
        ));
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err(invalid_env(
            PUBLIC_URL_ENV,
            "path prefixes are not supported",
        ));
    }
    if url.host().is_none() {
        return Err(invalid_env(PUBLIC_URL_ENV, "a host is required"));
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => {
            return Err(invalid_env(
                PUBLIC_URL_ENV,
                "HTTP is allowed only for loopback development addresses",
            ));
        }
        _ => return Err(invalid_env(PUBLIC_URL_ENV, "expected HTTPS")),
    }
    url.set_path("");
    Ok(url)
}

/// Whether a URL names this computer: `localhost` or a loopback address.
pub(crate) fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn parse_size(variable: &'static str, raw: &str) -> AppResult<u64> {
    let split = raw
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(raw.len());
    let (number, suffix) = raw.split_at(split);
    if number.is_empty() {
        return Err(invalid_env(variable, "expected a positive integer size"));
    }
    let value = number
        .parse::<u64>()
        .map_err(|_| invalid_env(variable, "size is too large"))?;
    let multiplier = match suffix {
        "B" => 1,
        "KB" => 1_000,
        "MB" => 1_000_000,
        "GB" => 1_000_000_000,
        "TB" => 1_000_000_000_000,
        "KiB" => 1 << 10,
        "MiB" => 1 << 20,
        "GiB" => 1 << 30,
        "TiB" => 1_u64 << 40,
        _ => {
            return Err(invalid_env(
                variable,
                "use B, KB, MB, GB, TB, KiB, MiB, GiB or TiB",
            ));
        }
    };
    let bytes = value
        .checked_mul(multiplier)
        .ok_or_else(|| invalid_env(variable, "size is too large"))?;
    if bytes == 0 {
        return Err(invalid_env(variable, "size must be greater than zero"));
    }
    Ok(bytes)
}

fn parse_trusted_proxies(raw: &str) -> AppResult<Vec<IpNet>> {
    let mut proxies = Vec::new();
    for value in comma_list(raw) {
        let network = IpNet::from_str(value)
            .or_else(|_| IpAddr::from_str(value).map(IpNet::from))
            .map_err(|_| invalid_env(TRUSTED_PROXIES_ENV, "expected IP addresses or CIDRs"))?;
        if !proxies.contains(&network) {
            proxies.push(network);
        }
    }
    Ok(proxies)
}

fn parse_log_level(raw: &str) -> AppResult<Level> {
    match raw.to_ascii_lowercase().as_str() {
        "error" => Ok(Level::ERROR),
        "warn" => Ok(Level::WARN),
        "info" => Ok(Level::INFO),
        "debug" => Ok(Level::DEBUG),
        "trace" => Ok(Level::TRACE),
        _ => Err(invalid_env(
            LOG_LEVEL_ENV,
            "expected error, warn, info, debug or trace",
        )),
    }
}

/// The absolute data folder. A missing folder is fine, because `db migrate`
/// and `backup restore` create it; anything else must be a folder.
pub fn resolve_data_dir(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(invalid_env(DATA_DIR_ENV, "path cannot be empty"));
    }
    let cannot_resolve =
        |reason: String| invalid_env(DATA_DIR_ENV, format!("cannot resolve {raw}: {reason}"));
    let path = Path::new(raw);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| cannot_resolve(error.to_string()))?
            .join(path)
    };
    let resolved = normalize_path(&absolute).map_err(|error| {
        cannot_resolve(match error {
            AppError::Validation { message, .. } | AppError::Io(message) => message,
            error => error.to_string(),
        })
    })?;
    match fs::metadata(&resolved) {
        Ok(metadata) if metadata.is_dir() => Ok(resolved),
        Ok(_) => Err(invalid_env(
            DATA_DIR_ENV,
            format!("{} is not a folder", resolved.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(resolved),
        Err(error) => Err(invalid_env(
            DATA_DIR_ENV,
            format!("cannot open {}: {error}", resolved.display()),
        )),
    }
}

/// Removes `.` and `..` from an absolute path, so later checks and writes see
/// the same directory even after missing folders are created.
pub(crate) fn normalize_path(path: &Path) -> AppResult<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => normalized = parent_directory(&normalized)?,
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

/// The directory that `path/..` reaches, resolving symbolic links in `path`
/// first, as the filesystem does.
fn parent_directory(path: &Path) -> AppResult<PathBuf> {
    match path.join("..").canonicalize() {
        Ok(parent) => Ok(parent),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match fs::symlink_metadata(path) {
                // A folder that doesn't exist yet is not a link, so once
                // created, its `..` is the folder above it.
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    Ok(path.parent().unwrap_or(path).to_path_buf())
                }
                // A broken link's `..` depends on a target that doesn't exist.
                Ok(_) => Err(AppError::validation(
                    "path",
                    format!("`..` follows the broken symbolic link {}", path.display()),
                )),
                Err(error) => Err(error.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn invalid_env(variable: &'static str, message: impl Into<String>) -> AppError {
    AppError::Config(format!("{variable}: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reference_documents_exactly_the_known_variables() {
        let reference = include_str!("../docs/src/reference.md");
        let documented = reference
            .match_indices("ONELOOP_")
            .filter_map(|(start, _)| {
                let name = &reference[start..];
                let end = name
                    .find(|c: char| !(c.is_ascii_uppercase() || c == '_'))
                    .unwrap_or(name.len());
                // Skip mentions of the prefix itself, such as "`ONELOOP_`".
                (end > "ONELOOP_".len()).then(|| &name[..end])
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(documented, BTreeSet::from(KNOWN_ENV));
    }
}
