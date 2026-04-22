//! Notification settings — per-category opt-out plus a handful of scalar
//! preferences (calendar lead time, battery threshold). Stored in the
//! `kv` table so we don't spawn a second disk file; keys are prefixed
//! `notif.<category>` / `pref.<name>` so the namespace is obvious.
//!
//! Missing keys default to "enabled" — a pristine install sends all
//! notifications out of the box; the user opts **out**, not in.


use serde::{Deserialize, Serialize};

use super::state::TelegramState;

pub const KEY_POMODORO: &str = "notif.pomodoro";
pub const KEY_DOWNLOAD: &str = "notif.download_complete";
pub const KEY_BATTERY_LOW: &str = "notif.battery_low";
pub const KEY_CALENDAR: &str = "notif.calendar";

pub const KEY_CALENDAR_LEAD_MIN: &str = "pref.calendar_lead_minutes";
pub const KEY_BATTERY_THRESHOLD: &str = "pref.battery_threshold_pct";

pub const DEFAULT_CALENDAR_LEAD_MIN: u32 = 10;
pub const DEFAULT_BATTERY_THRESHOLD: u32 = 20;

pub const KEY_AI_SYSTEM_PROMPT: &str = "ai.system_prompt";
pub const KEY_AI_CONTEXT_WINDOW: &str = "ai.context_window";
pub const KEY_AI_REPLY_ON_VOICE: &str = "ai.reply_on_voice";

pub const DEFAULT_AI_SYSTEM_PROMPT: &str =
    "You are Oleksandr's Stash assistant, talking back through Telegram. \
     Reply in the same language the user wrote in (default: Ukrainian). \
     Keep answers concise — usually one short paragraph. \
     Use emojis tastefully where they help scan the reply \
     (✅ done, ⚠️ caution, 📝 note, 🔋 battery, 🎧 music, ⏱ time, \
     📎 file, ✨ idea). No emoji spam — one or two is enough. \
     When the user sends a voice note you'll see a plain transcript; \
     respond to the intent behind it, not the fact of it being voice. \
     Use tools when they save the user time.";
pub const DEFAULT_AI_CONTEXT_WINDOW: u32 = 50;
pub const MIN_AI_CONTEXT_WINDOW: u32 = 10;
pub const MAX_AI_CONTEXT_WINDOW: u32 = 200;

/// Shape sent to / received from the frontend. Booleans default to
/// `true`; knobs fall back to the constants above.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationSettings {
    pub pomodoro: bool,
    pub download_complete: bool,
    pub battery_low: bool,
    pub calendar: bool,
    pub calendar_lead_minutes: u32,
    pub battery_threshold_pct: u32,
}

impl NotificationSettings {
    pub fn load(state: &TelegramState) -> Self {
        let repo = state.repo.lock().ok();
        let read_bool = |key: &str, default: bool| -> bool {
            repo.as_ref()
                .and_then(|r| r.kv_get(key).ok().flatten())
                .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                .unwrap_or(default)
        };
        let read_u32 = |key: &str, default: u32| -> u32 {
            repo.as_ref()
                .and_then(|r| r.kv_get(key).ok().flatten())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(default)
        };
        Self {
            pomodoro: read_bool(KEY_POMODORO, true),
            download_complete: read_bool(KEY_DOWNLOAD, true),
            battery_low: read_bool(KEY_BATTERY_LOW, true),
            calendar: read_bool(KEY_CALENDAR, true),
            calendar_lead_minutes: read_u32(
                KEY_CALENDAR_LEAD_MIN,
                DEFAULT_CALENDAR_LEAD_MIN,
            ),
            battery_threshold_pct: read_u32(
                KEY_BATTERY_THRESHOLD,
                DEFAULT_BATTERY_THRESHOLD,
            ),
        }
    }

    pub fn save(&self, state: &TelegramState) -> Result<(), String> {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        for (key, value) in [
            (KEY_POMODORO, bool_to_kv(self.pomodoro)),
            (KEY_DOWNLOAD, bool_to_kv(self.download_complete)),
            (KEY_BATTERY_LOW, bool_to_kv(self.battery_low)),
            (KEY_CALENDAR, bool_to_kv(self.calendar)),
            (
                KEY_CALENDAR_LEAD_MIN,
                self.calendar_lead_minutes.to_string(),
            ),
            (
                KEY_BATTERY_THRESHOLD,
                self.battery_threshold_pct.to_string(),
            ),
        ] {
            repo.kv_set(key, &value).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn bool_to_kv(b: bool) -> String {
    if b { "1" } else { "0" }.to_string()
}

/// AI assistant settings — editable system prompt + rolling chat history
/// window. Persisted in the same `kv` table as notification settings.
/// The LLM provider/model/key are intentionally NOT here: those live in
/// the `ai` module so there's one place to configure them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiSettings {
    pub system_prompt: String,
    pub context_window: u32,
    /// When `true` the assistant runs on every voice-note transcript
    /// and replies with 🤖 in Telegram. When `false` the user only
    /// sees the plain 📝 transcript and can trigger AI manually.
    /// Defaults to `true` — this is the original behaviour.
    pub reply_on_voice: bool,
}

impl AiSettings {
    pub fn load(state: &TelegramState) -> Self {
        let repo = state.repo.lock().ok();
        let system_prompt = repo
            .as_ref()
            .and_then(|r| r.kv_get(KEY_AI_SYSTEM_PROMPT).ok().flatten())
            .unwrap_or_else(|| DEFAULT_AI_SYSTEM_PROMPT.to_string());
        let context_window = repo
            .as_ref()
            .and_then(|r| r.kv_get(KEY_AI_CONTEXT_WINDOW).ok().flatten())
            .and_then(|s| s.parse::<u32>().ok())
            .map(clamp_context_window)
            .unwrap_or(DEFAULT_AI_CONTEXT_WINDOW);
        // Default: on. Stored as "0" / "1" for parity with the other
        // boolean flags in the kv table.
        let reply_on_voice = repo
            .as_ref()
            .and_then(|r| r.kv_get(KEY_AI_REPLY_ON_VOICE).ok().flatten())
            .map(|s| s != "0")
            .unwrap_or(true);
        Self {
            system_prompt,
            context_window,
            reply_on_voice,
        }
    }

    pub fn save(&self, state: &TelegramState) -> Result<(), String> {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        let prompt = self.system_prompt.trim();
        let prompt = if prompt.is_empty() {
            DEFAULT_AI_SYSTEM_PROMPT
        } else {
            prompt
        };
        repo.kv_set(KEY_AI_SYSTEM_PROMPT, prompt)
            .map_err(|e| e.to_string())?;
        repo.kv_set(
            KEY_AI_CONTEXT_WINDOW,
            &clamp_context_window(self.context_window).to_string(),
        )
        .map_err(|e| e.to_string())?;
        repo.kv_set(KEY_AI_REPLY_ON_VOICE, &bool_to_kv(self.reply_on_voice))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Context-window values outside `[10, 200]` tend to either starve the
/// assistant of continuity or blow up prompt size — clamp rather than
/// reject so an out-of-range slider move can't brick the UI.
pub fn clamp_context_window(n: u32) -> u32 {
    n.clamp(MIN_AI_CONTEXT_WINDOW, MAX_AI_CONTEXT_WINDOW)
}

/// Check whether a notifier category is currently enabled. Used by the
/// notifier before it touches the sender, so toggling in the UI takes
/// effect on the next event.
pub fn category_enabled(state: &TelegramState, category: super::notifier::Category) -> bool {
    use super::notifier::Category;
    let settings = NotificationSettings::load(state);
    match category {
        Category::Pomodoro => settings.pomodoro,
        Category::DownloadComplete => settings.download_complete,
        Category::BatteryLow => settings.battery_low,
        Category::Calendar => settings.calendar,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;
    use crate::modules::telegram::repo::TelegramRepo;
    use rusqlite::Connection;
    use std::sync::Arc;

    fn fresh() -> TelegramState {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn crate::modules::telegram::keyring::SecretStore> =
            Arc::new(MemStore::new());
        TelegramState::new(repo, secrets)
    }

    #[test]
    fn defaults_when_kv_empty() {
        let s = fresh();
        let n = NotificationSettings::load(&s);
        assert!(n.pomodoro);
        assert!(n.download_complete);
        assert!(n.battery_low);
        assert!(n.calendar);
        assert_eq!(n.calendar_lead_minutes, DEFAULT_CALENDAR_LEAD_MIN);
        assert_eq!(n.battery_threshold_pct, DEFAULT_BATTERY_THRESHOLD);
    }

    #[test]
    fn save_then_load_round_trips() {
        let s = fresh();
        let n = NotificationSettings {
            pomodoro: false,
            download_complete: true,
            battery_low: false,
            calendar: true,
            calendar_lead_minutes: 30,
            battery_threshold_pct: 15,
        };
        n.save(&s).unwrap();
        let reloaded = NotificationSettings::load(&s);
        assert_eq!(reloaded, n);
    }

    #[test]
    fn ai_settings_default_when_kv_empty() {
        let s = fresh();
        let ai = AiSettings::load(&s);
        assert_eq!(ai.system_prompt, DEFAULT_AI_SYSTEM_PROMPT);
        assert_eq!(ai.context_window, DEFAULT_AI_CONTEXT_WINDOW);
        // reply_on_voice defaults on so existing users keep the
        // pre-toggle behaviour (transcript + AI reply).
        assert!(ai.reply_on_voice);
    }

    #[test]
    fn ai_settings_round_trip() {
        let s = fresh();
        let ai = AiSettings {
            system_prompt: "You are a snarky cat.".into(),
            context_window: 80,
            reply_on_voice: false,
        };
        ai.save(&s).unwrap();
        let reloaded = AiSettings::load(&s);
        assert_eq!(reloaded, ai);
    }

    #[test]
    fn ai_settings_clamp_context_window() {
        let s = fresh();
        AiSettings {
            system_prompt: "p".into(),
            context_window: 9999,
            reply_on_voice: true,
        }
        .save(&s)
        .unwrap();
        assert_eq!(AiSettings::load(&s).context_window, MAX_AI_CONTEXT_WINDOW);

        AiSettings {
            system_prompt: "p".into(),
            context_window: 1,
            reply_on_voice: true,
        }
        .save(&s)
        .unwrap();
        assert_eq!(AiSettings::load(&s).context_window, MIN_AI_CONTEXT_WINDOW);
    }

    #[test]
    fn ai_settings_empty_prompt_falls_back_to_default() {
        let s = fresh();
        AiSettings {
            system_prompt: "   ".into(),
            context_window: 50,
            reply_on_voice: true,
        }
        .save(&s)
        .unwrap();
        assert_eq!(AiSettings::load(&s).system_prompt, DEFAULT_AI_SYSTEM_PROMPT);
    }

    #[test]
    fn category_enabled_respects_toggle() {
        let s = fresh();
        assert!(category_enabled(&s, super::super::notifier::Category::Pomodoro));
        let mut n = NotificationSettings::load(&s);
        n.pomodoro = false;
        n.save(&s).unwrap();
        assert!(!category_enabled(&s, super::super::notifier::Category::Pomodoro));
    }
}
