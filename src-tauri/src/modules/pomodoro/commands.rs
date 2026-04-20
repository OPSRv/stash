use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, State};

use super::driver::emit_events;
use super::engine::{EngineEvent, SessionSnapshot};
use super::model::{Block, Preset, SessionRow};
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
            .save_preset(trimmed, &blocks, now_sec()),
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
    if blocks.is_empty() {
        return Err("cannot start a session with no blocks".into());
    }
    // Finalize any in-flight session first so history is clean if the user
    // hits "Start" without explicitly stopping the previous run.
    finalize_in_flight(&state);
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
    emit_snapshot(&app, &snap);
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

#[tauri::command]
pub fn pomodoro_stop(
    app: AppHandle,
    state: State<'_, Arc<PomodoroState>>,
) -> Result<SessionSnapshot, String> {
    let now = now_ms();
    let (snap, completed_idx) = {
        let mut core = state.core.lock().unwrap();
        let completed = core.snapshot().current_idx;
        core.stop(now);
        (core.snapshot(), completed)
    };
    finalize_active(&state, completed_idx);
    emit_snapshot(&app, &snap);
    Ok(snap)
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
