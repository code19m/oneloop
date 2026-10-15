//! Page sizes and the opaque cursors that continue a page: JSON in URL-safe
//! base64, so a client can only hand one back.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{AppError, AppResult};

/// The page a client asks for: where to continue, and how many items.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

/// The requested page size, or `default`, kept between 1 and `max`.
pub(crate) fn page_limit(limit: Option<usize>, default: usize, max: usize) -> usize {
    limit.unwrap_or(default).clamp(1, max)
}

pub(crate) fn encode<T: Serialize>(cursor: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).unwrap_or_default())
}

pub(crate) fn decode<T: DeserializeOwned>(cursor: &str) -> AppResult<T> {
    let invalid = || AppError::validation("cursor", "is invalid");
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

/// The place after an item in a list ordered by time, then ID.
#[derive(Serialize, Deserialize)]
pub(crate) struct TimeCursor {
    pub(crate) time: i64,
    pub(crate) id: String,
}

/// Cuts a page that was read with one item too many back to `limit` items,
/// and returns the cursor of the next page when that extra item was there.
/// `key` gives an item's time and ID.
pub(crate) fn next_cursor<T>(
    items: &mut Vec<T>,
    limit: usize,
    key: impl Fn(&T) -> (i64, &String),
) -> Option<String> {
    let more = items.len() > limit;
    items.truncate(limit);
    items.last().filter(|_| more).map(|item| {
        let (time, id) = key(item);
        encode(&TimeCursor {
            time,
            id: id.clone(),
        })
    })
}
