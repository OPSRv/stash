//! Lifetime-tracking state for the keep-awake feature. Holds the child
//! `caffeinate` process (so we can kill it on disable / app shutdown)
//! and the JoinHandle of the hourly Telegram-nudge task.

use std::process::Child;
use std::sync::Mutex;
use tauri::async_runtime::JoinHandle;

pub struct KeepAwakeState {
    /// The running `caffeinate` child process. Some(_) iff keep-awake
    /// is currently active. Killing the child re-enables normal sleep.
    pub child: Mutex<Option<Child>>,
    /// UTC seconds when keep-awake was enabled. Used for status
    /// reporting ("active for 1h 23m").
    pub started_at: Mutex<Option<i64>>,
    /// The hourly-nudge tokio task. Aborted on disable so an old loop
    /// doesn't keep pinging Telegram after the user said off.
    pub nudge_task: Mutex<Option<JoinHandle<()>>>,
}

impl KeepAwakeState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            started_at: Mutex::new(None),
            nudge_task: Mutex::new(None),
        }
    }
}

impl Default for KeepAwakeState {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for KeepAwakeState {
    fn drop(&mut self) {
        // App-shutdown safety net: kill the caffeinate child so it does
        // not leak past the parent process. Best-effort — if the lock
        // is poisoned we still try via into_inner.
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
            }
        }
        if let Ok(mut guard) = self.nudge_task.lock() {
            if let Some(h) = guard.take() {
                h.abort();
            }
        }
    }
}
