//! Command registry — the single place where slash-commands are registered.
//! Reused by both the Telegram dispatcher and (later) the CLI transport.
//!
//! Adding a new command is a one-liner inside `default_registry` — the
//! handler holds its own state (Arc-cloned from the module it targets), and
//! `/help` auto-enumerates registered entries, so nothing else has to
//! change when commands come or go.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

/// Reply a handler wants delivered to the user. Plain text for now; Phase 1
/// keeps formatting simple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
}

impl Reply {
    pub fn text(s: impl Into<String>) -> Self {
        Self { text: s.into() }
    }
}

/// Context handed to every handler. Carries the chat id plus a Tauri
/// `AppHandle` so handlers can `emit` cross-module refresh events
/// (e.g. `/note` nudges the Notes panel to reload).
#[derive(Clone)]
pub struct Ctx {
    pub chat_id: i64,
    pub app: tauri::AppHandle,
}

#[async_trait]
pub trait CommandHandler: Send + Sync {
    /// Short name used for dispatch (e.g. `help` for `/help`). Must be
    /// lowercase ASCII without a leading slash.
    fn name(&self) -> &'static str;

    /// One-line description used by `/help`.
    fn description(&self) -> &'static str;

    /// Usage string shown by `/help <cmd>` (future). Include the leading
    /// slash and argument placeholders, e.g. `/clip [N]`.
    fn usage(&self) -> &'static str;

    async fn handle(&self, ctx: Ctx, args: &str) -> Reply;
}

/// Registry of slash-command handlers keyed by `name()`.
#[derive(Default)]
pub struct CommandRegistry {
    handlers: HashMap<&'static str, Arc<dyn CommandHandler>>,
    /// Stable insertion order for deterministic `/help` output.
    order: Vec<&'static str>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<H: CommandHandler + 'static>(&mut self, handler: H) {
        self.register_arc(Arc::new(handler));
    }

    /// Register a pre-wrapped handler — used when the caller needs to
    /// keep a separate `Arc<H>` for type-specific interactions (e.g.
    /// `HelpCmd`, which needs its snapshot mutated after registration).
    pub fn register_arc<H: CommandHandler + 'static>(&mut self, handler: Arc<H>) {
        let name = handler.name();
        if !self.handlers.contains_key(name) {
            self.order.push(name);
        }
        self.handlers.insert(name, handler);
    }

    pub fn find(&self, name: &str) -> Option<Arc<dyn CommandHandler>> {
        self.handlers.get(name).cloned()
    }

    /// Enumerate registered commands in insertion order. Used by `/help`
    /// so the listing is stable across runs.
    pub fn enumerate(&self) -> Vec<Arc<dyn CommandHandler>> {
        self.order
            .iter()
            .filter_map(|n| self.handlers.get(n).cloned())
            .collect()
    }
}

// ----- Built-in handlers -----

/// `/help` — auto-enumerates registered commands. Holds a reference to the
/// registry it belongs to via a closure-style snapshot so the listing
/// reflects reality even if new commands are registered at runtime.
pub struct HelpCmd {
    snapshot: Arc<std::sync::Mutex<Vec<(&'static str, &'static str, &'static str)>>>,
}

impl HelpCmd {
    pub fn new() -> Self {
        Self {
            snapshot: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Call once after the registry is fully built so `/help` knows what to
    /// print. Idempotent — subsequent calls replace the snapshot.
    pub fn set_snapshot(
        &self,
        entries: Vec<(&'static str, &'static str, &'static str)>,
    ) {
        *self.snapshot.lock().unwrap() = entries;
    }
}

impl Default for HelpCmd {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CommandHandler for HelpCmd {
    fn name(&self) -> &'static str {
        "help"
    }
    fn description(&self) -> &'static str {
        "Show available commands"
    }
    fn usage(&self) -> &'static str {
        "/help"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let snap = self.snapshot.lock().unwrap();
        let mut out = String::from("Available commands:\n");
        for (_name, usage, desc) in snap.iter() {
            out.push_str(&format!("• {usage} — {desc}\n"));
        }
        Reply::text(out.trim_end().to_string())
    }
}

/// `/status` — one-line snapshot of the app. Phase 1: just confirms the
/// bot is alive. Later phases flesh this out with battery / pomodoro / etc.
pub struct StatusCmd;

#[async_trait]
impl CommandHandler for StatusCmd {
    fn name(&self) -> &'static str {
        "status"
    }
    fn description(&self) -> &'static str {
        "Show whether Stash is reachable"
    }
    fn usage(&self) -> &'static str {
        "/status"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        Reply::text("✅ Stash is online.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests that call `handle()` are skipped at this level: constructing a
    // real `tauri::AppHandle` requires a running app, and producing a fake
    // one via `MaybeUninit::zeroed` would be UB. Handler behaviour is
    // covered by integration tests against the actual Tauri runtime.

    #[test]
    fn enumerate_preserves_insertion_order() {
        let mut r = CommandRegistry::new();
        r.register(StatusCmd);
        r.register(HelpCmd::new());
        let names: Vec<_> = r.enumerate().into_iter().map(|h| h.name()).collect();
        assert_eq!(names, vec!["status", "help"]);
    }

    #[test]
    fn re_register_replaces_but_keeps_position() {
        let mut r = CommandRegistry::new();
        r.register(HelpCmd::new());
        r.register(StatusCmd);
        r.register(StatusCmd); // second registration for same name
        let names: Vec<_> = r.enumerate().into_iter().map(|h| h.name()).collect();
        assert_eq!(names, vec!["help", "status"]);
    }

    #[test]
    fn help_snapshot_is_set_and_kept() {
        let help = HelpCmd::new();
        help.set_snapshot(vec![
            ("status", "/status", "Show whether Stash is reachable"),
            ("battery", "/battery", "Show battery level"),
        ]);
        // `handle` requires a real AppHandle; snapshot storage is what we
        // can verify here without a Tauri runtime.
        let stored = help.snapshot.lock().unwrap().clone();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].1, "/status");
        assert_eq!(stored[1].1, "/battery");
    }
}
