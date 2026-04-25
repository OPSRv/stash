//! 1Hz tick driver for the pomodoro engine. Lives in a dedicated std::thread
//! spawned from tauri `setup()` and owns an `Arc<PomodoroState>`. The driver
//! is the ONLY place where wall-clock time enters the engine — that keeps the
//! pure state machine in `engine.rs` fully testable and sleep/wake safe.
//!
//! Design notes (see docs/plans/2026-04-20-pomodoro-module.md):
//! * Tick interval is 500 ms so the frontend remaining-ms stays smooth without
//!   burning CPU. Only *state changes* fire events — idle ticks are cheap.
//! * Sleep/wake resilience: we never accumulate "+1s per tick"; we hand the
//!   engine the current wall-clock ms and let it compute the delta, so waking
//!   after a long sleep replays intermediate transitions correctly.
//! * System notifications are sent from here (Rust) and NEVER from the webview
//!   — Stash's popup webview may be fully unloaded (tab auto-unload + popup
//!   hide) and its JS listeners dead. If we relied on the frontend, posture
//!   prompts would silently be missed.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use super::commands::finalize_from_driver;
use super::engine::{transition_text, EngineEvent};
use super::state::PomodoroState;

const TICK_MS: u64 = 500;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn spawn(state: Arc<PomodoroState>, app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(TICK_MS));
        // Drain events AND push the tray-title update inside the lock. If we
        // release the lock before calling `set_title`, a `pomodoro_stop`
        // command can sneak in between `snapshot()` and `set_title(...)`: the
        // command clears the label to `None` first, and our stale call
        // immediately re-paints the last "⏸ MM:SS" over it. Holding the lock
        // across `set_title` serialises driver vs. command updates so the
        // most recent core state always wins.
        let (events, snapshot) = {
            let mut core = match state.core.lock() {
                Ok(c) => c,
                Err(poisoned) => poisoned.into_inner(),
            };
            let events = core.advance(now_ms());
            let snap = core.snapshot();
            crate::tray::set_title(&app, format_tray_title(&snap).as_deref());
            (events, snap)
        };
        // Always emit the snapshot + a tick — the frontend relies on this
        // for its countdown render when the webview is alive.
        let _ = app.emit("pomodoro:tick", &snapshot);
        if events.is_empty() {
            continue;
        }
        let _ = app.emit("pomodoro:state", &snapshot);
        emit_events(&app, &events);
        // The engine clears its state on the SessionDone transition, so we
        // read completion count straight off the event rather than the now-
        // empty snapshot.
        if let Some(EngineEvent::SessionDone {
            blocks_completed, ..
        }) = events
            .iter()
            .find(|e| matches!(e, EngineEvent::SessionDone { .. }))
        {
            finalize_from_driver(&state, *blocks_completed);
        }
    });
}

/// Fan out engine events to frontend listeners + OS notifications.
/// When a single tick contains multiple `BlockChanged` events (sleep/wake
/// replay), we still emit them all to the webview (the banner queues) but
/// collapse the *system* notification to the final transition only, so the
/// user doesn't get a burst of 5 toasts when they wake their Mac.
pub fn emit_events(app: &AppHandle, events: &[EngineEvent]) {
    let mut last_transition: Option<&EngineEvent> = None;
    for ev in events {
        let _ = match ev {
            EngineEvent::BlockChanged { .. } => {
                last_transition = Some(ev);
                app.emit("pomodoro:block_changed", ev)
            }
            EngineEvent::Nudge { .. } => app.emit("pomodoro:nudge", ev),
            EngineEvent::SessionDone { .. } => app.emit("pomodoro:session_done", ev),
        };
    }
    // One notification per tick for transitions (coalesced across sleep-wake).
    if let Some(EngineEvent::BlockChanged {
        from_posture,
        to_posture,
        block_name,
        ..
    }) = last_transition
    {
        let title = transition_text(*from_posture, *to_posture);
        let body = format!("Next: {}", block_name);
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
        crate::modules::telegram::notifier::notify_if_paired(
            app,
            crate::modules::telegram::notifier::Category::Pomodoro,
            format!("🍅 {title} · {block_name}"),
        );
    }
    if let Some(EngineEvent::SessionDone {
        blocks_completed,
        total_sec,
    }) = events
        .iter()
        .rev()
        .find(|e| matches!(e, EngineEvent::SessionDone { .. }))
    {
        let summary = format!("{} blocks · {} min", blocks_completed, total_sec / 60);
        let _ = app
            .notification()
            .builder()
            .title("Session complete")
            .body(&summary)
            .show();
        crate::modules::telegram::notifier::notify_if_paired(
            app,
            crate::modules::telegram::notifier::Category::Pomodoro,
            format!("🍅 Session complete — {summary}"),
        );
    }
}

/// Render the tray-title label for a pomodoro snapshot. Returns `None`
/// for Idle so the caller clears the label. Running sessions show bare
/// `MM:SS`; Paused sessions prefix `⏸` so at-a-glance the user knows
/// the clock isn't moving.
///
/// Kept pure (no `app`/IO) so the behaviour is fully unit-tested — the
/// driver calls it once per tick and pipes the result to `tray::set_title`.
pub fn format_tray_title(snap: &super::engine::SessionSnapshot) -> Option<String> {
    use super::engine::SessionStatus;
    match snap.status {
        SessionStatus::Idle => None,
        SessionStatus::Running | SessionStatus::Paused => {
            let total_sec = (snap.remaining_ms.max(0) / 1000) as u64;
            let mins = total_sec / 60;
            let secs = total_sec % 60;
            let body = format!("{mins:02}:{secs:02}");
            Some(match snap.status {
                SessionStatus::Paused => format!("⏸ {body}"),
                _ => body,
            })
        }
    }
}

#[cfg(test)]
mod tray_title_tests {
    use super::super::engine::{SessionSnapshot, SessionStatus};
    use super::format_tray_title;

    fn snap(status: SessionStatus, remaining_ms: i64) -> SessionSnapshot {
        SessionSnapshot {
            status,
            blocks: Vec::new(),
            current_idx: 0,
            remaining_ms,
            started_at: 0,
            preset_id: None,
        }
    }

    #[test]
    fn idle_returns_none() {
        assert_eq!(format_tray_title(&snap(SessionStatus::Idle, 0)), None);
    }

    #[test]
    fn running_formats_mm_ss() {
        let s = snap(SessionStatus::Running, 25 * 60 * 1000);
        assert_eq!(format_tray_title(&s).as_deref(), Some("25:00"));
    }

    #[test]
    fn running_pads_single_digit_minutes() {
        let s = snap(SessionStatus::Running, 9 * 60 * 1000 + 5 * 1000);
        assert_eq!(format_tray_title(&s).as_deref(), Some("09:05"));
    }

    #[test]
    fn paused_gets_prefix() {
        let s = snap(SessionStatus::Paused, 12 * 60 * 1000 + 34 * 1000);
        assert_eq!(format_tray_title(&s).as_deref(), Some("⏸ 12:34"));
    }

    #[test]
    fn zero_remaining_shows_zero() {
        let s = snap(SessionStatus::Running, 0);
        assert_eq!(format_tray_title(&s).as_deref(), Some("00:00"));
    }

    #[test]
    fn negative_remaining_clamps_to_zero() {
        let s = snap(SessionStatus::Running, -5000);
        assert_eq!(format_tray_title(&s).as_deref(), Some("00:00"));
    }

    #[test]
    fn hour_plus_overflows_minutes_field() {
        // Blocks longer than an hour are rare but valid — we just let
        // minutes exceed 60 rather than inventing an HH:MM:SS format
        // the menubar can't fit anyway.
        let s = snap(SessionStatus::Running, 90 * 60 * 1000);
        assert_eq!(format_tray_title(&s).as_deref(), Some("90:00"));
    }
}
