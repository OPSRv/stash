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
//! are gated (see `tools::ToolRegistry::invoke`).

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

/// Tool names that need confirmation when the LLM calls them directly.
pub const DANGEROUS_TOOLS: &[&str] = &["clipboard_clear", "npm_run_script"];

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

pub fn tool_needs_confirmation(name: &str) -> bool {
    DANGEROUS_TOOLS.contains(&name)
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
        format!("⚠️ Підтвердь дію:\n{description}\n\nЗапит дійсний 5 хв."),
        Some(confirm_keyboard(&id)),
    );
    serde_json::json!({
        "status": "awaiting_confirmation",
        "message": "A confirmation card with buttons was sent to the user. The action runs only \
                    after they tap ✅. Do not retry or call it again; just tell the user to \
                    confirm with the button."
    })
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
    match args.as_object() {
        Some(m) if !m.is_empty() => format!("{name} {args}"),
        _ => name.to_string(),
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
}
