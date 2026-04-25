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

/// True when both ONNX files are on disk *and* their sizes look
/// plausible. Used by the telegram voice path to decide whether to
/// hand the buffer to the diarizer or skip with a graceful fallback.
pub fn models_ready(app_data: &std::path::Path) -> bool {
    use super::catalog::{size_is_plausible, EMBEDDING, SEGMENTATION};
    let s = segmentation_path(app_data);
    let e = embedding_path(app_data);
    let s_ok = std::fs::metadata(&s)
        .map(|m| size_is_plausible(SEGMENTATION.size_bytes, m.len()))
        .unwrap_or(false);
    let e_ok = std::fs::metadata(&e)
        .map(|m| size_is_plausible(EMBEDDING.size_bytes, m.len()))
        .unwrap_or(false);
    s_ok && e_ok
}
