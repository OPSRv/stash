use std::io::Write;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};

/// Holds the live PTY session. Wrapped in `Arc<Mutex<_>>` in managed state
/// so commands can both read and replace the inner `Option`.
pub struct TerminalState {
    pub session: Mutex<Option<PtySession>>,
}

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    /// Reader thread is detached; we keep the shutdown flag so close() can
    /// stop it without waiting on the PTY FD.
    pub reader_shutdown: Arc<std::sync::atomic::AtomicBool>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self { session: Mutex::new(None) }
    }
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new()
    }
}
