use crate::modules::downloader::jobs::JobRepo;
use crate::modules::downloader::progress;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone)]
pub struct JobSpawnArgs {
    pub url: String,
    pub height: Option<u32>,
    pub kind: String,
    /// When true, the spawn will not attach `--cookies` even if a browser is
    /// configured. Set after a previous attempt failed with "Requested format
    /// is not available" — stale cookies make YouTube serve a degraded
    /// response, so retrying without them often succeeds.
    pub skip_cookies: bool,
}

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
    pub job_specs: Mutex<std::collections::HashMap<i64, JobSpawnArgs>>,
    pub retry_counts: Mutex<std::collections::HashMap<i64, u32>>,
    pub max_parallel: Mutex<usize>,
    pub pending_queue: Mutex<std::collections::VecDeque<i64>>,
    pub rate_limit: Mutex<Option<String>>, // e.g. "2M", "500K"
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
            job_specs: Mutex::new(std::collections::HashMap::new()),
            retry_counts: Mutex::new(std::collections::HashMap::new()),
            max_parallel: Mutex::new(3),
            pending_queue: Mutex::new(std::collections::VecDeque::new()),
            rate_limit: Mutex::new(None),
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
    height: Option<u32>,
    kind: &str, // "video" | "audio"
) -> Result<(), String> {
    // Queue gate: if the active slot count is at max, park this job as
    // pending and let a future completion event pull it off the queue.
    let (active_count, max_parallel) = {
        let a = state.active.lock().unwrap().len();
        let m = *state.max_parallel.lock().unwrap();
        (a, m)
    };
    if max_parallel > 0 && active_count >= max_parallel {
        state.job_specs.lock().unwrap().insert(
            job_id,
            JobSpawnArgs {
                url: url.to_string(),
                height,
                kind: kind.to_string(),
                skip_cookies: false,
            },
        );
        state.pending_queue.lock().unwrap().push_back(job_id);
        if let Ok(mut repo) = state.jobs.lock() {
            let _ = repo.set_status(job_id, "pending");
        }
        return Ok(());
    }

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

    // YouTube's default player client is the most fragile (needs PO Token on
    // many IPs); rotating through clients makes "Requested format is not
    // available" dramatically less likely. No-op for other sites.
    if url.contains("youtube.com") || url.contains("youtu.be") {
        cmd.args([
            "--extractor-args",
            "youtube:player_client=default,web_safari,mweb,android",
        ]);
    }

    if let Some(rate) = state.rate_limit.lock().unwrap().clone() {
        cmd.args(["--limit-rate", &rate]);
    }

    let skip_cookies = state
        .job_specs
        .lock()
        .unwrap()
        .get(&job_id)
        .map(|s| s.skip_cookies)
        .unwrap_or(false);
    let cookies_attached = if skip_cookies {
        false
    } else if let Some(browser) = state.cookies_browser.lock().unwrap().clone() {
        if let Some(file) = browser.strip_prefix("file:") {
            cmd.args(["--cookies", file]);
        } else {
            cmd.args(["--cookies-from-browser", &browser]);
        }
        true
    } else {
        false
    };

    if kind == "audio" {
        cmd.args(["-x", "--audio-format", "m4a", "-f", "bestaudio/best"]);
    } else {
        // Defensive format selector: `bv*` matches any video (muxed or
        // adaptive), `ba` audio, `b` a single progressive file. We always
        // fall through to `b` so YouTube's "Requested format is not
        // available" path can never bite us when the adaptive streams need
        // a PO token we don't have.
        let selector = match height {
            Some(h) => format!(
                "bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b/best"
            ),
            None => "bv*+ba/b/best".to_string(),
        };
        // `-S` is a sort spec (not a filter), so we always get *something*
        // back even if the ideal codec/resolution is missing.
        let sort = match height {
            Some(h) => format!("res:{h},codec:h264,br"),
            None => "codec:h264,res,br".to_string(),
        };
        cmd.args([
            "-f",
            &selector,
            "-S",
            &sort,
            "--merge-output-format",
            "mp4",
        ]);
    }

    cmd.arg(url);

    // Remember spawn args so retry / resume can reuse them. Preserve the
    // current skip_cookies decision so the failure handler can flip it on a
    // cookies-induced format error and re-spawn without losing context.
    state.job_specs.lock().unwrap().insert(
        job_id,
        JobSpawnArgs {
            url: url.to_string(),
            height,
            kind: kind.to_string(),
            skip_cookies,
        },
    );

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

    // stderr drain (for logging + keep last ~30 lines for retry classification).
    let stderr_buf: Arc<Mutex<std::collections::VecDeque<String>>> =
        Arc::new(Mutex::new(std::collections::VecDeque::with_capacity(32)));
    let stderr_buf_for_thread = Arc::clone(&stderr_buf);
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[yt-dlp:{job_id}] {line}");
            let mut q = stderr_buf_for_thread.lock().unwrap();
            if q.len() == 32 {
                q.pop_front();
            }
            q.push_back(line);
        }
    });

    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);
    let stderr_buf_for_final = Arc::clone(&stderr_buf);
    let yt_dlp_owned = yt_dlp.to_path_buf();
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
                    serde_json::json!({ "id": job_id, "path": path.clone() }),
                );
                // Mirror to Telegram if a chat is paired.
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("job #{job_id}"));
                crate::modules::telegram::notifier::notify_if_paired(
                    &app_clone,
                    crate::modules::telegram::notifier::Category::DownloadComplete,
                    format!("⬇️ Download finished — {name}"),
                );
                drop(repo);
                // Clear any retry-counter state we accumulated before success so
                // the `retry_counts` map doesn't grow unbounded across sessions.
                state_clone.retry_counts.lock().unwrap().remove(&job_id);
                drain_queue(app_clone.clone(), Arc::clone(&state_clone), &yt_dlp_owned);
            } else {
                let tail: String = stderr_buf_for_final
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = repo.set_failed(
                    job_id,
                    &if tail.is_empty() {
                        format!("yt-dlp exited with {:?}", status)
                    } else {
                        tail.clone()
                    },
                    now(),
                );
                drop(repo);
                // Stale browser cookies poison YouTube's response (only
                // storyboards come back), surfacing as "Requested format is
                // not available". One immediate retry without cookies almost
                // always succeeds for public videos.
                let cookies_in_play = cookies_attached;
                let try_no_cookies = cookies_in_play
                    && super::detector::is_cookies_format_failure(&tail);
                if try_no_cookies {
                    if let Some(spec) = state_clone.job_specs.lock().unwrap().get_mut(&job_id) {
                        spec.skip_cookies = true;
                    }
                    // The slot freed at the child-wait above is now available
                    // — kick the queue so other pending jobs don't idle while
                    // this job re-spins.
                    drain_queue(app_clone.clone(), Arc::clone(&state_clone), &yt_dlp_owned);
                    let app_retry = app_clone.clone();
                    let state_retry = Arc::clone(&state_clone);
                    let yt_dlp_retry = yt_dlp_owned.clone();
                    std::thread::spawn(move || {
                        if let Err(e) =
                            retry_download(app_retry.clone(), state_retry, &yt_dlp_retry, job_id)
                        {
                            eprintln!("[yt-dlp:{job_id}] no-cookies retry failed: {e}");
                            let _ = app_retry.emit(
                                "downloader:failed",
                                serde_json::json!({ "id": job_id }),
                            );
                        }
                    });
                    return;
                }
                // Auto-retry for transient errors (network hiccups, 5xx) up to 2 attempts
                // with exponential backoff (2s, 6s).
                let attempts = {
                    let mut counts = state_clone.retry_counts.lock().unwrap();
                    let n = counts.entry(job_id).or_insert(0);
                    *n += 1;
                    *n
                };
                if attempts <= 2 && is_transient_error(&tail) {
                    let backoff = std::time::Duration::from_secs(2 * (3u64.pow(attempts - 1)));
                    // Free-slot semantics: the queue drain must happen now so
                    // other pending jobs can run during this job's backoff
                    // sleep instead of waiting up to 6 s.
                    drain_queue(app_clone.clone(), Arc::clone(&state_clone), &yt_dlp_owned);
                    let app_retry = app_clone.clone();
                    let state_retry = Arc::clone(&state_clone);
                    let yt_dlp_retry = yt_dlp_owned.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(backoff);
                        if let Err(e) =
                            retry_download(app_retry.clone(), state_retry, &yt_dlp_retry, job_id)
                        {
                            eprintln!("[yt-dlp:{job_id}] auto-retry failed: {e}");
                            let _ = app_retry.emit(
                                "downloader:failed",
                                serde_json::json!({ "id": job_id }),
                            );
                        }
                    });
                } else {
                    state_clone.retry_counts.lock().unwrap().remove(&job_id);
                    let _ = app_clone.emit(
                        "downloader:failed",
                        serde_json::json!({ "id": job_id }),
                    );
                    drain_queue(app_clone.clone(), Arc::clone(&state_clone), &yt_dlp_owned);
                }
            }
        }
    });

    Ok(())
}

/// Pull the next pending job off the queue (if any) and spawn it.
/// Called after a slot frees (completion, failure, cancellation).
pub fn drain_queue(app: AppHandle, state: Arc<RunnerState>, yt_dlp: &Path) {
    loop {
        let next_id = {
            let active = state.active.lock().unwrap().len();
            let max = *state.max_parallel.lock().unwrap();
            if max > 0 && active >= max {
                return;
            }
            state.pending_queue.lock().unwrap().pop_front()
        };
        let Some(id) = next_id else { return };
        let spec = state.job_specs.lock().unwrap().get(&id).cloned();
        let Some(spec) = spec else { continue };
        if let Err(e) = spawn_download(
            app.clone(),
            Arc::clone(&state),
            yt_dlp,
            id,
            &spec.url,
            spec.height,
            &spec.kind,
        ) {
            eprintln!("[downloader] drain_queue spawn failed for {id}: {e}");
        }
    }
}

pub fn cancel_download(state: &RunnerState, job_id: i64) -> Result<(), String> {
    if let Some(mut child) = state.active.lock().unwrap().remove(&job_id) {
        let _ = child.kill();
    }
    state
        .pending_queue
        .lock()
        .unwrap()
        .retain(|id| *id != job_id);
    state.job_specs.lock().unwrap().remove(&job_id);
    state.retry_counts.lock().unwrap().remove(&job_id);
    if let Ok(mut repo) = state.jobs.lock() {
        let _ = repo.set_status(job_id, "cancelled");
    }
    Ok(())
}

#[cfg(unix)]
fn send_signal(pid: u32, sig: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .arg(sig)
        .arg(pid.to_string())
        .status()
        .map_err(|e| format!("spawn kill: {e}"))?;
    if !status.success() {
        return Err(format!("kill {sig} {pid} exited with {status}"));
    }
    Ok(())
}

pub fn pause_download(state: &RunnerState, job_id: i64) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = {
            let guard = state.active.lock().unwrap();
            guard.get(&job_id).map(|c| c.id())
        };
        let pid = pid.ok_or_else(|| "job not active".to_string())?;
        send_signal(pid, "-STOP")?;
    }
    if let Ok(mut repo) = state.jobs.lock() {
        let _ = repo.set_status(job_id, "paused");
    }
    Ok(())
}

pub fn resume_download(state: &RunnerState, job_id: i64) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = {
            let guard = state.active.lock().unwrap();
            guard.get(&job_id).map(|c| c.id())
        };
        let pid = pid.ok_or_else(|| "job not active".to_string())?;
        send_signal(pid, "-CONT")?;
    }
    if let Ok(mut repo) = state.jobs.lock() {
        let _ = repo.set_status(job_id, "active");
    }
    Ok(())
}

/// Restart a failed/cancelled job using its stored spawn args.
pub fn retry_download(
    app: AppHandle,
    state: Arc<RunnerState>,
    yt_dlp: &Path,
    job_id: i64,
) -> Result<(), String> {
    let spec = state
        .job_specs
        .lock()
        .unwrap()
        .get(&job_id)
        .cloned()
        .ok_or_else(|| "no spawn args recorded for this job".to_string())?;
    if let Ok(mut repo) = state.jobs.lock() {
        let _ = repo.set_status(job_id, "pending");
    }
    spawn_download(app, state, yt_dlp, job_id, &spec.url, spec.height, &spec.kind)
}

/// Classify a stderr snapshot as transient (worth auto-retry) or permanent.
pub fn is_transient_error(stderr_tail: &str) -> bool {
    let lower = stderr_tail.to_lowercase();
    const TRANSIENT: &[&str] = &[
        "http error 5",
        "timed out",
        "timeout",
        "connection reset",
        "temporary failure",
        "network is unreachable",
        "no route to host",
        "read error",
    ];
    const PERMANENT: &[&str] = &[
        "requested format is not available",
        "login required",
        "private video",
        "sign in",
        "copyright",
        "video unavailable",
        "members-only",
        "age-restricted",
    ];
    if PERMANENT.iter().any(|p| lower.contains(p)) {
        return false;
    }
    TRANSIENT.iter().any(|p| lower.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_5xx_is_retryable() {
        assert!(is_transient_error("HTTP Error 503: Service Unavailable"));
        assert!(is_transient_error("Connection reset by peer"));
        assert!(is_transient_error("read error: timed out"));
    }

    #[test]
    fn permanent_errors_are_not_retryable() {
        assert!(!is_transient_error("ERROR: Requested format is not available"));
        assert!(!is_transient_error("ERROR: login required"));
        assert!(!is_transient_error("Video unavailable"));
    }

    #[test]
    fn permanent_wins_over_transient() {
        assert!(!is_transient_error(
            "HTTP Error 503 while probing; video unavailable"
        ));
    }
}
