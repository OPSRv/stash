//! Tauri commands: queue / run / cancel the ffmpeg pipeline, plus a
//! one-shot transcribe-to-file that drives the active whisper model.
//!
//! Same job-queue shape as `separator::commands`: an enqueue function
//! validates input and inserts a `Queued` row, a `pump_queue` helper
//! kicks the next eligible job onto a worker thread, and progress is
//! emitted on `converter:job`. The frontend listens for that event +
//! a one-shot `converter:done` for transcript writes (whisper jobs
//! are short enough they don't need an interim progress signal — the
//! UI just shows a spinner and waits).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::jobs::{now_unix, unique_output_path, ConverterJob, JobKind, JobStatus};
use super::pipeline;
use super::presets::{self, PresetKind};
use super::state::{output_dir_default, ConverterState};

/// One-shot helper: pull the app-data dir and ask `ConverterState` to
/// hydrate from disk. Safe to call from every command — second-and-
/// later invocations short-circuit on the internal `loaded` flag.
fn ensure_loaded(app: &AppHandle, state: &Arc<ConverterState>) {
    if let Ok(dir) = app.path().app_data_dir() {
        state.ensure_loaded(&dir);
    }
}

/// Mirror of `ensure_loaded` for the write path: snapshot the queue to
/// `jobs.json` so reopening the popup (or restarting the app) shows
/// the same history the user just saw.
fn persist(app: &AppHandle, state: &Arc<ConverterState>) {
    if let Ok(dir) = app.path().app_data_dir() {
        state.persist(&dir);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PresetRow {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: PresetKind,
    pub ext: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConverterStatus {
    /// True when ffmpeg + ffprobe are both reachable on disk. The UI
    /// blocks every action behind this and renders the "Install
    /// ffmpeg" pointer otherwise.
    pub ffmpeg_ready: bool,
    /// Absolute directory where ffmpeg / ffprobe were found. None
    /// when `ffmpeg_ready` is false. Surfaced so the settings tab can
    /// confirm where Stash is reading from.
    pub ffmpeg_dir: Option<String>,
    pub default_output_dir: String,
    pub presets: Vec<PresetRow>,
}

#[tauri::command]
pub fn converter_status(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
) -> ConverterStatus {
    ensure_loaded(&app, &state);
    // Pick up the downloader's bundled `bin/` too — same trick as the
    // stems pipeline. If the user installed ffmpeg via Settings →
    // Downloads, we want this status to flip green without them having
    // to touch system PATH.
    let extras = downloader_extras();
    let dir = pipeline::find_ffmpeg_dir(&extras);
    let presets = presets::ALL
        .iter()
        .map(|p| PresetRow {
            id: p.id,
            label: p.label,
            description: p.description,
            kind: p.kind,
            ext: p.ext,
        })
        .collect();
    ConverterStatus {
        ffmpeg_ready: dir.is_some(),
        ffmpeg_dir: dir.map(|p| p.display().to_string()),
        default_output_dir: output_dir_default().display().to_string(),
        presets,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterRunArgs {
    pub input_path: String,
    pub preset_id: String,
    /// Override the default output dir for this job (the file the
    /// user dropped goes into `<output_dir>/<stem>.<ext>`). When
    /// `None`, the default is used.
    #[serde(default)]
    pub output_dir: Option<String>,
}

#[tauri::command]
pub fn converter_run(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
    args: ConverterRunArgs,
) -> Result<String, String> {
    enqueue_convert(&app, &state, args)
}

/// Shared between the Tauri command and the Telegram tool — both need
/// the same validation, queue insert and worker kick.
pub fn enqueue_convert(
    app: &AppHandle,
    state: &Arc<ConverterState>,
    args: ConverterRunArgs,
) -> Result<String, String> {
    ensure_loaded(app, state);
    let preset = presets::find(&args.preset_id)
        .ok_or_else(|| format!("unknown preset: {}", args.preset_id))?;
    let input = PathBuf::from(&args.input_path);
    if !input.is_file() {
        return Err(format!("input file not found: {}", input.display()));
    }
    let out_dir = args
        .output_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(output_dir_default);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("mkdir {}: {e}", out_dir.display()))?;

    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "output".to_string());
    let output_path = unique_output_path(&out_dir, &stem, preset.ext);

    let job_id = format!("conv-{}-{}", now_unix(), random_suffix());
    let job = ConverterJob {
        id: job_id.clone(),
        input_path: args.input_path,
        output_path: output_path.display().to_string(),
        kind: JobKind::Convert,
        preset_id: Some(preset.id.to_string()),
        status: JobStatus::Queued,
        progress: 0.0,
        duration_sec: None,
        started_at: now_unix(),
        finished_at: None,
        error: None,
    };
    state.jobs.lock().unwrap().push(job.clone());
    emit_job(app, &job);
    persist(app, state);

    pump_queue(app, state);
    Ok(job_id)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterTranscribeArgs {
    pub input_path: String,
    /// Output text format: "txt" (default) or "md". Markdown writes the
    /// same text but with a `.md` extension and a `# <stem>` heading on
    /// top so the file is presentable in any markdown viewer.
    #[serde(default)]
    pub format: Option<String>,
    /// BCP-47 hint forwarded to whisper.cpp. Defaults to "auto".
    #[serde(default)]
    pub language: Option<String>,
    /// Opt-in speaker diarization. Falls back to a flat transcript when
    /// the sidecar/models aren't installed yet — no hard error.
    #[serde(default)]
    pub diarize: Option<bool>,
    /// Pin the expected speaker count. `None` / `0` lets the diarizer
    /// auto-cluster via threshold. Ignored when `diarize` is false.
    #[serde(default)]
    pub num_speakers: Option<i32>,
    /// Run the active AI provider over the transcript to fix typos and
    /// punctuation. The model is instructed to preserve meaning and
    /// wording; only spelling, punctuation and obvious mishears change.
    #[serde(default)]
    pub ai_polish: Option<bool>,
    /// Override the polish prompt. `None` falls back to the built-in
    /// "fix errors only, never reword" instruction below.
    #[serde(default)]
    pub ai_prompt: Option<String>,
    /// Also persist the final transcript as a Stash note. The note
    /// title is the input file's stem; the body is the same text the
    /// `.txt` / `.md` carries. Returns the new note id alongside the
    /// file path so the UI can offer "Open in Notes".
    #[serde(default)]
    pub save_as_note: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConverterTranscribeResult {
    /// Absolute path of the written transcript file.
    pub output_path: String,
    /// Note id when `save_as_note` was requested and persistence
    /// succeeded; `None` otherwise.
    pub note_id: Option<i64>,
    /// Whether AI polish ran successfully. Surfaces to the UI so the
    /// user can tell whether their "fix errors" toggle actually applied
    /// (the LLM step degrades to plain text on configuration errors
    /// rather than aborting the whole job).
    pub polished: bool,
}

/// Built-in polish instruction. Stash's three elephants put UI/UX above
/// everything else — and the user's recurring pain point with AI passes
/// is the model rewording sentences "to sound better". The wording
/// below explicitly forbids that.
const DEFAULT_POLISH_PROMPT: &str = "You are an editor cleaning up a raw speech-to-text transcript. \
Fix only spelling, punctuation, capitalisation and obvious mishears (e.g. homophones \
the recogniser clearly misheard in context). \
Never change the speaker's words, never rephrase, never summarise, never translate, \
never add or remove sentences. Preserve speaker labels (`Спікер 1:` etc.) exactly. \
Keep the same language as the input. Return only the corrected transcript with no \
preamble or explanation.";

/// Transcribe an arbitrary audio/video file using whichever whisper
/// model the user has marked active, and write the transcript as a
/// `.txt` next to the input. Returns the absolute path of the written
/// transcript. Synchronous from the renderer's POV — there is no
/// per-line progress stream because whisper.cpp doesn't expose one in
/// this build, just the final text.
#[tauri::command]
pub async fn converter_transcribe_to_file(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
    args: ConverterTranscribeArgs,
) -> Result<ConverterTranscribeResult, String> {
    ensure_loaded(&app, &state);
    let input = PathBuf::from(&args.input_path);
    if !input.is_file() {
        return Err(format!("input file not found: {}", input.display()));
    }
    let format = args.format.as_deref().unwrap_or("txt").to_ascii_lowercase();
    let ext = match format.as_str() {
        "txt" => "txt",
        "md" | "markdown" => "md",
        other => return Err(format!("unsupported transcript format: {other}")),
    };
    let language = args.language.clone().unwrap_or_else(|| "auto".into());
    let diarize = args.diarize.unwrap_or(false);
    let num_speakers = args.num_speakers.filter(|n| *n > 0);
    let polish_requested = args.ai_polish.unwrap_or(false);
    let save_note = args.save_as_note.unwrap_or(false);

    // Mirror the convert job into the queue so the UI lists it
    // alongside ffmpeg jobs. Transcribe jobs run "in parallel" with
    // the ffmpeg worker — whisper does its own CPU work, but ffmpeg
    // is also CPU-bound, so the user could end up with both running.
    // That's fine; macOS schedules them and the UI shows two rows.
    let parent = input.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "transcript".to_string());
    let out_path = unique_output_path(&parent, &stem, ext);

    let job_id = format!("conv-tx-{}-{}", now_unix(), random_suffix());
    let job = ConverterJob {
        id: job_id.clone(),
        input_path: args.input_path.clone(),
        output_path: out_path.display().to_string(),
        kind: JobKind::Transcribe,
        preset_id: None,
        status: JobStatus::Running,
        progress: 0.0,
        duration_sec: None,
        started_at: now_unix(),
        finished_at: None,
        error: None,
    };
    {
        state.jobs.lock().unwrap().push(job.clone());
    }
    emit_job(&app, &job);
    persist(&app, &state);

    // Diarization-aware transcribe falls back to flat whisper text
    // when the sidecar/models aren't installed yet, so passing
    // `diarize=true` from a fresh install is still safe.
    let lang_opt = if language == "auto" { None } else { Some(language) };
    let result = crate::modules::diarization::pipeline::transcribe_with_optional_diarization(
        &app,
        input.clone(),
        lang_opt,
        diarize,
        num_speakers,
    )
    .await;

    let raw_text = match result {
        Ok(t) => t,
        Err(e) => {
            mark_failed(&app, &state, &job_id, e.clone());
            persist(&app, &state);
            return Err(e);
        }
    };

    // AI polish runs after diarization so the LLM sees the labeled
    // transcript and can keep the `Спікер N:` prefixes intact.
    let (text, polished) = if polish_requested {
        let prompt = args
            .ai_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_POLISH_PROMPT);
        match polish_with_llm(&app, prompt, &raw_text).await {
            Ok(t) => (t, true),
            Err(e) => {
                // Soft failure — keep the raw transcript so the user
                // still walks away with usable output. The job row
                // surfaces the polish failure via the `error` field
                // even though `status` stays `Completed`.
                tracing::warn!(error = %e, "ai polish failed, returning raw transcript");
                update_job(&app, &state, &job_id, |j| {
                    j.error = Some(format!("AI polish skipped: {e}"));
                });
                (raw_text, false)
            }
        }
    } else {
        (raw_text, false)
    };

    let body = if ext == "md" {
        format!("# {stem}\n\n{}\n", text.trim_end())
    } else {
        text.clone()
    };
    if let Err(e) = std::fs::write(&out_path, body.as_bytes()) {
        let err = format!("write transcript: {e}");
        mark_failed(&app, &state, &job_id, err.clone());
        return Err(err);
    }

    let note_id = if save_note {
        match save_transcript_as_note(&app, &stem, &body) {
            Ok(id) => Some(id),
            Err(e) => {
                tracing::warn!(error = %e, "save transcript as note failed");
                update_job(&app, &state, &job_id, |j| {
                    let prev = j.error.take();
                    let msg = format!("Save-as-note skipped: {e}");
                    j.error = Some(match prev {
                        Some(p) => format!("{p}; {msg}"),
                        None => msg,
                    });
                });
                None
            }
        }
    } else {
        None
    };

    update_job(&app, &state, &job_id, |j| {
        j.status = JobStatus::Completed;
        j.progress = 1.0;
        j.finished_at = Some(now_unix());
    });
    persist(&app, &state);
    Ok(ConverterTranscribeResult {
        output_path: out_path.display().to_string(),
        note_id,
        polished,
    })
}

/// Run the active AI provider over `text` using `instruction` as the
/// system prompt. Single-shot — no tool loop — because the polish step
/// has no need for tools and a deterministic, low-temperature pass
/// keeps the model from "improving" the transcript past recognition.
async fn polish_with_llm(
    app: &AppHandle,
    instruction: &str,
    text: &str,
) -> Result<String, String> {
    use crate::modules::ai::state::AiState;
    use crate::modules::telegram::llm::{factory, ChatMessage, LlmRequest};

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let cfg = factory::read_config(&data_dir.join("settings.json"))
        .map_err(|e| format!("ai config: {e}"))?;
    let ai_state = app
        .try_state::<AiState>()
        .ok_or_else(|| "AI module not initialised".to_string())?;
    let client = factory::build_client(&cfg, &ai_state.secrets)
        .map_err(|e| format!("ai client: {e}"))?;

    // Generous max_tokens: long voice memos can exceed 8k tokens once
    // polished. The default 8192 was tuned for chat replies; here we
    // want to clear the input's own size plus headroom for added
    // punctuation.
    let req = LlmRequest {
        messages: vec![
            ChatMessage::system(instruction),
            ChatMessage::user(text),
        ],
        tools: Vec::new(),
        temperature: 0.0,
        max_tokens: 16_384,
    };
    let resp = client.chat(req).await.map_err(|e| e.to_string())?;
    let out = resp.text.trim().to_string();
    if out.is_empty() {
        return Err("ai polish returned empty text".into());
    }
    Ok(out)
}

/// Persist `body` as a new Stash note titled `stem`. Returns the note
/// id assigned by the repository. Soft-fails when the notes module is
/// not registered (older test builds) — the caller turns that into a
/// non-fatal warning on the job row.
fn save_transcript_as_note(app: &AppHandle, stem: &str, body: &str) -> Result<i64, String> {
    use crate::modules::notes::commands::NotesState;

    let notes = app
        .try_state::<NotesState>()
        .ok_or_else(|| "notes module not initialised".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let title = if stem.is_empty() { "Transcript".to_string() } else { stem.to_string() };
    // Bind the Arc clone to a local so the MutexGuard's lifetime is
    // anchored to a named owner rather than the temporary that
    // `notes.repo` exposes through tauri::State's Deref. The original
    // chained form tripped E0597 on Rust ≥ 1.83 — the compiler can't
    // prove the State borrow outlives the guard otherwise.
    let repo = notes.repo.clone();
    let mut guard = repo.lock().map_err(|e| e.to_string())?;
    guard.create(&title, body, now).map_err(|e| e.to_string())
}

/// Read a converter job's output file as UTF-8 text. Restricted to
/// paths we already wrote ourselves — looking up by job_id means the
/// frontend can't ask us to slurp `/etc/shadow`, even though the
/// command is invoked from a renderer that the user controls.
#[tauri::command]
pub fn converter_read_transcript(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
    job_id: String,
) -> Result<String, String> {
    ensure_loaded(&app, &state);
    let path = {
        let jobs = state.jobs.lock().unwrap();
        let Some(j) = jobs.iter().find(|j| j.id == job_id) else {
            return Err(format!("job not found: {job_id}"));
        };
        if !matches!(j.status, JobStatus::Completed) {
            return Err("job not finished".into());
        }
        j.output_path.clone()
    };
    if path.is_empty() {
        return Err("job has no output".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

#[tauri::command]
pub fn converter_cancel(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
    job_id: String,
) -> Result<(), String> {
    ensure_loaded(&app, &state);
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
    // Re-emit so the UI flips the row to "Cancelled" without waiting
    // for the worker thread to notice the status change.
    if let Some(snapshot) = state
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|j| j.id == job_id)
        .cloned()
    {
        emit_job(&app, &snapshot);
    }
    persist(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn converter_list_jobs(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
) -> Vec<ConverterJob> {
    ensure_loaded(&app, &state);
    state.jobs.lock().unwrap().clone()
}

/// Remove an entry from the queue. When `delete_file` is true (the
/// default from the UI's confirm dialog), the produced output file on
/// disk is wiped too — same semantics as `separator_remove_job`,
/// keeps the list and the filesystem in lockstep. Failed / cancelled
/// rows never produced a usable output, so the flag is a no-op there.
#[tauri::command]
pub fn converter_remove_job(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
    job_id: String,
    delete_file: Option<bool>,
) -> Result<(), String> {
    ensure_loaded(&app, &state);
    let removed = {
        let mut jobs = state.jobs.lock().unwrap();
        let idx = jobs
            .iter()
            .position(|j| j.id == job_id)
            .ok_or_else(|| format!("job not found: {job_id}"))?;
        jobs.remove(idx)
    };
    if delete_file.unwrap_or(true) {
        purge_output(&removed);
    }
    persist(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn converter_clear_completed(
    app: AppHandle,
    state: State<'_, Arc<ConverterState>>,
    delete_files: Option<bool>,
) {
    ensure_loaded(&app, &state);
    let drained: Vec<ConverterJob> = {
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
    if delete_files.unwrap_or(true) {
        for job in &drained {
            purge_output(job);
        }
    }
    persist(&app, &state);
}

/// Best-effort delete of the output file a job produced. Only fires
/// on completed convert/transcribe jobs (failed / cancelled rows
/// never wrote anything we want to clean up — partial outputs are
/// already wiped by the worker on the cancel path).
fn purge_output(job: &ConverterJob) {
    if job.status != JobStatus::Completed {
        return;
    }
    if job.output_path.is_empty() {
        return;
    }
    let path = Path::new(&job.output_path);
    if path.is_file() {
        if let Err(e) = std::fs::remove_file(path) {
            eprintln!("[converter] remove {}: {e}", path.display());
        }
    }
}

// ── worker loop ────────────────────────────────────────────────────

fn emit_job(app: &AppHandle, job: &ConverterJob) {
    let _ = app.emit("converter:job", job.clone());
}

fn update_job<F: FnOnce(&mut ConverterJob)>(
    app: &AppHandle,
    state: &Arc<ConverterState>,
    job_id: &str,
    f: F,
) -> Option<ConverterJob> {
    let mut jobs = state.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|j| j.id == job_id)?;
    f(job);
    let snapshot = job.clone();
    drop(jobs);
    emit_job(app, &snapshot);
    // Persist on terminal states only — pumping a snapshot to disk on
    // every progress tick would write the JSON 10× per second during
    // an active job, which makes the popup process feel sluggish on
    // spinning disks. Mid-run progress is recoverable from memory; if
    // the app crashes mid-conversion, we want the row to show as
    // "interrupted by app restart" anyway.
    if matches!(
        snapshot.status,
        JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
    ) {
        persist(app, state);
    }
    Some(snapshot)
}

fn mark_failed(app: &AppHandle, state: &Arc<ConverterState>, job_id: &str, err: String) {
    update_job(app, state, job_id, |j| {
        j.status = JobStatus::Failed;
        j.error = Some(err);
        j.finished_at = Some(now_unix());
    });
}

fn pump_queue(app: &AppHandle, state: &Arc<ConverterState>) {
    // Only one ffmpeg job at a time. ffmpeg is CPU-heavy and running
    // two in parallel mostly just doubles the wall-clock per job
    // without speeding the queue overall — and progress UI becomes
    // hard to read.
    if state.active_pid.lock().unwrap().is_some() {
        return;
    }
    let next_id = {
        let jobs = state.jobs.lock().unwrap();
        jobs.iter()
            .find(|j| j.status == JobStatus::Queued && j.kind == JobKind::Convert)
            .map(|j| j.id.clone())
    };
    let Some(job_id) = next_id else {
        return;
    };
    let app2 = app.clone();
    let state2 = Arc::clone(state);
    std::thread::spawn(move || run_convert_worker(app2, state2, job_id));
}

fn run_convert_worker(app: AppHandle, state: Arc<ConverterState>, job_id: String) {
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

    let preset_id = job.preset_id.clone().unwrap_or_default();
    let Some(preset) = presets::find(&preset_id) else {
        mark_failed(&app, &state, &job_id, format!("unknown preset: {preset_id}"));
        pump_queue(&app, &state);
        return;
    };

    let ffmpeg_dir = match pipeline::find_ffmpeg_dir(&downloader_extras()) {
        Some(p) => p,
        None => {
            mark_failed(
                &app,
                &state,
                &job_id,
                "ffmpeg not found — Settings → Downloads → Install ffmpeg".into(),
            );
            pump_queue(&app, &state);
            return;
        }
    };
    let ffmpeg = ffmpeg_dir.join("ffmpeg");
    let ffprobe = ffmpeg_dir.join("ffprobe");
    let input = Path::new(&job.input_path);
    let output = Path::new(&job.output_path);

    let duration = pipeline::probe_duration(&ffprobe, input);
    update_job(&app, &state, &job_id, |j| {
        j.status = JobStatus::Running;
        j.progress = 0.0;
        j.duration_sec = duration;
        j.started_at = now_unix();
    });

    let pid_holder = Arc::clone(&state.active_pid);
    let app_for_progress = app.clone();
    let state_for_progress = Arc::clone(&state);
    let job_id_progress = job_id.clone();
    let result = pipeline::run_convert(
        &ffmpeg,
        input,
        preset.args,
        output,
        duration,
        pid_holder,
        move |ratio| {
            update_job(&app_for_progress, &state_for_progress, &job_id_progress, |j| {
                // Re-check status; the user may have cancelled mid-
                // run. Cancel sets status to `Cancelled`, and we don't
                // want a late progress tick to undo that.
                if j.status == JobStatus::Running {
                    j.progress = ratio;
                }
            });
        },
    );

    // ffmpeg dropped — clear the active PID before deciding whether
    // the job succeeded or failed, so a queued sibling can pump
    // without waiting.
    *state.active_pid.lock().unwrap() = None;

    let cancelled_mid_run = {
        let jobs = state.jobs.lock().unwrap();
        jobs.iter()
            .find(|j| j.id == job_id)
            .map(|j| j.status == JobStatus::Cancelled)
            .unwrap_or(false)
    };
    if cancelled_mid_run {
        // The cancel command already stamped Cancelled / finished_at;
        // nothing else to do. Wipe any partial output ffmpeg left
        // behind so the user doesn't end up double-clicking a half-
        // muxed file thinking the run completed.
        let _ = std::fs::remove_file(output);
        pump_queue(&app, &state);
        return;
    }

    match result {
        Ok(()) => {
            update_job(&app, &state, &job_id, |j| {
                j.status = JobStatus::Completed;
                j.progress = 1.0;
                j.finished_at = Some(now_unix());
            });
        }
        Err(e) => {
            // Best-effort clean-up of the (incomplete) output file.
            let _ = std::fs::remove_file(output);
            mark_failed(&app, &state, &job_id, e);
        }
    }
    pump_queue(&app, &state);
}

/// Tiny 6-char suffix; collisions don't matter because the unix-
/// seconds prefix already changes every second.
fn random_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:06x}", nanos & 0xffffff)
}

/// Bundle-bin candidate: same trick the stems pipeline uses to find
/// the downloader-installed copy of ffmpeg.
fn downloader_extras() -> Vec<PathBuf> {
    let mut extras: Vec<PathBuf> = Vec::new();
    // Without an `AppHandle` we can't read the downloader's runner
    // state directly. Stick with the default $APPLOCALDATA path the
    // downloader writes to — keeps the status command pure (no Tauri
    // state dependency).
    if let Some(home) = dirs_next::data_local_dir() {
        extras.push(home.join("stash").join("downloads").join("bin"));
        // dev/test layout
        extras.push(home.join("Stash").join("downloads").join("bin"));
    }
    extras
}
