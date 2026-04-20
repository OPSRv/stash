use std::sync::Mutex;

use super::engine::EngineCore;
use super::repo::PomodoroRepo;

/// Shared pomodoro state. Held as an `Arc<PomodoroState>` by tauri and by the
/// tick driver thread so both paths see the same engine.
///
/// Locking rule: never hold `core` and `repo` simultaneously, and never hold
/// either across an `app.emit` / `notification().show()`. The driver handles
/// this by draining events inside the lock and doing I/O after releasing.
pub struct PomodoroState {
    pub core: Mutex<EngineCore>,
    pub repo: Mutex<PomodoroRepo>,
    /// Row id of the in-flight session in `pomodoro_sessions`. Set when
    /// `pomodoro_start` writes the session row; cleared when the session is
    /// finalized. Also a Mutex so the driver can write `ended_at` when it
    /// observes `SessionDone` without racing command handlers.
    pub active_session: Mutex<Option<i64>>,
}

impl PomodoroState {
    pub fn new(repo: PomodoroRepo) -> Self {
        Self {
            core: Mutex::new(EngineCore::new()),
            repo: Mutex::new(repo),
            active_session: Mutex::new(None),
        }
    }
}
