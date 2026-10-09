use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};

/// Holds the live PTY sessions keyed by a frontend-chosen string id.
/// Multi-pane terminal UI can open 2-3 shells at once; the id is the
/// pane slot ("pane-1", "pane-2", …) so commands don't need to know
/// anything about the current layout.
pub struct TerminalState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    /// Run requests (e.g. tray "npm scripts") waiting for the Terminal
    /// tab to pick them up. The tab is lazy and may not be mounted when a
    /// request arrives, so a bare event could be lost — instead the
    /// request is parked here and `terminal_take_pending_runs` drains it
    /// on mount and on every `terminal:run_command` ping.
    pub pending_runs: Mutex<Vec<PendingRun>>,
    /// Monotonic id source for `PendingRun::run_id`.
    pub next_run_id: AtomicU64,
    /// Which pane each queued run landed in: `None` until `TerminalShell`
    /// reports it via `terminal_bind_run`. Entries are created by
    /// `queue_run` and dropped by `forget_run`, so a bind for an unknown
    /// (already forgotten) id is ignored instead of leaking.
    pub run_panes: Mutex<HashMap<u64, Option<String>>>,
}

/// One "open a new terminal tab in `cwd` and run `command`" request.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRun {
    /// Handle the frontend echoes back via `terminal_bind_run` once it
    /// knows which pane runs the command.
    pub run_id: u64,
    pub cwd: String,
    pub command: String,
    /// Optional tab label (e.g. the script name).
    pub label: Option<String>,
}

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    /// Reader thread is detached; we keep the shutdown flag so close() can
    /// stop it without waiting on the PTY FD.
    pub reader_shutdown: Arc<std::sync::atomic::AtomicBool>,
    /// Shared with the proc-name poller thread — stops it without waiting
    /// on the sleep tick. Distinct flag from `reader_shutdown` so we can
    /// reason about them independently (reader runs against the PTY FD;
    /// poller runs against `tcgetpgrp` + `ps`).
    pub proc_shutdown: Arc<std::sync::atomic::AtomicBool>,
    /// Last known current working directory, seeded from the spawn cwd
    /// and refreshed whenever the frontend reports an OSC 7 sequence via
    /// `pty_set_cwd`. Consumed by restart flows so a reopened shell lands
    /// in the same place as its predecessor.
    pub last_cwd: Arc<Mutex<Option<String>>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_runs: Mutex::new(Vec::new()),
            next_run_id: AtomicU64::new(1),
            run_panes: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new()
    }
}
