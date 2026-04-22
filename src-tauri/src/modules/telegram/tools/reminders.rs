//! Reminder tools — create / list / cancel.
//!
//! Reuse the Phase-4 `parse_when` parser so the assistant and the
//! `/remind` slash command understand the same time syntax — single
//! source of truth for what "tomorrow 9:00" means.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{Tool, ToolCtx};

pub struct CreateReminder;

#[async_trait]
impl Tool for CreateReminder {
    fn name(&self) -> &'static str {
        "create_reminder"
    }
    fn description(&self) -> &'static str {
        "Schedule a reminder. `when` follows the same syntax as the /remind \
         slash command: `10m`, `1h30m`, `14:30`, `tomorrow 9:00`, or \
         `YYYY-MM-DD HH:MM`. Returns the reminder id + due_at unix seconds."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Body of the reminder shown to the user when it fires."
                },
                "when": {
                    "type": "string",
                    "description": "Natural-language time string (10m, 14:30, tomorrow 9:00, YYYY-MM-DD HH:MM)."
                }
            },
            "required": ["text", "when"],
            "additionalProperties": false,
        })
    }

    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: text".to_string())?
            .trim();
        let when = args
            .get("when")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: when".to_string())?
            .trim();
        if text.is_empty() {
            return Err("text must not be empty".into());
        }

        // parse_when expects "<when> <text>". We carry the text
        // separately so the LLM doesn't have to jam it all into one
        // string — reconstruct the combined form for the parser.
        let combined = format!("{when} {text}");
        let now_sec = ctx.now_ms / 1000;
        let (due_at, parsed_text) = super::super::reminders::parse_when(&combined, now_sec)
            .ok_or_else(|| {
                format!("could not parse `when`: '{when}'. Try '10m', 'tomorrow 9:00', or 'YYYY-MM-DD HH:MM'.")
            })?;

        let id = {
            let mut repo = ctx.state.repo.lock().map_err(|e| e.to_string())?;
            repo.insert_reminder(&parsed_text, due_at, now_sec)
                .map_err(|e| e.to_string())?
        };
        Ok(json!({ "id": id, "due_at": due_at, "text": parsed_text }))
    }
}

pub struct ListReminders;

#[async_trait]
impl Tool for ListReminders {
    fn name(&self) -> &'static str {
        "list_reminders"
    }
    fn description(&self) -> &'static str {
        "List the active (unfired, uncancelled) reminders with their ids + due times."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let rows = {
            let repo = ctx.state.repo.lock().map_err(|e| e.to_string())?;
            repo.list_active_reminders().map_err(|e| e.to_string())?
        };
        let items: Vec<Value> = rows
            .into_iter()
            .map(|r| json!({ "id": r.id, "text": r.text, "due_at": r.due_at }))
            .collect();
        Ok(json!({ "reminders": items }))
    }
}

pub struct CancelReminder;

#[async_trait]
impl Tool for CancelReminder {
    fn name(&self) -> &'static str {
        "cancel_reminder"
    }
    fn description(&self) -> &'static str {
        "Cancel a still-active reminder by its id. Returns {ok:false} if the id is unknown or already fired."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer" }
            },
            "required": ["id"],
            "additionalProperties": false,
        })
    }

    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "missing required field: id (integer)".to_string())?;
        let removed = {
            let mut repo = ctx.state.repo.lock().map_err(|e| e.to_string())?;
            repo.cancel_reminder(id).map_err(|e| e.to_string())?
        };
        Ok(json!({ "ok": removed }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;
    use crate::modules::telegram::repo::TelegramRepo;
    use crate::modules::telegram::state::TelegramState;
    use rusqlite::Connection;
    use std::sync::Arc;

    fn ctx() -> ToolCtx {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn crate::modules::telegram::keyring::SecretStore> =
            Arc::new(MemStore::new());
        ToolCtx {
            state: Arc::new(TelegramState::new(repo, secrets)),
            app: None,
            // 2026-04-22 12:00 UTC in epoch ms — a stable "now" so
            // relative offsets land on a predictable wall-clock.
            now_ms: 1_776_672_000_000,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn create_then_list_includes_the_row() {
        let ctx = ctx();
        let out = CreateReminder
            .invoke(&ctx, json!({ "text": "tea", "when": "10m" }))
            .await
            .unwrap();
        assert!(out["id"].as_i64().unwrap() > 0);
        let list = ListReminders.invoke(&ctx, json!({})).await.unwrap();
        let items = list["reminders"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], "tea");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn create_rejects_unparseable_when() {
        let err = CreateReminder
            .invoke(&ctx(), json!({ "text": "x", "when": "whenever" }))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("parse"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn create_rejects_empty_text() {
        let err = CreateReminder
            .invoke(&ctx(), json!({ "text": "", "when": "10m" }))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancel_marks_row_inactive_and_reports_bool() {
        let ctx = ctx();
        let id = CreateReminder
            .invoke(&ctx, json!({ "text": "t", "when": "30m" }))
            .await
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let out = CancelReminder
            .invoke(&ctx, json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        // Second attempt is a no-op.
        let again = CancelReminder
            .invoke(&ctx, json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(again["ok"], false);
        let list = ListReminders.invoke(&ctx, json!({})).await.unwrap();
        assert_eq!(list["reminders"].as_array().unwrap().len(), 0);
    }
}
