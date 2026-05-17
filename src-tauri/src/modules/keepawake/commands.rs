//! Toggle + status commands for the keep-awake feature.
//!
//! Implementation choice: spawn `/usr/bin/caffeinate -dimsu` as a child
//! process. Apple's IOPMAssertion APIs are the lower-level alternative,
//! but they require linking IOKit and balancing assertion handles by
//! hand — a forked binary that the OS already maintains is the simpler
//! and more robust path for our single-toggle case.

use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use super::state::KeepAwakeState;

#[derive(Serialize, Clone, Debug)]
pub struct KeepAwakeStatus {
    /// True when a caffeinate child is running.
    pub active: bool,
    /// UTC seconds when the current "on" cycle started. None when off.
    pub since_unix: Option<i64>,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Pure status snapshot. Cheap — just locks the two Mutexes.
pub fn status(state: &KeepAwakeState) -> KeepAwakeStatus {
    let active = state.child.lock().unwrap().is_some();
    let since = *state.started_at.lock().unwrap();
    KeepAwakeStatus {
        active,
        since_unix: since,
    }
}

/// Enable / disable keep-awake. Idempotent: enabling while active is a
/// no-op, disabling while inactive is a no-op. Returns the resulting
/// status so callers (Telegram, CLI, UI) can echo it back.
pub fn set(
    app: &tauri::AppHandle,
    state: &Arc<KeepAwakeState>,
    enable: bool,
) -> Result<KeepAwakeStatus, String> {
    if enable {
        enable_caffeinate(app, state)?;
    } else {
        disable_caffeinate(state);
    }
    Ok(status(state))
}

#[cfg(target_os = "macos")]
fn enable_caffeinate(app: &tauri::AppHandle, state: &Arc<KeepAwakeState>) -> Result<(), String> {
    // Already on — nothing to do, but keep the started_at timestamp
    // anchored to the original on-event so status reflects total uptime.
    if state.child.lock().unwrap().is_some() {
        return Ok(());
    }
    // -d display, -i system idle, -m disk, -s system, -u declare user
    // activity (resets the dim/sleep timer). The combination is what
    // most caffeinator GUIs use for "stay awake completely".
    let child = Command::new("/usr/bin/caffeinate")
        .args(["-d", "-i", "-m", "-s", "-u"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn caffeinate: {e}"))?;
    *state.child.lock().unwrap() = Some(child);
    *state.started_at.lock().unwrap() = Some(now_unix());
    spawn_hourly_nudge(app, state);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn enable_caffeinate(_app: &tauri::AppHandle, _state: &Arc<KeepAwakeState>) -> Result<(), String> {
    Err("keep-awake is macOS-only".into())
}

fn disable_caffeinate(state: &Arc<KeepAwakeState>) {
    if let Some(mut c) = state.child.lock().unwrap().take() {
        let _ = c.kill();
        // Reap the zombie so PID tables stay clean even if many
        // toggles happen during a long session.
        let _ = c.wait();
    }
    *state.started_at.lock().unwrap() = None;
    if let Some(h) = state.nudge_task.lock().unwrap().take() {
        h.abort();
    }
}

/// Spawn the hourly Telegram reminder. Sleeps an hour, fires once,
/// loops while keep-awake is still active. Bails the moment the user
/// flips off (state.child becomes None) — that avoids a stale loop
/// nudging Telegram after a quick on/off toggle pair.
fn spawn_hourly_nudge(app: &tauri::AppHandle, state: &Arc<KeepAwakeState>) {
    let app = app.clone();
    let state_for_task = Arc::clone(state);
    let handle = tauri::async_runtime::spawn(async move {
        let state = state_for_task;
        loop {
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
            if state.child.lock().unwrap().is_none() {
                break;
            }
            let since = *state.started_at.lock().unwrap();
            let elapsed_h = since
                .map(|s| (now_unix() - s) / 3600)
                .unwrap_or(0)
                .max(1);
            crate::modules::telegram::notifier::notify_if_paired(
                &app,
                crate::modules::telegram::notifier::Category::KeepAwake,
                format!(
                    "☕ Stash тримає Mac не сплячим (≈{elapsed_h} год). \
                     Вимкнути: /keepawake off"
                ),
            );
        }
    });
    *state.nudge_task.lock().unwrap() = Some(handle);
}

// ----- Tauri commands ------------------------------------------------------

#[tauri::command]
pub fn keep_awake_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<KeepAwakeState>>,
    enable: bool,
) -> Result<KeepAwakeStatus, String> {
    set(&app, state.inner(), enable)
}

#[tauri::command]
pub fn keep_awake_status(
    state: tauri::State<'_, Arc<KeepAwakeState>>,
) -> KeepAwakeStatus {
    status(state.inner())
}
