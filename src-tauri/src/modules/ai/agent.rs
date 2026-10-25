//! Agent surface — AI: `/ai`, `/summarize`, `voice` action buttons.
//!
//! Moved verbatim from `telegram/module_cmds.rs` / `telegram/tools/stash.rs`
//! (see `docs/agent-surface-refactor.md`). Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(SummarizeCmd::new(Arc::clone(tg)));
    tg.register_command(AiCmd::new(Arc::clone(tg)));
    tg.register_command(VoiceActionCmd::new(Arc::clone(tg)));
}

// -------------------- /summarize --------------------

/// `/summarize [N]` — collect the last N inbox items (text body,
/// voice transcript, photo/video caption) and ask the assistant for a
/// single-paragraph recap with emojis. N defaults to 10 and is capped
/// at 50 so one command can't consume a whole context window.
pub struct SummarizeCmd {
    state: Arc<TelegramState>,
}

impl SummarizeCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for SummarizeCmd {
    fn name(&self) -> &'static str {
        "summarize"
    }
    fn description(&self) -> &'static str {
        "Підсумок останніх N повідомлень в інбоксі (N=10 за замовчуванням)"
    }
    fn usage(&self) -> &'static str {
        "/summarize [N]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let n = args.trim().parse::<usize>().unwrap_or(10).clamp(1, 50);
        let items = match self.state.repo.lock() {
            Ok(repo) => match repo.list_inbox(n) {
                Ok(list) => list,
                Err(e) => return Reply::text(format!("⚠️ {e}")),
            },
            Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
        };
        if items.is_empty() {
            return Reply::text("📭 В інбоксі нічого немає.");
        }
        let mut prompt = String::from(
            "Summarise the following recent Telegram-inbox items into one short \
             paragraph, in the same language as the majority of entries. \
             Use one or two emojis to group themes (📝 notes, 🎤 voice, 📷 photo, \
             📎 file). Skip meta-statements, just deliver the content.\n\n",
        );
        for (i, it) in items.iter().enumerate() {
            let content = it
                .text_content
                .as_deref()
                .or(it.transcript.as_deref())
                .or(it.caption.as_deref())
                .unwrap_or("[no text]");
            prompt.push_str(&format!("{}. [{}] {}\n", i + 1, it.kind, content));
        }
        match crate::modules::telegram::assistant::handle_user_text(&ctx.app, &self.state, &prompt).await {
            Ok(reply) => {
                let body = reply.text.trim();
                if body.is_empty() {
                    Reply::text("🤷 Нема на що відповісти — AI нічого не повернув.")
                } else {
                    Reply::text(format!("🗒 {body}"))
                }
            }
            Err(e) => Reply::text(format!("⚠️ AI: {e}")),
        }
    }
}

// -------------------- /ai --------------------

/// `/ai <prompt>` — free-text turn against the assistant. Primary entry
/// point for the CLI (`stash ai "…"`) and any non-Telegram transport that
/// needs the LLM + tool-loop. Telegram's dispatcher already routes bare
/// text through `handle_user_text`, but exposing it as a slash command
/// means the CLI's thin slash-dispatcher can reach the assistant without
/// a parallel code path.
pub struct AiCmd {
    state: Arc<TelegramState>,
}

impl AiCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for AiCmd {
    fn name(&self) -> &'static str {
        "ai"
    }
    fn description(&self) -> &'static str {
        "Запит до AI-асистента (з повним доступом до tools і slash-команд)."
    }
    fn usage(&self) -> &'static str {
        "/ai <запит>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let prompt = args.trim();
        if prompt.is_empty() {
            return Reply::text("✍️ Використання: /ai <запит>");
        }
        match crate::modules::telegram::assistant::handle_user_text(&ctx.app, &self.state, prompt).await {
            Ok(reply) => {
                let body = reply.text.trim();
                if body.is_empty() {
                    Reply::text("🤷 AI нічого не повернув.")
                } else if reply.truncated {
                    Reply::text(format!("{body}\n\n(обрізано через ліміт глибини)"))
                } else {
                    Reply::text(body.to_string())
                }
            }
            Err(e) => Reply::text(format!("⚠️ AI: {e}")),
        }
    }
}

// -------------------- voice action buttons --------------------

/// Helper used by the voice-transcript flow in `transport.rs` to build
/// the action keyboard that lands under each `📝 …` message. Each
/// button's callback_data points at the `voice` command below.
pub fn voice_action_keyboard(inbox_id: i64) -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![
            vec![
                InlineButton::new("🤖 Reply", format!("voice:reply:{inbox_id}")),
                InlineButton::new("📋 Summary", format!("voice:summary:{inbox_id}")),
            ],
            vec![
                InlineButton::new("🌐 EN", format!("voice:translate:{inbox_id}")),
                InlineButton::new("✏️ Improve", format!("voice:improve:{inbox_id}")),
            ],
        ],
    }
}

/// Inline-button handler for `voice:<action>:<inbox_id>`. Replaces the
/// old "auto-reply on every transcript" flow — the transcript itself
/// lands as plain text under the user's voice note, and any AI follow
/// -up is opt-in per message via the buttons we attach to it.
pub struct VoiceActionCmd {
    state: Arc<TelegramState>,
}

impl VoiceActionCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for VoiceActionCmd {
    fn name(&self) -> &'static str {
        "voice"
    }
    fn description(&self) -> &'static str {
        "Run an AI action over a recently-transcribed voice note"
    }
    fn usage(&self) -> &'static str {
        "(driven by the inline buttons under each transcript)"
    }

    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        // args = "<action>:<inbox_id>". Empty action is treated as a
        // no-op button (e.g. a ✕ "dismiss" we may add later) so the
        // user can tap to clear the keyboard without errors.
        let (action, id_str) = match args.split_once(':') {
            Some(p) => p,
            None => return Reply::text("⚠️ /voice: missing inbox id"),
        };
        let id: i64 = match id_str.parse() {
            Ok(n) => n,
            Err(_) => return Reply::text("⚠️ /voice: bad inbox id"),
        };

        let transcript = match self.state.repo.lock() {
            Ok(repo) => repo.inbox_transcript(id).unwrap_or(None),
            Err(e) => return Reply::text(format!("⚠️ /voice: {e}")),
        };
        let Some(transcript) = transcript.filter(|s| !s.trim().is_empty()) else {
            return Reply::text(
                "⚠️ Транскрипт уже видалено або порожній — спробуй надіслати голосове ще раз.",
            );
        };

        let prompt = match action {
            // "Reply" sends the transcript through the assistant as if
            // the user had typed it themselves — preserves history,
            // tool calls, the works.
            "reply" => transcript.clone(),
            "summary" => format!(
                "Підсумуй коротко українською (1-3 речення), без преамбули, лише суть:\n\n{transcript}"
            ),
            "translate" => format!(
                "Translate the following Ukrainian text to natural English. \
                 Reply with the translation only, no commentary:\n\n{transcript}"
            ),
            "improve" => format!(
                "Виправ граматику й стиль українською. Поверни лише виправлений текст:\n\n{transcript}"
            ),
            other => return Reply::text(format!("⚠️ /voice: unknown action `{other}`")),
        };

        match crate::modules::telegram::assistant::handle_user_text(&ctx.app, &self.state, &prompt).await {
            Ok(reply) => {
                let body = reply.text.trim();
                if body.is_empty() {
                    Reply::text("🤖 (нічого нового додати)")
                } else {
                    Reply::text(format!("🤖 {body}"))
                }
            }
            Err(e) => Reply::text(format!("🤖 ⚠️ не вдалося опрацювати: {e}")),
        }
    }
}

#[cfg(test)]
mod voice_action_tests {
    use super::*;

    #[test]
    fn keyboard_carries_inbox_id_in_every_callback() {
        let kb = voice_action_keyboard(42);
        let actions: Vec<&str> = kb
            .rows
            .iter()
            .flat_map(|r| r.iter().map(|b| b.callback_data.as_str()))
            .collect();
        assert!(actions.contains(&"voice:reply:42"));
        assert!(actions.contains(&"voice:summary:42"));
        assert!(actions.contains(&"voice:translate:42"));
        assert!(actions.contains(&"voice:improve:42"));
    }
}
