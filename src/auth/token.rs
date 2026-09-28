use crate::{AppError, AppResult};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

pub(crate) fn random_token(bytes: usize) -> AppResult<String> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|e| AppError::internal(format!("secure random generator failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

pub fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
