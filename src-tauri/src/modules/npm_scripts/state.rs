use std::sync::Mutex;

use serde::Serialize;

/// One configured project as last read from disk. `error` is set (and
/// `scripts` empty) when the `package.json` could not be read — the tray
/// renders that as a disabled row instead of dropping the project.
#[derive(Debug, Clone, Serialize)]
pub struct NpmProject {
    pub path: String,
    pub name: String,
    pub scripts: Vec<String>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct NpmScriptsState {
    pub projects: Mutex<Vec<NpmProject>>,
}

/// Snapshot of the configured projects (cheap clone for menu rebuilds).
pub fn snapshot(state: &NpmScriptsState) -> Vec<NpmProject> {
    state.projects.lock().map(|g| g.clone()).unwrap_or_default()
}
