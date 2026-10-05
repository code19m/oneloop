use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationCommand {
    pub operation: String,
    #[serde(default)]
    pub payload: Value,
    pub idempotency_key: String,
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationCommandResult {
    pub entities: Vec<Value>,
    pub events: Vec<ActivityEvent>,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MentionKind {
    User,
    Everyone,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MentionToken {
    pub kind: MentionKind,
    #[serde(default)]
    pub user_id: Option<String>,
    pub start_offset: usize,
    pub end_offset: usize,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentCreate {
    pub task_id: String,
    pub content: String,
    #[serde(default)]
    pub reply_to_id: Option<String>,
    #[serde(default)]
    pub mentions: Vec<MentionToken>,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentEdit {
    pub comment_id: String,
    pub content: String,
    #[serde(default)]
    pub mentions: Vec<MentionToken>,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentDelete {
    pub comment_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentRestore {
    pub comment_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentView {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub author_id: String,
    pub author_name: String,
    pub root_id: String,
    pub reply_to_id: Option<String>,
    pub content: Option<String>,
    pub mentions: Vec<MentionToken>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPage {
    pub items: Vec<CommentView>,
    /// Roots and exact reply targets outside this page; these do not advance its cursor.
    pub context: Vec<CommentView>,
    pub reply_counts: BTreeMap<String, i64>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub id: String,
    pub project_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub task_id: Option<String>,
    pub actor_user_id: Option<String>,
    pub actor_name: Option<String>,
    #[serde(default)]
    pub actor_mcp_grant_id: Option<String>,
    #[serde(default)]
    pub actor_app_name: Option<String>,
    pub event_type: String,
    pub field_key: Option<String>,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub metadata: Value,
    pub entity_revision: Option<i64>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub items: Vec<ActivityEvent>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxFilter {
    #[serde(default)]
    pub project_ids: BTreeSet<String>,
    #[serde(default)]
    pub unread_only: bool,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub event_type: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub task_id: Option<String>,
    pub task_key: Option<String>,
    pub task_title: Option<String>,
    pub comment_id: Option<String>,
    pub block_id: Option<String>,
    pub actor_name: Option<String>,
    pub actor_user_id: Option<String>,
    pub excerpt: Option<String>,
    pub destination_available: bool,
    pub read_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub items: Vec<InboxItem>,
    pub next_cursor: Option<String>,
    pub unread_count: u64,
    pub filtered_count: u64,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxItemCommand {
    pub notification_id: String,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxBulkCommand {
    #[serde(default)]
    pub filter: InboxFilter,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SseHint {
    pub id: String,
    pub kind: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub entity_revision: Option<i64>,
    pub notification_id: Option<String>,
    #[serde(skip)]
    pub recipient_ids: BTreeSet<String>,
}
