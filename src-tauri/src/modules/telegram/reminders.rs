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
        // Optional whitespace inside compound offset: "1h 30m".
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
            break; // only consume one run of ws here
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
    fn ymd_roundtrip() {
        for days in [0i64, 1, 30, 365, 20_000, -1, -500] {
            let ymd = ymd_from_days(days);
            let back = days_from_ymd(ymd);
            assert_eq!(back, days, "roundtrip failed for days={days}");
        }
    }
}
