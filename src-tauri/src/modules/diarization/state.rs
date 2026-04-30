//! Persistent diarization state and on-disk paths.
//!
//! The UI guards diarization behind an opt-in install — when nothing
//! is downloaded yet, the telegram voice path skips diarization
//! entirely and just returns the flat whisper transcript. The
//! `assets_ready` check below is the canonical "is diarization
//! usable?" question; everywhere else (settings UI, pipeline
//! orchestrator) goes through it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::catalog::{self, AssetSubdir, DiarAsset, ALL, EMBEDDING, SEGMENTATION, SIDECAR};

pub struct DiarizationState {
    /// Filenames currently being downloaded — guards against two
    /// concurrent `diarization_download` invocations racing on the
    /// same destination.
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

/// Root folder for everything diarization-related under the app data
/// dir. Created on demand by the downloader; missing dir means
/// "nothing installed yet".
pub fn root_dir(app_data: &Path) -> PathBuf {
    app_data.join("diarization")
}

pub fn asset_path(app_data: &Path, asset: &DiarAsset) -> PathBuf {
    let mut p = root_dir(app_data);
    match asset.subdir {
        AssetSubdir::Root => {}
        AssetSubdir::Bin => p.push("bin"),
        AssetSubdir::Lib => p.push("lib"),
    }
    p.push(asset.filename);
    p
}

pub fn segmentation_path(app_data: &Path) -> PathBuf {
    asset_path(app_data, &SEGMENTATION)
}

pub fn embedding_path(app_data: &Path) -> PathBuf {
    asset_path(app_data, &EMBEDDING)
}

pub fn sidecar_path(app_data: &Path) -> PathBuf {
    asset_path(app_data, &SIDECAR)
}

/// True when every asset (both ONNX models *and* the sidecar trio) is
/// on disk and large enough to plausibly be a real file rather than
/// an error page. Sherpa itself reads the model files at load time
/// and fails loudly on a truly corrupt one, which is the right place
/// for a hard check; here we just guard against partial installs.
pub fn assets_ready(app_data: &Path) -> bool {
    ALL.iter().all(|a| {
        let path = asset_path(app_data, a);
        std::fs::metadata(&path)
            .map(|m| m.len() >= catalog::min_plausible_bytes(a.kind))
            .unwrap_or(false)
    })
}
