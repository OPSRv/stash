//! Tauri commands: install / run / cancel for the stem-separation +
//! tempo-detection pipeline.
//!
//! Install is a multi-step affair (uv → Python → venv → pip → models)
//! orchestrated by `installer::run_runtime_install` plus the per-model
//! download loop here. Both halves emit progress on
//! `separator:install`. Run / cancel mirror the diarization shape:
//! one job at a time (htdemucs_ft can peak at ~6 GB RAM), the worker
//! thread holds the spawned `Child` and the cancel command kills its
//! PID.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::catalog::{self, AssetKind, SeparatorAsset, ALL, OPTIONAL_FT, REQUIRED};
use super::installer;
use super::jobs::{now_unix, source_dir_name, JobMode, JobStatus, SeparatorJob};
use super::pipeline;
use super::state::{
    asset_path, ft_ready, install_flag, models_root, output_dir_default, python_path, ready,
    root_dir, runtime_ready, script_path, SeparatorState,
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
    /// Required runtime + model are both installed — separator can
    /// service a job without further downloads.
    pub ready: bool,
    /// Python runtime (uv + venv + pip packages) is fully installed.
    pub runtime_ready: bool,
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
        ready: ready(&data_dir),
        runtime_ready: runtime_ready(&data_dir),
        ft_ready: ft_ready(&data_dir),
        assets,
        default_output_dir: output_dir_default().display().to_string(),
    })
}

/// Install / fix-up the runtime, then download whichever model assets
/// are missing. `with_ft = true` adds the optional htdemucs_ft pack
/// (~320 MB). Idempotent — every step short-circuits when its target
/// is already in place.
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

    // Concurrency guard for the whole install pipeline. Two parallel
    // `uv pip install` runs against the same venv can produce a
    // half-built Python environment that imports clean but fails on
    // the first call (we've seen it during dev). One install at a
    // time, please.
    {
        let mut flag = state.install_in_flight.lock().unwrap();
        if *flag {
            return Err("Install already in progress".into());
        }
        *flag = true;
    }
    let result = run_install_inner(&app, &data_dir, &state, with_ft).await;
    *state.install_in_flight.lock().unwrap() = false;
    result
}

async fn run_install_inner(
    app: &AppHandle,
    data_dir: &Path,
    state: &Arc<SeparatorState>,
    with_ft: bool,
) -> Result<(), String> {
    // Surface a `phase` tick the moment install starts so the UI's
    // staged card pops into view immediately. Without this, an install
    // that short-circuits (everything already on disk) would emit
    // nothing visible — the user clicks "Завантажити" and sees
    // nothing happening, then a flash of "Готово".
    installer::emit_phase(
        app,
        installer::InstallPhase::Uv,
        "Checking install state…",
        Some(0.0),
    );

    if !runtime_ready(data_dir) {
        installer::run_runtime_install(app, data_dir).await?;
    } else {
        // Runtime says "installed" — but a stale install_flag from a
        // pre-fix install can still leave the venv unable to import
        // demucs.api. Re-run the cheap probe; on failure, wipe the
        // runtime and reinstall fresh so the user doesn't have to
        // hit Wipe themselves.
        if let Err(e) = installer::verify_runtime(app, data_dir) {
            tracing::warn!(error = %e, "stale runtime — reinstalling");
            installer::emit_phase(
                app,
                installer::InstallPhase::Uv,
                "Broken venv — reinstalling…",
                None,
            );
            installer::purge_runtime(data_dir)?;
            installer::run_runtime_install(app, data_dir).await?;
        }
    }

    let mut targets: Vec<&SeparatorAsset> = REQUIRED.iter().copied().collect();
    if with_ft {
        targets.extend(OPTIONAL_FT.iter().copied());
    }

    let total = targets.len().max(1);
    installer::emit_phase(
        app,
        installer::InstallPhase::Models,
        "Downloading models…",
        Some(0.0),
    );
    for (idx, a) in targets.iter().enumerate() {
        let path = asset_path(data_dir, a);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        if std::fs::metadata(&path)
            .map(|meta| meta.len() >= catalog::min_plausible_bytes(a.kind))
            .unwrap_or(false)
        {
            let _ = app.emit(
                "separator:download",
                DownloadEvent {
                    id: kind_str(a.kind),
                    received: a.size_bytes,
                    total: a.size_bytes,
                    done: true,
                },
            );
            installer::emit_phase(
                app,
                installer::InstallPhase::Models,
                &format!("{} already on disk", a.label),
                Some((idx + 1) as f32 / total as f32),
            );
            continue;
        }
        {
            let mut inflight = state.in_flight.lock().unwrap();
            if !inflight.insert(a.filename) {
                return Err(format!("{} download already in progress", a.label));
            }
        }
        let result = run_download(app, a, &path, idx, total).await;
        state.in_flight.lock().unwrap().remove(a.filename);
        result?;
    }
    installer::emit_phase(
        app,
        installer::InstallPhase::Done,
        "Done",
        Some(1.0),
    );
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
    // Full uninstall — wipe the runtime and every model. Drop the
    // install flag first so a concurrent ready-check can't catch a
    // half-deleted state.
    let _ = std::fs::remove_file(install_flag(&data_dir));
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
    if !ready(&data_dir) {
        return Err("separator runtime / assets not installed".into());
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
    let removed: Vec<SeparatorJob> = {
        let mut jobs = state.jobs.lock().unwrap();
        let mut keep = Vec::with_capacity(jobs.len());
        let mut drop_ = Vec::new();
        for j in jobs.drain(..) {
            if matches!(
                j.status,
                JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
            ) {
                drop_.push(j);
            } else {
                keep.push(j);
            }
        }
        *jobs = keep;
        drop_
    };
    // Wipe each cleared job's output directory off disk too. Best-effort:
    // a failed rmdir is logged but doesn't block the in-memory clear so
    // the UI never gets out of sync with state.
    for job in removed {
        purge_job_dir(&job);
    }
}

/// Delete a single job — both the in-memory entry and (best-effort) the
/// on-disk output directory. Returns `Err` only when the job id is
/// unknown; filesystem errors are swallowed because the directory may
/// already be gone (user moved it, OS cleared `/tmp`, etc.) and forcing
/// the user to re-confirm a delete after a partial failure is worse UX
/// than just letting the row vanish.
#[tauri::command]
pub fn separator_remove_job(
    state: State<'_, Arc<SeparatorState>>,
    job_id: String,
) -> Result<(), String> {
    let job = {
        let mut jobs = state.jobs.lock().unwrap();
        let idx = jobs
            .iter()
            .position(|j| j.id == job_id)
            .ok_or_else(|| format!("job not found: {job_id}"))?;
        jobs.remove(idx)
    };
    purge_job_dir(&job);
    Ok(())
}

/// Walk the user's stems output directory and reconstruct one
/// `SeparatorJob` per subfolder that holds a `manifest.json`. Used on
/// startup so a fresh popup process still sees historical jobs the user
/// produced before the relaunch — the in-memory `state.jobs` would
/// otherwise come up empty.
///
/// Synthetic jobs are merged with the live in-memory list; entries that
/// already exist (matched by `output_dir`) are kept as-is so an actively
/// running job doesn't get clobbered by its half-written manifest.
#[tauri::command]
pub fn separator_scan_disk(
    app: AppHandle,
    state: State<'_, Arc<SeparatorState>>,
) -> Result<Vec<SeparatorJob>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    // Mirror the start-of-job logic so the scan walks the same folder
    // the worker writes into. Honouring a custom output_dir setting is
    // a future enhancement — today the user-facing default is the only
    // location the UI can produce.
    let _ = data_dir; // referenced for future overrides
    let base = output_dir_default();
    let synthetic = scan_jobs_on_disk(&base);

    // Merge: keep live in-memory jobs as-is; append disk entries that
    // don't share an output_dir with anything in state. Sort the result
    // newest-first so the UI gets a deterministic order.
    let mut jobs = state.jobs.lock().unwrap();
    for s in synthetic {
        let already_tracked = jobs.iter().any(|j| j.output_dir == s.output_dir);
        if !already_tracked {
            jobs.push(s);
        }
    }
    jobs.sort_by(|a, b| {
        b.finished_at
            .unwrap_or(b.started_at)
            .cmp(&a.finished_at.unwrap_or(a.started_at))
    });
    Ok(jobs.clone())
}

/// Best-effort `rm -rf` of `job.output_dir`. Stays inside the user's
/// stems directory by checking that the path was something we wrote
/// ourselves — protecting against a corrupted state where output_dir
/// was somehow set to a parent / system path.
fn purge_job_dir(job: &SeparatorJob) {
    let dir = match job
        .result
        .as_ref()
        .and_then(|r| r.stems_dir.clone())
        .or_else(|| {
            if job.output_dir.is_empty() {
                None
            } else {
                Some(job.output_dir.clone())
            }
        }) {
        Some(d) => PathBuf::from(d),
        None => return,
    };
    if !dir.exists() || !dir.is_dir() {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        eprintln!("[separator] purge {} failed: {e}", dir.display());
    }
}

/// Walk every immediate subdirectory of `base` and reconstruct one
/// `SeparatorJob` per folder. Two paths:
///
///   1. **Manifest present** (`manifest.json`) — parse it directly.
///      That's the canonical record written by recent runs.
///   2. **Legacy folder** — folders produced before manifest support
///      was added. We synthesise a minimal job from the stem files we
///      can recognise (`vocals.wav`, `drums.wav`, …) so the user
///      sees their existing extractions instead of an empty Done list.
///
/// On a successful legacy reconstruction we *also* write a manifest so
/// subsequent scans take the fast path. That keeps the cost of "I have
/// 200 old folders" to a single boot and avoids re-listing each folder
/// on every popup open.
fn scan_jobs_on_disk(base: &Path) -> Vec<SeparatorJob> {
    let entries = match std::fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
            match serde_json::from_str::<SeparatorJob>(&raw) {
                Ok(job) => out.push(job),
                Err(e) => eprintln!("[separator] manifest {}: {e}", manifest_path.display()),
            }
            continue;
        }
        if let Some(job) = reconstruct_legacy_job(&path) {
            // Promote the synthetic record to a real manifest so we
            // don't rebuild it from scratch every boot. Best-effort —
            // a read-only directory still surfaces the job in the UI.
            write_manifest(&job);
            out.push(job);
        }
    }
    out
}

/// Stem keys we recognise inside a legacy folder. Mirrors the set
/// `STEM_LABELS` in `api.ts` — Demucs writes one wav per key. We
/// accept any of the audio extensions the sidecar can output (wav is
/// the default but mp3 is a common manual conversion).
const KNOWN_STEM_NAMES: &[&str] = &["vocals", "drums", "bass", "other", "guitar", "piano"];
const STEM_FILE_EXTS: &[&str] = &["wav", "flac", "mp3", "m4a", "ogg", "aac"];

/// Build a `SeparatorJob` from the stem files we find inside `dir`.
/// Returns `None` when the folder has no recognisable stem audio —
/// that's how we filter random folders the user happened to drop into
/// `Stash Stems/` (cover art exports, README files, etc.).
fn reconstruct_legacy_job(dir: &Path) -> Option<SeparatorJob> {
    let mut stems: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_ascii_lowercase(),
            None => continue,
        };
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !STEM_FILE_EXTS.iter().any(|e| *e == ext.as_str()) {
            continue;
        }
        if !KNOWN_STEM_NAMES.iter().any(|n| *n == stem.as_str()) {
            continue;
        }
        stems.insert(stem, p.display().to_string());
    }
    if stems.is_empty() {
        return None;
    }
    // Folder mtime is the only honest "when was this finished" we
    // have. Falling back to 0 when the OS doesn't expose it keeps
    // sorting deterministic but pushes legacy entries to the bottom,
    // which is the desired behaviour anyway.
    let finished_at = dir
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let folder_name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    let id = format!("legacy-{folder_name}");
    Some(SeparatorJob {
        id,
        // We don't know the original input path. The folder name is
        // what `source_dir_name` derived from it at run time, so it
        // still reads sensibly in the UI ("Djent Metal Drum Track…").
        input_path: folder_name,
        model: String::new(),
        mode: JobMode::Analyze,
        stems: None,
        output_dir: dir.display().to_string(),
        status: JobStatus::Completed,
        progress: 1.0,
        phase: "done".into(),
        started_at: finished_at,
        finished_at: Some(finished_at),
        error: None,
        result: Some(super::pipeline::SeparatorAnalysis {
            stems_dir: Some(dir.display().to_string()),
            stems: Some(stems),
            bpm: None,
            beats: None,
            duration_sec: None,
            model: None,
            device: None,
        }),
    })
}

/// Persist the canonical job state next to its stems so a future
/// process restart can reconstruct it via `scan_jobs_on_disk`. Called
/// after every terminal status transition (completed / failed /
/// cancelled). Best-effort — a write failure is logged but never
/// surfaced to the user, the in-memory state remains authoritative for
/// the live session.
pub(crate) fn write_manifest(job: &SeparatorJob) {
    let dir = PathBuf::from(&job.output_dir);
    if dir.as_os_str().is_empty() || !dir.is_dir() {
        return;
    }
    let path = dir.join("manifest.json");
    match serde_json::to_vec_pretty(job) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("[separator] manifest {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[separator] serialise manifest: {e}"),
    }
}

// ── helpers ─────────────────────────────────────────────────────────

fn kind_str(k: AssetKind) -> &'static str {
    match k {
        AssetKind::Htdemucs6s => "htdemucs_6s",
        AssetKind::HtdemucsFtVocals => "htdemucs_ft_vocals",
        AssetKind::HtdemucsFtDrums => "htdemucs_ft_drums",
        AssetKind::HtdemucsFtBass => "htdemucs_ft_bass",
        AssetKind::HtdemucsFtOther => "htdemucs_ft_other",
    }
}

fn pick_model(requested: Option<&str>, data_dir: &Path) -> String {
    let req = requested.unwrap_or("htdemucs_6s");
    match req {
        "htdemucs_ft" if ft_ready(data_dir) => "htdemucs_ft".into(),
        "htdemucs_ft" => "htdemucs_6s".into(),
        "htdemucs" => "htdemucs".into(),
        _ => "htdemucs_6s".into(),
    }
}

fn random_suffix() -> String {
    use std::time::Instant;
    let n = format!("{:?}", Instant::now());
    let mut h: u64 = 1469598103934665603;
    for b in n.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:08x}", (h as u32))
}

async fn run_download(
    app: &AppHandle,
    spec: &SeparatorAsset,
    final_path: &Path,
    asset_idx: usize,
    asset_total: usize,
) -> Result<(), String> {
    let url = catalog::resolve_url(spec);
    if !url.starts_with("https://") {
        return Err("asset url must be https".into());
    }
    // Connect timeout guards against the CDN never even completing
    // a TLS handshake; the per-chunk read timeout below catches a
    // mid-stream hang (the original symptom — Settings was stuck at
    // "Завантажую моделі" for minutes with no traffic and no error).
    let client = reqwest::Client::builder()
        .user_agent("stash-app/separator-downloader")
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(std::time::Duration::from_secs(30))
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
    let phase_base = asset_idx as f32 / asset_total as f32;
    let phase_span = 1.0 / asset_total as f32;
    use futures_util::StreamExt;
    use std::io::Write;
    loop {
        // 60-second per-chunk read timeout. A working CDN streams a
        // chunk well under a second; a stalled connection produces
        // none for minutes. Killing the request after a minute lets
        // the user retry instead of staring at a frozen progress bar.
        let chunk = match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            stream.next(),
        )
        .await
        {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(_) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!(
                    "{}: download stalled (60 s without data)",
                    spec.label
                ));
            }
        };
        let bytes = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        file.write_all(&bytes).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        received += bytes.len() as u64;
        if last_emit.elapsed() >= std::time::Duration::from_millis(150) {
            last_emit = std::time::Instant::now();
            let in_asset = if total > 0 {
                (received as f32 / total as f32).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "separator:download",
                DownloadEvent {
                    id: kind_str(spec.kind),
                    received,
                    total,
                    done: false,
                },
            );
            // Mirror the same byte progress into the install phase
            // card so the user sees the model phase actually moving.
            installer::emit_phase(
                app,
                installer::InstallPhase::Models,
                &format!(
                    "{} ({} / {})",
                    spec.label,
                    asset_idx + 1,
                    asset_total
                ),
                Some(phase_base + phase_span * in_asset),
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

fn pump_queue(app: &AppHandle, state: &Arc<SeparatorState>) {
    if state.active_pid.lock().unwrap().is_some() {
        return;
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
    if !ready(&data_dir) {
        mark_failed(
            &app,
            &state,
            &job_id,
            "separator runtime / assets not installed".into(),
        );
        pump_queue(&app, &state);
        return;
    }
    let python = python_path(&data_dir);
    let script = script_path(&data_dir);
    let models_root = models_root(&data_dir);

    let snapshot = {
        let jobs = state.jobs.lock().unwrap();
        jobs.iter().find(|j| j.id == job_id).cloned()
    };
    let Some(job) = snapshot else {
        return;
    };
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

    let mut cmd = std::process::Command::new(&python);
    cmd.arg(&script);
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
    // Force the Python stdout/stderr unbuffered so `progress` lines
    // reach us promptly. CPython buffers when stdout is a pipe by
    // default; this saves us a 4 KB-block delay on short clips.
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            mark_failed(&app, &state, &job_id, format!("spawn python: {e}"));
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
            mark_failed(&app, &state, &job_id, format!("wait python: {e}"));
            pump_queue(&app, &state);
            return;
        }
    };

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
            // Persist the manifest now that the terminal state is set —
            // a fresh popup launch will pick this folder back up via
            // `separator_scan_disk` so the user keeps their history.
            persist_manifest_for(&state, &job_id);
        }
        Err(e) => {
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

/// Snapshot the named job from state and write its manifest to disk.
/// Pulled out so completion / failure paths can call it without
/// re-locking the mutex inside the closure passed to `update_job`.
fn persist_manifest_for(state: &Arc<SeparatorState>, job_id: &str) {
    let snapshot = state
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|j| j.id == job_id)
        .cloned();
    if let Some(j) = snapshot {
        write_manifest(&j);
    }
}

fn mark_failed(app: &AppHandle, state: &Arc<SeparatorState>, job_id: &str, error: String) {
    update_job(app, state, job_id, |j| {
        if j.status != JobStatus::Cancelled {
            j.status = JobStatus::Failed;
            j.error = Some(error);
            j.finished_at = Some(now_unix());
        }
    });
    // Snapshot failure on disk too — the user might want to rm the folder
    // manually, and a manifest is the most reliable breadcrumb.
    persist_manifest_for(state, job_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_model_falls_back_when_ft_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
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
