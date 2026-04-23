use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};

/// Holds the live PTY sessions keyed by a frontend-chosen string id.
/// Multi-pane terminal UI can open 2-3 shells at once; the id is the
/// pane slot ("pane-1", "pane-2", …) so commands don't need to know
/// anything about the current layout.
pub struct TerminalState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
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
        }
    }
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new()
    }
}
