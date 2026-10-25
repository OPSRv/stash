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
/// When `true`, every voice/video/video_note transcript runs through
/// the speaker-diarization pipeline (pyannote + 3D-Speaker) so the
/// stored transcript is labeled "Спікер 1: … / Спікер 2: …" instead
/// of one flat block.
pub const KEY_AI_DIARIZATION: &str = "ai.diarization_enabled";

/// Inbox storage caps. Values are stored as plain MB integers so the
/// kv table stays human-inspectable.
pub const KEY_INBOX_PER_FILE_MB: &str = "inbox.per_file_mb";
pub const KEY_INBOX_PER_DAY_MB: &str = "inbox.per_day_mb";
/// Days of inbox history kept on disk before the retention sweeper
/// removes the row + file. `0` disables auto-deletion.
pub const KEY_INBOX_RETENTION_DAYS: &str = "inbox.retention_days";
pub const DEFAULT_INBOX_RETENTION_DAYS: u32 = 30;
pub const MAX_INBOX_RETENTION_DAYS: u32 = 365;

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
            calendar_lead_minutes: read_u32(KEY_CALENDAR_LEAD_MIN, DEFAULT_CALENDAR_LEAD_MIN),
            battery_threshold_pct: read_u32(KEY_BATTERY_THRESHOLD, DEFAULT_BATTERY_THRESHOLD),
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
    /// When `true`, transcripts of voice/video/video_note messages are
    /// labeled per speaker by the diarization pipeline. Defaults to
    /// `false` because the model pair has to be downloaded first
    /// (~24 MB) — flipping the toggle in the UI triggers the
    /// download, then enables this flag.
    pub diarization_enabled: bool,
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
        let diarization_enabled = repo
            .as_ref()
            .and_then(|r| r.kv_get(KEY_AI_DIARIZATION).ok().flatten())
            .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        Self {
            system_prompt,
            context_window,
            diarization_enabled,
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
        repo.kv_set(KEY_AI_DIARIZATION, &bool_to_kv(self.diarization_enabled))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// User-tunable inbox storage limits, in megabytes, plus a retention
/// window in days. Sent over IPC so the Settings UI can render the
/// sliders together. All fields are clamped on save against the
/// bounds in `inbox::MIN_*` / `MAX_*` so a typo can't bypass them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxLimits {
    pub per_file_mb: u32,
    pub per_day_mb: u32,
    /// How long an inbox row + its file stay on disk. `0` disables
    /// auto-deletion entirely; positive values trigger the retention
    /// sweeper at startup and once an hour after that.
    pub retention_days: u32,
}

impl InboxLimits {
    pub fn load(state: &TelegramState) -> Self {
        use super::inbox::{
            DEFAULT_PER_DAY_CAP, DEFAULT_PER_FILE_CAP, MAX_PER_DAY_MB, MAX_PER_FILE_MB,
            MIN_PER_DAY_MB, MIN_PER_FILE_MB,
        };
        let read = |key: &str, default_mb: u32, lo: u32, hi: u32| -> u32 {
            state
                .repo
                .lock()
                .ok()
                .and_then(|r| r.kv_get(key).ok().flatten())
                .and_then(|s| s.parse::<u32>().ok())
                .map(|v| v.clamp(lo, hi))
                .unwrap_or(default_mb)
        };
        let default_pf = (DEFAULT_PER_FILE_CAP / 1024 / 1024) as u32;
        let default_pd = (DEFAULT_PER_DAY_CAP / 1024 / 1024) as u32;
        Self {
            per_file_mb: read(
                KEY_INBOX_PER_FILE_MB,
                default_pf,
                MIN_PER_FILE_MB,
                MAX_PER_FILE_MB,
            ),
            per_day_mb: read(
                KEY_INBOX_PER_DAY_MB,
                default_pd,
                MIN_PER_DAY_MB,
                MAX_PER_DAY_MB,
            ),
            // 0 is intentionally allowed (= disable auto-deletion);
            // upper bound is one year so a slider at the right edge
            // still feels like "basically forever".
            retention_days: read(
                KEY_INBOX_RETENTION_DAYS,
                DEFAULT_INBOX_RETENTION_DAYS,
                0,
                MAX_INBOX_RETENTION_DAYS,
            ),
        }
    }

    pub fn save(&self, state: &TelegramState) -> Result<(), String> {
        use super::inbox::{MAX_PER_DAY_MB, MAX_PER_FILE_MB, MIN_PER_DAY_MB, MIN_PER_FILE_MB};
        let pf = self.per_file_mb.clamp(MIN_PER_FILE_MB, MAX_PER_FILE_MB);
        let pd = self.per_day_mb.clamp(MIN_PER_DAY_MB, MAX_PER_DAY_MB);
        let rd = self.retention_days.min(MAX_INBOX_RETENTION_DAYS);
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.kv_set(KEY_INBOX_PER_FILE_MB, &pf.to_string())
            .map_err(|e| e.to_string())?;
        repo.kv_set(KEY_INBOX_PER_DAY_MB, &pd.to_string())
            .map_err(|e| e.to_string())?;
        repo.kv_set(KEY_INBOX_RETENTION_DAYS, &rd.to_string())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Morning digest — a scheduled push of the dashboard to the paired
/// chat. Unlike notification categories this is opt **in**: a pristine
/// install never sends an unsolicited daily message.
pub const KEY_DIGEST_ENABLED: &str = "digest.enabled";
pub const KEY_DIGEST_TIME: &str = "digest.time";
pub const KEY_DIGEST_WEEKDAYS: &str = "digest.weekdays";
/// Local day number (days since 1970-01-01 in local time) of the last
/// digest sent — persisted so a restart doesn't double-send.
pub const KEY_DIGEST_LAST_SENT_DAY: &str = "digest.last_sent_day";
pub const DEFAULT_DIGEST_TIME: &str = "08:00";
/// Weekday bitmask, bit 0 = Monday … bit 6 = Sunday.
pub const DIGEST_ALL_DAYS: u8 = 0b111_1111;
pub const DIGEST_WORKDAYS: u8 = 0b001_1111;
pub const DIGEST_WEEKENDS: u8 = 0b110_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DigestSettings {
    pub enabled: bool,
    /// Local wall-clock time, `HH:MM` (24h).
    pub time: String,
    /// Bit 0 = Monday … bit 6 = Sunday.
    pub weekdays: u8,
}

impl Default for DigestSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            time: DEFAULT_DIGEST_TIME.to_string(),
            weekdays: DIGEST_ALL_DAYS,
        }
    }
}

impl DigestSettings {
    pub fn load(state: &TelegramState) -> Self {
        let Ok(repo) = state.repo.lock() else {
            return Self::default();
        };
        let get = |k: &str| repo.kv_get(k).ok().flatten();
        let d = Self::default();
        Self {
            enabled: get(KEY_DIGEST_ENABLED)
                .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                .unwrap_or(d.enabled),
            time: get(KEY_DIGEST_TIME)
                .and_then(|s| normalize_hhmm(&s))
                .unwrap_or(d.time),
            weekdays: get(KEY_DIGEST_WEEKDAYS)
                .and_then(|s| s.parse::<u8>().ok())
                .map(|m| m & DIGEST_ALL_DAYS)
                .unwrap_or(d.weekdays),
        }
    }

    /// Persists the settings. Rejects a malformed `time` instead of
    /// silently storing garbage the scheduler can't read.
    pub fn save(&self, state: &TelegramState) -> Result<(), String> {
        let time = normalize_hhmm(&self.time)
            .ok_or_else(|| format!("invalid time '{}', expected HH:MM", self.time))?;
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.kv_set(KEY_DIGEST_ENABLED, &bool_to_kv(self.enabled))
            .map_err(|e| e.to_string())?;
        repo.kv_set(KEY_DIGEST_TIME, &time)
            .map_err(|e| e.to_string())?;
        repo.kv_set(
            KEY_DIGEST_WEEKDAYS,
            &(self.weekdays & DIGEST_ALL_DAYS).to_string(),
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Target time as minutes after local midnight.
    pub fn minute_of_day(&self) -> u32 {
        parse_hhmm(&self.time)
            .or_else(|| parse_hhmm(DEFAULT_DIGEST_TIME))
            .map(|(h, m)| h * 60 + m)
            .unwrap_or(8 * 60)
    }
}

/// Parse `H:MM` / `HH:MM` (24h) into `(hour, minute)`.
pub fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    (h < 24 && m < 60).then_some((h, m))
}

/// Canonical zero-padded `HH:MM`, or `None` when unparseable.
pub fn normalize_hhmm(s: &str) -> Option<String> {
    parse_hhmm(s).map(|(h, m)| format!("{h:02}:{m:02}"))
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
        // KeepAwake has no per-category toggle — the feature's own
        // on/off already controls whether nudges are scheduled, and
        // hiding them via a second setting would make the user wonder
        // why their Mac is still caffeinated without reminders.
        Category::KeepAwake => true,
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
        // diarization_enabled defaults off — model files aren't
        // shipped, the user opts in once and the download kicks off.
        assert!(!ai.diarization_enabled);
    }

    #[test]
    fn ai_settings_round_trip() {
        let s = fresh();
        let ai = AiSettings {
            system_prompt: "You are a snarky cat.".into(),
            context_window: 80,
            diarization_enabled: true,
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
            diarization_enabled: false,
        }
        .save(&s)
        .unwrap();
        assert_eq!(AiSettings::load(&s).context_window, MAX_AI_CONTEXT_WINDOW);

        AiSettings {
            system_prompt: "p".into(),
            context_window: 1,
            diarization_enabled: false,
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
            diarization_enabled: false,
        }
        .save(&s)
        .unwrap();
        assert_eq!(AiSettings::load(&s).system_prompt, DEFAULT_AI_SYSTEM_PROMPT);
    }

    #[test]
    fn inbox_limits_default_and_round_trip() {
        let s = fresh();
        let l = InboxLimits::load(&s);
        assert_eq!(l.per_file_mb, 200, "default per-file is 200 MB");
        assert_eq!(l.per_day_mb, 1024, "default per-day is 1 GB");
        assert_eq!(l.retention_days, DEFAULT_INBOX_RETENTION_DAYS);

        InboxLimits {
            per_file_mb: 500,
            per_day_mb: 4096,
            retention_days: 7,
        }
        .save(&s)
        .unwrap();
        let reloaded = InboxLimits::load(&s);
        assert_eq!(reloaded.per_file_mb, 500);
        assert_eq!(reloaded.per_day_mb, 4096);
        assert_eq!(reloaded.retention_days, 7);
    }

    #[test]
    fn inbox_limits_clamp_against_bounds() {
        let s = fresh();
        InboxLimits {
            per_file_mb: 0,
            per_day_mb: 99_999,
            retention_days: 9_999,
        }
        .save(&s)
        .unwrap();
        let l = InboxLimits::load(&s);
        assert_eq!(l.per_file_mb, super::super::inbox::MIN_PER_FILE_MB);
        assert_eq!(l.per_day_mb, super::super::inbox::MAX_PER_DAY_MB);
        assert_eq!(l.retention_days, MAX_INBOX_RETENTION_DAYS);
    }

    #[test]
    fn inbox_limits_allow_zero_retention_to_disable() {
        let s = fresh();
        InboxLimits {
            per_file_mb: 200,
            per_day_mb: 1024,
            retention_days: 0,
        }
        .save(&s)
        .unwrap();
        assert_eq!(InboxLimits::load(&s).retention_days, 0);
    }

    #[test]
    fn digest_defaults_off_every_day() {
        let s = fresh();
        let d = DigestSettings::load(&s);
        assert!(!d.enabled);
        assert_eq!(d.time, DEFAULT_DIGEST_TIME);
        assert_eq!(d.weekdays, DIGEST_ALL_DAYS);
    }

    #[test]
    fn digest_round_trip_normalises_time() {
        let s = fresh();
        DigestSettings {
            enabled: true,
            time: "7:05".into(),
            weekdays: DIGEST_WORKDAYS,
        }
        .save(&s)
        .unwrap();
        let d = DigestSettings::load(&s);
        assert!(d.enabled);
        assert_eq!(d.time, "07:05");
        assert_eq!(d.weekdays, DIGEST_WORKDAYS);
        assert_eq!(d.minute_of_day(), 7 * 60 + 5);
    }

    #[test]
    fn digest_rejects_bad_time() {
        let s = fresh();
        let bad = DigestSettings {
            time: "25:00".into(),
            ..DigestSettings::default()
        };
        assert!(bad.save(&s).is_err());
        for t in ["", "8", "08:5", "08:60", "ab:cd", "123:00"] {
            assert!(parse_hhmm(t).is_none(), "{t}");
        }
        assert_eq!(parse_hhmm(" 23:59 "), Some((23, 59)));
    }

    #[test]
    fn category_enabled_respects_toggle() {
        let s = fresh();
        assert!(category_enabled(
            &s,
            super::super::notifier::Category::Pomodoro
        ));
        let mut n = NotificationSettings::load(&s);
        n.pomodoro = false;
        n.save(&s).unwrap();
        assert!(!category_enabled(
            &s,
            super::super::notifier::Category::Pomodoro
        ));
    }
}
