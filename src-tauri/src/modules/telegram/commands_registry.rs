//! Command registry — the single place where slash-commands are registered.
//! Reused by both the Telegram dispatcher and (later) the CLI transport.
//!
//! Adding a new command is a one-liner inside `default_registry` — the
//! handler holds its own state (Arc-cloned from the module it targets), and
//! `/help` auto-enumerates registered entries, so nothing else has to
//! change when commands come or go.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

/// Reply a handler wants delivered to the user. Optionally carries an
/// inline keyboard for buttons; the transport layer converts it to the
/// teloxide shape before sending.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
    pub keyboard: Option<InlineKeyboard>,
    /// File attachments sent alongside `text`. On Telegram these go as
    /// `send_document` (not `send_photo`) so PNGs from multi-4K screen
    /// captures keep every pixel — the photo path re-encodes and scales
    /// down to ≤1280px, which defeats the point for a screenshot tool.
    /// On non-Telegram transports (CLI) only `text` is delivered, so
    /// handlers must still put usable paths or a summary into `text`.
    pub documents: Vec<PathBuf>,
}

impl Reply {
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            text: s.into(),
            keyboard: None,
            documents: Vec::new(),
        }
    }
}

/// Transport-agnostic inline-keyboard description. Telegram transport
/// translates to teloxide::types::InlineKeyboardMarkup before sending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineKeyboard {
    pub rows: Vec<Vec<InlineButton>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineButton {
    pub text: String,
    pub callback_data: String,
}

impl InlineButton {
    pub fn new(text: impl Into<String>, callback_data: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            callback_data: callback_data.into(),
        }
    }
}

/// Canonical two-row quick-actions keyboard reused by the pairing welcome
/// and `/help`. Each button's `callback_data` is just a bare command name
/// — `handle_callback` treats data without a colon as "ns:<empty args>",
/// so each button runs the same handler the user would reach by typing
/// `/battery`, `/clip`, etc.
pub fn quick_actions_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![
            vec![
                InlineButton::new("🔋 Battery", "battery"),
                InlineButton::new("📋 Clip", "clip"),
                InlineButton::new("📸 Shot", "screenshot"),
            ],
            vec![
                InlineButton::new("🎵 Music", "music"),
                InlineButton::new("⏰ Reminders", "reminders"),
                InlineButton::new("🧠 Memory", "memory"),
            ],
        ],
    }
}

/// Context handed to every handler. Carries a Tauri `AppHandle` so
/// handlers can `emit` cross-module refresh events (e.g. `/note` nudges
/// the Notes panel to reload).
#[derive(Clone)]
pub struct Ctx {
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
    pub fn set_snapshot(&self, entries: Vec<(&'static str, &'static str, &'static str)>) {
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
        "Показати доступні команди"
    }
    fn usage(&self) -> &'static str {
        "/help"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let snap = self.snapshot.lock().unwrap();
        let text = render_help(&snap);
        Reply {
            text,
            keyboard: Some(quick_actions_keyboard()),
            ..Default::default()
        }
    }
}

/// Command groups shown in `/help`. A command that isn't listed here
/// falls through to a trailing "Інше" bucket so new commands surface
/// automatically even without updating this table.
const HELP_CATEGORIES: &[(&str, &[&str])] = &[
    ("🧭 Overview", &["dashboard", "status"]),
    (
        "💻 System",
        &["battery", "display", "sleep", "shutdown", "screenshot"],
    ),
    (
        "📥 Capture",
        &[
            "clip",
            "note",
            "notes",
            "memory",
            "remember",
            "forget_fact",
            "summarize",
        ],
    ),
    ("🎛 Control", &["music", "volume"]),
    ("⏰ Time", &["remind", "reminders", "forget"]),
    ("ℹ️ Meta", &["help"]),
];

fn render_help(snap: &[(&'static str, &'static str, &'static str)]) -> String {
    // Index by name so category lookup is O(n) rather than O(n*m).
    let by_name: std::collections::HashMap<&str, (&str, &str)> =
        snap.iter().map(|(n, u, d)| (*n, (*u, *d))).collect();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut out = String::new();
    out.push_str("🤖 *Stash commands*\n\n");
    for (title, names) in HELP_CATEGORIES {
        let present: Vec<_> = names.iter().filter(|n| by_name.contains_key(**n)).collect();
        if present.is_empty() {
            continue;
        }
        out.push_str(&format!("{title}\n"));
        for name in present {
            let (usage, desc) = by_name[*name];
            seen.insert(*name);
            out.push_str(&format!("• `{usage}` — {desc}\n"));
        }
        out.push('\n');
    }
    // Anything uncategorised — keeps new commands discoverable even when
    // someone forgets to update HELP_CATEGORIES.
    let leftovers: Vec<_> = snap.iter().filter(|(n, _, _)| !seen.contains(n)).collect();
    if !leftovers.is_empty() {
        out.push_str("📦 Інше\n");
        for (_n, u, d) in leftovers {
            out.push_str(&format!("• `{u}` — {d}\n"));
        }
        out.push('\n');
    }
    out.push_str("_Tip: натисни `/` для автокомпліту або скористайся кнопками нижче._");
    out
}

/// Return up to `limit` registered command names closest to `needle`.
/// Used by the transport to turn an unknown-command reply into a
/// suggest-and-click response ("`/fo` не знайшов. Може /forget?"). Pure
/// — operates on the name list the caller passes in.
pub fn suggest_commands(needle: &str, names: &[&str], limit: usize) -> Vec<String> {
    let needle = needle.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut ranked: Vec<(usize, &str)> = names
        .iter()
        .map(|n| (levenshtein(&needle, n), *n))
        .filter(|(d, n)| {
            // Tight bound: either a close edit distance OR a clear
            // prefix/substring match. Prevents "foobarbaz" from
            // suggesting random 3-letter commands.
            *d <= 2
                || *d <= n.len().max(needle.len()) / 2
                || n.starts_with(&needle)
                || n.contains(&needle)
        })
        .collect();
    ranked.sort_by_key(|(d, _)| *d);
    ranked.truncate(limit);
    ranked.into_iter().map(|(_, n)| n.to_string()).collect()
}

/// Classic iterative Levenshtein. Pulled in as a local helper rather
/// than a dependency — the string pairs are <30 chars each, so a
/// `Vec<usize>` scratch is cheaper than adding a crate to the graph.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, ac) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, bc) in b.iter().enumerate() {
            let cost = if ac == bc { 0 } else { 1 };
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
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
        "Перевірити, що Stash на зв'язку"
    }
    fn usage(&self) -> &'static str {
        "/status"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        Reply::text("✅ Stash на зв'язку.")
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

    #[test]
    fn quick_actions_keyboard_has_six_buttons_in_two_rows() {
        let kb = quick_actions_keyboard();
        assert_eq!(kb.rows.len(), 2);
        assert_eq!(kb.rows[0].len(), 3);
        assert_eq!(kb.rows[1].len(), 3);
        // Each callback_data must match a real slash-command name so
        // `handle_callback` can route it back via `find_command` without
        // any new ns:* routing.
        let names: Vec<&str> = kb
            .rows
            .iter()
            .flat_map(|r| r.iter().map(|b| b.callback_data.as_str()))
            .collect();
        for expected in [
            "battery",
            "clip",
            "screenshot",
            "music",
            "reminders",
            "memory",
        ] {
            assert!(
                names.contains(&expected),
                "missing {expected} in quick actions"
            );
        }
    }

    #[test]
    fn render_help_groups_commands_by_category() {
        let snap = vec![
            ("battery", "/battery", "b"),
            ("clip", "/clip [N]", "c"),
            ("music", "/music", "m"),
            ("remind", "/remind …", "r"),
            ("help", "/help", "h"),
        ];
        let out = render_help(&snap);
        // Category headers present in the order defined by HELP_CATEGORIES.
        let idx_sys = out.find("💻 System").unwrap();
        let idx_cap = out.find("📥 Capture").unwrap();
        let idx_ctrl = out.find("🎛 Control").unwrap();
        let idx_time = out.find("⏰ Time").unwrap();
        let idx_meta = out.find("ℹ️ Meta").unwrap();
        assert!(idx_sys < idx_cap && idx_cap < idx_ctrl);
        assert!(idx_ctrl < idx_time);
        // `help` sits in the Meta bucket; the presence of Meta confirms
        // category ordering extends past the Time header.
        assert!(idx_time < idx_meta);
        // Every command in the snapshot appears exactly once.
        for (_, usage, _) in &snap {
            let occurrences = out.matches(usage).count();
            assert_eq!(occurrences, 1, "expected {usage} once, got {occurrences}");
        }
    }

    #[test]
    fn suggest_commands_catches_typos_and_prefixes() {
        let names = &[
            "battery",
            "clip",
            "note",
            "music",
            "remind",
            "reminders",
            "forget",
            "forget_fact",
            "help",
            "memory",
        ];
        // Typo: /fo → most likely /forget (then /forget_fact).
        let out = suggest_commands("fo", names, 3);
        assert_eq!(out.first().map(String::as_str), Some("forget"));
        // Transposition: /remnd → /remind.
        let out = suggest_commands("remnd", names, 2);
        assert!(out.contains(&"remind".to_string()));
        // Prefix: /rem → /remind + /reminders (distance tied, both valid).
        let out = suggest_commands("rem", names, 3);
        assert!(out.iter().any(|n| n == "remind"));
        // Empty needle yields nothing (avoid carpet-bombing the user).
        assert!(suggest_commands("", names, 3).is_empty());
    }

    #[test]
    fn suggest_commands_skips_far_matches() {
        // A totally unrelated input shouldn't suggest random commands —
        // the Levenshtein cap + substring fallback should return empty
        // so the caller falls back to the generic "type / to explore" hint.
        let names = &["battery", "clip", "note"];
        let out = suggest_commands("xqwerty", names, 3);
        assert!(
            out.is_empty(),
            "expected no suggestions for wild input, got {out:?}"
        );
    }

    #[test]
    fn render_help_surfaces_uncategorised_commands_in_fallback_bucket() {
        // A hypothetical new command not listed in HELP_CATEGORIES must
        // still show up, so the help stays honest as the registry grows.
        let snap = vec![("wubalubadubdub", "/wubalubadubdub", "chaos")];
        let out = render_help(&snap);
        assert!(out.contains("📦 Інше"));
        assert!(out.contains("/wubalubadubdub"));
    }
}
