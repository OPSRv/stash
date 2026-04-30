//! Tauri commands: download / status / delete for the diarization
//! asset bundle (two ONNX models + sidecar binary + two dylibs).
//! Mirrors the whisper download UX so the frontend can reuse its
//! progress-bar pattern.
//!
//! The user opts into diarization once; from there on the telegram
//! voice path picks it up automatically (`assets_ready` flips to
//! `true`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::catalog::{self, AssetKind, DiarAsset, ALL};
use super::state::{asset_path, assets_ready, root_dir, DiarizationState};

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent<'a> {
    /// Catalog kind ("segmentation", "embedding", "sidecar",
    /// "sherpalib", "onnxlib") — the frontend keys progress bars by it.
    id: &'a str,
    received: u64,
    total: u64,
    done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiarAssetStatus {
    pub kind: &'static str,
    pub label: &'static str,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiarStatus {
    pub ready: bool,
    pub assets: Vec<DiarAssetStatus>,
}

#[tauri::command]
pub fn diarization_status(app: AppHandle) -> Result<DiarStatus, String> {
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
            DiarAssetStatus {
                kind: kind_str(a.kind),
                label: a.label,
                size_bytes: a.size_bytes,
                downloaded,
                local_path: downloaded.then(|| path.display().to_string()),
            }
        })
        .collect::<Vec<_>>();
    let ready = assets_ready(&data_dir);
    Ok(DiarStatus { ready, assets })
}

/// Download whichever assets are missing. Idempotent — already-present
/// files emit a `done` event and are skipped. Concurrent calls for the
/// same asset are rejected via the in-memory `in_flight` set.
#[tauri::command]
pub async fn diarization_download(
    app: AppHandle,
    state: State<'_, DiarizationState>,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(root_dir(&data_dir)).map_err(|e| format!("mkdir: {e}"))?;

    for a in ALL {
        let path = asset_path(&data_dir, a);
        // Make sure the parent (`bin/`, `lib/`, or root) exists before
        // we try to drop a file into it. `root_dir` was created above,
        // but `bin/` and `lib/` aren't.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        if std::fs::metadata(&path)
            .map(|meta| meta.len() >= catalog::min_plausible_bytes(a.kind))
            .unwrap_or(false)
        {
            let _ = app.emit(
                "diarization:download",
                DownloadEvent {
                    id: kind_str(a.kind),
                    received: a.size_bytes,
                    total: a.size_bytes,
                    done: true,
                },
            );
            continue;
        }
        // Concurrency guard.
        {
            let mut inflight = state.in_flight.lock().unwrap();
            if !inflight.insert(a.filename) {
                return Err(format!("{} download already in progress", a.label));
            }
        }
        let result = run_download(&app, a, &path).await;
        // Sidecar binary needs +x. Run the chmod inside the success
        // branch so a failed/partial download doesn't leave a fake
        // executable behind.
        if result.is_ok() && a.kind == AssetKind::Sidecar {
            ensure_executable(&path)?;
        }
        state.in_flight.lock().unwrap().remove(a.filename);
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
    for a in ALL {
        let path = asset_path(&data_dir, a);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("rm {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn kind_str(k: AssetKind) -> &'static str {
    match k {
        AssetKind::Segmentation => "segmentation",
        AssetKind::Embedding => "embedding",
        AssetKind::Sidecar => "sidecar",
        AssetKind::SherpaLib => "sherpalib",
        AssetKind::OnnxLib => "onnxlib",
    }
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
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

async fn run_download(
    app: &AppHandle,
    spec: &DiarAsset,
    final_path: &PathBuf,
) -> Result<(), String> {
    // Defensive — `resolve_url` should always return an HTTPS URL
    // (models carry one literally, runtime URLs are formatted from a
    // hard-coded https template). Reject anything else so a future
    // bad edit can't redirect the downloader.
    let url = catalog::resolve_url(spec);
    if !url.starts_with("https://") {
        return Err("asset url must be https".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("stash-app/diarization-downloader")
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
    let min = catalog::min_plausible_bytes(spec.kind);
    if len < min {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "{}: download produced only {len} bytes (< {min}) — looks corrupt",
            spec.label
        ));
    }
    if !catalog::size_is_plausible(spec.size_bytes, len) {
        // Mismatches against the catalog `size_bytes` are common — HF /
        // GitHub re-encode files without changing the URL — and they
        // don't actually break loading, so we surface as a `warn!` and
        // keep going.
        tracing::warn!(
            label = spec.label,
            got = len,
            expected = spec.size_bytes,
            "downloaded asset size differs from catalog — accepting anyway"
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
    Ok(())
}
