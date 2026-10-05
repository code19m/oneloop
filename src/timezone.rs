//! The instance timezone. Its rules come from the server's zoneinfo when that
//! copy of the IANA timezone database is at least as new as the one built into
//! oneloop, and from the built-in copy otherwise. The server's clock settings
//! and `TZ` never apply.

use std::{
    fmt,
    io::{BufRead, Read},
    path::{Path, PathBuf},
};

/// Where the server keeps its zoneinfo when `TZDIR` doesn't say.
pub const SYSTEM_ZONEINFO: &str = "/usr/share/zoneinfo";

/// A timezone loaded by its IANA name, such as `Europe/Berlin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeZone {
    rules: jiff::tz::TimeZone,
    database: Database,
}

/// The copy of the IANA timezone database that a timezone's rules came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Database {
    BuiltIn,
    System { directory: PathBuf, version: String },
}

impl TimeZone {
    /// Loads `name` from the built-in database. The name must match an entry
    /// exactly, including case.
    pub fn built_in(name: &str) -> Option<Self> {
        let (canonical, data) = jiff_tzdb::get(name)?;
        if canonical != name {
            return None;
        }
        let rules = jiff::tz::TimeZone::tzif(name, data).ok()?;
        Some(Self {
            rules,
            database: Database::BuiltIn,
        })
    }

    /// Loads `name` from the zoneinfo in `directory`, or in
    /// [`SYSTEM_ZONEINFO`] without one, when its `tzdata.zi` names a release at
    /// least as new as the built-in one and has the zone. Otherwise, or if that
    /// fails, uses the built-in database. Only names in the built-in database
    /// are valid, so a zoneinfo file such as `localtime` is not a timezone.
    pub fn load(name: &str, directory: Option<&Path>) -> Option<Self> {
        let built_in = Self::built_in(name)?;
        let directory = directory.unwrap_or(Path::new(SYSTEM_ZONEINFO));
        Some(system_zone(directory, name).unwrap_or(built_in))
    }

    /// The IANA name the timezone was loaded by.
    pub fn name(&self) -> &str {
        self.rules.iana_name().unwrap_or_default()
    }

    /// The rules that map instants to local times and back.
    pub fn rules(&self) -> &jiff::tz::TimeZone {
        &self.rules
    }

    pub fn database(&self) -> &Database {
        &self.database
    }
}

impl fmt::Display for Database {
    /// The release and its source, such as `2026c (built in)` or
    /// `2026e (system, /usr/share/zoneinfo)`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BuiltIn => write!(formatter, "{} (built in)", built_in_version()),
            Self::System { directory, version } => {
                write!(formatter, "{version} (system, {})", directory.display())
            }
        }
    }
}

/// The release of the built-in database, such as `2026c`.
pub fn built_in_version() -> &'static str {
    jiff_tzdb::VERSION.unwrap_or("unknown")
}

fn system_zone(directory: &Path, name: &str) -> Option<TimeZone> {
    let version = system_version(directory)?;
    if version.as_str() < built_in_version() {
        return None;
    }
    let data = std::fs::read(directory.join(name)).ok()?;
    let rules = jiff::tz::TimeZone::tzif(name, &data).ok()?;
    Some(TimeZone {
        rules,
        database: Database::System {
            directory: directory.to_owned(),
            version,
        },
    })
}

/// `tzdata.zi` starts with `# version 2026c`, or `# version 2026c-rearguard`
/// on macOS.
fn system_version(directory: &Path) -> Option<String> {
    let file = std::fs::File::open(directory.join("tzdata.zi")).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(file.take(64))
        .read_line(&mut line)
        .ok()?;
    let version = line.strip_prefix("# version ")?.trim();
    let version = version.split('-').next()?;
    // A release is a year and lowercase letters, such as `2026c`; after
    // `2026z` comes `2026za`. Plain string order then sorts them.
    let (year, letters) = version.split_at_checked(4)?;
    let valid = year.bytes().all(|byte| byte.is_ascii_digit())
        && !letters.is_empty()
        && letters.bytes().all(|byte| byte.is_ascii_lowercase());
    valid.then(|| version.to_owned())
}
