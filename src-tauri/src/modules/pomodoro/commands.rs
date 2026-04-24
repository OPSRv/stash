use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};

use super::driver::emit_events;
use super::engine::{EngineEvent, SessionSnapshot, SessionStatus};
use super::model::{Block, Preset, PresetKind, SessionRow};
use super::state::PomodoroState;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_sec() -> i64 {
    now_ms() / 1000
}

fn to_string_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn emit_snapshot(app: &AppHandle, snap: &SessionSnapshot) {
    let _ = app.emit("pomodoro:state", snap);
    crate::tray::set_title(app, super::driver::format_tray_title(snap).as_deref());
    crate::tray::notify_pomodoro_changed(app, snap.status == SessionStatus::Paused);
}

// --- Presets -----------------------------------------------------------

#[tauri::command]
pub fn pomodoro_list_presets(
    state: State<'_, Arc<PomodoroState>>,
) -> Result<Vec<Preset>, String> {
    to_string_err(state.repo.lock().unwrap().list_presets())
}

#[tauri::command]
pub fn pomodoro_save_preset(
    state: State<'_, Arc<PomodoroState>>,
    name: String,
    kind: PresetKind,
    blocks: Vec<Block>,
) -> Result<Preset, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("preset name is required".into());
    }
    to_string_err(
        state
            .repo
            .lock()
            .unwrap()
            .save_preset(trimmed, kind, &blocks, now_sec()),
    )
}

#[tauri::command]
pub fn pomodoro_delete_preset(
    state: State<'_, Arc<PomodoroState>>,
    id: i64,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().delete_preset(id))
}

#[tauri::command]
pub fn pomodoro_list_history(
    state: State<'_, Arc<PomodoroState>>,
    limit: Option<u32>,
) -> Result<Vec<SessionRow>, String> {
    let limit = limit.unwrap_or(50).min(500);
    to_string_err(state.repo.lock().unwrap().list_sessions(limit))
}

// --- Session control ---------------------------------------------------

#[tauri::command]
pub fn pomodoro_get_state(
    state: State<'_, Arc<PomodoroState>>,
) -> Result<SessionSnapshot, String> {
    let core = state.core.lock().unwrap();
    Ok(core.snapshot())
}

#[tauri::command]
pub fn pomodoro_start(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
    blocks: Vec<Block>,
    preset_id: Option<i64>,
) -> Result<SessionSnapshot, String> {
    start_session(&app, state.inner(), blocks, preset_id)
}

/// Shared start path used by the Tauri command and the telegram AI tool.
/// Keeps history-writing + event-emission behaviour in a single place.
pub fn start_session(
    app: &AppHandle,
    state: &Arc<PomodoroState>,
    blocks: Vec<Block>,
    preset_id: Option<i64>,
) -> Result<SessionSnapshot, String> {
    if blocks.is_empty() {
        return Err("cannot start a session with no blocks".into());
    }
    finalize_in_flight(state);
    let now = now_ms();
    let snap = {
        let mut core = state.core.lock().unwrap();
        core.start(blocks.clone(), preset_id, now);
        core.snapshot()
    };
    let sid = state
        .repo
        .lock()
        .unwrap()
        .insert_session_start(preset_id, &blocks, now_sec())
        .map_err(|e| e.to_string())?;
    *state.active_session.lock().unwrap() = Some(sid);
    emit_snapshot(app, &snap);
    Ok(snap)
}

#[tauri::command]
pub fn pomodoro_pause(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
) -> Result<SessionSnapshot, String> {
    let now = now_ms();
    let snap = {
        let mut core = state.core.lock().unwrap();
        core.pause(now);
        core.snapshot()
    };
    emit_snapshot(&app, &snap);
    Ok(snap)
}

#[tauri::command]
pub fn pomodoro_resume(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
) -> Result<SessionSnapshot, String> {
    let now = now_ms();
    let snap = {
        let mut core = state.core.lock().unwrap();
        core.resume(now);
        core.snapshot()
    };
    emit_snapshot(&app, &snap);
    Ok(snap)
}

/// Called from the tray menu event handler — no Tauri `State` available
/// there, so we look up managed state via `AppHandle::try_state` directly.
pub fn pomodoro_resume_from_tray(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<Arc<PomodoroState>>()
        .ok_or("pomodoro state not initialised")?;
    let now = now_ms();
    let snap = {
        let mut core = state.core.lock().unwrap();
        core.resume(now);
        core.snapshot()
    };
    emit_snapshot(&app, &snap);
    Ok(())
}

#[tauri::command]
pub fn pomodoro_stop(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
) -> Result<SessionSnapshot, String> {
    Ok(stop_session(&app, state.inner()))
}

pub fn stop_session(app: &AppHandle, state: &Arc<PomodoroState>) -> SessionSnapshot {
    let now = now_ms();
    let (snap, completed_idx) = {
        let mut core = state.core.lock().unwrap();
        let completed = core.snapshot().current_idx;
        core.stop(now);
        (core.snapshot(), completed)
    };
    finalize_active(state, completed_idx);
    emit_snapshot(app, &snap);
    snap
}

#[tauri::command]
pub fn pomodoro_skip_to(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
    idx: usize,
) -> Result<SessionSnapshot, String> {
    let now = now_ms();
    let (snap, events) = {
        let mut core = state.core.lock().unwrap();
        let ev = core.skip_to(idx, now);
        (core.snapshot(), ev)
    };
    // Run fanout so the webview gets transition banners for manual skips too.
    emit_events(&app, &events);
    // SessionDone from skip-past-end clears active session.
    if events
        .iter()
        .any(|e| matches!(e, EngineEvent::SessionDone { .. }))
    {
        finalize_active(&state, snap.blocks.len());
    }
    emit_snapshot(&app, &snap);
    Ok(snap)
}

#[tauri::command]
pub fn pomodoro_edit_blocks(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
    blocks: Vec<Block>,
) -> Result<SessionSnapshot, String> {
    let now = now_ms();
    let snap = {
        let mut core = state.core.lock().unwrap();
        core.edit_blocks(blocks, now);
        core.snapshot()
    };
    emit_snapshot(&app, &snap);
    Ok(snap)
}

// --- Internal helpers -------------------------------------------------

/// Called on `pomodoro_start` when the previous session wasn't explicitly
/// stopped. Leaves `ended_at` set so history reflects the abandoned session.
fn finalize_in_flight(state: &Arc<PomodoroState>) {
    let sid_opt = state.active_session.lock().unwrap().take();
    if let Some(sid) = sid_opt {
        let completed = state.core.lock().unwrap().snapshot().current_idx;
        let _ = state
            .repo
            .lock()
            .unwrap()
            .finalize_session(sid, now_sec(), completed);
    }
}

fn finalize_active(state: &Arc<PomodoroState>, completed_idx: usize) {
    let sid_opt = state.active_session.lock().unwrap().take();
    if let Some(sid) = sid_opt {
        let _ = state
            .repo
            .lock()
            .unwrap()
            .finalize_session(sid, now_sec(), completed_idx);
    }
}

/// Called by the driver when it sees `SessionDone` on a tick, so auto-finished
/// sessions are persisted with the right completion count.
pub fn finalize_from_driver(state: &Arc<PomodoroState>, completed: usize) {
    finalize_active(state, completed);
}
