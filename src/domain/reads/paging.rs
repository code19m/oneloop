//! Page sizes and the opaque cursors that continue a page.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

use super::*;

pub(super) const PAGE_SIZE: usize = 50;

pub(super) fn task_page_generation(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> AppResult<i64> {
    Ok(connection.query_row(
        "SELECT generation FROM project_task_versions WHERE project_id=?1",
        [project_id],
        |r| r.get(0),
    )?)
}

pub(super) fn check_task_cursor(
    saved: i64,
    current: i64,
    saved_scope: &str,
    scope: &str,
) -> AppResult<()> {
    if saved_scope != scope {
        return Err(AppError::validation(
            "cursor",
            "cursor belongs to another collection",
        ));
    }
    if saved != current {
        return Err(AppError::rule(
            crate::error::RuleKind::CursorStale,
            "Tasks changed while paging; reload the collection from its first page",
        ));
    }
    Ok(())
}

pub(super) fn encode_cursor<T: Serialize>(value: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap_or_default())
}

pub(super) fn decode_cursor<T: for<'de> Deserialize<'de>>(value: &str) -> AppResult<T> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::validation("cursor", "invalid cursor"))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor", "invalid cursor"))
}

pub(super) fn page_limit(value: Option<usize>) -> usize {
    value.unwrap_or(PAGE_SIZE).clamp(1, PAGE_SIZE)
}
pub(super) fn parse_position_cursor(
    value: Option<&str>,
) -> AppResult<(Option<i64>, Option<String>)> {
    let Some(value) = value else {
        return Ok((None, None));
    };
    let Some((left, right)) = value.split_once(':') else {
        return Err(AppError::validation("cursor", "invalid cursor"));
    };
    let position = left
        .parse()
        .map_err(|_| AppError::validation("cursor", "invalid cursor"))?;
    if right.is_empty() {
        return Err(AppError::validation("cursor", "invalid cursor"));
    }
    Ok((Some(position), Some(right.into())))
}
