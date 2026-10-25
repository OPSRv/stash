//! Periodic battery probe that pushes a low-battery alert to the paired
//! chat. Runs once every `POLL_PERIOD`; a fresh alert fires when the
//! level is at or below `THRESHOLD_PERCENT` and the Mac isn't charging.
//!
//! Alerts are rate-limited by a local one-hour cooldown (mirroring the
//! notifier's `BatteryLow` policy), so a user watching the slider tick
//! 20 → 19 → 18 gets one ping, not three.

use std::process::Command;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::commands_registry::{InlineButton, InlineKeyboard};
use super::notifier::{notify_with_keyboard, Category};

const POLL_PERIOD: Duration = Duration::from_secs(5 * 60);
const ALERT_COOLDOWN: Duration = Duration::from_secs(60 * 60);

/// Spawn the watcher. Idempotent in practice — called once from `lib.rs`
/// at setup time; repeated calls just add a second harmless ticker.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let mut tick = tokio::time::interval(POLL_PERIOD);
        // Skip the instant first tick so rehydrate can finish.
        tick.tick().await;
        let mut last_alert: Option<Instant> = None;
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
                if last_alert.is_some_and(|t| t.elapsed() < ALERT_COOLDOWN) {
                    continue;
                }
                if notify_with_keyboard(
                    &app,
                    Category::BatteryLow,
                    format!("🪫 Battery low: {percent}% — plug in when you can."),
                    low_battery_keyboard(),
                ) {
                    last_alert = Some(Instant::now());
                }
            }
        }
    });
}

/// Quick actions under the low-battery alert.
fn low_battery_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![
            vec![
                InlineButton::new("🔋 Статус", "battery"),
                InlineButton::new("☕ Keep awake off", "keepawake:off"),
            ],
            // Two-tap: opens a confirm card instead of sleeping on one tap.
            vec![InlineButton::new("💤 Sleep Mac", "sleep:ask")],
        ],
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_battery_buttons_route_to_registered_commands() {
        let kb = low_battery_keyboard();
        let cbs: Vec<&str> = kb
            .rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.as_str())
            .collect();
        assert_eq!(cbs, vec!["battery", "keepawake:off", "sleep:ask"]);
        assert!(cbs.iter().all(|c| c.len() <= 64));
    }
}
