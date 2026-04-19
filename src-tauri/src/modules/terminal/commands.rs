use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::AppHandle;

use super::pty::{open_session, resize, write_input};
use super::state::TerminalState;

/// Ensure a PTY session is running with the given geometry. Idempotent —
/// a second call while a session is alive just resizes. If the previous
/// session died, it's replaced.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: tauri::State<'_, Arc<TerminalState>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut slot = state.session.lock().unwrap();
    // Detect a dead child by probing try_wait; if Some(_), the shell exited
    // and we must re-open.
    if let Some(session) = slot.as_mut() {
        if session.child.try_wait().ok().flatten().is_some() {
            *slot = None;
        }
    }
    if slot.is_some() {
        if let Some(session) = slot.as_ref() {
            resize(session, cols, rows)?;
        }
        return Ok(());
    }
    let cwd = dirs_next::home_dir();
    let session = open_session(&app, cols, rows, cwd)?;
    *slot = Some(session);
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, Arc<TerminalState>>, data: String) -> Result<(), String> {
    let mut slot = state.session.lock().unwrap();
    let session = slot.as_mut().ok_or_else(|| "no pty session".to_string())?;
    write_input(session, &data)
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, Arc<TerminalState>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let slot = state.session.lock().unwrap();
    let session = slot.as_ref().ok_or_else(|| "no pty session".to_string())?;
    resize(session, cols, rows)
}

#[tauri::command]
pub fn pty_close(state: tauri::State<'_, Arc<TerminalState>>) -> Result<(), String> {
    let mut slot = state.session.lock().unwrap();
    if let Some(mut session) = slot.take() {
        session.reader_shutdown.store(true, Ordering::SeqCst);
        let _ = session.child.kill();
    }
    Ok(())
}
