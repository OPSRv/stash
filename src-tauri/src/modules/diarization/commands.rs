//! Tauri commands: download / status / delete for the diarization
//! model pair. Mirrors the whisper download UX so the frontend can
//! reuse its progress-bar pattern (event name differs).

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::catalog::{self, DiarModel, ALL, EMBEDDING, SEGMENTATION};
use super::state::{embedding_path, models_dir, models_ready, segmentation_path, DiarizationState};

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent<'a> {
    /// `"segmentation"` or `"embedding"` — matches the catalog kind.
    id: &'a str,
    received: u64,
    total: u64,
    done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiarModelStatus {
    pub kind: &'static str,
    pub label: &'static str,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiarStatus {
    pub ready: bool,
    pub models: Vec<DiarModelStatus>,
}

#[tauri::command]
pub fn diarization_status(app: AppHandle) -> Result<DiarStatus, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let models = ALL
        .iter()
        .map(|m| {
            let path = file_path_for(&data_dir, m);
            // Mirrors `state::models_ready` — file present and ≥ 1 MB
            // is the lenient threshold; sherpa load-time errors catch
            // genuinely corrupt content.
            let downloaded = std::fs::metadata(&path)
                .map(|meta| meta.len() >= 1024 * 1024)
                .unwrap_or(false);
            DiarModelStatus {
                kind: kind_str(m.kind),
                label: m.label,
                size_bytes: m.size_bytes,
                downloaded,
                local_path: downloaded.then(|| path.display().to_string()),
            }
        })
        .collect::<Vec<_>>();
    let ready = models_ready(&data_dir);
    Ok(DiarStatus { ready, models })
}

/// Download whichever models are missing. Idempotent — already-present
/// files emit a `done` event and are skipped. Concurrent calls for the
/// same model are rejected via the in-memory `in_flight` set.
#[tauri::command]
pub async fn diarization_download(
    app: AppHandle,
    state: State<'_, DiarizationState>,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(models_dir(&data_dir)).map_err(|e| format!("mkdir: {e}"))?;

    for m in ALL {
        // Skip when the file already looks usable. We don't compare
        // against the catalog size — see `state::models_ready` for
        // why exact-match was too strict.
        let path = file_path_for(&data_dir, m);
        if std::fs::metadata(&path)
            .map(|meta| meta.len() >= 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = app.emit(
                "diarization:download",
                DownloadEvent {
                    id: kind_str(m.kind),
                    received: m.size_bytes,
                    total: m.size_bytes,
                    done: true,
                },
            );
            continue;
        }
        // Concurrency guard.
        {
            let mut inflight = state.in_flight.lock().unwrap();
            if !inflight.insert(kind_str(m.kind)) {
                return Err(format!("{} download already in progress", kind_str(m.kind)));
            }
        }
        let result = run_download(&app, m, &path).await;
        state.in_flight.lock().unwrap().remove(kind_str(m.kind));
        result?;
    }
    Ok(())
}

#[tauri::command]
pub fn diarization_delete(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    for path in [segmentation_path(&data_dir), embedding_path(&data_dir)] {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("rm {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn file_path_for(data_dir: &std::path::Path, m: &DiarModel) -> PathBuf {
    models_dir(data_dir).join(m.filename)
}

fn kind_str(k: catalog::ModelKind) -> &'static str {
    match k {
        catalog::ModelKind::Segmentation => "segmentation",
        catalog::ModelKind::Embedding => "embedding",
    }
}

async fn run_download(
    app: &AppHandle,
    spec: &DiarModel,
    final_path: &PathBuf,
) -> Result<(), String> {
    // Defensive — the catalog ships HTTPS URLs; reject anything else
    // so a future bad edit can't redirect the downloader.
    if !spec.url.starts_with("https://") {
        return Err("model url must be https".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("stash-app/diarization-downloader")
        .redirect(reqwest::redirect::Policy::limited(10))
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
                "diarization:download",
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
    // Only fail outright when the result is clearly broken (sub-1 MB
    // chunks of garbage). Mismatches against the catalog `size_bytes`
    // are common — HF / GitHub re-encode files without changing the
    // URL — and they don't actually break sherpa, so we surface them
    // as a `warn!` and keep going.
    if len < 1024 * 1024 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "{}: download produced only {len} bytes — looks corrupt",
            spec.label
        ));
    }
    if !catalog::size_is_plausible(spec.size_bytes, len) {
        tracing::warn!(
            label = spec.label,
            got = len,
            expected = spec.size_bytes,
            "downloaded model size differs from catalog — accepting anyway"
        );
    }
    std::fs::rename(&tmp, final_path).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "diarization:download",
        DownloadEvent {
            id: kind_str(spec.kind),
            received: len,
            total: len,
            done: true,
        },
    );
    // Suppress unused warning — referenced indirectly via constants.
    let _ = (SEGMENTATION.size_bytes, EMBEDDING.size_bytes);
    Ok(())
}
