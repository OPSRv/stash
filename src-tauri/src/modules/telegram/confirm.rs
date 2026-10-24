//! Confirmation gate for destructive actions requested by the LLM.
//!
//! When the assistant asks to run something irreversible (`/shutdown`,
//! `/app quit …`, `clipboard_clear`, …) we don't execute it. Instead we
//! park the action in an in-memory store under a short id and send the
//! paired chat a card with `✅ / ✖` buttons. Tapping a button dispatches
//! `refresh:confirm:<id>` (or `refresh:confirm:x<id>`), so the card is
//! edited in place into the action's result.
//!
//! User-typed slash commands never pass through here — the user typed
//! them on purpose. Only `invoke_command` and tool calls from the LLM
//! are gated (see `tools::ToolRegistry::invoke`), plus MCP calls from the
//! assistant's own `claude -p` run (tagged via `MCP_ORIGIN_ENV`, gated in
//! `ipc::server::dispatch`). A human running `stash shutdown` is not gated.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::commands_registry::{CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply};
use super::pairing::PairingState;
use super::state::TelegramState;
use super::tools::{Tool, ToolCtx};

/// Pending actions older than this are dropped; tapping their button
/// replies "⌛ Запит застарів".
pub const PENDING_TTL_MS: i64 = 5 * 60 * 1000;

/// Upper bound on parked actions — a runaway model can't grow the store
/// without limit. Oldest entries are evicted first.
const MAX_PENDING: usize = 16;

/// Command names that are destructive regardless of the handler's own
/// `CommandHandler::dangerous` answer. Kept central so module handlers
/// don't each need an override; `app` is arg-dependent (see below).
const DANGEROUS_COMMANDS: &[&str] = &["shutdown", "sleep", "update"];

/// Tool names that always need confirmation when the LLM calls them
/// directly. Arg-dependent tools (`control_download` delete) are handled
/// in `tool_needs_confirmation`.
pub const DANGEROUS_TOOLS: &[&str] = &[
    "clipboard_clear",
    "clipboard_delete",
    "npm_run_script",
    "delete_note",
    "update_note",
];

/// Env var the assistant's `claude -p` run sets for the `stash mcp`
/// server it spawns. The MCP server forwards it as `Request::origin`,
/// so the IPC dispatcher can gate destructive commands requested by the
/// model while the user's own `stash shutdown` stays ungated. Must match
/// `MCP_ORIGIN_ENV` in `crates/stash-cli/src/mcp.rs`.
pub const MCP_ORIGIN_ENV: &str = "STASH_MCP_ORIGIN";
/// Value of `MCP_ORIGIN_ENV` / `Request::origin` for assistant runs.
pub const ASSISTANT_ORIGIN: &str = "assistant";

/// What runs once the user taps ✅.
pub enum PendingAction {
    Command { name: String, args: String },
    Tool { tool: Arc<dyn Tool>, args: Value },
}

pub struct Pending {
    pub id: String,
    pub action: PendingAction,
    pub created_at_ms: i64,
}

/// In-memory id → action map. A `Vec` is plenty for ≤16 entries and
/// keeps the static const-constructible.
#[derive(Default)]
pub struct PendingStore {
    items: Vec<Pending>,
    counter: u32,
}

impl PendingStore {
    pub const fn new() -> Self {
        Self {
            items: Vec::new(),
            counter: 0,
        }
    }

    /// Park `action` and return its short id (≤8 chars, so
    /// `refresh:confirm:x<id>` stays far below Telegram's 64-byte cap).
    pub fn insert(&mut self, action: PendingAction, now_ms: i64) -> String {
        self.prune(now_ms);
        while self.items.len() >= MAX_PENDING {
            self.items.remove(0);
        }
        self.counter = self.counter.wrapping_add(1);
        let id = loop {
            let candidate = short_id(now_ms, self.counter);
            if !self.items.iter().any(|p| p.id == candidate) {
                break candidate;
            }
            self.counter = self.counter.wrapping_add(1);
        };
        self.items.push(Pending {
            id: id.clone(),
            action,
            created_at_ms: now_ms,
        });
        id
    }

    /// Remove and return the action for `id` if it exists and hasn't
    /// expired. One-shot: a second tap on the same button finds nothing.
    pub fn take(&mut self, id: &str, now_ms: i64) -> Option<PendingAction> {
        self.prune(now_ms);
        let idx = self.items.iter().position(|p| p.id == id)?;
        Some(self.items.remove(idx).action)
    }

    fn prune(&mut self, now_ms: i64) {
        self.items
            .retain(|p| now_ms.saturating_sub(p.created_at_ms) < PENDING_TTL_MS);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.items.len()
    }
}

/// Mix wall-clock and a counter into 8 hex chars. Not a secret — only
/// the paired user can press buttons — just unique and short.
fn short_id(now_ms: i64, counter: u32) -> String {
    let mixed = (now_ms as u64)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .rotate_left(17)
        ^ (counter as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    format!("{:08x}", (mixed ^ (mixed >> 32)) as u32)
}

static PENDING: Mutex<PendingStore> = Mutex::new(PendingStore::new());

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Name-based danger check for slash-commands. Arg-aware: read-only
/// sub-commands (`/shutdown status`, `/update check`) pass through.
pub fn builtin_dangerous(name: &str, args: &str) -> bool {
    let first = args
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match name {
        "shutdown" | "sleep" => !matches!(
            first.as_str(),
            "status" | "cancel" | "off" | "stop" | "abort"
        ),
        "update" => first != "check",
        "app" => matches!(
            first.as_str(),
            "quit" | "close" | "exit" | "kill" | "force-quit"
        ),
        _ => DANGEROUS_COMMANDS.contains(&name),
    }
}

/// Full check used by `invoke_command`: central list OR the handler's
/// own opt-in.
pub fn command_needs_confirmation(handler: &dyn CommandHandler, args: &str) -> bool {
    builtin_dangerous(handler.name(), args) || handler.dangerous(args)
}

/// Tool-call danger check. Name-based via `DANGEROUS_TOOLS`, plus
/// arg-dependent rules for tools that are only destructive in some modes.
pub fn tool_needs_confirmation(name: &str, args: &Value) -> bool {
    if DANGEROUS_TOOLS.contains(&name) {
        return true;
    }
    match name {
        // Delete drops the history row (and with `purge_file` the file).
        "control_download" => args
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|a| a.trim().eq_ignore_ascii_case("delete")),
        _ => false,
    }
}

/// Park `action` and send the confirmation card to the paired chat.
/// Returns the JSON the LLM sees as the tool result.
pub fn request(state: &TelegramState, action: PendingAction, description: &str) -> Value {
    let chat_id = match state.pairing.lock().as_deref() {
        Ok(PairingState::Paired { chat_id }) => *chat_id,
        _ => {
            return serde_json::json!({
                "status": "confirmation_unavailable",
                "message": "This action is destructive and needs confirmation via a Telegram \
                            button, but Telegram is not paired. Do not retry; tell the user \
                            to run the slash-command themselves."
            });
        }
    };
    let id = PENDING.lock().unwrap().insert(action, now_ms());
    state.sender.enqueue_with_keyboard(
        chat_id,
        card_text(description),
        Some(confirm_keyboard(&id)),
    );
    serde_json::json!({
        "status": "awaiting_confirmation",
        "message": "A confirmation card with buttons was sent to the user. The action runs only \
                    after they tap ✅. Do not retry or call it again; just tell the user to \
                    confirm with the button."
    })
}

/// Card body. The description carries model-supplied args, and the
/// sender renders Markdown → HTML, so it goes inside a fenced code
/// block: the model can't bold/link/hide parts of what is being
/// confirmed. Backticks are swapped for a look-alike so the fence
/// can't be closed early.
pub fn card_text(description: &str) -> String {
    let safe = description.replace('`', "ˋ");
    format!("⚠️ Підтвердь дію:\n```\n{safe}\n```\nЗапит дійсний 5 хв.")
}

pub fn confirm_keyboard(id: &str) -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("✅ Так, виконати", format!("refresh:confirm:{id}")),
            InlineButton::new("✖ Скасувати", format!("refresh:confirm:x{id}")),
        ]],
    }
}

/// Human-readable one-liner for the card.
pub fn describe_command(name: &str, args: &str) -> String {
    let args = args.trim();
    if args.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {args}")
    }
}

pub fn describe_tool(name: &str, args: &Value) -> String {
    let human = match name {
        "delete_note" => Some("Видалити нотатку"),
        "update_note" => Some("Перезаписати нотатку"),
        "clipboard_delete" => Some("Видалити запис з історії буфера"),
        "clipboard_clear" => Some("Очистити історію буфера обміну"),
        "npm_run_script" => Some("Запустити npm-скрипт"),
        "control_download" => Some(
            if args.get("purge_file").and_then(Value::as_bool) == Some(true) {
                "Видалити завантаження разом із файлом"
            } else {
                "Видалити завантаження з історії"
            },
        ),
        _ => None,
    };
    let raw = match args.as_object() {
        Some(m) if !m.is_empty() => format!(
            "{name} {}",
            super::format::truncate_chars(&args.to_string(), 300)
        ),
        _ => name.to_string(),
    };
    match human {
        Some(h) => format!("{h}\n{raw}"),
        None => raw,
    }
}

/// Upper bound for running a confirmed tool — matches the generous
/// `invoke_command` budget since the user is waiting on the card.
const CONFIRMED_TOOL_TIMEOUT: Duration = Duration::from_secs(30);

/// `/confirm <id>` / `/confirm x<id>` — hidden command behind the
/// confirmation card buttons.
pub struct ConfirmCmd {
    state: Arc<TelegramState>,
}

impl ConfirmCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ConfirmCmd {
    fn name(&self) -> &'static str {
        "confirm"
    }
    fn description(&self) -> &'static str {
        "Підтвердити або скасувати дію, яку запросив AI (кнопки картки)."
    }
    fn usage(&self) -> &'static str {
        "/confirm <id>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let raw = args.trim();
        let (cancel, id) = match raw.strip_prefix('x') {
            Some(rest) => (true, rest),
            None => (false, raw),
        };
        let Some(action) = PENDING.lock().unwrap().take(id, now_ms()) else {
            return Reply::text("⌛ Запит застарів");
        };
        if cancel {
            return Reply::text("✖ Скасовано.");
        }
        match action {
            PendingAction::Command { name, args } => match self.state.find_command(&name) {
                Some(handler) => {
                    let mut reply = handler.handle(ctx, &args).await;
                    reply.text = format!("✅ {}\n\n{}", describe_command(&name, &args), reply.text);
                    reply
                }
                None => Reply::text(format!("⚠️ Команда /{name} більше не доступна.")),
            },
            PendingAction::Tool { tool, args } => {
                let tctx = ToolCtx {
                    state: Arc::clone(&self.state),
                    app: Some(ctx.app),
                    now_ms: now_ms(),
                };
                let name = tool.name();
                match tokio::time::timeout(CONFIRMED_TOOL_TIMEOUT, tool.invoke(&tctx, args)).await
                {
                    Ok(Ok(v)) => Reply::text(format!("✅ {name}: {v}")),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {name}: {e}")),
                    Err(_) => Reply::text(format!("⚠️ {name}: timeout")),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(name: &str) -> PendingAction {
        PendingAction::Command {
            name: name.into(),
            args: String::new(),
        }
    }

    #[test]
    fn insert_then_take_returns_action_once() {
        let mut s = PendingStore::new();
        let id = s.insert(cmd("shutdown"), 1_000);
        assert!(id.len() <= 8);
        match s.take(&id, 2_000) {
            Some(PendingAction::Command { name, .. }) => assert_eq!(name, "shutdown"),
            _ => panic!("expected pending command"),
        }
        assert!(s.take(&id, 2_000).is_none(), "take must be one-shot");
    }

    #[test]
    fn expired_entries_are_dropped() {
        let mut s = PendingStore::new();
        let id = s.insert(cmd("sleep"), 0);
        assert!(s.take(&id, PENDING_TTL_MS).is_none());
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn unknown_id_yields_none() {
        let mut s = PendingStore::new();
        s.insert(cmd("sleep"), 0);
        assert!(s.take("deadbeef", 10).is_none());
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn ids_are_unique_and_store_is_bounded() {
        let mut s = PendingStore::new();
        let mut ids = std::collections::HashSet::new();
        for _ in 0..(MAX_PENDING * 2) {
            ids.insert(s.insert(cmd("update"), 42));
        }
        assert_eq!(ids.len(), MAX_PENDING * 2);
        assert_eq!(s.len(), MAX_PENDING);
    }

    #[test]
    fn callback_data_fits_telegram_limit() {
        let mut s = PendingStore::new();
        let id = s.insert(cmd("shutdown"), i64::MAX / 2);
        for row in confirm_keyboard(&id).rows {
            for b in row {
                assert!(b.callback_data.len() <= 64, "{}", b.callback_data);
            }
        }
    }

    #[test]
    fn builtin_dangerous_is_arg_aware() {
        assert!(builtin_dangerous("shutdown", ""));
        assert!(builtin_dangerous("shutdown", "10m"));
        assert!(!builtin_dangerous("shutdown", "status"));
        assert!(!builtin_dangerous("sleep", "cancel"));
        assert!(builtin_dangerous("update", ""));
        assert!(!builtin_dangerous("update", "check"));
        assert!(builtin_dangerous("app", "quit Safari"));
        assert!(builtin_dangerous("app", "KILL Safari"));
        assert!(!builtin_dangerous("app", "open Safari"));
        assert!(!builtin_dangerous("volume", "50"));
    }

    #[test]
    fn destructive_tools_are_gated() {
        let none = serde_json::json!({});
        for t in [
            "delete_note",
            "update_note",
            "clipboard_delete",
            "clipboard_clear",
        ] {
            assert!(tool_needs_confirmation(t, &none), "{t}");
        }
        assert!(!tool_needs_confirmation("save_note", &none));
    }

    #[test]
    fn control_download_is_gated_only_for_delete() {
        let del = serde_json::json!({"id": 3, "action": "delete", "purge_file": true});
        assert!(tool_needs_confirmation("control_download", &del));
        let del2 = serde_json::json!({"id": 3, "action": "Delete"});
        assert!(tool_needs_confirmation("control_download", &del2));
        let pause = serde_json::json!({"id": 3, "action": "pause"});
        assert!(!tool_needs_confirmation("control_download", &pause));
        let d = describe_tool("control_download", &del);
        assert!(d.contains("разом із файлом"), "{d}");
        assert!(d.contains("\"action\":\"delete\""), "{d}");
    }

    #[test]
    fn card_description_cannot_escape_code_block() {
        let card = card_text("rm **bold** [x](http://e.vil)\n```\n<b>hi</b>");
        let html = super::super::format::markdown_to_telegram_html(&card);
        assert!(!html.contains("<b>"), "{html}");
        assert!(!html.contains("<a "), "{html}");
        assert!(html.contains("&lt;b&gt;"), "{html}");
    }
}
