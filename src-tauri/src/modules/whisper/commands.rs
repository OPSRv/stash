use crate::modules::whisper::catalog::{self, ModelSpec};
use crate::modules::whisper::pipeline;
use crate::modules::whisper::state::WhisperStateHandle;
use futures_util::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
pub struct ModelRow {
    #[serde(flatten)]
    pub spec: ModelSpec,
    /// Whether the file already exists locally (and has plausible size).
    pub downloaded: bool,
    /// Whether this model is the one currently selected for transcription.
    pub active: bool,
}

fn whisper_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(whisper_dir(app)?.join(format!("ggml-{id}.bin")))
}

fn is_downloaded(path: &PathBuf, expected: u64) -> bool {
    std::fs::metadata(path)
        .map(|m| catalog::size_is_plausible(expected, m.len()))
        .unwrap_or(false)
}

/// Resolve the active whisper model's on-disk path. Returns `Err` when
/// no model is active or the active one isn't downloaded yet. Exposed
/// so cross-module orchestrators (e.g. the diarization pipeline) can
/// pick up the same model without re-implementing the lookup.
pub fn resolve_active_model(app: &AppHandle) -> Result<PathBuf, String> {
    let state: tauri::State<'_, WhisperStateHandle> = app.state();
    let active = state
        .config
        .lock()
        .unwrap()
        .active_model_id
        .clone()
        .ok_or_else(|| "no active whisper model — download one first".to_string())?;
    let spec = catalog::find(&active).ok_or_else(|| format!("unknown model: {active}"))?;
    let model = model_path(app, &active)?;
    if !is_downloaded(&model, spec.size_bytes) {
        return Err("active model is not downloaded".into());
    }
    Ok(model)
}

/// Default thread count for whisper.cpp. Half the cores keeps the UI
/// snappy while leaving plenty of headroom for the rest of the app.
pub fn default_threads() -> i32 {
    (std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        / 2)
    .max(2) as i32
}

/// Transcribe `audio` using whichever model the user has made active in
/// the Whisper tab. Returns the text. Used by the Telegram inbox (voice
/// auto-transcription) and future cross-module integrations — one place
/// to pick the active model means these callers don't duplicate the
/// "download state → catalog → model file" lookup.
pub async fn transcribe_with_active_model(
    app: &AppHandle,
    audio: PathBuf,
    language: Option<String>,
) -> Result<String, String> {
    let state: tauri::State<'_, WhisperStateHandle> = app.state();
    let active = state
        .config
        .lock()
        .unwrap()
        .active_model_id
        .clone()
        .ok_or_else(|| "no active whisper model — download one first".to_string())?;
    let spec = catalog::find(&active).ok_or_else(|| format!("unknown model: {active}"))?;
    let model = model_path(app, &active)?;
    if !is_downloaded(&model, spec.size_bytes) {
        return Err("active model is not downloaded".into());
    }
    if !audio.is_file() {
        return Err(format!("audio file not found: {}", audio.display()));
    }
    let lang = language.unwrap_or_else(|| "uk".into());
    let threads = (std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        / 2)
    .max(2) as i32;
    tauri::async_runtime::spawn_blocking(move || {
        pipeline::transcribe(&audio, &model, &lang, threads).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn whisper_list_models(
    app: AppHandle,
    state: State<'_, WhisperStateHandle>,
) -> Result<Vec<ModelRow>, String> {
    let active_id = state.config.lock().unwrap().active_model_id.clone();
    let rows = catalog::MODELS
        .iter()
        .map(|m| {
            let path = model_path(&app, m.id).unwrap_or_default();
            ModelRow {
                spec: m.clone(),
                downloaded: is_downloaded(&path, m.size_bytes),
                active: active_id.as_deref() == Some(m.id),
            }
        })
        .collect();
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent<'a> {
    id: &'a str,
    received: u64,
    total: u64,
    /// `true` on the final event after the file is fully written.
    done: bool,
}

/// Stream a model file from its canonical URL into
/// `appData/whisper/ggml-<id>.bin`. Emits `whisper:download` events so the
/// frontend can render a progress bar. The download is idempotent — if the
/// file already exists at a plausible size we return immediately.
#[tauri::command]
pub async fn whisper_download_model(
    app: AppHandle,
    state: State<'_, WhisperStateHandle>,
    id: String,
) -> Result<(), String> {
    let spec = catalog::find(&id).ok_or_else(|| format!("unknown model: {id}"))?;
    let path = model_path(&app, &id)?;
    if is_downloaded(&path, spec.size_bytes) {
        // No-op if already present; still emit a `done` so the UI can flip
        // its state without special-casing this branch.
        let _ = app.emit(
            "whisper:download",
            DownloadEvent {
                id: &id,
                received: spec.size_bytes,
                total: spec.size_bytes,
                done: true,
            },
        );
        return Ok(());
    }

    // Serialize duplicate downloads of the same id. We briefly take the
    // lock, insert, and drop — the actual download runs unlocked.
    {
        let mut inflight = state.in_flight.lock().unwrap();
        if !inflight.insert(id.clone()) {
            return Err("download already in progress".into());
        }
    }
    let result = run_download(&app, spec, &path).await;
    state.in_flight.lock().unwrap().remove(&id);
    result
}

async fn run_download(
    app: &AppHandle,
    spec: &ModelSpec,
    final_path: &PathBuf,
) -> Result<(), String> {
    // Defensive: only fetch from the prefix we baked into the catalog.
    if !spec
        .url
        .starts_with("https://huggingface.co/ggerganov/whisper.cpp/")
    {
        return Err("model url is not on the allowed host".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("stash-app/whisper-downloader")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(spec.url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(spec.size_bytes);
    let tmp = final_path.with_extension("bin.part");
    // If a previous attempt crashed mid-download, start fresh. We don't
    // bother with HTTP range-resumes — models are 30 MB to 1.5 GB and a
    // retry is simpler than bookkeeping a checkpoint.
    let _ = std::fs::remove_file(&tmp);
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    // Throttle progress events to at most ~10/s so we don't flood the
    // renderer on fast links.
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
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
                "whisper:download",
                DownloadEvent {
                    id: spec.id,
                    received,
                    total,
                    done: false,
                },
            );
        }
    }
    drop(file);

    let len = std::fs::metadata(&tmp).map_err(|e| e.to_string())?.len();
    if !catalog::size_is_plausible(spec.size_bytes, len) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "downloaded file has unexpected size: got {len} bytes, expected ~{}",
            spec.size_bytes
        ));
    }
    std::fs::rename(&tmp, final_path).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "whisper:download",
        DownloadEvent {
            id: spec.id,
            received: len,
            total: len,
            done: true,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn whisper_delete_model(app: AppHandle, id: String) -> Result<(), String> {
    let _ = catalog::find(&id).ok_or_else(|| format!("unknown model: {id}"))?;
    let path = model_path(&app, &id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn whisper_set_active(
    state: State<'_, WhisperStateHandle>,
    id: Option<String>,
) -> Result<(), String> {
    // Validate — reject ids we don't know so a typo doesn't get persisted.
    if let Some(ref chosen) = id {
        if catalog::find(chosen).is_none() {
            return Err(format!("unknown model: {chosen}"));
        }
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.active_model_id = id;
    let path = state.config_path.lock().unwrap().clone();
    cfg.save(&path)
}

#[tauri::command]
pub fn whisper_get_active(state: State<'_, WhisperStateHandle>) -> Result<Option<String>, String> {
    Ok(state.config.lock().unwrap().active_model_id.clone())
}

#[derive(Debug, Clone, Serialize)]
struct TranscribeEvent<'a> {
    note_id: i64,
    stage: &'a str,
}

/// Transcribe an arbitrary audio file at `path` and return the transcript
/// text. Does not touch any DB row — the caller decides where the text
/// goes (usually splicing it into a note's body next to the `![](…)` embed
/// it was drawn from).
///
/// `language` defaults to `"uk"` (Ukrainian — the product's base language).
/// Pass `"auto"` to let whisper detect.
#[tauri::command]
pub async fn whisper_transcribe_path(
    app: AppHandle,
    state: State<'_, WhisperStateHandle>,
    path: String,
    language: Option<String>,
) -> Result<String, String> {
    let active = state
        .config
        .lock()
        .unwrap()
        .active_model_id
        .clone()
        .ok_or_else(|| "no active whisper model — download one first".to_string())?;
    let spec = catalog::find(&active).ok_or_else(|| format!("unknown model: {active}"))?;
    let model_path = model_path(&app, &active)?;
    if !is_downloaded(&model_path, spec.size_bytes) {
        return Err("active model is not downloaded".into());
    }
    let audio = PathBuf::from(&path);
    if !audio.is_file() {
        return Err(format!("audio file not found: {path}"));
    }
    let lang = language.unwrap_or_else(|| "uk".into());
    let threads = (std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        / 2)
    .max(2) as i32;
    let _ = app.emit(
        "whisper:transcribe",
        TranscribeEvent {
            note_id: 0,
            stage: "running",
        },
    );
    let model = model_path.clone();
    let lang_owned = lang.clone();
    let text = tauri::async_runtime::spawn_blocking(move || {
        pipeline::transcribe(&audio, &model, &lang_owned, threads).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "whisper:transcribe",
        TranscribeEvent {
            note_id: 0,
            stage: "done",
        },
    );
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_model_yields_error_on_set_active() {
        // We can't construct a State<'_, …> in unit tests, but we can
        // exercise the validation branch by calling `find` directly.
        assert!(catalog::find("nonsense").is_none());
    }
}
