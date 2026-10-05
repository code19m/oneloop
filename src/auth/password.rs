use std::{io::Read, path::Path, sync::Arc};

use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};

use crate::error::{AppError, AppResult};

/// The shortest password anyone may choose. Settings can only raise it.
pub const MIN_PASSWORD_CHARACTERS: usize = 5;
/// The highest minimum a setting may ask for. A password this long fits the
/// size limit even in 4-byte characters.
pub const MAX_MIN_PASSWORD_CHARACTERS: usize = 1024;
// Preserve passwords that could fit the former 16 KiB sign-in request budget.
pub(crate) const MAX_PASSWORD_BYTES: usize = 16 * 1024;
/// The largest blocklist file oneloop loads.
pub const MAX_BLOCKLIST_BYTES: u64 = 16 * 1024 * 1024;

/// The rules for passwords that people choose: for new accounts, resets and
/// changes, in the browser and on the command line. Sign-in never applies
/// them, so stricter rules don't lock anyone out of an existing password.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswordPolicy {
    /// The fewest characters for anyone.
    pub min_length: usize,
    /// The fewest characters for an admin; never less than `min_length`.
    pub admin_min_length: usize,
    /// Passwords nobody may choose. With a list, a password equal to the
    /// username is refused too.
    pub blocklist: Option<Arc<Blocklist>>,
    /// How long a temporary password works for signing in, in seconds.
    pub temporary_lifetime_seconds: Option<i64>,
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self {
            min_length: MIN_PASSWORD_CHARACTERS,
            admin_min_length: MIN_PASSWORD_CHARACTERS,
            blocklist: None,
            temporary_lifetime_seconds: None,
        }
    }
}

impl PasswordPolicy {
    /// Checks a password that someone chooses for the account `username`.
    pub fn check(&self, password: &str, username: &str, is_admin: bool) -> AppResult<()> {
        validate_password_size(password)?;
        let minimum = if is_admin {
            self.admin_min_length.max(self.min_length)
        } else {
            self.min_length
        }
        .max(MIN_PASSWORD_CHARACTERS);
        if password.chars().take(minimum).count() < minimum {
            return Err(AppError::validation(
                "password",
                format!("Use at least {minimum} characters."),
            ));
        }
        if let Some(blocklist) = &self.blocklist {
            let lowered = password.to_lowercase();
            if lowered == username.to_lowercase() || blocklist.contains(&lowered) {
                return Err(AppError::validation(
                    "password",
                    "This password is too easy to guess. Choose another one.",
                ));
            }
        }
        Ok(())
    }

    /// A random temporary password, long enough for any account under this policy.
    pub fn temporary_password(&self) -> AppResult<String> {
        let characters = self.min_length.max(self.admin_min_length);
        // Base64url spells three bytes as four characters.
        crate::auth::token::random_token(32.max((3 * characters).div_ceil(4)))
    }

    /// Whether a temporary password set at `set_at` no longer works for signing in.
    pub fn temporary_password_expired(&self, set_at: i64, now: i64) -> bool {
        self.temporary_lifetime_seconds
            .is_some_and(|lifetime| now.saturating_sub(set_at) > lifetime)
    }
}

/// Common passwords, compared without letter case. They are kept sorted in
/// one string, which costs little more memory than the file itself.
#[derive(Debug, PartialEq, Eq)]
pub struct Blocklist {
    text: String,
    ends: Vec<u32>,
}

impl Blocklist {
    /// One password per line; empty lines are skipped.
    pub fn from_text(text: &str) -> Self {
        let lowered = text.to_lowercase();
        let mut lines = lowered
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        lines.sort_unstable();
        lines.dedup();
        let mut list = Self {
            text: String::with_capacity(lines.iter().map(|line| line.len()).sum()),
            ends: Vec::with_capacity(lines.len()),
        };
        for line in lines {
            list.text.push_str(line);
            list.ends
                .push(u32::try_from(list.text.len()).unwrap_or(u32::MAX));
        }
        list
    }

    /// Reads a list of at most `MAX_BLOCKLIST_BYTES`.
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(MAX_BLOCKLIST_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_BLOCKLIST_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the file is larger than 16 MiB",
            ));
        }
        Ok(Self::from_text(&String::from_utf8_lossy(&bytes)))
    }

    pub fn len(&self) -> usize {
        self.ends.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }

    fn entry(&self, index: usize) -> &str {
        let start = index
            .checked_sub(1)
            .map_or(0, |previous| self.ends[previous] as usize);
        &self.text[start..self.ends[index] as usize]
    }

    fn contains(&self, lowered: &str) -> bool {
        let (mut low, mut high) = (0, self.ends.len());
        while low < high {
            let middle = low + (high - low) / 2;
            match self.entry(middle).cmp(lowered) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return true,
            }
        }
        false
    }
}

fn argon2() -> AppResult<Argon2<'static>> {
    // OWASP's minimum Argon2id profile: 19 MiB, two passes, one lane.
    let params = Params::new(19 * 1024, 2, 1, None)
        .map_err(|error| AppError::Internal(format!("invalid password parameters: {error}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

pub(crate) fn validate_password_size(password: &str) -> AppResult<()> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::validation(
            "password",
            format!("Use at most {MAX_PASSWORD_BYTES} UTF-8 bytes."),
        ));
    }
    Ok(())
}

/// The rules every new password meets, whatever the settings.
pub fn validate_new_password(password: &str) -> AppResult<()> {
    PasswordPolicy::default().check(password, "", false)
}

pub fn hash_password(password: &str) -> AppResult<String> {
    validate_new_password(password)?;
    argon2()?
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::Internal(format!("password hashing failed: {error}")))
}

pub fn verify_password(password: &str, encoded: &str) -> AppResult<bool> {
    validate_password_size(password)?;
    let parsed = PasswordHash::new(encoded)
        .map_err(|error| AppError::Internal(format!("stored password hash is invalid: {error}")))?;
    Ok(argon2()?
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_salted_and_verify() {
        let first = hash_password("a long test password").unwrap();
        let second = hash_password("a long test password").unwrap();
        assert_ne!(first, second);
        assert!(verify_password("a long test password", &first).unwrap());
        assert!(!verify_password("wrong password", &first).unwrap());
        assert!(first.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
    }

    #[test]
    fn new_passwords_require_at_least_five_unicode_characters() {
        for password in ["", "1234", "😀😀😀😀"] {
            assert!(validate_new_password(password).is_err());
        }
        for password in ["12345", "aaaaa", "     ", "😀😀😀😀😀", "  a  "] {
            assert!(validate_new_password(password).is_ok());
        }
        let long = "x".repeat(8192);
        let hash = hash_password(&long).unwrap();
        assert!(verify_password(&long, &hash).unwrap());
    }

    fn strict() -> PasswordPolicy {
        PasswordPolicy {
            min_length: 8,
            admin_min_length: 12,
            blocklist: Some(Arc::new(Blocklist::from_text(
                "Password1\r\n\nletmein123\nLETMEIN123\n",
            ))),
            temporary_lifetime_seconds: Some(3600),
        }
    }

    #[test]
    fn stricter_rules_follow_the_role_and_refuse_listed_passwords() {
        let policy = strict();
        let refused = |password: &str, admin: bool| {
            policy
                .check(password, "robin.smith", admin)
                .unwrap_err()
                .client_details()
                .unwrap()["message"]
                .clone()
        };
        assert_eq!(refused("seven77", false), "Use at least 8 characters.");
        assert!(policy.check("eight888", "robin.smith", false).is_ok());
        assert_eq!(refused("eleven char", true), "Use at least 12 characters.");
        assert!(policy.check("twelve chars", "robin.smith", true).is_ok());
        for listed in ["PASSWORD1", "LetMeIn123", "Robin.Smith"] {
            assert_eq!(
                refused(listed, false),
                "This password is too easy to guess. Choose another one."
            );
        }
        assert!(validate_new_password("12345").is_ok(), "the defaults stay");
        let maximum = "😀".repeat(MAX_MIN_PASSWORD_CHARACTERS);
        let longest = PasswordPolicy {
            min_length: MAX_MIN_PASSWORD_CHARACTERS,
            admin_min_length: MAX_MIN_PASSWORD_CHARACTERS,
            ..PasswordPolicy::default()
        };
        assert!(longest.check(&maximum, "robin", true).is_ok());
        assert!(maximum.len() <= MAX_PASSWORD_BYTES);
    }

    #[test]
    fn temporary_passwords_meet_the_longest_minimum_and_expire() {
        assert_eq!(
            PasswordPolicy::default()
                .temporary_password()
                .unwrap()
                .len(),
            43
        );
        let policy = PasswordPolicy {
            min_length: 50,
            admin_min_length: 100,
            ..strict()
        };
        let temporary = policy.temporary_password().unwrap();
        assert!(temporary.len() >= 100, "{}", temporary.len());
        assert!(policy.check(&temporary, "robin", true).is_ok());
        assert!(!policy.temporary_password_expired(1_000, 4_600));
        assert!(policy.temporary_password_expired(1_000, 4_601));
        assert!(!PasswordPolicy::default().temporary_password_expired(0, i64::MAX));
    }

    #[test]
    fn a_blocklist_keeps_one_sorted_copy_without_letter_case() {
        let list = Blocklist::from_text("b\nA\r\n\na\nC\n");
        assert_eq!(list.len(), 3);
        for present in ["a", "b", "c"] {
            assert!(list.contains(present), "{present}");
        }
        for absent in ["", "A", "d", "ab"] {
            assert!(!list.contains(absent), "{absent}");
        }
        assert!(Blocklist::from_text("").is_empty());
    }

    #[test]
    fn existing_passwords_are_verified_without_reapplying_new_password_rules() {
        let legacy = "😀😀😀"; // Previously accepted as twelve UTF-8 bytes.
        let hash = argon2()
            .unwrap()
            .hash_password(legacy.as_bytes())
            .unwrap()
            .to_string();
        assert!(verify_password(legacy, &hash).unwrap());
        assert!(validate_new_password(legacy).is_err());
    }
}
