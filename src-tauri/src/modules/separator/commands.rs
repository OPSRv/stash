//! Tauri commands: install / run / cancel for the stem-separation +
//! tempo-detection sidecar.
//!
//! Same opt-in shape as `modules::diarization::commands` — the user
//! installs once, then every separator action ("Розділити стеми",
//! Telegram `/stems`, the LLM tool) checks `state::assets_ready` before
//! kicking off any work.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::catalog::{self, AssetKind, SeparatorAsset, ALL, OPTIONAL_FT, REQUIRED};
use super::jobs::{now_unix, source_dir_name, JobMode, JobStatus, SeparatorJob};
use super::pipeline;
use super::state::{
    asset_path, assets_ready, ft_ready, models_root, output_dir_default, root_dir,
    sidecar_executable, SeparatorState,
};

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent<'a> {
    id: &'a str,
    received: u64,
    total: u64,
    done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeparatorAssetStatus {
    pub kind: &'static str,
    pub label: &'static str,
    pub size_bytes: u64,
    pub optional: bool,
    pub downloaded: bool,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeparatorStatus {
    /// Required pack (sidecar + htdemucs_6s) is fully installed.
    pub ready: bool,
    /// All four htdemucs_ft files are installed.
    pub ft_ready: bool,
    pub assets: Vec<SeparatorAssetStatus>,
    pub default_output_dir: String,
}

#[tauri::command]
pub fn separator_status(app: AppHandle) -> Result<SeparatorStatus, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let assets = ALL
        .iter()
        .map(|a| {
            let path = asset_path(&data_dir, a);
            let downloaded = std::fs::metadata(&path)
                .map(|meta| meta.len() >= catalog::min_plausible_bytes(a.kind))
                .unwrap_or(false);
            SeparatorAssetStatus {
                kind: kind_str(a.kind),
                label: a.label,
                size_bytes: a.size_bytes,
                optional: a.optional,
                downloaded,
                local_path: downloaded.then(|| path.display().to_string()),
            }
        })
        .collect::<Vec<_>>();
    Ok(SeparatorStatus {
        ready: assets_ready(&data_dir),
        ft_ready: ft_ready(&data_dir),
        assets,
        default_output_dir: output_dir_default().display().to_string(),
    })
}

/// Download whichever assets are missing. `with_ft = true` adds the
/// optional htdemucs_ft pack (~320 MB). Idempotent — already-present
/// files emit a `done` event and are skipped.
#[tauri::command]
pub async fn separator_download(
    app: AppHandle,
    state: State<'_, Arc<SeparatorState>>,
    with_ft: bool,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(root_dir(&data_dir)).map_err(|e| format!("mkdir: {e}"))?;

    let mut targets: Vec<&SeparatorAsset> = REQUIRED.iter().copied().collect();
    if with_ft {
        targets.extend(OPTIONAL_FT.iter().copied());
    }

    for a in targets {
        let path = asset_path(&data_dir, a);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        if std::fs::metadata(&path)
            .map(|meta| meta.len() >= catalog::min_plausible_bytes(a.kind))
            .unwrap_or(false)
        {
            // Already on disk and plausible — short-circuit but make
            // sure the sidecar tarball was actually unpacked, since the
            // .tar.gz can survive across an interrupted install.
            if a.kind == AssetKind::Sidecar {
                ensure_sidecar_extracted(&data_dir)?;
            }
            let _ = app.emit(
                "separator:download",
                DownloadEvent {
                    id: kind_str(a.kind),
                    received: a.size_bytes,
                    total: a.size_bytes,
                    done: true,
                },
            );
            continue;
        }
        {
            let mut inflight = state.in_flight.lock().unwrap();
            if !inflight.insert(a.filename) {
                return Err(format!("{} download already in progress", a.label));
            }
        }
        let result = run_download(&app, a, &path).await;
        if result.is_ok() && a.kind == AssetKind::Sidecar {
            // Extract the tarball into bin/, then remove the archive so
            // a future "is the sidecar installed?" check doesn't get
            // confused between the unpacked tree and the archive sitting
            // next to it.
            extract_sidecar_archive(&path)?;
            ensure_executable(&sidecar_executable(&data_dir))?;
            let _ = std::fs::remove_file(&path);
        }
        state.in_flight.lock().unwrap().remove(a.filename);
        result?;
    }
    Ok(())
}

#[tauri::command]
pub fn separator_delete(app: AppHandle, ft_only: bool) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if ft_only {
        for a in OPTIONAL_FT {
            let path = asset_path(&data_dir, a);
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("rm {}: {e}", path.display()))?;
            }
        }
        return Ok(());
    }
    // Full uninstall — wipe the entire `separator/` subtree so the bin
    // directory's PyInstaller dist + any partial downloads go with it.
    let root = root_dir(&data_dir);
    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|e| format!("rm {}: {e}", root.display()))?;
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeparatorRunArgs {
    pub input_path: String,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub stems: Option<Vec<String>>,
    pub output_dir: Option<String>,
}

#[tauri::command]
pub fn separator_run(
    app: AppHandle,
    state: State<'_, Arc<SeparatorState>>,
    args: SeparatorRunArgs,
) -> Result<String, String> {
    enqueue_job(&app, &state, args)
}

/// Schedule a separator job and return its id. Shared between the
/// Tauri `separator_run` command (frontend) and the Telegram `/stems`
/// + `/bpm` handlers — both need the same validation, queue insert,
/// and worker kick.
pub fn enqueue_job(
    app: &AppHandle,
    state: &Arc<SeparatorState>,
    args: SeparatorRunArgs,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if !assets_ready(&data_dir) {
        return Err("separator assets not installed".into());
    }
    let input = PathBuf::from(&args.input_path);
    if !input.is_file() {
        return Err(format!("input file not found: {}", input.display()));
    }

    let mode = args
        .mode
        .as_deref()
        .map(JobMode::from_str_lossy)
        .unwrap_or(JobMode::Analyze);
    let model = pick_model(args.model.as_deref(), &data_dir);
    let base_out = args
        .output_dir
        .map(PathBuf::from)
        .unwrap_or_else(output_dir_default);
    let job_dir = base_out.join(source_dir_name(&args.input_path));
    std::fs::create_dir_all(&job_dir)
        .map_err(|e| format!("mkdir {}: {e}", job_dir.display()))?;

    let job_id = format!("sep-{}-{}", now_unix(), random_suffix());
    let job = SeparatorJob {
        id: job_id.clone(),
        input_path: args.input_path,
        model: model.clone(),
        mode,
        stems: args.stems.filter(|s| !s.is_empty()),
        output_dir: job_dir.display().to_string(),
        status: JobStatus::Queued,
        progress: 0.0,
        phase: "queued".into(),
        started_at: now_unix(),
        finished_at: None,
        error: None,
        result: None,
    };
    state.jobs.lock().unwrap().push(job.clone());
    emit_job(app, &job);

    pump_queue(app, state);
    Ok(job_id)
}

#[tauri::command]
pub fn separator_cancel(
    state: State<'_, Arc<SeparatorState>>,
    job_id: String,
) -> Result<(), String> {
    // Mark the job cancelled first so the worker thread doesn't race
    // with us: when wait_with_output returns, the worker checks the
    // current status before flipping it to Failed/Completed.
    let was_running = {
        let mut jobs = state.jobs.lock().unwrap();
        let Some(j) = jobs.iter_mut().find(|j| j.id == job_id) else {
            return Err(format!("job not found: {job_id}"));
        };
        if matches!(j.status, JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled) {
            return Ok(());
        }
        let was = j.status == JobStatus::Running;
        j.status = JobStatus::Cancelled;
        j.finished_at = Some(now_unix());
        was
    };
    if was_running {
        if let Some(pid) = *state.active_pid.lock().unwrap() {
            let _ = std::process::Command::new("/bin/kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn separator_list_jobs(state: State<'_, Arc<SeparatorState>>) -> Vec<SeparatorJob> {
    state.jobs.lock().unwrap().clone()
}

#[tauri::command]
pub fn separator_clear_completed(state: State<'_, Arc<SeparatorState>>) {
    state.jobs.lock().unwrap().retain(|j| {
        !matches!(
            j.status,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
        )
    });
}

// ── helpers ─────────────────────────────────────────────────────────

fn kind_str(k: AssetKind) -> &'static str {
    match k {
        AssetKind::Sidecar => "sidecar",
        AssetKind::Htdemucs6s => "htdemucs_6s",
        AssetKind::HtdemucsFtVocals => "htdemucs_ft_vocals",
        AssetKind::HtdemucsFtDrums => "htdemucs_ft_drums",
        AssetKind::HtdemucsFtBass => "htdemucs_ft_bass",
        AssetKind::HtdemucsFtOther => "htdemucs_ft_other",
    }
}

fn pick_model(requested: Option<&str>, data_dir: &Path) -> String {
    // The UI/LLM may ask for a model the user hasn't installed; we fall
    // back to whatever is available rather than letting demucs error
    // out at runtime.
    let req = requested.unwrap_or("htdemucs_6s");
    match req {
        "htdemucs_ft" if ft_ready(data_dir) => "htdemucs_ft".into(),
        "htdemucs_ft" => "htdemucs_6s".into(),
        "htdemucs" => "htdemucs".into(),
        _ => "htdemucs_6s".into(),
    }
}

fn random_suffix() -> String {
    // We don't need cryptographic uniqueness; the job id only needs to
    // disambiguate jobs created within the same second. Hash of the
    // current Instant is fine.
    use std::time::Instant;
    let n = format!("{:?}", Instant::now());
    let mut h: u64 = 1469598103934665603; // FNV-1a offset
    for b in n.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:08x}", (h as u32))
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    let mut perms = meta.permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms)
        .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Unpack the sidecar tarball into `separator/bin/`. We shell out to
/// `tar` because macOS ships it natively and the alternative — adding
/// `tar` + `flate2` to Cargo.toml — would bloat the main binary by a
/// few hundred KB just to read a file the OS already knows how to.
///
/// After extraction we strip Gatekeeper's quarantine attribute from
/// the unpacked tree. The downloaded tarball comes from a non-Apple
/// source (GitHub Releases), so macOS slaps `com.apple.quarantine`
/// on every file inside; running an unsigned PyInstaller binary with
/// that attr present produces "stash-separator can't be opened" with
/// no remedy from the in-app side. Stripping it on extract turns
/// that into a single `bash -c xattr` instead of teaching every user
/// the right Terminal incantation.
fn extract_sidecar_archive(archive: &Path) -> Result<(), String> {
    let parent = archive
        .parent()
        .ok_or_else(|| format!("archive has no parent dir: {}", archive.display()))?;
    let status = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(parent)
        .status()
        .map_err(|e| format!("spawn tar: {e}"))?;
    if !status.success() {
        return Err(format!("tar exited {status}"));
    }
    let bundle = parent.join("stash-separator");
    if bundle.is_dir() {
        let _ = std::process::Command::new("xattr")
            .arg("-dr")
            .arg("com.apple.quarantine")
            .arg(&bundle)
            .status();
    }
    Ok(())
}

/// Defend against an interrupted install where the .tar.gz was deleted
/// but the unpack didn't finish — re-run the extract if the binary
/// isn't there.
fn ensure_sidecar_extracted(data_dir: &Path) -> Result<(), String> {
    let bin = sidecar_executable(data_dir);
    if bin.is_file() {
        return Ok(());
    }
    let archive = root_dir(data_dir)
        .join("bin")
        .join(catalog::SIDECAR.filename);
    if archive.is_file() {
        extract_sidecar_archive(&archive)?;
        ensure_executable(&bin)?;
        let _ = std::fs::remove_file(&archive);
    }
    Ok(())
}

async fn run_download(
    app: &AppHandle,
    spec: &SeparatorAsset,
    final_path: &Path,
) -> Result<(), String> {
    let url = catalog::resolve_url(spec);
    if !url.starts_with("https://") {
        return Err("asset url must be https".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("stash-app/separator-downloader")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(spec.size_bytes);
    let tmp = final_path.with_extension("part");
    let _ = std::fs::remove_file(&tmp);
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    use futures_util::StreamExt;
    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        file.write_all(&bytes).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        received += bytes.len() as u64;
        if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "separator:download",
                DownloadEvent {
                    id: kind_str(spec.kind),
                    received,
                    total,
                    done: false,
                },
            );
        }
    }
    drop(file);

    let len = std::fs::metadata(&tmp).map_err(|e| e.to_string())?.len();
    let min = catalog::min_plausible_bytes(spec.kind);
    if len < min {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "{}: download produced only {len} bytes (< {min}) — looks corrupt",
            spec.label
        ));
    }
    if !catalog::size_is_plausible(spec.size_bytes, len) {
        tracing::warn!(
            label = spec.label,
            got = len,
            expected = spec.size_bytes,
            "downloaded asset size differs from catalog — accepting anyway"
        );
    }
    std::fs::rename(&tmp, final_path).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "separator:download",
        DownloadEvent {
            id: kind_str(spec.kind),
            received: len,
            total: len,
            done: true,
        },
    );
    Ok(())
}

// ── job worker ──────────────────────────────────────────────────────

fn emit_job(app: &AppHandle, job: &SeparatorJob) {
    let _ = app.emit("separator:job", job.clone());
}

fn update_job<F: FnOnce(&mut SeparatorJob)>(
    app: &AppHandle,
    state: &Arc<SeparatorState>,
    job_id: &str,
    f: F,
) -> Option<SeparatorJob> {
    let mut jobs = state.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|j| j.id == job_id)?;
    f(job);
    let snapshot = job.clone();
    drop(jobs);
    emit_job(app, &snapshot);
    Some(snapshot)
}

/// Find the next queued job and spawn a worker thread for it. Called
/// after every job-state transition (push, cancel, completion) so the
/// queue is single-threaded but always moves.
fn pump_queue(app: &AppHandle, state: &Arc<SeparatorState>) {
    if state.active_pid.lock().unwrap().is_some() {
        return; // a worker is already running
    }
    let next_id = {
        let jobs = state.jobs.lock().unwrap();
        jobs.iter()
            .find(|j| j.status == JobStatus::Queued)
            .map(|j| j.id.clone())
    };
    let Some(job_id) = next_id else {
        return;
    };
    let app2 = app.clone();
    let state2 = Arc::clone(state);
    std::thread::spawn(move || run_worker(app2, state2, job_id));
}

fn run_worker(app: AppHandle, state: Arc<SeparatorState>, job_id: String) {
    let data_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            mark_failed(&app, &state, &job_id, format!("app_data_dir: {e}"));
            return;
        }
    };
    if !assets_ready(&data_dir) {
        mark_failed(
            &app,
            &state,
            &job_id,
            "separator assets not installed".into(),
        );
        pump_queue(&app, &state);
        return;
    }
    let bin = sidecar_executable(&data_dir);
    let models_root = models_root(&data_dir);

    // Snapshot the job parameters so we don't hold the jobs-lock during
    // the multi-second spawn / wait below.
    let snapshot = {
        let jobs = state.jobs.lock().unwrap();
        jobs.iter().find(|j| j.id == job_id).cloned()
    };
    let Some(job) = snapshot else {
        return; // job got cleared between push and worker pickup
    };

    // The user may have cancelled while the job sat queued.
    if job.status == JobStatus::Cancelled {
        pump_queue(&app, &state);
        return;
    }

    update_job(&app, &state, &job_id, |j| {
        j.status = JobStatus::Running;
        j.progress = 0.0;
        j.phase = "starting".into();
        j.started_at = now_unix();
    });

    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--mode").arg(job.mode.as_arg());
    cmd.arg("--input").arg(&job.input_path);
    cmd.arg("--out-dir").arg(&job.output_dir);
    cmd.arg("--model").arg(&job.model);
    cmd.arg("--device").arg("auto");
    cmd.arg("--models-dir").arg(&models_root);
    if let Some(stems) = job.stems.as_ref() {
        if !stems.is_empty() {
            cmd.arg("--stems").arg(stems.join(","));
        }
    }
    cmd.env("TORCH_HOME", &models_root);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            mark_failed(&app, &state, &job_id, format!("spawn sidecar: {e}"));
            pump_queue(&app, &state);
            return;
        }
    };
    let pid = child.id();
    *state.active_pid.lock().unwrap() = Some(pid);

    let stderr = child.stderr.take();
    let stderr_thread = stderr.map(|e| {
        let app_for = app.clone();
        let state_for = Arc::clone(&state);
        let job_for = job_id.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(e);
            for line in reader.lines().map_while(Result::ok) {
                if let Some((frac, phase)) = pipeline::parse_progress_line(&line) {
                    update_job(&app_for, &state_for, &job_for, |j| {
                        if j.status == JobStatus::Running {
                            j.progress = frac;
                            j.phase = phase.clone();
                        }
                    });
                } else if !line.trim().is_empty() {
                    tracing::debug!(target: "separator", "{line}");
                }
            }
        })
    });

    let output = child.wait_with_output();
    *state.active_pid.lock().unwrap() = None;
    if let Some(t) = stderr_thread {
        let _ = t.join();
    }

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            mark_failed(&app, &state, &job_id, format!("wait sidecar: {e}"));
            pump_queue(&app, &state);
            return;
        }
    };

    // Cancel-races: if the user already flipped status to Cancelled,
    // keep it — the SIGTERM we sent would otherwise show up as
    // `Failed: separator sidecar produced no output`.
    let was_cancelled = state
        .jobs
        .lock()
        .unwrap()
        .iter()
        .any(|j| j.id == job_id && j.status == JobStatus::Cancelled);
    if was_cancelled {
        pump_queue(&app, &state);
        return;
    }

    match pipeline::parse_sidecar_output(&output.stdout) {
        Ok(analysis) => {
            update_job(&app, &state, &job_id, |j| {
                j.status = JobStatus::Completed;
                j.progress = 1.0;
                j.phase = "done".into();
                j.finished_at = Some(now_unix());
                j.result = Some(analysis.clone());
            });
        }
        Err(e) => {
            // Surface stderr tail in the error to give the user *some*
            // diagnostic on a hard crash. Limit to the last 4 KB so we
            // don't fill the panel with torch warnings.
            let stderr_tail = String::from_utf8_lossy(&output.stderr);
            let tail = stderr_tail
                .chars()
                .rev()
                .take(4096)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            mark_failed(&app, &state, &job_id, format!("{e}\n---stderr---\n{tail}"));
        }
    }

    pump_queue(&app, &state);
}

fn mark_failed(app: &AppHandle, state: &Arc<SeparatorState>, job_id: &str, error: String) {
    update_job(app, state, job_id, |j| {
        if j.status != JobStatus::Cancelled {
            j.status = JobStatus::Failed;
            j.error = Some(error);
            j.finished_at = Some(now_unix());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_model_falls_back_when_ft_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        // ft pack is not installed → htdemucs_ft request degrades to
        // 6s instead of failing later inside the sidecar.
        assert_eq!(pick_model(Some("htdemucs_ft"), tmp.path()), "htdemucs_6s");
        assert_eq!(pick_model(Some("htdemucs_6s"), tmp.path()), "htdemucs_6s");
        assert_eq!(pick_model(Some("htdemucs"), tmp.path()), "htdemucs");
        assert_eq!(pick_model(None, tmp.path()), "htdemucs_6s");
        assert_eq!(pick_model(Some("garbage"), tmp.path()), "htdemucs_6s");
    }

    #[test]
    fn random_suffix_is_hex_eight_chars() {
        let s = random_suffix();
        assert_eq!(s.len(), 8);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn kind_str_round_trips_for_all_kinds() {
        for a in catalog::ALL {
            let s = kind_str(a.kind);
            assert!(!s.is_empty());
        }
    }
}
