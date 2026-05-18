//! In-memory state shared between commands + the resolver for the
//! user-facing default output directory.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::jobs::{now_unix, ConverterJob, JobStatus};

pub struct ConverterState {
    pub jobs: Mutex<Vec<ConverterJob>>,
    /// PID of the active ffmpeg process — set while a `Convert` job
    /// is running so `converter_cancel` can SIGTERM it. Wrapped in
    /// an `Arc` so the worker thread can hand a clone to the ffmpeg
    /// pipeline closure without needing to keep the surrounding
    /// `Arc<ConverterState>` alive across the closure boundary.
    pub active_pid: Arc<Mutex<Option<u32>>>,
    /// `true` once we've hydrated the in-memory queue from the on-disk
    /// `jobs.json`. Commands call `ensure_loaded(&app)` at their entry
    /// point — the first one wins and seeds `jobs`, subsequent calls
    /// short-circuit on this flag.
    loaded: Mutex<bool>,
}

impl ConverterState {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            active_pid: Arc::new(Mutex::new(None)),
            loaded: Mutex::new(false),
        }
    }

    /// Hydrate `jobs` from `<app_data>/converter/jobs.json` the first
    /// time any command runs. Jobs that were `Running` or `Queued`
    /// when the previous process died are flipped to `Failed` with an
    /// "interrupted" note — the OS killed their ffmpeg child along
    /// with the rest of the app, so leaving them as Running would
    /// leak a forever-spinning row in the UI.
    pub fn ensure_loaded(&self, app_data: &Path) {
        let mut loaded = self.loaded.lock().unwrap();
        if *loaded {
            return;
        }
        *loaded = true;
        let mut jobs = self.jobs.lock().unwrap();
        if !jobs.is_empty() {
            return;
        }
        *jobs = load_persisted(app_data);
    }

    /// Snapshot `jobs` to disk. Called after every mutation. Best-
    /// effort: a failed write logs but doesn't propagate, so the in-
    /// memory queue stays authoritative for the live session.
    pub fn persist(&self, app_data: &Path) {
        let snapshot = self.jobs.lock().unwrap().clone();
        save_persisted(app_data, &snapshot);
    }
}

impl Default for ConverterState {
    fn default() -> Self {
        Self::new()
    }
}

/// Where the per-job history lives. Same dir whisper / separator /
/// etc. write into, namespaced by module.
pub fn jobs_path(app_data: &Path) -> PathBuf {
    app_data.join("converter").join("jobs.json")
}

pub fn load_persisted(app_data: &Path) -> Vec<ConverterJob> {
    let path = jobs_path(app_data);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut jobs: Vec<ConverterJob> = serde_json::from_str(&text).unwrap_or_default();
    let now = now_unix();
    for j in &mut jobs {
        if matches!(j.status, JobStatus::Running | JobStatus::Queued) {
            j.status = JobStatus::Failed;
            j.error = Some("interrupted by app restart".into());
            j.finished_at = Some(now);
        }
    }
    jobs
}

pub fn save_persisted(app_data: &Path, jobs: &[ConverterJob]) {
    let path = jobs_path(app_data);
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[converter] persist mkdir: {e}");
            return;
        }
    }
    match serde_json::to_string_pretty(jobs) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&path, text) {
                eprintln!("[converter] persist write: {e}");
            }
        }
        Err(e) => eprintln!("[converter] persist serialise: {e}"),
    }
}

/// Where the converter drops outputs by default. ~/Downloads matches
/// the user's mental model for "the file is over there" — same dir
/// the downloader writes into. The folder is created lazily on first
/// job so a user who only uses the in-place transcribe path never
/// sees an empty "Stash Converted" directory appear in Finder.
pub fn output_dir_default() -> PathBuf {
    if let Some(dir) = dirs_next::download_dir() {
        return dir.join("Stash Converted");
    }
    if let Some(home) = dirs_next::home_dir() {
        return home.join("Downloads").join("Stash Converted");
    }
    PathBuf::from("./Stash Converted")
}
