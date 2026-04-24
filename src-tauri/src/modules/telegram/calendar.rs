//! Calendar watcher — polls macOS Calendar.app via AppleScript for
//! events starting within the configured lead window and pushes a
//! Telegram alert when one crosses the threshold.
//!
//! AppleScript approach intentional: avoids pulling in `objc2-event-kit`
//! + entitlement plumbing for now. First access prompts the user for
//! Automation permission in System Settings → Privacy & Security →
//! Automation. If denied, the watcher logs a warning and stays silent.
//!
//! Dedup keyed by event UID in a `HashSet` so a 10-minute lead time
//! followed by a 60s poll doesn't ping the same event nine times.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;

use super::notifier::{notify_if_paired, Category};
use super::settings::NotificationSettings;

const POLL_PERIOD: Duration = Duration::from_secs(60);
/// How far ahead of the user-configured lead time we widen the fetch
/// window. Keeps the watcher from missing an event whose start drifts
/// past `lead_minutes` between two ticks.
const FETCH_SLACK_MIN: u32 = 5;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(POLL_PERIOD);
        tick.tick().await; // skip instant fire — startup isn't a real event
        let seen: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        loop {
            tick.tick().await;
            if let Err(e) = run_once(&app, &seen).await {
                tracing::debug!(error = %e, "calendar watcher tick failed");
            }
        }
    });
}

async fn run_once(app: &AppHandle, seen: &Mutex<HashSet<String>>) -> Result<(), String> {
    use tauri::Manager;

    let Some(state) = app.try_state::<std::sync::Arc<super::state::TelegramState>>() else {
        return Ok(());
    };
    let settings = NotificationSettings::load(&**state);
    if !settings.calendar {
        return Ok(());
    }
    let lead = settings.calendar_lead_minutes.max(1);
    let events = fetch_upcoming(lead + FETCH_SLACK_MIN)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    for ev in events {
        let delta = ev.starts_at - now;
        if delta < 0 || delta > (lead as i64) * 60 {
            continue;
        }
        let mut guard = seen.lock().unwrap();
        if !guard.insert(ev.uid.clone()) {
            continue;
        }
        drop(guard);
        let minutes = (delta / 60).max(0);
        let minute_word = if minutes == 1 { "minute" } else { "minutes" };
        let loc = ev
            .location
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| format!("\n📍 {s}"))
            .unwrap_or_default();
        notify_if_paired(
            app,
            Category::Calendar,
            format!("📅 {} in {minutes} {minute_word}{loc}", ev.title.trim()),
        );
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct UpcomingEvent {
    uid: String,
    title: String,
    starts_at: i64, // unix seconds
    location: Option<String>,
}

/// Query Calendar.app for events starting in the next `window_min` minutes.
/// Output format: tab-separated `UID\tTITLE\tEPOCH\tLOCATION`, one per line.
fn fetch_upcoming(window_min: u32) -> Result<Vec<UpcomingEvent>, String> {
    let script = format!(
        r#"set w to {window_min} * minutes
set a to (current date)
set b to a + w
set out to ""
tell application "Calendar"
  try
    repeat with c in calendars
      set es to (every event of c whose start date >= a and start date <= b)
      repeat with e in es
        set t to (summary of e)
        set u to (uid of e)
        set s to ((start date of e) - (date "Thursday, January 1, 1970 at 00:00:00"))
        set l to ""
        try
          set l to (location of e)
        end try
        set out to out & u & tab & t & tab & s & tab & l & linefeed
      end repeat
    end repeat
  end try
end tell
return out"#
    );
    let out = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("osascript spawn: {e}"))?;
    if !out.status.success() {
        // Permission denied / Calendar unavailable — don't propagate as
        // error, just no events this tick.
        tracing::debug!(
            stderr = %String::from_utf8_lossy(&out.stderr),
            "calendar osascript exited non-zero"
        );
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut events = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\t');
        let uid = parts.next().unwrap_or("").to_string();
        let title = parts.next().unwrap_or("").to_string();
        let secs_str = parts.next().unwrap_or("");
        let location = parts
            .next()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        let Ok(secs_float) = secs_str.trim().parse::<f64>() else {
            continue;
        };
        // AppleScript's date subtraction gives seconds *in local time*;
        // normalise to UTC-unix by subtracting the local offset.
        let local_secs = secs_float as i64;
        let offset = super::inbox::local_offset_seconds_public();
        let unix = local_secs - offset;
        if uid.is_empty() || title.is_empty() {
            continue;
        }
        events.push(UpcomingEvent {
            uid,
            title,
            starts_at: unix,
            location,
        });
    }
    Ok(events)
}
