//! Memory tools — let the assistant persist and recall user facts.
//!
//! Three small tools wired to the `memory` SQLite table via
//! `TelegramRepo`. All take / return plain JSON matching design §7.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{Tool, ToolCtx};

pub struct RememberFact;

#[async_trait]
impl Tool for RememberFact {
    fn name(&self) -> &'static str {
        "remember_fact"
    }
    fn description(&self) -> &'static str {
        "Persist a single short fact about the user. Use only when the user \
         explicitly asks to remember something — never silently infer."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The fact to remember, in natural language."
                }
            },
            "required": ["text"],
            "additionalProperties": false,
        })
    }

    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: text".to_string())?;
        let id = {
            let mut repo = ctx.state.repo.lock().map_err(|e| e.to_string())?;
            repo.memory_insert(text, ctx.now_ms)
                .map_err(|e| e.to_string())?
        };
        Ok(json!({ "id": id }))
    }
}

pub struct ListFacts;

#[async_trait]
impl Tool for ListFacts {
    fn name(&self) -> &'static str {
        "list_facts"
    }
    fn description(&self) -> &'static str {
        "List every remembered fact, newest first, so the assistant can cite them."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        })
    }

    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let rows = {
            let repo = ctx.state.repo.lock().map_err(|e| e.to_string())?;
            repo.memory_list().map_err(|e| e.to_string())?
        };
        let facts: Vec<Value> = rows
            .into_iter()
            .map(|r| json!({ "id": r.id, "text": r.fact }))
            .collect();
        Ok(json!({ "facts": facts }))
    }

}

pub struct ForgetFact;

#[async_trait]
impl Tool for ForgetFact {
    fn name(&self) -> &'static str {
        "forget_fact"
    }
    fn description(&self) -> &'static str {
        "Delete a single remembered fact by its id."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "integer",
                    "description": "ID returned by remember_fact or list_facts."
                }
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
            repo.memory_delete(id).map_err(|e| e.to_string())?
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
            now_ms: 1,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remember_and_list_round_trip() {
        let ctx = ctx();
        let out = RememberFact
            .invoke(&ctx, json!({ "text": "loves tea" }))
            .await
            .unwrap();
        assert!(out.get("id").unwrap().as_i64().unwrap() > 0);

        let list = ListFacts.invoke(&ctx, json!({})).await.unwrap();
        let facts = list["facts"].as_array().unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0]["text"], "loves tea");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forget_removes_existing_and_reports_false_on_unknown() {
        let ctx = ctx();
        let rid = RememberFact
            .invoke(&ctx, json!({ "text": "x" }))
            .await
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let out = ForgetFact.invoke(&ctx, json!({ "id": rid })).await.unwrap();
        assert_eq!(out["ok"], true);
        let again = ForgetFact.invoke(&ctx, json!({ "id": rid })).await.unwrap();
        assert_eq!(again["ok"], false);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remember_rejects_missing_text() {
        let err = RememberFact
            .invoke(&ctx(), json!({}))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("text"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forget_rejects_missing_id() {
        let err = ForgetFact
            .invoke(&ctx(), json!({}))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("id"));
    }
}
