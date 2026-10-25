//! Agent surface — Telegram send: `/send` + `send_telegram`.
//!
//! Moved verbatim from `telegram/module_cmds.rs` / `telegram/tools/stash.rs`
//! (see `docs/agent-surface-refactor.md`). Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::modules::telegram::commands_registry::{CommandHandler, Ctx, Reply};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(SendCmd::new(Arc::clone(tg)));
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(SendTelegram);
}

// -------------------- /send --------------------

/// `/send <text>` — push the text verbatim into the paired chat.
/// From the CLI (`stash send "…"`) this is how scripts / Claude Code
/// deliver a notification to the user's phone.
pub struct SendCmd {
    state: Arc<TelegramState>,
}

impl SendCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for SendCmd {
    fn name(&self) -> &'static str {
        "send"
    }
    fn description(&self) -> &'static str {
        "Надіслати текст у спарений Telegram-чат"
    }
    fn usage(&self) -> &'static str {
        "/send <текст>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        if args.trim().is_empty() {
            return Reply::text("✍️ Використання: /send <текст>");
        }
        if self.state.send_to_paired(args) {
            Reply::text("📨 Надіслано в Telegram.")
        } else {
            Reply::text("⚠️ Telegram не спарено — відкрий Settings → Telegram.")
        }
    }
}

// ---- Telegram ----

pub struct SendTelegram;

#[async_trait]
impl Tool for SendTelegram {
    fn name(&self) -> &'static str {
        "send_telegram"
    }
    fn description(&self) -> &'static str {
        "Push a text message to the user's phone via their paired Telegram \
         chat. Use when the user asks to be notified / messaged in Telegram, \
         or when the request comes from the CLI and the user wants the \
         result on their phone. The text is sent verbatim. Returns \
         {sent:false, reason:'not_paired'} if Telegram isn't set up."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Message text to send, as-is."
                }
            },
            "required": ["text"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: text".to_string())?;
        if text.trim().is_empty() {
            return Err("text must not be empty".to_string());
        }
        Ok(if ctx.state.send_to_paired(text) {
            json!({ "sent": true })
        } else {
            json!({ "sent": false, "reason": "not_paired" })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;

    #[tokio::test(flavor = "current_thread")]
    async fn send_telegram_rejects_empty_and_reports_unpaired() {
        let c = ctx();
        assert!(SendTelegram.invoke(&c, json!({ "text": "  " })).await.is_err());
        let out = SendTelegram.invoke(&c, json!({ "text": "hi" })).await.unwrap();
        assert_eq!(out, json!({ "sent": false, "reason": "not_paired" }));
    }
}
