//! Read-time compatibility for immutable pre-publication payloads. Never apply
//! this to incoming requests or rewrite stored audit/outbox/receipt data.
use serde_json::Value;

pub(crate) fn status(value: Value) -> Value {
    if value.as_str() == Some("planned") {
        Value::String("planning".into())
    } else {
        value
    }
}

pub(crate) fn payload(mut value: Value) -> Value {
    match &mut value {
        Value::Array(items) => {
            for item in items {
                *item = payload(item.take());
            }
        }
        Value::Object(object) => {
            let status_field = object
                .get("fieldKey")
                .and_then(Value::as_str)
                .is_some_and(|field| matches!(field, "status" | "state"));
            for (key, item) in object {
                if matches!(key.as_str(), "status" | "state")
                    || (status_field && matches!(key.as_str(), "before" | "after"))
                {
                    *item = status(item.take());
                } else {
                    *item = payload(item.take());
                }
            }
        }
        _ => {}
    }
    value
}

pub(crate) fn activity(value: Option<Value>, field: Option<&str>) -> Option<Value> {
    value.map(|value| {
        if matches!(field, Some("status" | "state")) {
            status(value)
        } else {
            payload(value)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_notifications_outbox_and_receipts_translate_only_status_fields() {
        let stored = json!({"task":{"status":"planned","title":"planned"},
            "epic":{"state":"planned"}, "notification":{"task":{"status":"planned"}},
            "fieldKey":"status","before":"planned","after":"done",
            "comment":"planned","items":[{"status":"planned"}]});
        let read = payload(stored.clone());
        assert_eq!(read["task"]["status"], "planning");
        assert_eq!(read["epic"]["state"], "planning");
        assert_eq!(read["notification"]["task"]["status"], "planning");
        assert_eq!(read["before"], "planning");
        assert_eq!(read["items"][0]["status"], "planning");
        assert_eq!(read["task"]["title"], "planned");
        assert_eq!(read["comment"], "planned");
        assert_eq!(stored["task"]["status"], "planned");
        assert_eq!(
            activity(Some(json!("planned")), Some("state")),
            Some(json!("planning"))
        );
        assert_eq!(
            activity(Some(json!("planned")), Some("title")),
            Some(json!("planned"))
        );
        assert!(serde_json::from_value::<crate::domain::TaskStatus>(json!("planned")).is_err());
    }
}
