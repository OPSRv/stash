use crate::modules::downloader::jobs::JobRepo;
use crate::modules::downloader::progress;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::modules::downloader::detector::VideoInfo;

pub struct CachedDetection {
    pub info: VideoInfo,
    pub fetched_at: std::time::Instant,
}

pub struct RunnerState {
    pub jobs: Mutex<JobRepo>,
    pub active: Mutex<std::collections::HashMap<i64, Child>>,
    pub yt_dlp_path: Mutex<Option<PathBuf>>,
    pub downloads_dir: Mutex<PathBuf>,
    pub default_downloads_dir: PathBuf,
    pub detect_cache: Mutex<std::collections::HashMap<String, CachedDetection>>,
    pub cookies_browser: Mutex<Option<String>>,
}

impl RunnerState {
    pub fn new(repo: JobRepo, downloads_dir: PathBuf) -> Self {
        Self {
            jobs: Mutex::new(repo),
            active: Mutex::new(Default::default()),
            yt_dlp_path: Mutex::new(None),
            downloads_dir: Mutex::new(downloads_dir.clone()),
            default_downloads_dir: downloads_dir,
            detect_cache: Mutex::new(std::collections::HashMap::new()),
            cookies_browser: Mutex::new(None),
        }
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Spawn yt-dlp for a given job id. Reads stdout in a background thread,
/// persists progress, and emits downloader:progress / downloader:completed
/// events via the tauri app handle.
pub fn spawn_download(
    app: AppHandle,
    state: Arc<RunnerState>,
    yt_dlp: &Path,
    job_id: i64,
    url: &str,
    format_id: Option<&str>,
    kind: &str, // "video" | "audio"
) -> Result<(), String> {
    let downloads_dir = state.downloads_dir.lock().unwrap().clone();
    std::fs::create_dir_all(&downloads_dir).ok();
    let output_template = downloads_dir
        .join("%(title).100B [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string();

    let mut cmd = Command::new(yt_dlp);
    cmd.args(["--newline", "--no-warnings", "--no-playlist"])
        .arg("-o")
        .arg(&output_template)
        .arg("--print")
        .arg("after_move:filepath:%(filepath)s")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(browser) = state.cookies_browser.lock().unwrap().clone() {
        if let Some(file) = browser.strip_prefix("file:") {
            cmd.args(["--cookies", file]);
        } else {
            cmd.args(["--cookies-from-browser", &browser]);
        }
    }

    if kind == "audio" {
        cmd.args(["-x", "--audio-format", "m4a"]);
        if let Some(fid) = format_id {
            cmd.arg("-f").arg(fid);
        }
    } else if let Some(fid) = format_id {
        // Merge chosen video with best audio.
        cmd.arg("-f").arg(format!("{fid}+bestaudio/best"));
    }

    cmd.arg(url);

    let mut child = cmd.spawn().map_err(|e| format!("spawn yt-dlp: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr".to_string())?;

    state
        .active
        .lock()
        .unwrap()
        .insert(job_id, child);

    // stderr drain (for logging)
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[yt-dlp:{job_id}] {line}");
        }
    });

    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);
    std::thread::spawn(move || {
        let mut final_path: Option<String> = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("filepath:") {
                final_path = Some(rest.trim().to_string());
                continue;
            }
            if let Some(update) = progress::parse_line(&line) {
                if let Ok(mut repo) = state_clone.jobs.lock() {
                    let _ = repo.set_progress(
                        job_id,
                        update.percent / 100.0,
                        update.bytes_done.map(|b| b as i64),
                        update.bytes_total.map(|b| b as i64),
                    );
                }
                let _ = app_clone.emit(
                    "downloader:progress",
                    serde_json::json!({ "id": job_id, "update": update }),
                );
            }
        }
        // Wait for the child to exit.
        let status = {
            let mut guard = state_clone.active.lock().unwrap();
            guard.remove(&job_id).and_then(|mut c| c.wait().ok())
        };
        let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
        if let Ok(mut repo) = state_clone.jobs.lock() {
            if success {
                let path = final_path.unwrap_or_default();
                let _ = repo.set_completed(job_id, &path, now());
                let _ = app_clone.emit(
                    "downloader:completed",
                    serde_json::json!({ "id": job_id, "path": path }),
                );
            } else {
                let _ = repo.set_failed(
                    job_id,
                    &format!("yt-dlp exited with {:?}", status),
                    now(),
                );
                let _ = app_clone.emit(
                    "downloader:failed",
                    serde_json::json!({ "id": job_id }),
                );
            }
        }
    });

    Ok(())
}

pub fn cancel_download(state: &RunnerState, job_id: i64) -> Result<(), String> {
    if let Some(mut child) = state.active.lock().unwrap().remove(&job_id) {
        let _ = child.kill();
    }
    if let Ok(mut repo) = state.jobs.lock() {
        let _ = repo.set_status(job_id, "cancelled");
    }
    Ok(())
}
