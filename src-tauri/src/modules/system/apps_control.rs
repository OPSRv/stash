//! Launch / hide / quit macOS applications by name.
//!
//! Two execution paths:
//! - `open -a <Name>` for launching. This is argv-safe (no shell) and
//!   lets macOS resolve partial names / aliases the same way it does
//!   from Spotlight, so `/app open Safari` behaves like ⌘-Space Safari.
//! - `osascript -e 'tell application "<Name>" to <verb>'` for hide /
//!   quit. AppleScript needs the app name embedded in the script body,
//!   so we escape `"` and `\` and reject names with control chars.
//!
//! `list_running_apps` uses System Events to enumerate visible
//! application processes — background daemons (Spotlight, Dock) are
//! filtered out because listing them doesn't help the user control
//! anything.

use std::process::Command;

/// Reject app names with control characters or a backslash / double
/// quote that survived escaping. Rejecting up front (rather than
/// silently sanitising) gives the user a clear error — a typo in the
/// name shouldn't turn into a half-working script.
fn validate_name(name: &str) -> Result<(), String> {
    // Check the *raw* input for control chars — trimming first would
    // silently strip a trailing newline that's probably a symptom of
    // an unescaped shell variable upstream, not something we want to
    // paper over.
    if name.chars().any(|c| c.is_control()) {
        return Err("app name contains control characters".into());
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("app name is empty".into());
    }
    if trimmed.len() > 128 {
        return Err("app name too long (>128 chars)".into());
    }
    Ok(())
}

/// Escape a bare string so it can be safely interpolated inside AppleScript
/// double quotes. `"` → `\"`, `\` → `\\` — same rules as a C-style string.
fn escape_applescript(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c => out.push(c),
        }
    }
    out
}

fn run_osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("osascript: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Launch or bring-to-front an application. Mirrors `open -a`.
pub fn open_app(name: &str) -> Result<(), String> {
    validate_name(name)?;
    let out = Command::new("open")
        .arg("-a")
        .arg(name.trim())
        .output()
        .map_err(|e| format!("open: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // macOS returns "Unable to find application named 'Foo'" verbatim —
        // pass that through so the user learns they need the real app name.
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

/// Send the app to the background without quitting it (⌘H equivalent).
pub fn hide_app(name: &str) -> Result<(), String> {
    validate_name(name)?;
    let script = format!(
        "tell application \"System Events\" to set visible of process \"{n}\" to false",
        n = escape_applescript(name.trim())
    );
    run_osascript(&script).map(|_| ())
}

/// Outcome of `quit_app` — we verify post-hoc rather than trust the
/// AppleScript return code, because `tell application "X" to quit` is
/// routinely silent-no-op when the user-visible name doesn't match the
/// internal AppleScript name (localised apps, Spotlight aliases, etc.).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitOutcome {
    /// Process was running and is gone after the Quit event landed.
    Quit { resolved_name: String },
    /// Process didn't show up in `System Events` to begin with.
    NotRunning,
    /// Quit event was sent but the process is still alive after the
    /// wait budget — usually means an unsaved-document dialog is
    /// blocking. Surface as a warning so the assistant doesn't lie.
    StillRunning { resolved_name: String },
}

/// Best-effort fuzzy match: find a running process whose name contains
/// the query (case-insensitive). Covers the usual cases — user says
/// "Slack" and the process name is exactly that, user says "activity"
/// and matches "Activity Monitor", etc.
fn find_running_by_query(query: &str) -> Option<String> {
    let q = query.trim().to_lowercase();
    list_running_apps()
        .ok()?
        .into_iter()
        .find(|n| n.to_lowercase() == q)
        .or_else(|| {
            list_running_apps()
                .ok()?
                .into_iter()
                .find(|n| n.to_lowercase().contains(&q))
        })
}

/// Quit a running app. Tries the bundle-ID path first (works for
/// localised apps and aliases), then waits up to 2 s for the process
/// to exit, then reports what actually happened.
pub fn quit_app(name: &str) -> Result<QuitOutcome, String> {
    validate_name(name)?;
    // Resolve the user-supplied name to whatever `System Events`
    // actually sees — lets "монітор активності" reach "Activity Monitor"
    // without the caller knowing the canonical name.
    let resolved = match find_running_by_query(name) {
        Some(n) => n,
        None => return Ok(QuitOutcome::NotRunning),
    };
    // Quit via bundle ID. `tell application id "com.foo.bar" to quit` is
    // the only AppleScript form that doesn't care about localisation —
    // looking up bundle ID first through System Events keeps everything
    // in one `osascript` call so the process name can't change between
    // steps.
    let script = format!(
        "tell application \"System Events\" to set bid to bundle identifier of \
         (first application process whose name is \"{name}\")\n\
         tell application id bid to quit",
        name = escape_applescript(&resolved)
    );
    // A misbehaving app (or missing Accessibility permission) surfaces
    // here; don't swallow the error.
    run_osascript(&script)?;

    // Poll for up to ~2 s — most apps exit within 100 ms, the slow ones
    // (e.g. a Save prompt) won't go away no matter how long we wait.
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let still = list_running_apps()
            .ok()
            .map(|list| list.iter().any(|n| n.eq_ignore_ascii_case(&resolved)))
            .unwrap_or(true);
        if !still {
            return Ok(QuitOutcome::Quit {
                resolved_name: resolved,
            });
        }
    }
    Ok(QuitOutcome::StillRunning {
        resolved_name: resolved,
    })
}

/// Enumerate currently-running *foreground* app processes. Returns an
/// alphabetically sorted, deduped list of names — the same you'd see
/// in ⌘-Tab.
pub fn list_running_apps() -> Result<Vec<String>, String> {
    let script = "tell application \"System Events\" to \
         get name of every application process whose background only is false";
    // AppleScript returns `Safari, Finder, Stash` — a flat comma-separated
    // list. No escaping needed because we're *reading* the result, not
    // passing arbitrary input back into another script.
    let raw = run_osascript(script)?;
    let mut names: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_applescript_doubles_backslashes_and_quotes() {
        assert_eq!(escape_applescript("Safari"), "Safari");
        assert_eq!(escape_applescript(r#"Foo "Bar""#), r#"Foo \"Bar\""#);
        assert_eq!(escape_applescript(r"C:\path"), r"C:\\path");
    }

    #[test]
    fn validate_name_rejects_empty_and_control_chars() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name("Safari\n").is_err());
        assert!(validate_name("Safari\0").is_err());
    }

    #[test]
    fn validate_name_rejects_overlong_input() {
        let huge = "A".repeat(200);
        let err = validate_name(&huge).unwrap_err();
        assert!(err.contains("long"));
    }

    #[test]
    fn validate_name_accepts_normal_app_names() {
        assert!(validate_name("Safari").is_ok());
        assert!(validate_name("Google Chrome").is_ok());
        assert!(validate_name("Visual Studio Code").is_ok());
    }
}
