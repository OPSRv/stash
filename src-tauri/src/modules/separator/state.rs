//! On-disk paths for the separator install + the in-memory state the
//! commands share between invocations.
//!
//! `assets_ready` is the canonical "is separation usable?" question
//! — the UI guards every separator action behind it (matches the
//! diarization opt-in pattern).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::catalog::{self, AssetSubdir, SeparatorAsset, OPTIONAL_FT, REQUIRED};
use super::jobs::SeparatorJob;

pub struct SeparatorState {
    /// Filenames currently being downloaded — guards against two
    /// concurrent `separator_download` invocations racing on the same
    /// destination.
    pub in_flight: Mutex<HashSet<&'static str>>,
    /// Every job the user has kicked off in this session, newest last.
    /// Persisted only in memory: stems on disk are the durable artifact;
    /// the queue rebuilds on app restart.
    pub jobs: Mutex<Vec<SeparatorJob>>,
    /// PID of the currently-running sidecar process, if any. Used by
    /// `separator_cancel` to send SIGTERM without juggling a `Child`
    /// handle across the worker thread boundary. Limited to one job at
    /// a time on purpose — htdemucs_ft peaks at ~6 GB RAM, two parallel
    /// runs would thrash.
    pub active_pid: Mutex<Option<u32>>,
}

impl SeparatorState {
    pub fn new() -> Self {
        Self {
            in_flight: Mutex::new(HashSet::new()),
            jobs: Mutex::new(Vec::new()),
            active_pid: Mutex::new(None),
        }
    }
}

impl Default for SeparatorState {
    fn default() -> Self {
        Self::new()
    }
}

/// Root for everything separator-related under the app data dir. Created
/// on demand by the downloader; missing dir means "nothing installed
/// yet".
pub fn root_dir(app_data: &Path) -> PathBuf {
    app_data.join("separator")
}

pub fn asset_path(app_data: &Path, asset: &SeparatorAsset) -> PathBuf {
    let mut p = root_dir(app_data);
    match asset.subdir {
        AssetSubdir::Bin => p.push("bin"),
        AssetSubdir::Models | AssetSubdir::ModelsFt => {
            // demucs reads weights at `$TORCH_HOME/hub/checkpoints/<hash>.th`
            // and we point TORCH_HOME at `models/`, so weights need to land
            // exactly at `models/hub/checkpoints/`. Same path for both 6s
            // and ft so a single TORCH_HOME export covers everything.
            p.push("models");
            p.push("hub");
            p.push("checkpoints");
        }
    }
    p.push(asset.filename);
    p
}

/// Path to the sidecar binary inside the unpacked `--onedir` bundle.
/// PyInstaller produces `dist/stash-separator/stash-separator`, which
/// we extract under `bin/` preserving its directory structure so the
/// dylibs next to the binary keep resolving via PyInstaller's own
/// loader logic.
pub fn sidecar_executable(app_data: &Path) -> PathBuf {
    root_dir(app_data)
        .join("bin")
        .join("stash-separator")
        .join("stash-separator")
}

/// Where to point `TORCH_HOME` when spawning the sidecar. Demucs and
/// torch both read weights from `<TORCH_HOME>/hub/checkpoints/`.
pub fn models_root(app_data: &Path) -> PathBuf {
    root_dir(app_data).join("models")
}

/// Default user-facing output directory for stems. Falls back to the
/// home directory when the system has no Music dir (rare on macOS but
/// possible on a freshly imaged user account).
pub fn output_dir_default() -> PathBuf {
    if let Some(dir) = dirs_next::audio_dir() {
        return dir.join("Stash Stems");
    }
    if let Some(home) = dirs_next::home_dir() {
        return home.join("Stash Stems");
    }
    PathBuf::from("./Stash Stems")
}

/// True when the required pack (sidecar + htdemucs_6s) is on disk and
/// big enough to plausibly be a real file. Optional `ft` weights are
/// checked separately via `ft_ready`.
pub fn assets_ready(app_data: &Path) -> bool {
    REQUIRED.iter().all(|a| has_asset(app_data, a))
}

/// True when all four htdemucs_ft model files are installed. Used by
/// settings to decide whether the "high-quality 4-stem" checkbox is
/// in the on / off / partially-installed state.
pub fn ft_ready(app_data: &Path) -> bool {
    OPTIONAL_FT.iter().all(|a| has_asset(app_data, a))
}

pub fn has_asset(app_data: &Path, a: &SeparatorAsset) -> bool {
    let path = asset_path(app_data, a);
    std::fs::metadata(&path)
        .map(|m| m.len() >= catalog::min_plausible_bytes(a.kind))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn root_dir_is_under_app_data() {
        let app_data = Path::new("/tmp/some-app");
        assert_eq!(root_dir(app_data), Path::new("/tmp/some-app/separator"));
    }

    #[test]
    fn asset_path_lays_models_under_torch_hub_layout() {
        let app_data = Path::new("/tmp/x");
        let p = asset_path(app_data, &catalog::HTDEMUCS_6S);
        // demucs reads weights via torch.hub which expects exactly this
        // segment chain — moving any of them breaks the loader.
        assert!(p.ends_with("separator/models/hub/checkpoints/5c90dfd2-34c22ccb.th"));
    }

    #[test]
    fn sidecar_executable_lives_inside_bundle_dir() {
        let p = sidecar_executable(Path::new("/tmp/x"));
        assert!(p.ends_with("separator/bin/stash-separator/stash-separator"));
    }

    #[test]
    fn assets_ready_false_when_nothing_installed() {
        let tmp = TempDir::new().unwrap();
        assert!(!assets_ready(tmp.path()));
    }

    #[test]
    fn assets_ready_true_when_required_assets_plausible() {
        let tmp = TempDir::new().unwrap();
        for a in REQUIRED {
            let p = asset_path(tmp.path(), a);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            // Write a 60 MB stub so it clears `min_plausible_bytes`.
            let bytes = vec![0u8; 60 * 1024 * 1024];
            fs::write(&p, bytes).unwrap();
        }
        assert!(assets_ready(tmp.path()));
        // ft pack is independent — should still report not-ready.
        assert!(!ft_ready(tmp.path()));
    }

    #[test]
    fn assets_ready_false_when_file_too_small() {
        let tmp = TempDir::new().unwrap();
        for a in REQUIRED {
            let p = asset_path(tmp.path(), a);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            // Token-sized — looks like a 404 HTML body.
            fs::write(&p, b"<!doctype html>").unwrap();
        }
        assert!(!assets_ready(tmp.path()));
    }
}
