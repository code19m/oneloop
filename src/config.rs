use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::{OsStr, OsString},
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    str::FromStr,
};

use chrono_tz::Tz;
use ipnet::IpNet;
use tracing::Level;
use url::{Host, Url};

use crate::error::{AppError, AppResult};

pub const PUBLIC_URL_ENV: &str = "ONELOOP_PUBLIC_URL";
pub const LISTEN_ENV: &str = "ONELOOP_LISTEN";
pub const DATA_DIR_ENV: &str = "ONELOOP_DATA_DIR";
pub const TIMEZONE_ENV: &str = "ONELOOP_TIMEZONE";
pub const STORAGE_LIMIT_ENV: &str = "ONELOOP_STORAGE_LIMIT";
pub const DISK_MIN_FREE_ENV: &str = "ONELOOP_DISK_MIN_FREE";
pub const TRUSTED_PROXIES_ENV: &str = "ONELOOP_TRUSTED_PROXIES";
pub const LOG_LEVEL_ENV: &str = "ONELOOP_LOG_LEVEL";

const KNOWN_ENV: [&str; 8] = [
    PUBLIC_URL_ENV,
    LISTEN_ENV,
    DATA_DIR_ENV,
    TIMEZONE_ENV,
    STORAGE_LIMIT_ENV,
    DISK_MIN_FREE_ENV,
    TRUSTED_PROXIES_ENV,
    LOG_LEVEL_ENV,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub public_url: Url,
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub timezone: Tz,
    pub storage_limit_bytes: u64,
    pub disk_min_free_bytes: u64,
    pub trusted_proxies: Vec<IpNet>,
    pub log_level: Level,
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
        let timezone = env
            .get(TIMEZONE_ENV)
            .unwrap_or("UTC")
            .parse::<Tz>()
            .map_err(|_| invalid_env(TIMEZONE_ENV, "unknown IANA timezone"))?;
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

        Ok(Self {
            public_url,
            listen,
            data_dir,
            timezone,
            storage_limit_bytes,
            disk_min_free_bytes,
            trusted_proxies,
            log_level,
        })
    }
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
}

impl Environment {
    fn collect<I, K, V>(values: I) -> AppResult<Self>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let mut found = BTreeMap::new();
        let known = KNOWN_ENV.into_iter().collect::<BTreeSet<_>>();

        for (raw_key, raw_value) in values {
            let raw_key = raw_key.into();
            let Some(key) = raw_key.to_str() else {
                continue;
            };
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
        Ok(Self { values: found })
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
    let loopback = match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => return Err(invalid_env(PUBLIC_URL_ENV, "a host is required")),
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
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
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut proxies = Vec::new();
    for item in raw.split(',') {
        let value = item.trim();
        if value.is_empty() {
            return Err(invalid_env(TRUSTED_PROXIES_ENV, "empty proxy entry"));
        }
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

pub fn resolve_data_dir(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(invalid_env(DATA_DIR_ENV, "path cannot be empty"));
    }
    let path = Path::new(raw);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    normalize_path(&absolute)
}

pub(crate) fn normalize_path(path: &Path) -> AppResult<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::Config(
                        "path escapes its filesystem root".to_owned(),
                    ));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

fn invalid_env(variable: &'static str, message: impl Into<String>) -> AppError {
    AppError::Config(format!("{variable}: {}", message.into()))
}

#[cfg(test)]
mod generated_tests {
    use super::*;
    proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config { failure_persistence: None, ..proptest::test_runner::Config::default() })]
        #[test]
        fn generated_configuration_parsers_do_not_panic(raw in ".{0,512}") {
            let _ = parse_size("test", &raw);
            let _ = parse_trusted_proxies(&raw);
            let _ = parse_public_url(&raw);
        }
    }
}
