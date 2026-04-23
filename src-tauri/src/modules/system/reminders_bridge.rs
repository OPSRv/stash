//! Mirror scheduled /remind entries into the native macOS Reminders.app
//! so the alert also rings on iPhone/iPad via iCloud sync.
//!
//! Uses AppleScript — Reminders has full scripting support and lets us
//! create a reminder with a due date atomically. We don't read it back;
//! the Stash side stays the source of truth for the ID, Reminders.app
//! just acts as a notifier.

use std::process::Command;

/// Escape `"` and `\` so they survive interpolation inside an
/// AppleScript string literal. Same contract as `apps_control`.
fn escape_applescript(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c => out.push(c),
        }
    }
    out
}

/// Build an AppleScript literal for a `date` object expressed in
/// `month dd, yyyy hh:mm:ss` format, which AppleScript parses without
/// locale ambiguity across macOS versions. Using ISO-style `yyyy-mm-dd`
/// can silently flip meaning under non-US locales.
fn applescript_date_literal(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> String {
    let month_name = match month {
        1 => "January",
        2 => "February",
        3 => "March",
        4 => "April",
        5 => "May",
        6 => "June",
        7 => "July",
        8 => "August",
        9 => "September",
        10 => "October",
        11 => "November",
        12 => "December",
        _ => "January",
    };
    format!(
        "date \"{month_name} {day}, {year} {hour:02}:{minute:02}:00\""
    )
}

/// Create a reminder in the default list. `due_unix_secs` is interpreted
/// in the user's *local* timezone — Reminders.app stores the due date
/// as a local wall-clock time, matching what the user typed.
pub fn create_reminder(title: &str, due_unix_secs: i64) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("reminder title is empty".into());
    }
    if title.chars().any(|c| c.is_control()) {
        return Err("reminder title contains control characters".into());
    }
    let (year, month, day, hour, minute) = split_local(due_unix_secs)?;
    let script = format!(
        "tell application \"Reminders\" to \
         make new reminder with properties {{name:\"{name}\", due date:{due}}}",
        name = escape_applescript(title),
        due = applescript_date_literal(year, month, day, hour, minute)
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Reminders.app: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Break a unix timestamp into local `(year, month, day, hour, minute)`.
/// Uses `date -r` (macOS BSD date) which honours the system timezone —
/// avoids pulling `chrono` just for this single conversion.
fn split_local(ts: i64) -> Result<(i32, u32, u32, u32, u32), String> {
    let out = Command::new("date")
        .args(["-r", &ts.to_string(), "+%Y %m %d %H %M"])
        .output()
        .map_err(|e| format!("date: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "date: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parts: Vec<&str> = stdout.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(format!("date: unexpected output `{stdout}`"));
    }
    let y: i32 = parts[0].parse().map_err(|_| format!("bad year: {}", parts[0]))?;
    let m: u32 = parts[1].parse().map_err(|_| format!("bad month: {}", parts[1]))?;
    let d: u32 = parts[2].parse().map_err(|_| format!("bad day: {}", parts[2]))?;
    let h: u32 = parts[3].parse().map_err(|_| format!("bad hour: {}", parts[3]))?;
    let mi: u32 = parts[4].parse().map_err(|_| format!("bad minute: {}", parts[4]))?;
    Ok((y, m, d, h, mi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_date_literal_pads_hours_and_minutes() {
        let s = applescript_date_literal(2026, 4, 25, 9, 5);
        assert_eq!(s, "date \"April 25, 2026 09:05:00\"");
    }

    #[test]
    fn escape_applescript_doubles_quotes_and_backslashes() {
        assert_eq!(escape_applescript(r#"say "hi""#), r#"say \"hi\""#);
        assert_eq!(escape_applescript(r"a\b"), r"a\\b");
    }
}
