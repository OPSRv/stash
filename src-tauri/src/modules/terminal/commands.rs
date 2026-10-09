use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::pty::{open_session, resize, write_input};
use super::state::{PendingRun, TerminalState};

fn normalise_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("pty id is empty".into());
    }
    if trimmed.len() > 64 {
        return Err("pty id too long".into());
    }
    Ok(trimmed.to_string())
}

/// Ensure a PTY session with the given id is running at the given
/// geometry. Idempotent: a second call for the same id just resizes.
/// Dead sessions are detected via `try_wait` and replaced so the user
/// can hit Restart without needing a separate "kill" command.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: tauri::State<'_, Arc<TerminalState>>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let id = normalise_id(&id)?;
    let mut map = state.sessions.lock().unwrap();
    if let Some(session) = map.get_mut(&id) {
        if session.child.try_wait().ok().flatten().is_some() {
            // Inherit last-known cwd of the dead session so Restart
            // respawns where the shell left off.
            let carry = session.last_cwd.lock().ok().and_then(|g| g.clone());
            let stale = map.remove(&id).expect("just observed");
            stale.proc_shutdown.store(true, Ordering::SeqCst);
            // Use the caller's cwd if provided, otherwise the carried one.
            let resolved = cwd.clone().or(carry);
            let session = open_session(&app, &id, cols, rows, resolved.map(PathBuf::from))?;
            map.insert(id, session);
            return Ok(());
        }
    }
    if let Some(session) = map.get(&id) {
        resize(session, cols, rows)?;
        return Ok(());
    }
    let fallback = dirs_next::home_dir();
    let resolved = cwd.map(PathBuf::from).or(fallback);
    let session = open_session(&app, &id, cols, rows, resolved)?;
    map.insert(id, session);
    Ok(())
}

/// Update a session's last-known working directory. Called by the
/// frontend when xterm sees an OSC 7 sequence (`ESC ] 7 ; file://…/<path> BEL`).
/// Persisted on the session so a subsequent Restart can land in the
/// same directory.
#[tauri::command]
pub fn pty_set_cwd(
    state: tauri::State<'_, Arc<TerminalState>>,
    id: String,
    cwd: String,
) -> Result<(), String> {
    let id = normalise_id(&id)?;
    let map = state.sessions.lock().unwrap();
    let session = map
        .get(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    let mut guard = session.last_cwd.lock().unwrap();
    *guard = if cwd.trim().is_empty() {
        None
    } else {
        Some(cwd)
    };
    Ok(())
}

/// Return the session's last-known cwd so the frontend can pass it
/// back on Restart. Returns None when no OSC 7 has been seen yet.
#[tauri::command]
pub fn pty_get_cwd(
    state: tauri::State<'_, Arc<TerminalState>>,
    id: String,
) -> Result<Option<String>, String> {
    let id = normalise_id(&id)?;
    let map = state.sessions.lock().unwrap();
    let session = map
        .get(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    let cwd = session.last_cwd.lock().unwrap().clone();
    Ok(cwd)
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, Arc<TerminalState>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let id = normalise_id(&id)?;
    let mut map = state.sessions.lock().unwrap();
    let session = map
        .get_mut(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    write_input(session, &data)
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, Arc<TerminalState>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let id = normalise_id(&id)?;
    let map = state.sessions.lock().unwrap();
    let session = map
        .get(&id)
        .ok_or_else(|| format!("no pty session: {id}"))?;
    resize(session, cols, rows)
}

#[tauri::command]
pub fn pty_close(state: tauri::State<'_, Arc<TerminalState>>, id: String) -> Result<(), String> {
    let id = normalise_id(&id)?;
    let mut map = state.sessions.lock().unwrap();
    if let Some(mut session) = map.remove(&id) {
        session.reader_shutdown.store(true, Ordering::SeqCst);
        session.proc_shutdown.store(true, Ordering::SeqCst);
        let _ = session.child.kill();
    }
    Ok(())
}

/// Persist a binary blob dropped or pasted into the compose box to a
/// predictable cache path so the running program (Claude Code etc.) can
/// pick it up via an `@<path>` reference. The extension is sanitised to
/// a narrow allow-list so a rogue paste can't smuggle a shell script
/// onto disk under a convincing name.
///
/// Returns the absolute path as a UTF-8 string.
#[tauri::command]
pub fn terminal_save_paste_blob(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
    const MAX_BYTES: usize = 25 * 1024 * 1024; // 25 MB cap — images from clipboard are <5 MB
    if bytes.is_empty() {
        return Err("empty blob".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "blob too large ({} bytes, max {})",
            bytes.len(),
            MAX_BYTES
        ));
    }
    // Accept any dropped file Claude Code / shells might want to inspect,
    // but block-list executables so a drop can't smuggle a launch vector
    // onto disk under a convincing name. Unknown/unsafe types fall back
    // to .bin — still addressable via `@<path>`, just without a
    // misleading suffix.
    let raw = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    const BLOCKED: &[&str] = &[
        "exe", "bat", "cmd", "com", "msi", "dll", "sh", "bash", "zsh", "fish", "ps1", "app", "pkg",
        "dmg", "dylib", "so", "deb", "rpm", "scpt", "scptd", "jar", "apk", "ipa", "workflow",
    ];
    let ext: String = if raw.is_empty()
        || raw.len() > 6
        || BLOCKED.iter().any(|b| *b == raw)
        || !raw.chars().all(|c| c.is_ascii_alphanumeric())
    {
        "bin".to_string()
    } else {
        raw
    };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?
        .join("terminal-paste");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("paste-{nonce}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
    path.into_os_string()
        .into_string()
        .map_err(|_| "path is not valid UTF-8".to_string())
}

/// Queue a "new tab in `cwd`, run `command`" request for the Terminal tab,
/// reveal the popup on that tab and ping the frontend. The ping carries
/// no payload on purpose — the frontend always drains via
/// `terminal_take_pending_runs`, so a mount-time drain and a live event
/// can never run the same request twice.
///
/// Returns the run id; the frontend reports the pane it picked for it via
/// `terminal_bind_run`, after which `run_pane` can resolve the live shell.
pub fn queue_run(
    app: &AppHandle,
    cwd: String,
    command: String,
    label: Option<String>,
) -> Result<u64, String> {
    use tauri::Emitter;
    let state = app
        .try_state::<Arc<TerminalState>>()
        .ok_or_else(|| "terminal state is not initialised".to_string())?;
    let run_id = state.next_run_id.fetch_add(1, Ordering::SeqCst);
    state
        .run_panes
        .lock()
        .map_err(|_| "terminal run map poisoned".to_string())?
        .insert(run_id, None);
    state
        .pending_runs
        .lock()
        .map_err(|_| "terminal queue poisoned".to_string())?
        .push(PendingRun {
            run_id,
            cwd,
            command,
            label,
        });
    crate::tray::show_popup(app);
    let _ = app.emit("nav:activate", "terminal");
    let _ = app.emit("terminal:run_command", ());
    Ok(run_id)
}

/// Drain every queued run request. Called by `TerminalShell` on mount and
/// whenever `terminal:run_command` fires.
#[tauri::command]
pub fn terminal_take_pending_runs(
    state: tauri::State<'_, Arc<TerminalState>>,
) -> Result<Vec<PendingRun>, String> {
    let mut q = state
        .pending_runs
        .lock()
        .map_err(|_| "terminal queue poisoned".to_string())?;
    Ok(std::mem::take(&mut *q))
}

/// Record which pane a queued run was assigned to. Unknown ids (already
/// forgotten by their owner) are ignored.
#[tauri::command]
pub fn terminal_bind_run(
    state: tauri::State<'_, Arc<TerminalState>>,
    run_id: u64,
    pane_id: String,
) -> Result<(), String> {
    let pane_id = normalise_id(&pane_id)?;
    let mut map = state
        .run_panes
        .lock()
        .map_err(|_| "terminal run map poisoned".to_string())?;
    if let Some(slot) = map.get_mut(&run_id) {
        *slot = Some(pane_id);
    }
    Ok(())
}

/// Where a queued run currently stands, from the PTY's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunPane {
    /// Queued, but the frontend has not reported a pane yet.
    Unbound,
    /// Unknown run id, or its pane's PTY was closed / its shell exited.
    Gone,
    Live {
        pane_id: String,
        /// Pid of the pane's shell (the PTY child).
        shell_pid: u32,
        /// Foreground process group of the PTY (`tcgetpgrp`). Equals
        /// `shell_pid` while the shell sits at its prompt.
        fg_pgid: Option<i32>,
    },
}

/// Resolve a run id to its pane's live shell.
pub fn run_pane(app: &AppHandle, run_id: u64) -> RunPane {
    let Some(state) = app.try_state::<Arc<TerminalState>>() else {
        return RunPane::Gone;
    };
    // Release `run_panes` before touching `sessions` — never hold both.
    let pane_id = match state.run_panes.lock().ok().and_then(|m| m.get(&run_id).cloned()) {
        None => return RunPane::Gone,
        Some(None) => return RunPane::Unbound,
        Some(Some(p)) => p,
    };
    let Ok(mut map) = state.sessions.lock() else {
        return RunPane::Gone;
    };
    let Some(session) = map.get_mut(&pane_id) else {
        return RunPane::Gone;
    };
    if session.child.try_wait().ok().flatten().is_some() {
        return RunPane::Gone;
    }
    let Some(shell_pid) = session.child.process_id() else {
        return RunPane::Gone;
    };
    RunPane::Live {
        pane_id,
        shell_pid,
        fg_pgid: session.master.process_group_leader(),
    }
}

/// Drop a run's pane binding (its owner stopped tracking it).
pub fn forget_run(app: &AppHandle, run_id: u64) {
    if let Some(state) = app.try_state::<Arc<TerminalState>>() {
        if let Ok(mut map) = state.run_panes.lock() {
            map.remove(&run_id);
        }
    }
}

/// Write raw bytes (e.g. `\x03` for Ctrl+C) into a pane's PTY, exactly as
/// if the user had typed them.
pub fn write_to_pane(app: &AppHandle, pane_id: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let state = app
        .try_state::<Arc<TerminalState>>()
        .ok_or_else(|| "terminal state is not initialised".to_string())?;
    let mut map = state.sessions.lock().map_err(|_| "terminal state poisoned".to_string())?;
    let session = map
        .get_mut(pane_id)
        .ok_or_else(|| format!("no pty session: {pane_id}"))?;
    session
        .writer
        .write_all(bytes)
        .map_err(|e| format!("pty write: {e}"))?;
    session.writer.flush().ok();
    Ok(())
}

/// Open the popup on the Terminal tab and ask `TerminalShell` to activate
/// the tab holding `pane_id` and focus that pane.
pub fn reveal_pane(app: &AppHandle, pane_id: &str) {
    use tauri::Emitter;
    crate::tray::show_popup(app);
    let _ = app.emit("nav:activate", "terminal");
    let _ = app.emit("terminal:focus_pane", pane_id.to_string());
}
