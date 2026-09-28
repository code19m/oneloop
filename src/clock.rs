use crate::{AppError, AppResult};

pub fn unix_now() -> AppResult<i64> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| AppError::internal(format!("system clock is before Unix epoch: {error}")))?
        .as_secs();
    i64::try_from(seconds).map_err(|_| AppError::internal("system timestamp exceeds i64"))
}
