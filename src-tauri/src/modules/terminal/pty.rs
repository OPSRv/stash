use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};

use super::state::PtySession;

#[derive(Clone, serde::Serialize)]
pub struct DataPayload {
    /// Pane-slot id this payload belongs to. Frontend filters on it so
    /// one xterm instance doesn't receive another pane's bytes.
    pub id: String,
    /// Raw PTY bytes, base64-encoded so binary sequences (cursor control,
    /// colours, UTF-8 multibyte) survive the IPC boundary intact.
    pub data: String,
}

#[derive(Clone, serde::Serialize)]
pub struct ExitPayload {
    pub id: String,
    pub code: Option<i32>,
}

#[derive(Clone, serde::Serialize)]
pub struct ProcPayload {
    pub id: String,
    /// Foreground process `comm` (e.g. "zsh", "claude", "vim"). Empty
    /// string when the shell idle-prompt owns the foreground — the
    /// frontend treats empty as "fallback to $SHELL label".
    pub name: String,
}

/// Open a PTY, spawn the user's preferred shell inside it, and start a
/// reader thread that forwards bytes to the frontend as `terminal:data`
/// events. Returns a session handle to be stored in managed state.
pub fn open_session(
    app: &AppHandle,
    id: &str,
    cols: u16,
    rows: u16,
    cwd: Option<PathBuf>,
) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {}", e))?;

    // Prefer $SHELL so the user's login shell (with their zsh/bash init)
    // runs; fall back to /bin/sh if unset.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    // Login shell so ~/.zprofile/.zshrc are loaded and Homebrew paths
    // (where `claude` usually lives) end up on $PATH.
    cmd.arg("-l");
    let seeded_cwd: Option<String> = cwd.as_ref().and_then(|p| p.to_str().map(String::from));
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
    let id_r = id.to_string();
    thread::spawn(move || reader_loop(app_r, id_r, reader_pty, shutdown_r));

    // Per-session foreground-process poller. Runs outside the reader
    // thread so slow `ps` spawns can't stall the byte pipeline.
    let proc_shutdown = Arc::new(AtomicBool::new(false));
    let proc_shutdown_r = proc_shutdown.clone();
    let app_p = app.clone();
    let id_p = id.to_string();
    let leader = pair.master.process_group_leader();
    thread::spawn(move || proc_poll_loop(app_p, id_p, leader, proc_shutdown_r));

    Ok(PtySession {
        master: pair.master,
        writer,
        child,
        reader_shutdown: shutdown,
        proc_shutdown,
        last_cwd: Arc::new(Mutex::new(seeded_cwd)),
    })
}

fn reader_loop(
    app: AppHandle,
    id: String,
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
                let _ = app.emit(
                    "terminal:data",
                    DataPayload {
                        id: id.clone(),
                        data: encoded,
                    },
                );
            }
            Err(_) => break,
        }
    }
    let _ = app.emit("terminal:exit", ExitPayload { id, code: None });
}

/// Poll `tcgetpgrp(master_fd)` (exposed via portable_pty's
/// `process_group_leader`) every ~800 ms; when the foreground process
/// changes, emit `terminal:proc` so the pane header can reflect
/// whatever the user is actually running (`claude`, `vim`, `cargo`…).
///
/// We use `ps` rather than reading `/proc` so the code stays
/// cross-platform friendly (even though Stash is macOS-first — `ps`
/// also works on Linux for future ports).
fn proc_poll_loop(app: AppHandle, id: String, leader_pid: Option<i32>, shutdown: Arc<AtomicBool>) {
    let mut last: String = String::new();
    let tick = Duration::from_millis(800);
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let name = leader_pid
            .and_then(|pid| read_comm(pid))
            .unwrap_or_default();
        if name != last {
            last = name.clone();
            let _ = app.emit(
                "terminal:proc",
                ProcPayload {
                    id: id.clone(),
                    name,
                },
            );
        }
        thread::sleep(tick);
    }
}

/// Return the `comm` (process basename) of the given pid by shelling
/// out to `ps -p <pid> -o comm=`. Returns None on any error; callers
/// treat that as "no current foreground process" and display the
/// shell label instead.
fn read_comm(pid: i32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // `comm` can be an absolute path (macOS login shells); strip the
    // directory so the header shows just the basename.
    let basename = trimmed.rsplit('/').next().unwrap_or(trimmed);
    Some(basename.to_string())
}

/// Write user-typed bytes (already base64-encoded by the frontend) into
/// the PTY master, so the shell sees them as if they came from stdin.
pub fn write_input(session: &mut PtySession, input_b64: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input_b64)
        .map_err(|e| format!("bad base64: {}", e))?;
    session
        .writer
        .write_all(&bytes)
        .map_err(|e| format!("pty write: {}", e))?;
    session.writer.flush().ok();
    Ok(())
}

pub fn resize(session: &PtySession, cols: u16, rows: u16) -> Result<(), String> {
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {}", e))
}
