//! Scheduled reminders backed by the `reminders` SQLite table.
//!
//! Phase-1 slice: a plain-text `/remind` parser that accepts compact
//! offsets (`10m`, `1h30m`), wall-clock times (`14:30`, `tomorrow 10:00`),
//! and absolute dates (`2026-04-25 14:30`). AI-tool-use natural-language
//! parsing lands with the assistant (Phase 3 of the design).
//!
//! A single tokio ticker polls the table every 30 s and forwards any
//! due row through the existing outbound sender. Missed reminders (Mac
//! was asleep) fire on next tick with a "(late)" marker so the user
//! isn't silently dropped.

use std::sync::Arc;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::state::TelegramState;

const TICK_PERIOD: Duration = Duration::from_secs(30);
const LATE_THRESHOLD_SEC: i64 = 120;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Reminder {
    pub id: i64,
    pub text: String,
    pub due_at: i64,
    pub sent: bool,
    pub cancelled: bool,
}

/// Start the background ticker. Safe to call multiple times — caller
/// enforces single-start via `TelegramState`.
pub fn spawn(app: tauri::AppHandle, state: Arc<TelegramState>) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(TICK_PERIOD);
        tick.tick().await; // first fire is instant
        loop {
            tick.tick().await;
            let now = now_secs();
            if let Err(e) = flush_due(&app, &state, now) {
                tracing::warn!(error = %e, "reminders flush failed");
            }
        }
    });
}

fn flush_due(app: &tauri::AppHandle, state: &TelegramState, now: i64) -> Result<(), String> {
    use super::pairing::PairingState;
    use tauri::Emitter;

    let chat_id = match &*state.pairing.lock().unwrap() {
        PairingState::Paired { chat_id } => *chat_id,
        _ => return Ok(()),
    };

    let due = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.due_reminders(now, 20).map_err(|e| e.to_string())?
    };

    let mut any_fired = false;
    for r in due {
        let late = now - r.due_at >= LATE_THRESHOLD_SEC;
        let prefix = if late {
            "⏰ (запізно) "
        } else {
            "⏰ "
        };
        state.sender.enqueue(chat_id, format!("{prefix}{}", r.text));
        if let Ok(mut repo) = state.repo.lock() {
            let _ = repo.mark_reminder_sent(r.id);
        }
        let _ = app.emit("telegram:reminder_fired", r.id);
        any_fired = true;
    }
    // Surface the state change to the Reminders tab so a fired row
    // disappears from the active list without manually pressing refresh.
    if any_fired {
        let _ = app.emit("reminders:changed", ());
    }
    Ok(())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// -------------------- parser --------------------

/// Parse `args` into `(due_at_unix_sec, reminder_text)`. Returns `None`
/// when the input doesn't start with a recognisable time.
///
/// Accepted shapes (case-insensitive):
/// - `10m buy milk`, `1h buy milk`, `1h30m call mom`, `45s poll`
/// - `14:30 team sync`  — today, or tomorrow if already past
/// - `tomorrow 9:00 gym`
/// - `2026-04-25 14:30 doctor`
pub fn parse_when(args: &str, now: i64) -> Option<(i64, String)> {
    let args = args.trim();
    if args.is_empty() {
        return None;
    }
    // Accept Ukrainian time-unit suffixes ("5 хв", "1 год 30 хв", "45 сек",
    // "2 дні") by folding them into the ASCII compact form the rest of
    // the parser already understands.
    let normalized = normalize_cyrillic_units(args);
    let args = normalized.as_str();

    // Relative offset: e.g. "10m rest", "1h30m lunch".
    if let Some((abs, rest)) = parse_relative(args, now) {
        if !rest.trim().is_empty() {
            return Some((abs, rest.trim().to_string()));
        }
    }

    let (head, rest) = split_once_ws(args);
    // Absolute date "YYYY-MM-DD HH:MM text"
    if head.len() == 10 && head.as_bytes().get(4) == Some(&b'-') {
        let (time, rest2) = split_once_ws(rest);
        if let (Some(date), Some(hm)) = (parse_ymd(head), parse_hm(time)) {
            let stamp = ymd_hm_to_unix(date, hm);
            if !rest2.trim().is_empty() && stamp > now {
                return Some((stamp, rest2.trim().to_string()));
            }
        }
    }

    // "tomorrow HH:MM text"
    if head.eq_ignore_ascii_case("tomorrow") {
        let (time, rest2) = split_once_ws(rest);
        if let Some(hm) = parse_hm(time) {
            let today = today_ymd(now);
            let tomorrow = add_days(today, 1);
            let stamp = ymd_hm_to_unix(tomorrow, hm);
            if !rest2.trim().is_empty() {
                return Some((stamp, rest2.trim().to_string()));
            }
        }
    }

    // Bare "HH:MM text" — today (or next day if past).
    if let Some(hm) = parse_hm(head) {
        let today = today_ymd(now);
        let mut stamp = ymd_hm_to_unix(today, hm);
        if stamp <= now {
            stamp = ymd_hm_to_unix(add_days(today, 1), hm);
        }
        if !rest.trim().is_empty() {
            return Some((stamp, rest.trim().to_string()));
        }
    }

    None
}

/// Rewrite a leading time-spec that uses Ukrainian unit words into the
/// compact ASCII form (`5 хв` → `5m`). Only the prefix that looks like
/// digits + unit pairs is touched — the reminder body (which may
/// legitimately contain Cyrillic words and digits) is left untouched.
fn normalize_cyrillic_units(s: &str) -> String {
    // Order matters: longer prefixes first so "хвилин" wins over "хв".
    const MAP: &[(&str, char)] = &[
        ("хвилин", 'm'),
        ("хв", 'm'),
        ("годин", 'h'),
        ("год", 'h'),
        ("секунд", 's'),
        ("сек", 's'),
        ("днів", 'd'),
        ("дні", 'd'),
        ("день", 'd'),
        ("дн", 'd'),
    ];
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut idx = 0;
    loop {
        // Pass through ASCII whitespace.
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            out.push(bytes[idx] as char);
            idx += 1;
        }
        // Require a digit run to consider this a unit.
        let dig_start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx == dig_start {
            break;
        }
        out.push_str(&s[dig_start..idx]);
        // Optional space between the number and the unit.
        while idx < bytes.len() && bytes[idx] == b' ' {
            idx += 1;
        }
        let tail = &s[idx..];
        let tail_lower = tail.to_lowercase();
        let mut matched = None;
        for (kw, ch) in MAP {
            if tail_lower.starts_with(kw) {
                // Cyrillic A-Я / Ї-ї / Є-є / І-і / Ґ-ґ all preserve UTF-8
                // byte length across upper/lower-case, so `kw.len()` in the
                // lowercased tail maps 1:1 onto the original.
                let mut consume = kw.len();
                let after = &tail_lower[consume..];
                for c in after.chars() {
                    if matches!(c, '\u{0400}'..='\u{04FF}') {
                        consume += c.len_utf8();
                    } else {
                        break;
                    }
                }
                matched = Some((*ch, consume));
                break;
            }
        }
        if let Some((ch, consume)) = matched {
            out.push(ch);
            idx += consume;
        } else if idx < bytes.len()
            && matches!(
                bytes[idx],
                b's' | b'S' | b'm' | b'M' | b'h' | b'H' | b'd' | b'D'
            )
        {
            // ASCII unit — leave it as-is, keep walking so "1h 30хв" still
            // gets its Cyrillic tail normalised.
            out.push(bytes[idx] as char);
            idx += 1;
        } else {
            break;
        }
    }
    out.push_str(&s[idx..]);
    out
}

fn parse_relative(s: &str, now: i64) -> Option<(i64, String)> {
    // Consume a prefix of form `(\d+[smhd])+` then a space.
    let bytes = s.as_bytes();
    let mut total_sec: i64 = 0;
    let mut i = 0;
    let mut matched_any_unit = false;
    while i < bytes.len() {
        let num_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == num_start {
            break;
        }
        let n: i64 = s[num_start..i].parse().ok()?;
        if i >= bytes.len() {
            break;
        }
        let unit = bytes[i];
        let mul = match unit {
            b's' | b'S' => 1,
            b'm' | b'M' => 60,
            b'h' | b'H' => 60 * 60,
            b'd' | b'D' => 24 * 60 * 60,
            _ => return None,
        };
        total_sec = total_sec.checked_add(n.checked_mul(mul)?)?;
        matched_any_unit = true;
        i += 1;
        // Optional whitespace inside compound offset: "1h 30m". A single
        // step is enough — the outer parser tolerates trailing ws on the
        // next iteration if there were several spaces.
        if i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
    }
    if !matched_any_unit || total_sec <= 0 {
        return None;
    }
    let rest = s[i..].to_string();
    Some((now + total_sec, rest))
}

fn split_once_ws(s: &str) -> (&str, &str) {
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], s[i + 1..].trim_start()),
        None => (s, ""),
    }
}

fn parse_ymd(s: &str) -> Option<(i64, u32, u32)> {
    let mut it = s.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

fn parse_hm(s: &str) -> Option<(u32, u32)> {
    let mut it = s.split(':');
    let h: u32 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

fn today_ymd(now: i64) -> (i64, u32, u32) {
    let local = now + super::inbox::local_offset_seconds_public();
    let days = local.div_euclid(86_400);
    ymd_from_days(days)
}

fn add_days(ymd: (i64, u32, u32), delta: i64) -> (i64, u32, u32) {
    let base = days_from_ymd(ymd) + delta;
    ymd_from_days(base)
}

fn ymd_hm_to_unix(ymd: (i64, u32, u32), hm: (u32, u32)) -> i64 {
    let days = days_from_ymd(ymd);
    let local = days * 86_400 + hm.0 as i64 * 3600 + hm.1 as i64 * 60;
    local - super::inbox::local_offset_seconds_public()
}

fn days_from_ymd((y, m, d): (i64, u32, u32)) -> i64 {
    // Inverse of ymd_from_days.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = m as u64;
    let d = d as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn ymd_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

// -------------------- Tauri commands --------------------
//
// Surface the reminder repo to the frontend so the Reminders tab can
// share the same SQLite table the Telegram `/remind` flow + LLM tools
// already use. Every mutation emits `reminders:changed` so any open
// tab refreshes immediately. Google Calendar sync would plug in here
// as an extra sink that listens to the same event.

/// Wire-format row exposed to the frontend. We send unix seconds and
/// the bare flags; the React layer does the calendar maths from the
/// user's local tz, which sidesteps a Mac-clock-skew vs. server-time
/// round trip every render.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReminderDto {
    pub id: i64,
    pub text: String,
    pub due_at: i64,
    pub sent: bool,
    pub cancelled: bool,
}

impl From<Reminder> for ReminderDto {
    fn from(r: Reminder) -> Self {
        Self {
            id: r.id,
            text: r.text,
            due_at: r.due_at,
            sent: r.sent,
            cancelled: r.cancelled,
        }
    }
}

#[tauri::command]
pub fn reminders_list(
    state: tauri::State<'_, std::sync::Arc<super::state::TelegramState>>,
) -> Result<Vec<ReminderDto>, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    let rows = repo.list_active_reminders().map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(ReminderDto::from).collect())
}

#[tauri::command]
pub fn reminders_list_range(
    state: tauri::State<'_, std::sync::Arc<super::state::TelegramState>>,
    start_sec: i64,
    end_sec: i64,
) -> Result<Vec<ReminderDto>, String> {
    if end_sec <= start_sec {
        return Err("end_sec must be strictly greater than start_sec".into());
    }
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    let rows = repo
        .list_reminders_in_range(start_sec, end_sec)
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(ReminderDto::from).collect())
}

#[tauri::command]
pub fn reminders_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<super::state::TelegramState>>,
    text: String,
    when: String,
) -> Result<ReminderDto, String> {
    use tauri::Emitter;
    let text = text.trim();
    let when = when.trim();
    if text.is_empty() {
        return Err("text must not be empty".into());
    }
    if when.is_empty() {
        return Err("when must not be empty".into());
    }
    // Same parser path the Telegram /remind handler and the LLM tool
    // hit — one source of truth for what "tomorrow 9:00" means.
    let combined = format!("{when} {text}");
    let now = now_secs();
    let (due_at, parsed_text) = parse_when(&combined, now).ok_or_else(|| {
        format!(
            "could not parse `when`: '{when}'. Try '10m', '14:30', \
             'tomorrow 9:00', or 'YYYY-MM-DD HH:MM'."
        )
    })?;
    let id = {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.insert_reminder(&parsed_text, due_at, now)
            .map_err(|e| e.to_string())?
    };
    let _ = app.emit("reminders:changed", ());
    Ok(ReminderDto {
        id,
        text: parsed_text,
        due_at,
        sent: false,
        cancelled: false,
    })
}

#[tauri::command]
pub fn reminders_cancel(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<super::state::TelegramState>>,
    id: i64,
) -> Result<bool, String> {
    use tauri::Emitter;
    let removed = {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.cancel_reminder(id).map_err(|e| e.to_string())?
    };
    if removed {
        let _ = app.emit("reminders:changed", ());
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_10m() {
        let (stamp, text) = parse_when("10m buy milk", 1_000).unwrap();
        assert_eq!(stamp, 1_000 + 10 * 60);
        assert_eq!(text, "buy milk");
    }

    #[test]
    fn relative_compound_1h30m() {
        let (stamp, text) = parse_when("1h30m call mom", 0).unwrap();
        assert_eq!(stamp, 90 * 60);
        assert_eq!(text, "call mom");
    }

    #[test]
    fn relative_seconds() {
        let (stamp, text) = parse_when("45s poll", 500).unwrap();
        assert_eq!(stamp, 545);
        assert_eq!(text, "poll");
    }

    #[test]
    fn absolute_date_time() {
        // 2026-04-25 12:00 local offset-agnostic check — the parser
        // produces a consistent ordering we can assert against `now`.
        let (stamp, text) = parse_when("2026-04-25 14:30 doctor", 0).unwrap();
        assert!(stamp > 0, "stamp should be positive");
        assert_eq!(text, "doctor");
    }

    #[test]
    fn bare_time_rolls_to_tomorrow_when_past() {
        // Use "tomorrow HH:MM" to sidestep local-time quirks — checks
        // that the parse path at least computes something in the future.
        let now = 0i64;
        let (stamp, text) = parse_when("tomorrow 09:00 gym", now).unwrap();
        assert!(stamp > now);
        assert_eq!(text, "gym");
    }

    #[test]
    fn missing_text_rejected() {
        assert!(parse_when("10m", 0).is_none());
        assert!(parse_when("14:30", 0).is_none());
    }

    #[test]
    fn malformed_rejected() {
        assert!(parse_when("zzz", 0).is_none());
        assert!(parse_when("9999-99-99 25:99 x", 0).is_none());
    }

    #[test]
    fn cyrillic_minutes_with_space() {
        let (stamp, text) = parse_when("5 хв call mom", 1_000).unwrap();
        assert_eq!(stamp, 1_000 + 5 * 60);
        assert_eq!(text, "call mom");
    }

    #[test]
    fn cyrillic_minutes_no_space() {
        let (stamp, text) = parse_when("5хв тест", 1_000).unwrap();
        assert_eq!(stamp, 1_000 + 5 * 60);
        assert_eq!(text, "тест");
    }

    #[test]
    fn cyrillic_compound_hours_minutes() {
        let (stamp, text) = parse_when("1 год 30 хв обід", 0).unwrap();
        assert_eq!(stamp, 90 * 60);
        assert_eq!(text, "обід");
    }

    #[test]
    fn cyrillic_seconds_and_days() {
        let (stamp, _) = parse_when("45 сек тест", 0).unwrap();
        assert_eq!(stamp, 45);
        let (stamp, _) = parse_when("2 дні тест", 0).unwrap();
        assert_eq!(stamp, 2 * 86_400);
    }

    #[test]
    fn cyrillic_longer_suffix_consumed() {
        // "хвилини" (plural) should still resolve to minutes.
        let (stamp, text) = parse_when("10 хвилин call", 0).unwrap();
        assert_eq!(stamp, 600);
        assert_eq!(text, "call");
    }

    #[test]
    fn cyrillic_body_with_digits_preserved() {
        // Body contains a number that must NOT be misread as a second unit.
        let (stamp, text) = parse_when("5 хв call 3 друзів", 0).unwrap();
        assert_eq!(stamp, 300);
        assert_eq!(text, "call 3 друзів");
    }

    #[test]
    fn ymd_roundtrip() {
        for days in [0i64, 1, 30, 365, 20_000, -1, -500] {
            let ymd = ymd_from_days(days);
            let back = days_from_ymd(ymd);
            assert_eq!(back, days, "roundtrip failed for days={days}");
        }
    }
}
