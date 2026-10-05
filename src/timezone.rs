//! The instance timezone, with its rules from the IANA timezone database
//! built into oneloop. The server's clock settings and `TZ` never apply.

/// A timezone loaded by its IANA name, such as `Europe/Berlin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeZone(jiff::tz::TimeZone);

impl TimeZone {
    /// Loads `name` from the built-in database. The name must match an entry
    /// exactly, including case.
    pub fn built_in(name: &str) -> Option<Self> {
        let (canonical, data) = jiff_tzdb::get(name)?;
        if canonical != name {
            return None;
        }
        jiff::tz::TimeZone::tzif(name, data).ok().map(Self)
    }

    /// The IANA name the timezone was loaded by.
    pub fn name(&self) -> &str {
        self.0.iana_name().unwrap_or_default()
    }

    /// The rules that map instants to local times and back.
    pub fn rules(&self) -> &jiff::tz::TimeZone {
        &self.0
    }
}

/// The release of the built-in database, such as `2026c`.
pub fn built_in_version() -> &'static str {
    jiff_tzdb::VERSION.unwrap_or("unknown")
}
