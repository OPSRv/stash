//! App → Telegram notifications.
//!
//! Phase-1 slice: a single `notify_if_paired` helper that other Stash
//! modules can call as a fire-and-forget. It looks up the managed
//! `Arc<TelegramState>`, checks that a chat is paired and that the
//! category hasn't been rate-limited recently, and pushes the message
//! through the existing outbound sender.
//!
//! A real per-category settings toggle + richer dedup policy lands when
//! the Settings UI gains a "Notifications" panel (Phase 2 of the design).
//! For now categories only carry a cool-down so a battery-low alert
//! fired ten times in a row doesn't spam the chat.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::commands_registry::InlineKeyboard;
use super::pairing::PairingState;
use super::state::TelegramState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Pomodoro,
    BatteryLow,
    DownloadComplete,
    Calendar,
    KeepAwake,
}

impl Category {
    fn cooldown(self) -> Duration {
        match self {
            Category::Pomodoro => Duration::from_secs(2), // burst-safe only
            Category::BatteryLow => Duration::from_secs(60 * 60),
            Category::DownloadComplete => Duration::from_secs(2),
            Category::Calendar => Duration::from_secs(60),
            Category::KeepAwake => Duration::from_secs(1),
        }
    }
}

fn last_fired() -> &'static Mutex<std::collections::HashMap<Category, Instant>> {
    static STORE: OnceLock<Mutex<std::collections::HashMap<Category, Instant>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Managed telegram state + paired chat id, or `None` when the bot isn't
/// running / no chat is paired.
fn paired_chat(app: &AppHandle) -> Option<(tauri::State<'_, Arc<TelegramState>>, i64)> {
    let state = app.try_state::<Arc<TelegramState>>()?;
    let chat_id = match &*state.pairing.lock().unwrap() {
        PairingState::Paired { chat_id } => *chat_id,
        _ => return None,
    };
    Some((state, chat_id))
}

/// Fire-and-forget notification. Silently drops when:
///   - the telegram state isn't managed (app setup failed / not running),
///   - no chat is paired,
///   - the category is still within its cooldown window.
pub fn notify_if_paired(app: &AppHandle, category: Category, text: impl Into<String>) {
    let Some((state, chat_id)) = paired_chat(app) else {
        return;
    };

    // Per-category toggle check — user may have silenced this kind.
    if !super::settings::category_enabled(&state, category) {
        tracing::debug!(?category, "telegram notifier: disabled in settings");
        return;
    }

    // Cooldown check — per category, global (single-user).
    let now = Instant::now();
    {
        let mut map = last_fired().lock().unwrap();
        if let Some(&last) = map.get(&category) {
            if now.duration_since(last) < category.cooldown() {
                tracing::debug!(?category, "telegram notifier: cooldown suppressed");
                return;
            }
        }
        map.insert(category, now);
    }

    state.sender.enqueue(chat_id, text);
}

/// Like `notify_if_paired`, but carries an inline keyboard. Honours
/// pairing + the per-category settings toggle; cooldown/dedup is the
/// caller's job (each watcher already tracks its own). Returns whether
/// the message was queued.
pub fn notify_with_keyboard(
    app: &AppHandle,
    category: Category,
    text: impl Into<String>,
    keyboard: impl Into<Option<InlineKeyboard>>,
) -> bool {
    let Some((state, chat_id)) = paired_chat(app) else {
        return false;
    };
    if !super::settings::category_enabled(&state, category) {
        tracing::debug!(?category, "telegram notifier: disabled in settings");
        return false;
    }
    state
        .sender
        .enqueue_with_keyboard(chat_id, text, keyboard.into());
    true
}

/// Push a message straight to the paired chat, bypassing category toggles
/// and cooldowns. For results the user explicitly asked for (e.g. a long
/// job started from a button). Returns whether it was queued.
pub fn send_to_paired(
    app: &AppHandle,
    text: impl Into<String>,
    keyboard: Option<InlineKeyboard>,
    documents: Vec<PathBuf>,
) -> bool {
    let Some((state, chat_id)) = paired_chat(app) else {
        return false;
    };
    state.sender.enqueue_full(chat_id, text, keyboard, documents);
    true
}
