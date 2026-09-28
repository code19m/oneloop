use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};

use crate::error::{AppError, AppResult};

const MIN_PASSWORD_CHARACTERS: usize = 5;

fn argon2() -> AppResult<Argon2<'static>> {
    // OWASP's minimum Argon2id profile: 19 MiB, two passes, one lane.
    let params = Params::new(19 * 1024, 2, 1, None)
        .map_err(|error| AppError::Internal(format!("invalid password parameters: {error}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

pub fn validate_new_password(password: &str) -> AppResult<()> {
    if password.chars().take(MIN_PASSWORD_CHARACTERS).count() < MIN_PASSWORD_CHARACTERS {
        return Err(AppError::validation(
            "password",
            format!("Use at least {MIN_PASSWORD_CHARACTERS} characters."),
        ));
    }
    Ok(())
}

pub fn hash_password(password: &str) -> AppResult<String> {
    validate_new_password(password)?;
    argon2()?
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::Internal(format!("password hashing failed: {error}")))
}

pub fn verify_password(password: &str, encoded: &str) -> AppResult<bool> {
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
    fn new_passwords_only_require_five_unicode_characters() {
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
