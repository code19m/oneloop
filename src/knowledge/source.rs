//! Repository location rules. Only HTTPS and SSH reach a Git host, a URL never
//! carries a password, a branch is a plain name and the folder stays inside the
//! repository. Values that pass these checks are safe to hand to `git`.

use url::Url;

use crate::{AppError, AppResult};

const URL_MAX: usize = 2_000;
const BRANCH_MAX: usize = 255;
const FOLDER_MAX: usize = 1_000;
const TOKEN_MAX: usize = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Transport {
    Https,
    Ssh,
    /// Local repositories, accepted only when tests allow them.
    File,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitUrl {
    raw: String,
    transport: Transport,
    host: String,
    path: String,
    username: Option<String>,
}

impl GitUrl {
    pub(crate) fn parse(value: &str, allow_file: bool) -> AppResult<Self> {
        let raw = value.trim();
        let invalid = || AppError::validation("url", "must be an HTTPS or SSH Git URL");
        if raw.is_empty()
            || raw.len() > URL_MAX
            || raw.chars().any(|c| c.is_control() || c.is_whitespace())
            || raw.split('/').any(is_dot_segment)
        {
            return Err(invalid());
        }
        if raw
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        {
            return Err(AppError::validation(
                "url",
                "must use HTTPS or SSH; plain HTTP is not supported",
            ));
        }
        let scheme = raw
            .split_once("://")
            .map(|(scheme, _)| scheme.to_ascii_lowercase());
        match scheme.as_deref() {
            Some("https") => Self::from_url(raw, Transport::Https),
            Some("ssh") => Self::from_url(raw, Transport::Ssh),
            Some("file") if allow_file => Self::from_url(raw, Transport::File),
            Some(_) => Err(invalid()),
            None => Self::scp_like(raw).ok_or_else(invalid),
        }
    }

    fn from_url(raw: &str, transport: Transport) -> AppResult<Self> {
        let invalid = || AppError::validation("url", "must be an HTTPS or SSH Git URL");
        let url = Url::parse(raw).map_err(|_| invalid())?;
        if url.password().is_some() {
            return Err(AppError::validation(
                "url",
                "must not contain a password; use the access token field",
            ));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(invalid());
        }
        let host = match transport {
            Transport::File => String::new(),
            _ => url
                .host_str()
                .filter(|host| !host.is_empty())
                .ok_or_else(invalid)?
                .to_ascii_lowercase(),
        };
        let path = url.path().trim_start_matches('/').to_owned();
        if path.is_empty() || path.split('/').any(|part| part == "..") {
            return Err(invalid());
        }
        let username = (!url.username().is_empty()).then(|| percent_decode(url.username()));
        if username
            .as_deref()
            .is_some_and(|name| name.chars().any(|c| c.is_control() || c == ':'))
        {
            return Err(invalid());
        }
        Ok(Self {
            raw: raw.to_owned(),
            transport,
            host: match url.port() {
                Some(port) if transport == Transport::Https => format!("{host}:{port}"),
                _ => host,
            },
            path,
            username,
        })
    }

    /// `user@host:path`, as Git hosts show for SSH. A user is required so the
    /// form never looks like a local path.
    fn scp_like(raw: &str) -> Option<Self> {
        let (authority, path) = raw.split_once(':')?;
        let (user, host) = authority.split_once('@')?;
        // Neither part may start with `-`, which Git or SSH would read as an option.
        let valid_user = !user.is_empty()
            && !user.starts_with('-')
            && user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        let valid_host = !host.is_empty()
            && !host.starts_with('-')
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
        let path = path.trim_start_matches('/');
        if !valid_user
            || !valid_host
            || path.is_empty()
            || path.starts_with('-')
            || path.split('/').any(|part| part == "..")
        {
            return None;
        }
        Some(Self {
            raw: raw.to_owned(),
            transport: Transport::Ssh,
            host: host.to_ascii_lowercase(),
            path: path.to_owned(),
            username: None,
        })
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.raw
    }

    pub(crate) fn transport(&self) -> Transport {
        self.transport
    }

    /// The name people recognize: host and repository path without `.git`.
    pub(crate) fn display_name(&self) -> String {
        let path = self.path.trim_end_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path);
        if self.host.is_empty() {
            path.to_owned()
        } else {
            format!("{}/{path}", self.host)
        }
    }

    /// The username for HTTPS token authentication, taken from the URL.
    pub(crate) fn username(&self) -> Option<&str> {
        self.username.as_deref()
    }

    /// Where an HTTPS access token may be sent: this host only.
    pub(crate) fn origin(&self) -> Option<String> {
        (self.transport == Transport::Https).then(|| format!("https://{}/", self.host))
    }

    /// The URL handed to `git`. An HTTPS username moves into the
    /// Authorization header instead, so Git never prompts for its password.
    pub(crate) fn fetch_url(&self) -> String {
        match self.transport {
            Transport::Https => {
                let mut url = Url::parse(&self.raw).expect("validated URL");
                let _ = url.set_username("");
                url.to_string()
            }
            Transport::Ssh | Transport::File => self.raw.clone(),
        }
    }
}

/// `.` and `..`, including their percent-encoded forms, which URL parsing
/// would otherwise resolve silently.
fn is_dot_segment(part: &str) -> bool {
    matches!(
        part.to_ascii_lowercase().as_str(),
        "." | ".." | "%2e" | "%2e%2e" | ".%2e" | "%2e."
    )
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                decoded.push(byte);
                index += 3;
            }
            (byte, _) => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// A branch name Git accepts and that cannot be read as an option or a range.
pub(crate) fn branch(value: &str) -> AppResult<String> {
    let branch = value.trim();
    let invalid = || AppError::validation("branch", "is not a valid branch name");
    if branch.is_empty() || branch.len() > BRANCH_MAX {
        return Err(invalid());
    }
    if branch.starts_with(['-', '/', '.'])
        || branch.ends_with(['/', '.'])
        || branch.ends_with(".lock")
        || branch == "@"
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
        || branch.contains("/.")
        || branch.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
    {
        return Err(invalid());
    }
    Ok(branch.to_owned())
}

/// A folder inside the repository, `/`-separated with no leading or trailing
/// slash. An empty value is the repository root.
pub(crate) fn folder(value: &str) -> AppResult<String> {
    let trimmed = value.trim().trim_matches('/');
    let invalid = || AppError::validation("folder", "must be a folder inside the repository");
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }
    if trimmed.len() > FOLDER_MAX {
        return Err(invalid());
    }
    for part in trimmed.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.eq_ignore_ascii_case(".git")
            || part.chars().any(|c| c.is_control() || c == '\\')
        {
            return Err(invalid());
        }
    }
    Ok(trimmed.to_owned())
}

/// An access token travels in an HTTP header, so it must be one line of
/// visible ASCII.
pub(crate) fn token(value: &str) -> AppResult<String> {
    let token = value.trim();
    if token.is_empty() || token.len() > TOKEN_MAX || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(AppError::validation(
            "token",
            "must be one line of visible characters",
        ));
    }
    Ok(token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: &str) -> Option<GitUrl> {
        GitUrl::parse(value, false).ok()
    }

    #[test]
    fn https_and_ssh_urls_from_any_host_are_accepted() {
        for (value, name, transport) in [
            (
                "https://git.example.com/team/docs.git",
                "git.example.com/team/docs",
                Transport::Https,
            ),
            (
                "https://gitlab.com/group/sub/project",
                "gitlab.com/group/sub/project",
                Transport::Https,
            ),
            (
                "https://bitbucket.org/team/docs.git/",
                "bitbucket.org/team/docs",
                Transport::Https,
            ),
            (
                "https://git.example.com:8443/team/docs.git",
                "git.example.com:8443/team/docs",
                Transport::Https,
            ),
            (
                "ssh://git@git.example.com:2222/team/docs.git",
                "git.example.com/team/docs",
                Transport::Ssh,
            ),
            (
                "git@gitlab.com:group/sub/project.git",
                "gitlab.com/group/sub/project",
                Transport::Ssh,
            ),
            (
                "git@github.com:team/docs.git",
                "github.com/team/docs",
                Transport::Ssh,
            ),
        ] {
            let url = parse(value).unwrap_or_else(|| panic!("{value} should parse"));
            assert_eq!(url.display_name(), name);
            assert_eq!(url.transport(), transport);
        }
    }

    #[test]
    fn unsafe_or_ambiguous_urls_are_rejected() {
        for value in [
            "",
            "team/project",
            "http://git.example.com/team/docs.git",
            "https://bot:secret@git.example.com/team/docs.git",
            "https://git.example.com",
            "https://git.example.com/team/docs.git?x=1",
            "https://git.example.com/team/../docs.git",
            "https://git.example.com/team/%2E%2E/docs.git",
            "ssh://git@git.example.com/./docs.git",
            "file:///srv/docs.git",
            "ext::sh -c touch% /tmp/pwned",
            "-uhttps://git.example.com/docs.git",
            "git@-oProxyCommand=x:docs.git",
            "-oProxyCommand=x@host:docs.git",
            "-u@host:docs.git",
            "git@host:-docs.git",
            "/srv/docs.git",
            "C:\\docs",
            "https://git.example.com/team/docs .git",
        ] {
            assert!(parse(value).is_none(), "{value:?} should be rejected");
        }
        assert!(GitUrl::parse("file:///srv/docs.git", true).is_ok());
    }

    #[test]
    fn an_https_username_leaves_the_fetch_url() {
        let url = parse("https://reader@bitbucket.org/team/docs.git").unwrap();
        assert_eq!(url.username(), Some("reader"));
        assert_eq!(url.fetch_url(), "https://bitbucket.org/team/docs.git");
        assert_eq!(url.origin().as_deref(), Some("https://bitbucket.org/"));
        let ported = parse("https://Git.Example.com:8443/team/docs.git").unwrap();
        assert_eq!(
            ported.origin().as_deref(),
            Some("https://git.example.com:8443/")
        );
        assert_eq!(parse("git@host:team/docs.git").unwrap().origin(), None);
        assert_eq!(url.as_str(), "https://reader@bitbucket.org/team/docs.git");
    }

    #[test]
    fn branches_follow_git_naming_rules() {
        for good in ["main", "release/2026", "docs-v2", "feature_x"] {
            assert_eq!(branch(good).unwrap(), good);
        }
        for bad in [
            "", "-main", "a..b", "a b", "x~1", "x^", "a:b", "x.lock", "a//b", "@", "x@{1}", "/x",
            "x/", ".x", "a/.b",
        ] {
            assert!(branch(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn folders_stay_inside_the_repository() {
        assert_eq!(folder("").unwrap(), "");
        assert_eq!(folder("/").unwrap(), "");
        assert_eq!(folder(".").unwrap(), "");
        assert_eq!(folder("/docs/guides/").unwrap(), "docs/guides");
        for bad in [
            "../docs",
            "docs/../x",
            "docs/.git",
            ".GIT",
            "a//b",
            "a\\b",
            "docs/./x",
        ] {
            assert!(folder(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn tokens_are_single_header_safe_lines() {
        assert_eq!(token(" glpat-abc_123 ").unwrap(), "glpat-abc_123");
        for bad in ["", "two words", "line\nbreak", "tab\there", "café"] {
            assert!(token(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
