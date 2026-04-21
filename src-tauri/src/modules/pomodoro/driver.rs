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
        // Drain events inside the lock, then release before doing I/O.
        let (events, snapshot) = {
            let mut core = match state.core.lock() {
                Ok(c) => c,
                Err(poisoned) => poisoned.into_inner(),
            };
            let events = core.advance(now_ms());
            let snap = core.snapshot();
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
    }) = events.iter().rev().find(|e| matches!(e, EngineEvent::SessionDone { .. }))
    {
        let summary = format!("{} блоків · {} хв", blocks_completed, total_sec / 60);
        let _ = app
            .notification()
            .builder()
            .title("Сесія завершена")
            .body(&summary)
            .show();
        crate::modules::telegram::notifier::notify_if_paired(
            app,
            crate::modules::telegram::notifier::Category::Pomodoro,
            format!("🍅 Сесія завершена — {summary}"),
        );
    }
}
