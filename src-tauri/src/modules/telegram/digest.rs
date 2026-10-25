//! Morning digest — a scheduled push of the `/dashboard` snapshot plus
//! today's reminders to the paired chat.
//!
//! Scheduling: a minute ticker (same shape as `battery_watcher` /
//! `calendar`) fires once per local day at/after the configured time on
//! the enabled weekdays. The last-sent local day is persisted in the
//! telegram kv store so a restart never double-sends. If the Mac was
//! asleep at the scheduled time the digest still goes out on wake as
//! long as we're within `CATCH_UP_MIN` of it; later than that the day
//! is skipped (a "morning" digest at 4 pm is noise).
//!
//! Surfaces: `/digest` (card + buttons), the `configure_digest` LLM tool
//! and the Settings → Telegram panel all funnel writes through
//! [`apply_settings`].

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::commands_registry::{CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply};
use super::pairing::PairingState;
use super::reminders::{format_local_when, Reminder};
use super::settings::{
    normalize_hhmm, DigestSettings, DIGEST_ALL_DAYS, DIGEST_WEEKENDS, DIGEST_WORKDAYS,
    KEY_DIGEST_LAST_SENT_DAY,
};
use super::state::TelegramState;
use super::tools::{Tool, ToolCtx};

const POLL_PERIOD: Duration = Duration::from_secs(60);
/// How late (in minutes) a missed digest may still be delivered on wake.
const CATCH_UP_MIN: u32 = 3 * 60;
const DAY_SECS: i64 = 86_400;

/// Local day number on which the scheduler must stay quiet because a
/// settings change landed after the target time (see [`suppressed_day_after_change`]).
/// Kept separate from `last_sent_day` so it can be recomputed (and
/// cleared) on every later change instead of permanently eating the day.
const KEY_DIGEST_SUPPRESSED_DAY: &str = "digest.suppressed_day";

const WEEKDAY_SHORT: [&str; 7] = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"];

// -------------------- scheduler --------------------

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(POLL_PERIOD);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // skip the instant fire so rehydrate can finish
        loop {
            tick.tick().await;
            run_once(&app).await;
        }
    });
}

async fn run_once(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<TelegramState>>() else {
        return;
    };
    let state = Arc::clone(state.inner());
    let settings = DigestSettings::load(&state);
    if !settings.enabled || paired_chat(&state).is_none() {
        return;
    }
    let now_local = now_secs() + super::inbox::local_offset_seconds_public();
    if !should_send(
        now_local,
        &settings,
        kv_day(&state, KEY_DIGEST_LAST_SENT_DAY),
        kv_day(&state, KEY_DIGEST_SUPPRESSED_DAY),
    ) {
        return;
    }
    // Mark first: a slow dashboard build racing the next tick must not
    // produce a second message.
    mark_sent(&state, local_day(now_local));
    if !send_digest(app, &state).await {
        tracing::debug!("digest: not sent (bot unpaired mid-flight)");
    }
}

/// Monday = 0 … Sunday = 6 for a local day number (1970-01-01 was a Thursday).
fn weekday_index(day: i64) -> u32 {
    (day + 3).rem_euclid(7) as u32
}

fn local_day(now_local: i64) -> i64 {
    now_local.div_euclid(DAY_SECS)
}

fn minute_of_day(now_local: i64) -> u32 {
    (now_local.rem_euclid(DAY_SECS) / 60) as u32
}

/// Pure scheduling decision. `now_local` is unix seconds shifted by the
/// local UTC offset.
pub(crate) fn should_send(
    now_local: i64,
    settings: &DigestSettings,
    last_sent_day: Option<i64>,
    suppressed_day: Option<i64>,
) -> bool {
    if !settings.enabled {
        return false;
    }
    let day = local_day(now_local);
    if last_sent_day.is_some_and(|d| d >= day) || suppressed_day == Some(day) {
        return false;
    }
    if settings.weekdays & (1 << weekday_index(day)) == 0 {
        return false;
    }
    let minute = minute_of_day(now_local);
    let target = settings.minute_of_day();
    minute >= target && minute - target < CATCH_UP_MIN
}

/// Recompute today's suppression after a settings change. Returns the
/// local day to suppress, or `None` to clear it.
///
/// Any change that lands when today's (new) target time has already
/// passed suppresses today — enabling at 10:00 for 08:00, moving the time
/// earlier than now, or adding today's weekday after the time — otherwise
/// the scheduler would fire within a minute, which reads as a bug. A
/// change whose target is still ahead today clears the suppression, so an
/// intermediate value (e.g. "07:00" while retyping 08:00 → 07:45 at
/// 07:30) can't eat the day for good. A no-op save keeps what was there.
pub(crate) fn suppressed_day_after_change(
    old: &DigestSettings,
    new: &DigestSettings,
    now_local: i64,
    current: Option<i64>,
) -> Option<i64> {
    let today = local_day(now_local);
    let current = current.filter(|d| *d == today);
    if !new.enabled || minute_of_day(now_local) < new.minute_of_day() {
        return None;
    }
    if old == new {
        return current;
    }
    Some(today)
}

fn kv_day(state: &TelegramState, key: &str) -> Option<i64> {
    state.repo.lock().ok()?.kv_get(key).ok().flatten()?.parse().ok()
}

fn set_kv_day(state: &TelegramState, key: &str, day: Option<i64>) {
    if let Ok(mut repo) = state.repo.lock() {
        let v = day.map(|d| d.to_string()).unwrap_or_default();
        let _ = repo.kv_set(key, &v);
    }
}

fn mark_sent(state: &TelegramState, day: i64) {
    set_kv_day(state, KEY_DIGEST_LAST_SENT_DAY, Some(day));
}

/// Single write path for digest settings (command, tool, Settings UI).
pub fn apply_settings(
    state: &TelegramState,
    new: DigestSettings,
) -> Result<DigestSettings, String> {
    let old = DigestSettings::load(state);
    new.save(state)?;
    let saved = DigestSettings::load(state);
    let now_local = now_secs() + super::inbox::local_offset_seconds_public();
    let current = kv_day(state, KEY_DIGEST_SUPPRESSED_DAY);
    let next = suppressed_day_after_change(&old, &saved, now_local, current);
    if next != current {
        set_kv_day(state, KEY_DIGEST_SUPPRESSED_DAY, next);
    }
    Ok(saved)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn paired_chat(state: &TelegramState) -> Option<i64> {
    match &*state.pairing.lock().ok()? {
        PairingState::Paired { chat_id } => Some(*chat_id),
        _ => None,
    }
}

// -------------------- content --------------------

/// Compose the digest message: dashboard snapshot + today's reminders.
pub async fn build_digest(app: &AppHandle, state: &TelegramState) -> Reply {
    let mut text = String::from("🌅 *Доброго ранку!*\n\n");
    // Reuse the `/dashboard` handler through the registry so the digest
    // never drifts from what the cockpit shows.
    if let Some(dashboard) = state.find_command("dashboard") {
        let r = dashboard.handle(Ctx { app: app.clone() }, "").await;
        text.push_str(r.text.trim());
        text.push_str("\n\n");
    }
    let reminders = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_active_reminders().ok())
        .unwrap_or_default();
    let offset = super::inbox::local_offset_seconds_public();
    let now = now_secs();
    text.push_str(&format_today_reminders(&reminders, now, offset));
    // Rest of today's Calendar.app events (osascript is blocking; failures
    // — no permission, Calendar not running — just omit the section).
    let window_min = minutes_until_local_midnight(now, offset);
    if let Ok(Ok(events)) =
        tokio::task::spawn_blocking(move || super::calendar::fetch_upcoming(window_min)).await
    {
        text.push_str(&format_today_events(&events, now, offset));
    }
    Reply {
        text,
        keyboard: Some(digest_keyboard()),
        ..Default::default()
    }
}

fn minutes_until_local_midnight(now: i64, offset: i64) -> u32 {
    let into_day = (now + offset).rem_euclid(86_400);
    ((86_400 - into_day) / 60).max(1) as u32
}

/// "Calendar" section — empty string when there's nothing left today.
fn format_today_events(events: &[super::calendar::UpcomingEvent], now: i64, offset: i64) -> String {
    if events.is_empty() {
        return String::new();
    }
    let mut sorted: Vec<_> = events.iter().collect();
    sorted.sort_by_key(|e| e.starts_at);
    let mut out = String::from("\n\n🗓 *Календар:*");
    for e in sorted {
        let title: String = e.title.chars().take(60).collect();
        out.push_str(&format!("\n• {} — {}", format_local_when(e.starts_at, now, offset), title));
        if let Some(loc) = e.location.as_deref().filter(|l| !l.is_empty()) {
            let loc: String = loc.chars().take(40).collect();
            out.push_str(&format!(" ({loc})"));
        }
    }
    out
}

/// "Today" section — reminders whose due time falls on the current local day.
fn format_today_reminders(reminders: &[Reminder], now: i64, offset: i64) -> String {
    let today = local_day(now + offset);
    let mut items: Vec<&Reminder> = reminders
        .iter()
        .filter(|r| !r.sent && !r.cancelled && local_day(r.due_at + offset) == today)
        .collect();
    if items.is_empty() {
        return "📅 Сьогодні нагадувань немає.".to_string();
    }
    items.sort_by_key(|r| r.due_at);
    let mut out = String::from("📅 *Сьогодні:*");
    for r in items {
        let label: String = r.text.chars().take(60).collect();
        out.push_str(&format!(
            "\n• {} — {}",
            format_local_when(r.due_at, now, offset),
            label.replace('\n', " ")
        ));
    }
    out
}

fn digest_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("🔄 Оновити", "refresh:digest:now"),
            InlineButton::new("☰ Меню", "menu"),
        ]],
    }
}

/// Push the digest to the paired chat. Returns `false` when unpaired.
pub async fn send_digest(app: &AppHandle, state: &TelegramState) -> bool {
    let Some(chat_id) = paired_chat(state) else {
        return false;
    };
    let reply = build_digest(app, state).await;
    state
        .sender
        .enqueue_with_keyboard(chat_id, reply.text, reply.keyboard);
    true
}

// -------------------- weekday parsing --------------------

fn day_token(tok: &str) -> Option<u32> {
    let t = tok.trim().to_lowercase();
    let idx = match t.as_str() {
        "mon" | "monday" | "пн" | "понеділок" => 0,
        "tue" | "tuesday" | "вт" | "вівторок" => 1,
        "wed" | "wednesday" | "ср" | "середа" => 2,
        "thu" | "thursday" | "чт" | "четвер" => 3,
        "fri" | "friday" | "пт" | "пʼятниця" | "п'ятниця" => 4,
        "sat" | "saturday" | "сб" | "субота" => 5,
        "sun" | "sunday" | "нд" | "неділя" => 6,
        _ => return None,
    };
    Some(idx)
}

/// Parse a weekday spec: a preset (`all`, `weekdays`, `weekends`, and
/// Ukrainian equivalents) or a comma/space list of day names.
pub(crate) fn parse_days(spec: &str) -> Option<u8> {
    let s = spec.trim().to_lowercase();
    match s.as_str() {
        "all" | "daily" | "every" | "everyday" | "щодня" | "усі" | "всі" => {
            return Some(DIGEST_ALL_DAYS)
        }
        "weekdays" | "workdays" | "будні" | "робочі" => return Some(DIGEST_WORKDAYS),
        "weekends" | "weekend" | "вихідні" => return Some(DIGEST_WEEKENDS),
        _ => {}
    }
    let mut mask = 0u8;
    for tok in s.split(|c: char| c == ',' || c.is_whitespace()) {
        if tok.is_empty() {
            continue;
        }
        mask |= 1 << day_token(tok)?;
    }
    (mask != 0).then_some(mask)
}

pub(crate) fn format_days(mask: u8) -> String {
    match mask & DIGEST_ALL_DAYS {
        DIGEST_ALL_DAYS => "щодня".into(),
        DIGEST_WORKDAYS => "будні".into(),
        DIGEST_WEEKENDS => "вихідні".into(),
        0 => "жодного дня".into(),
        m => (0..7)
            .filter(|i| m & (1 << i) != 0)
            .map(|i| WEEKDAY_SHORT[i as usize])
            .collect::<Vec<_>>()
            .join(", "),
    }
}

fn days_to_names(mask: u8) -> Vec<&'static str> {
    const EN: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    (0..7)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| EN[i as usize])
        .collect()
}

// -------------------- /digest --------------------

pub struct DigestCmd {
    telegram: Arc<TelegramState>,
}

impl DigestCmd {
    pub fn new(telegram: Arc<TelegramState>) -> Self {
        Self { telegram }
    }
}

const TIME_PRESETS: [&str; 3] = ["07:00", "08:00", "09:00"];

fn settings_card(s: &DigestSettings, notice: Option<&str>) -> Reply {
    let mut text = String::new();
    if let Some(n) = notice {
        text.push_str(n);
        text.push_str("\n\n");
    }
    text.push_str(&format!(
        "🌅 *Ранковий дайджест*\n\nСтатус: {}\nЧас: {}\nДні: {}",
        if s.enabled {
            "✅ увімкнено"
        } else {
            "⏸ вимкнено"
        },
        s.time,
        format_days(s.weekdays),
    ));
    let mark = |on: bool, label: &str| {
        if on {
            format!("• {label}")
        } else {
            label.to_string()
        }
    };
    let toggle = if s.enabled {
        InlineButton::new("⏸ Вимкнути", "refresh:digest:off")
    } else {
        InlineButton::new("✅ Увімкнути", "refresh:digest:on")
    };
    let times = TIME_PRESETS
        .iter()
        .map(|t| InlineButton::new(mark(s.time == *t, t), format!("refresh:digest:time {t}")))
        .collect();
    let days = [
        (DIGEST_ALL_DAYS, "Щодня", "all"),
        (DIGEST_WORKDAYS, "Будні", "weekdays"),
        (DIGEST_WEEKENDS, "Вихідні", "weekends"),
    ]
    .iter()
    .map(|(m, label, arg)| {
        InlineButton::new(
            mark(s.weekdays == *m, label),
            format!("refresh:digest:days {arg}"),
        )
    })
    .collect();
    Reply {
        text,
        keyboard: Some(InlineKeyboard {
            rows: vec![
                vec![toggle],
                times,
                days,
                vec![
                    InlineButton::new("📨 Надіслати зараз", "digest:now"),
                    InlineButton::new("☰ Меню", "menu"),
                ],
            ],
        }),
        ..Default::default()
    }
}

#[async_trait]
impl CommandHandler for DigestCmd {
    fn name(&self) -> &'static str {
        "digest"
    }
    fn description(&self) -> &'static str {
        "Ранковий дайджест: cockpit + нагадування на сьогодні за розкладом"
    }
    fn usage(&self) -> &'static str {
        "/digest [on|off|time HH:MM|days будні|now]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let args = args.trim();
        let (verb, rest) = args
            .split_once(char::is_whitespace)
            .map(|(a, b)| (a, b.trim()))
            .unwrap_or((args, ""));
        let state = &self.telegram;
        let current = DigestSettings::load(state);
        let update = |next: DigestSettings, ok: &str| match apply_settings(state, next) {
            Ok(saved) => settings_card(&saved, Some(ok)),
            Err(e) => settings_card(&current, Some(&format!("⚠️ {e}"))),
        };
        match verb.to_lowercase().as_str() {
            "" | "show" | "settings" => settings_card(&current, None),
            "on" => update(
                DigestSettings {
                    enabled: true,
                    ..current.clone()
                },
                "✅ Дайджест увімкнено",
            ),
            "off" => update(
                DigestSettings {
                    enabled: false,
                    ..current.clone()
                },
                "⏸ Дайджест вимкнено",
            ),
            "time" => match normalize_hhmm(rest) {
                Some(time) => update(
                    DigestSettings {
                        time: time.clone(),
                        ..current.clone()
                    },
                    &format!("⏰ Час дайджесту: {time}"),
                ),
                None => settings_card(
                    &current,
                    Some("⚠️ Формат часу: HH:MM, напр. `/digest time 08:30`"),
                ),
            },
            "days" => match parse_days(rest) {
                Some(mask) => update(
                    DigestSettings {
                        weekdays: mask,
                        ..current.clone()
                    },
                    &format!("📆 Дні: {}", format_days(mask)),
                ),
                None => settings_card(
                    &current,
                    Some("⚠️ Дні: `all`, `weekdays`, `weekends` або список `пн,ср,пт`"),
                ),
            },
            "now" | "preview" => build_digest(&ctx.app, state).await,
            _ => Reply::text(format!("Usage: `{}`", self.usage())),
        }
    }
}

// -------------------- LLM tool --------------------

pub struct ConfigureDigest;

fn settings_json(s: &DigestSettings) -> Value {
    json!({
        "enabled": s.enabled,
        "time": s.time,
        "weekdays": days_to_names(s.weekdays),
    })
}

#[async_trait]
impl Tool for ConfigureDigest {
    fn name(&self) -> &'static str {
        "configure_digest"
    }
    fn description(&self) -> &'static str {
        "Read or change the scheduled morning digest (dashboard + today's \
         reminders pushed to Telegram once a day). Omit every field to just \
         read the current settings. `time` is local 24h HH:MM. `weekdays` is \
         either a preset ('all', 'weekdays', 'weekends') or a list of days \
         ('mon'..'sun'). Set `send_now: true` to push the digest immediately. \
         Returns the resulting settings."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "enabled": { "type": "boolean", "description": "Turn the daily digest on/off." },
                "time": { "type": "string", "pattern": "^\\d{1,2}:\\d{2}$", "description": "Local send time, HH:MM (24h)." },
                "weekdays": {
                    "description": "Preset 'all' | 'weekdays' | 'weekends', or a list like ['mon','wed','fri'].",
                    "oneOf": [
                        { "type": "string", "enum": ["all", "weekdays", "weekends"] },
                        { "type": "array", "items": { "type": "string", "enum": ["mon","tue","wed","thu","fri","sat","sun"] }, "minItems": 1 }
                    ]
                },
                "send_now": { "type": "boolean", "description": "Push the digest to Telegram right now." }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let mut next = DigestSettings::load(&ctx.state);
        let mut changed = false;
        if let Some(b) = args.get("enabled").and_then(Value::as_bool) {
            next.enabled = b;
            changed = true;
        }
        if let Some(t) = args.get("time").and_then(Value::as_str) {
            next.time =
                normalize_hhmm(t).ok_or_else(|| format!("invalid time '{t}', expected HH:MM"))?;
            changed = true;
        }
        if let Some(w) = args.get("weekdays") {
            let spec = match w {
                Value::String(s) => s.clone(),
                Value::Array(a) => a
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
                _ => return Err("weekdays must be a string or array".into()),
            };
            next.weekdays =
                parse_days(&spec).ok_or_else(|| format!("invalid weekdays '{spec}'"))?;
            changed = true;
        }
        let saved = if changed {
            apply_settings(&ctx.state, next)?
        } else {
            next
        };
        let mut out = settings_json(&saved);
        if args.get("send_now").and_then(Value::as_bool) == Some(true) {
            let app = ctx
                .app
                .as_ref()
                .ok_or_else(|| "send_now needs the app handle".to_string())?;
            let sent = send_digest(app, &ctx.state).await;
            out["sent"] = json!(sent);
            if !sent {
                out["reason"] = json!("not_paired");
            }
        }
        Ok(out)
    }
}

// -------------------- Tauri commands --------------------

#[tauri::command]
pub fn telegram_get_digest_settings(
    state: tauri::State<'_, Arc<TelegramState>>,
) -> Result<DigestSettings, String> {
    Ok(DigestSettings::load(state.as_ref()))
}

#[tauri::command]
pub fn telegram_set_digest_settings(
    state: tauri::State<'_, Arc<TelegramState>>,
    settings: DigestSettings,
) -> Result<DigestSettings, String> {
    apply_settings(state.as_ref(), settings)
}

/// Push the digest now. Resolves `false` when the bot isn't paired.
#[tauri::command]
pub async fn telegram_send_digest_now(app: AppHandle) -> Result<bool, String> {
    let state = app
        .try_state::<Arc<TelegramState>>()
        .map(|s| Arc::clone(s.inner()))
        .ok_or_else(|| "telegram state not initialised".to_string())?;
    Ok(send_digest(&app, &state).await)
}

#[cfg(test)]
mod tests {
    #[test]
    fn minutes_until_midnight_counts_rest_of_local_day() {
        // 23:00 UTC with +2h offset → 01:00 local → 23h left.
        assert_eq!(super::minutes_until_local_midnight(82_800, 7_200), 23 * 60);
        assert_eq!(super::minutes_until_local_midnight(86_399, 0), 1);
    }

    use super::*;

    fn s(enabled: bool, time: &str, weekdays: u8) -> DigestSettings {
        DigestSettings {
            enabled,
            time: time.into(),
            weekdays,
        }
    }

    /// Local timestamp for day `day` (days since epoch) at HH:MM.
    fn at(day: i64, h: i64, m: i64) -> i64 {
        day * DAY_SECS + h * 3600 + m * 60
    }

    // 2026-10-26 is a Monday: days since epoch = 20752.
    const MONDAY: i64 = 20_752;

    #[test]
    fn weekday_index_known_dates() {
        assert_eq!(weekday_index(0), 3, "1970-01-01 was a Thursday");
        assert_eq!(weekday_index(MONDAY), 0);
        assert_eq!(weekday_index(MONDAY + 6), 6);
    }

    #[test]
    fn fires_at_or_after_time_once_per_day() {
        let cfg = s(true, "08:00", DIGEST_ALL_DAYS);
        assert!(!should_send(at(MONDAY, 7, 59), &cfg, None, None));
        assert!(should_send(at(MONDAY, 8, 0), &cfg, None, None));
        assert!(should_send(at(MONDAY, 8, 1), &cfg, Some(MONDAY - 1), None));
        assert!(
            !should_send(at(MONDAY, 8, 1), &cfg, Some(MONDAY), None),
            "already sent today"
        );
    }

    #[test]
    fn catch_up_window_is_three_hours() {
        let cfg = s(true, "08:00", DIGEST_ALL_DAYS);
        assert!(should_send(at(MONDAY, 10, 59), &cfg, None, None));
        assert!(!should_send(at(MONDAY, 11, 0), &cfg, None, None));
    }

    #[test]
    fn respects_disabled_and_weekday_mask() {
        assert!(!should_send(
            at(MONDAY, 9, 0),
            &s(false, "08:00", DIGEST_ALL_DAYS),
            None,
            None
        ));
        let weekends = s(true, "08:00", DIGEST_WEEKENDS);
        assert!(!should_send(at(MONDAY, 9, 0), &weekends, None, None));
        assert!(
            should_send(at(MONDAY + 5, 9, 0), &weekends, None, None),
            "Saturday"
        );
    }

    #[test]
    fn enabling_after_time_suppresses_today() {
        let off = s(false, "08:00", DIGEST_ALL_DAYS);
        let on = s(true, "08:00", DIGEST_ALL_DAYS);
        let now = at(MONDAY, 10, 0);
        assert_eq!(suppressed_day_after_change(&off, &on, now, None), Some(MONDAY));
        assert_eq!(suppressed_day_after_change(&off, &on, at(MONDAY, 7, 0), None), None);
        // Moving the time earlier than now counts as a change.
        let earlier = s(true, "07:00", DIGEST_ALL_DAYS);
        let later = s(true, "18:00", DIGEST_ALL_DAYS);
        assert_eq!(suppressed_day_after_change(&later, &earlier, now, None), Some(MONDAY));
        // Disabling clears.
        assert_eq!(suppressed_day_after_change(&on, &off, now, Some(MONDAY)), None);
    }

    #[test]
    fn suppression_is_recomputed_on_every_change() {
        // Retyping 08:00 → 07:45 at 07:30 passes through 07:00.
        let now = at(MONDAY, 7, 30);
        let a = s(true, "08:00", DIGEST_ALL_DAYS);
        let mid = s(true, "07:00", DIGEST_ALL_DAYS);
        let fin = s(true, "07:45", DIGEST_ALL_DAYS);
        let sup = suppressed_day_after_change(&a, &mid, now, None);
        assert_eq!(sup, Some(MONDAY));
        let sup = suppressed_day_after_change(&mid, &fin, now, sup);
        assert_eq!(sup, None, "final target is still ahead today");
        assert!(should_send(at(MONDAY, 7, 45), &fin, None, sup));

        // Enabled at 10:00 for 08:00, then moved to 11:00 → fires at 11:00.
        let off = s(false, "08:00", DIGEST_ALL_DAYS);
        let on = s(true, "08:00", DIGEST_ALL_DAYS);
        let eleven = s(true, "11:00", DIGEST_ALL_DAYS);
        let sup = suppressed_day_after_change(&off, &on, at(MONDAY, 10, 0), None);
        assert!(!should_send(at(MONDAY, 10, 1), &on, None, sup));
        let sup = suppressed_day_after_change(&on, &eleven, at(MONDAY, 10, 5), sup);
        assert_eq!(sup, None);
        assert!(should_send(at(MONDAY, 11, 0), &eleven, None, sup));
    }

    #[test]
    fn adding_todays_weekday_after_time_does_not_fire() {
        let weekends = s(true, "08:00", DIGEST_WEEKENDS);
        let all = s(true, "08:00", DIGEST_ALL_DAYS);
        let now = at(MONDAY, 9, 0);
        let sup = suppressed_day_after_change(&weekends, &all, now, None);
        assert_eq!(sup, Some(MONDAY));
        assert!(!should_send(at(MONDAY, 9, 1), &all, None, sup));
        // Next day fires normally (stale suppression is ignored).
        assert!(should_send(at(MONDAY + 1, 8, 0), &all, None, sup));
    }

    #[test]
    fn noop_save_keeps_suppression_but_drops_stale_days() {
        let on = s(true, "08:00", DIGEST_ALL_DAYS);
        let now = at(MONDAY, 9, 0);
        assert_eq!(suppressed_day_after_change(&on, &on, now, Some(MONDAY)), Some(MONDAY));
        assert_eq!(suppressed_day_after_change(&on, &on, now, Some(MONDAY - 1)), None);
        assert_eq!(suppressed_day_after_change(&on, &on, now, None), None);
    }

    #[test]
    fn parse_and_format_days() {
        assert_eq!(parse_days("all"), Some(DIGEST_ALL_DAYS));
        assert_eq!(parse_days("Будні"), Some(DIGEST_WORKDAYS));
        assert_eq!(parse_days("weekends"), Some(DIGEST_WEEKENDS));
        assert_eq!(parse_days("mon, wed fri"), Some(0b001_0101));
        assert_eq!(parse_days("пн,ср,пт"), Some(0b001_0101));
        assert_eq!(parse_days("mon,blah"), None);
        assert_eq!(parse_days(""), None);
        assert_eq!(format_days(DIGEST_ALL_DAYS), "щодня");
        assert_eq!(format_days(0b001_0101), "пн, ср, пт");
        assert_eq!(days_to_names(DIGEST_WEEKENDS), vec!["sat", "sun"]);
    }

    fn rem(id: i64, text: &str, due_at: i64) -> Reminder {
        Reminder {
            id,
            text: text.into(),
            due_at,
            sent: false,
            cancelled: false,
        }
    }

    #[test]
    fn today_reminders_filters_and_sorts() {
        let offset = 3 * 3600;
        // "now" = Monday 07:00 local.
        let now = at(MONDAY, 7, 0) - offset;
        let list = vec![
            rem(1, "пізніше", at(MONDAY, 18, 30) - offset),
            rem(2, "зранку", at(MONDAY, 9, 15) - offset),
            rem(3, "завтра", at(MONDAY + 1, 9, 0) - offset),
        ];
        let out = format_today_reminders(&list, now, offset);
        assert_eq!(out, "📅 *Сьогодні:*\n• 09:15 — зранку\n• 18:30 — пізніше");
        assert_eq!(
            format_today_reminders(&list[2..], now, offset),
            "📅 Сьогодні нагадувань немає."
        );
    }

    #[test]
    fn card_buttons_fit_callback_limit() {
        let card = settings_card(&s(true, "08:00", DIGEST_WORKDAYS), Some("ok"));
        let kb = card.keyboard.unwrap();
        let cbs: Vec<&str> = kb
            .rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.as_str())
            .collect();
        assert!(cbs.contains(&"refresh:digest:off"));
        assert!(cbs.contains(&"refresh:digest:time 08:00"));
        assert!(cbs.iter().all(|c| c.len() <= 64));
        for b in digest_keyboard().rows.iter().flatten() {
            assert!(b.callback_data.len() <= 64);
        }
    }
}
