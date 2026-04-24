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

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::pairing::PairingState;
use super::state::TelegramState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Pomodoro,
    BatteryLow,
    DownloadComplete,
    Calendar,
}

impl Category {
    fn cooldown(self) -> Duration {
        match self {
            Category::Pomodoro => Duration::from_secs(2), // burst-safe only
            Category::BatteryLow => Duration::from_secs(60 * 60),
            Category::DownloadComplete => Duration::from_secs(2),
            Category::Calendar => Duration::from_secs(60),
        }
    }
}

fn last_fired() -> &'static Mutex<std::collections::HashMap<Category, Instant>> {
    static STORE: OnceLock<Mutex<std::collections::HashMap<Category, Instant>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Fire-and-forget notification. Silently drops when:
///   - the telegram state isn't managed (app setup failed / not running),
///   - no chat is paired,
///   - the category is still within its cooldown window.
pub fn notify_if_paired(app: &AppHandle, category: Category, text: impl Into<String>) {
    let state = match app.try_state::<std::sync::Arc<TelegramState>>() {
        Some(s) => s,
        None => return,
    };
    let chat_id = match &*state.pairing.lock().unwrap() {
        PairingState::Paired { chat_id } => *chat_id,
        _ => return,
    };

    // Per-category toggle check — user may have silenced this kind.
    // Double-deref: State<'_, Arc<T>> → Arc<T> → T.
    if !super::settings::category_enabled(&**state, category) {
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
