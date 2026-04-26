//! Periodic battery probe that pushes a low-battery alert to the paired
//! chat. Runs once every `POLL_PERIOD`; a fresh alert fires when the
//! level is at or below `THRESHOLD_PERCENT` and the Mac isn't charging.
//!
//! Alerts are rate-limited by the notifier's per-category cooldown
//! (1 hour), so a user watching the slider tick 20 → 19 → 18 gets one
//! ping, not three.

use std::process::Command;
use std::time::Duration;

use tauri::AppHandle;

use super::notifier::{notify_if_paired, Category};

const POLL_PERIOD: Duration = Duration::from_secs(5 * 60);

/// Spawn the watcher. Idempotent in practice — called once from `lib.rs`
/// at setup time; repeated calls just add a second harmless ticker.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let mut tick = tokio::time::interval(POLL_PERIOD);
        // Skip the instant first tick so rehydrate can finish.
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some((percent, charging)) = read_pmset_percent() else {
                continue;
            };
            // Look up the user's threshold — defaults to 20 when kv row
            // is missing (pristine install).
            let threshold = app
                .try_state::<std::sync::Arc<super::state::TelegramState>>()
                .map(|s| super::settings::NotificationSettings::load(&s).battery_threshold_pct)
                .unwrap_or(20);
            if !charging && percent <= threshold {
                notify_if_paired(
                    &app,
                    Category::BatteryLow,
                    format!("🪫 Battery low: {percent}% — plug in when you can."),
                );
            }
        }
    });
}

fn read_pmset_percent() -> Option<(u32, bool)> {
    let out = Command::new("pmset").args(["-g", "batt"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let pct_idx = text.find('%')?;
    let prefix = &text[..pct_idx];
    let start = prefix
        .rfind(|c: char| !c.is_ascii_digit())
        .map(|i| i + 1)
        .unwrap_or(0);
    let percent: u32 = prefix[start..].parse().ok()?;
    let rest = &text[pct_idx + 1..];
    let charging = rest
        .split(';')
        .nth(1)
        .map(|s| {
            let w = s.trim().to_lowercase();
            w == "charging" || w.starts_with("ac")
        })
        .unwrap_or(false);
    Some((percent, charging))
}
