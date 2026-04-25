//! Persistent diarization state. Two pieces:
//!
//! - `enabled` flag (kv-backed, lives next to the AI settings) — when
//!   `false` the telegram voice path skips diarization entirely.
//! - In-memory `in_flight` set guarding concurrent downloads of the
//!   same model file.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct DiarizationState {
    pub in_flight: Mutex<HashSet<&'static str>>,
}

impl DiarizationState {
    pub fn new() -> Self {
        Self {
            in_flight: Mutex::new(HashSet::new()),
        }
    }
}

impl Default for DiarizationState {
    fn default() -> Self {
        Self::new()
    }
}

/// Folder under the app data dir where diarization ONNX files live.
/// Created on demand by the downloader; missing dir means "no models
/// installed yet".
pub fn models_dir(app_data: &std::path::Path) -> PathBuf {
    app_data.join("diarization")
}

pub fn segmentation_path(app_data: &std::path::Path) -> PathBuf {
    models_dir(app_data).join(super::catalog::SEGMENTATION.filename)
}

pub fn embedding_path(app_data: &std::path::Path) -> PathBuf {
    models_dir(app_data).join(super::catalog::EMBEDDING.filename)
}

/// True when both ONNX files are on disk and at least look like real
/// model blobs (≥ 1 MB each). We deliberately don't verify the exact
/// size against the catalog: HuggingFace and GitHub releases sometimes
/// re-encode files without bumping the URL, and a strict ±5 % check
/// then turns a working download into a permanent "not ready" state.
/// Sherpa itself reads the file at load time and fails loudly on a
/// truly corrupt one, which is the right place for a hard check.
pub fn models_ready(app_data: &std::path::Path) -> bool {
    const MIN_MODEL_BYTES: u64 = 1024 * 1024;
    let s = segmentation_path(app_data);
    let e = embedding_path(app_data);
    let s_ok = std::fs::metadata(&s)
        .map(|m| m.len() >= MIN_MODEL_BYTES)
        .unwrap_or(false);
    let e_ok = std::fs::metadata(&e)
        .map(|m| m.len() >= MIN_MODEL_BYTES)
        .unwrap_or(false);
    s_ok && e_ok
}
