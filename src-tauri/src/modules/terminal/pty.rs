use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

use super::state::PtySession;

#[derive(Clone, serde::Serialize)]
pub struct DataPayload {
    /// Raw PTY bytes, base64-encoded so binary sequences (cursor control,
    /// colours, UTF-8 multibyte) survive the IPC boundary intact.
    pub data: String,
}

#[derive(Clone, serde::Serialize)]
pub struct ExitPayload {
    pub code: Option<i32>,
}

/// Open a PTY, spawn the user's preferred shell inside it, and start a
/// reader thread that forwards bytes to the frontend as `terminal:data`
/// events. Returns a session handle to be stored in managed state.
pub fn open_session(
    app: &AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<PathBuf>,
) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {}", e))?;

    // Prefer $SHELL so the user's login shell (with their zsh/bash init)
    // runs; fall back to /bin/sh if unset.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    // Login shell so ~/.zprofile/.zshrc are loaded and Homebrew paths
    // (where `claude` usually lives) end up on $PATH.
    cmd.arg("-l");
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // Ensure a sensible TERM so ncurses programs behave.
    cmd.env("TERM", "xterm-256color");
    // Forward any existing PATH so spawned processes still find userland
    // binaries — otherwise CommandBuilder starts with a minimal env.
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", lang);
    } else {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {}", e))?;
    // `slave` must be dropped before we start reading or writes will echo.
    drop(pair.slave);

    let reader_pty = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {}", e))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_r = shutdown.clone();
    let app_r = app.clone();
    thread::spawn(move || reader_loop(app_r, reader_pty, shutdown_r));

    Ok(PtySession {
        master: pair.master,
        writer,
        child,
        reader_shutdown: shutdown,
    })
}

fn reader_loop(
    app: AppHandle,
    mut pty: Box<dyn Read + Send>,
    shutdown: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 4096];
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match pty.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                let _ = app.emit("terminal:data", DataPayload { data: encoded });
            }
            Err(_) => break,
        }
    }
    let _ = app.emit("terminal:exit", ExitPayload { code: None });
}

/// Write user-typed bytes (already base64-encoded by the frontend) into
/// the PTY master, so the shell sees them as if they came from stdin.
pub fn write_input(session: &mut PtySession, input_b64: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input_b64)
        .map_err(|e| format!("bad base64: {}", e))?;
    session.writer.write_all(&bytes).map_err(|e| format!("pty write: {}", e))?;
    session.writer.flush().ok();
    Ok(())
}

pub fn resize(session: &PtySession, cols: u16, rows: u16) -> Result<(), String> {
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize: {}", e))
}
