//! Mirror scheduled /remind entries into the native macOS Reminders.app
//! so the alert also rings on iPhone/iPad via iCloud sync.
//!
//! Uses AppleScript — Reminders has full scripting support. Creating a
//! reminder returns its Reminders.app id (`x-apple-reminder://…`), which
//! the Stash side stores so a later snooze / cancel / done in the bot can
//! move, delete or complete the very same item. Stash stays the source
//! of truth; Reminders.app is just the cross-device notifier.

use std::process::Command;

/// Escape a string so it survives interpolation inside an AppleScript
/// string literal: `"` and `\` get backslash-escaped, newlines / tabs map
/// to AppleScript's `\n` / `\r` / `\t` escapes, and any other control
/// character is dropped (it would render as garbage in Reminders.app).
fn escape_applescript(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Local wall-clock components of a due date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalDateTime {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
}

/// AppleScript statements that build the date into variable `dueDate`
/// component by component. Parsing a `date "…"` string literal follows
/// the user's locale date format and can misread under non-US settings;
/// setting the properties numerically can't. `day` goes to 1 first so
/// e.g. Jan 31 → Feb never overflows into March mid-assignment.
fn applescript_date_setup(dt: LocalDateTime) -> String {
    format!(
        "set dueDate to current date\n\
         set day of dueDate to 1\n\
         set year of dueDate to {y}\n\
         set month of dueDate to {m}\n\
         set day of dueDate to {d}\n\
         set time of dueDate to {t}\n",
        y = dt.year,
        m = dt.month,
        d = dt.day,
        t = dt.hour * 3600 + dt.minute * 60,
    )
}

/// Script that creates a reminder in the default list and prints its id.
fn create_script(title: &str, due: LocalDateTime) -> String {
    format!(
        "{date}tell application \"Reminders\"\n\
         set r to make new reminder with properties {{name:\"{name}\", due date:dueDate}}\n\
         return id of r\n\
         end tell",
        date = applescript_date_setup(due),
        name = escape_applescript(title),
    )
}

/// Script that moves an existing reminder to a new due date and re-opens
/// it (a snoozed reminder that already rang may have been ticked off).
fn set_due_script(ext_id: &str, due: LocalDateTime) -> String {
    format!(
        "{date}tell application \"Reminders\"\n\
         set r to reminder id \"{id}\"\n\
         set due date of r to dueDate\n\
         set completed of r to false\n\
         end tell",
        date = applescript_date_setup(due),
        id = escape_applescript(ext_id),
    )
}

fn delete_script(ext_id: &str) -> String {
    format!(
        "tell application \"Reminders\" to delete reminder id \"{}\"",
        escape_applescript(ext_id)
    )
}

fn complete_script(ext_id: &str) -> String {
    format!(
        "tell application \"Reminders\" to set completed of reminder id \"{}\" to true",
        escape_applescript(ext_id)
    )
}

/// Run a script and return its trimmed stdout.
fn run_osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Reminders.app: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Create a reminder in the default list and return its Reminders.app id.
/// `due_unix_secs` is interpreted in the user's *local* timezone —
/// Reminders.app stores the due date as a local wall-clock time,
/// matching what the user typed.
pub fn create_reminder(title: &str, due_unix_secs: i64) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("reminder title is empty".into());
    }
    let due = split_local(due_unix_secs)?;
    let id = run_osascript(&create_script(title, due))?;
    if id.is_empty() {
        return Err("Reminders.app returned no id".into());
    }
    Ok(id)
}

/// Move the reminder `ext_id` to a new due date (and mark it incomplete).
pub fn update_due(ext_id: &str, due_unix_secs: i64) -> Result<(), String> {
    let due = split_local(due_unix_secs)?;
    run_osascript(&set_due_script(ext_id, due)).map(|_| ())
}

/// Delete the reminder `ext_id` from Reminders.app.
pub fn delete_reminder(ext_id: &str) -> Result<(), String> {
    run_osascript(&delete_script(ext_id)).map(|_| ())
}

/// Mark the reminder `ext_id` as completed in Reminders.app.
pub fn complete_reminder(ext_id: &str) -> Result<(), String> {
    run_osascript(&complete_script(ext_id)).map(|_| ())
}

/// Break a unix timestamp into local `(year, month, day, hour, minute)`.
/// Uses `date -r` (macOS BSD date) which honours the system timezone —
/// avoids pulling `chrono` just for this single conversion.
fn split_local(ts: i64) -> Result<LocalDateTime, String> {
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
    let y: i32 = parts[0]
        .parse()
        .map_err(|_| format!("bad year: {}", parts[0]))?;
    let m: u32 = parts[1]
        .parse()
        .map_err(|_| format!("bad month: {}", parts[1]))?;
    let d: u32 = parts[2]
        .parse()
        .map_err(|_| format!("bad day: {}", parts[2]))?;
    let h: u32 = parts[3]
        .parse()
        .map_err(|_| format!("bad hour: {}", parts[3]))?;
    let mi: u32 = parts[4]
        .parse()
        .map_err(|_| format!("bad minute: {}", parts[4]))?;
    Ok(LocalDateTime {
        year: y,
        month: m,
        day: d,
        hour: h,
        minute: mi,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: LocalDateTime = LocalDateTime {
        year: 2026,
        month: 4,
        day: 25,
        hour: 9,
        minute: 5,
    };

    #[test]
    fn date_setup_is_numeric_and_resets_day_first() {
        let s = applescript_date_setup(DT);
        assert_eq!(
            s,
            "set dueDate to current date\n\
             set day of dueDate to 1\n\
             set year of dueDate to 2026\n\
             set month of dueDate to 4\n\
             set day of dueDate to 25\n\
             set time of dueDate to 32700\n"
        );
    }

    #[test]
    fn escape_applescript_doubles_quotes_and_backslashes() {
        assert_eq!(escape_applescript(r#"say "hi""#), r#"say \"hi\""#);
        assert_eq!(escape_applescript(r"a\b"), r"a\\b");
    }

    #[test]
    fn escape_applescript_maps_newlines_and_drops_other_controls() {
        assert_eq!(escape_applescript("a\nb\r\tc"), r"a\nb\r\tc");
        assert_eq!(escape_applescript("x\u{7}y\u{0}z"), "xyz");
        assert_eq!(escape_applescript("кава ☕"), "кава ☕");
    }

    #[test]
    fn create_script_returns_id_and_escapes_title() {
        let s = create_script("call \"mom\"\nthen \\ rest", DT);
        assert!(s.starts_with("set dueDate to current date\n"));
        assert!(s.contains(
            r#"make new reminder with properties {name:"call \"mom\"\nthen \\ rest", due date:dueDate}"#
        ));
        assert!(s.contains("return id of r"));
        // The title's newline must not leak as a raw line break.
        assert!(!s.contains("mom\\\"\nthen"));
    }

    #[test]
    fn set_due_script_targets_item_and_reopens_it() {
        let s = set_due_script("x-apple-reminder://ABC", DT);
        assert!(s.contains(r#"set r to reminder id "x-apple-reminder://ABC""#));
        assert!(s.contains("set due date of r to dueDate"));
        assert!(s.contains("set completed of r to false"));
    }

    #[test]
    fn delete_and_complete_scripts_escape_the_id() {
        assert_eq!(
            delete_script("x-apple-reminder://A"),
            r#"tell application "Reminders" to delete reminder id "x-apple-reminder://A""#
        );
        assert_eq!(
            complete_script("a\"b"),
            r#"tell application "Reminders" to set completed of reminder id "a\"b" to true"#
        );
    }
}
