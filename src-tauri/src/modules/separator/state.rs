//! On-disk paths for the separator install + the in-memory state the
//! commands share between invocations.
//!
//! `runtime_ready` + `assets_ready` together answer "is separation
//! usable right now?" — the UI guards every separator action behind
//! their conjunction. They are intentionally independent: the user
//! can have demucs models on disk but no Python runtime yet (or vice
//! versa) during an interrupted install, and both halves report that
//! independently.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::catalog::{self, AssetSubdir, SeparatorAsset, OPTIONAL_FT, REQUIRED};
use super::jobs::SeparatorJob;

pub struct SeparatorState {
    /// Filenames currently being downloaded — guards against two
    /// concurrent download invocations racing on the same model file.
    pub in_flight: Mutex<HashSet<&'static str>>,
    /// Every job the user has kicked off in this session, newest last.
    pub jobs: Mutex<Vec<SeparatorJob>>,
    /// PID of the currently-running sidecar process, if any.
    pub active_pid: Mutex<Option<u32>>,
    /// Set while the multi-step Python runtime install is mid-flight.
    /// Stops two concurrent `separator_download` calls from racing
    /// each other through `uv venv` / `uv pip install` and leaving a
    /// half-built environment behind.
    pub install_in_flight: Mutex<bool>,
}

impl SeparatorState {
    pub fn new() -> Self {
        Self {
            in_flight: Mutex::new(HashSet::new()),
            jobs: Mutex::new(Vec::new()),
            active_pid: Mutex::new(None),
            install_in_flight: Mutex::new(false),
        }
    }
}

impl Default for SeparatorState {
    fn default() -> Self {
        Self::new()
    }
}

/// Root for everything separator-related under the app data dir.
pub fn root_dir(app_data: &Path) -> PathBuf {
    app_data.join("separator")
}

/// Where the staged Python entry point lives. Written from the Rust
/// `include_str!` payload during install, so the venv runs the exact
/// `main.py` the app was built against.
pub fn script_path(app_data: &Path) -> PathBuf {
    root_dir(app_data).join("main.py")
}

/// `requirements.txt` staged next to `main.py`, fed to
/// `uv pip install -r`.
pub fn requirements_path(app_data: &Path) -> PathBuf {
    root_dir(app_data).join("requirements.txt")
}

/// Standalone `uv` binary — single source of truth for venv + Python
/// management. Installed lazily by `installer::ensure_uv` from the
/// astral-sh/uv release.
pub fn uv_path(app_data: &Path) -> PathBuf {
    root_dir(app_data).join("bin").join("uv")
}

/// Project venv created with `uv venv --python 3.11`. Holds demucs +
/// BeatNet + torch + their dylibs.
pub fn venv_dir(app_data: &Path) -> PathBuf {
    root_dir(app_data).join(".venv")
}

/// Python interpreter inside the venv we spawn the script with.
pub fn python_path(app_data: &Path) -> PathBuf {
    venv_dir(app_data).join("bin").join("python")
}

/// Sentinel created by the installer after `uv pip install` succeeds.
/// Its presence is the canonical "Python runtime is installed" check —
/// pip install can produce a venv with broken/partial deps in tear-
/// downs, and a single existence check on the python binary is too
/// loose. The flag is stamped only once everything end-to-end ran
/// green.
pub fn install_flag(app_data: &Path) -> PathBuf {
    root_dir(app_data).join(".installed")
}

pub fn asset_path(app_data: &Path, asset: &SeparatorAsset) -> PathBuf {
    let mut p = root_dir(app_data);
    match asset.subdir {
        AssetSubdir::Models | AssetSubdir::ModelsFt => {
            // demucs reads weights at `$TORCH_HOME/hub/checkpoints/<hash>.th`
            // and we point TORCH_HOME at `models/`, so weights need to land
            // exactly at `models/hub/checkpoints/`.
            p.push("models");
            p.push("hub");
            p.push("checkpoints");
        }
    }
    p.push(asset.filename);
    p
}

/// Where to point `TORCH_HOME` when spawning the sidecar.
pub fn models_root(app_data: &Path) -> PathBuf {
    root_dir(app_data).join("models")
}

/// Default user-facing output directory for stems.
pub fn output_dir_default() -> PathBuf {
    if let Some(dir) = dirs_next::audio_dir() {
        return dir.join("Stash Stems");
    }
    if let Some(home) = dirs_next::home_dir() {
        return home.join("Stash Stems");
    }
    PathBuf::from("./Stash Stems")
}

/// True when the Python runtime is fully installed: uv + venv +
/// `pip install -r requirements.txt` all completed and the install
/// flag was stamped. The flag is the final write of the install
/// sequence, so its presence implies every previous step succeeded.
pub fn runtime_ready(app_data: &Path) -> bool {
    install_flag(app_data).is_file()
        && python_path(app_data).is_file()
        && uv_path(app_data).is_file()
        && script_path(app_data).is_file()
}

/// True when the required model pack (htdemucs_6s) is on disk and
/// big enough to plausibly be a real file. Optional `ft` weights are
/// checked separately via `ft_ready`.
pub fn assets_ready(app_data: &Path) -> bool {
    REQUIRED.iter().all(|a| has_asset(app_data, a))
}

/// Conjunction of `runtime_ready` and `assets_ready`. The UI guards
/// every action with this; either half on its own is useless.
pub fn ready(app_data: &Path) -> bool {
    runtime_ready(app_data) && assets_ready(app_data)
}

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
        assert!(p.ends_with("separator/models/hub/checkpoints/5c90dfd2-34c22ccb.th"));
    }

    #[test]
    fn python_path_lives_inside_venv() {
        let p = python_path(Path::new("/tmp/x"));
        assert!(p.ends_with("separator/.venv/bin/python"));
    }

    #[test]
    fn uv_path_lives_inside_bin() {
        let p = uv_path(Path::new("/tmp/x"));
        assert!(p.ends_with("separator/bin/uv"));
    }

    #[test]
    fn runtime_ready_false_when_nothing_installed() {
        let tmp = TempDir::new().unwrap();
        assert!(!runtime_ready(tmp.path()));
        assert!(!ready(tmp.path()));
    }

    #[test]
    fn runtime_ready_requires_install_flag_and_all_paths() {
        let tmp = TempDir::new().unwrap();
        // Drop empty placeholders for every check the flag-presence
        // path expects to find — no flag means the function should
        // still report not-ready even if the rest is staged.
        fs::create_dir_all(tmp.path().join("separator/bin")).unwrap();
        fs::create_dir_all(tmp.path().join("separator/.venv/bin")).unwrap();
        fs::write(tmp.path().join("separator/bin/uv"), b"").unwrap();
        fs::write(tmp.path().join("separator/.venv/bin/python"), b"").unwrap();
        fs::write(tmp.path().join("separator/main.py"), b"").unwrap();
        assert!(!runtime_ready(tmp.path()));

        // Flag flips it green.
        fs::write(tmp.path().join("separator/.installed"), b"").unwrap();
        assert!(runtime_ready(tmp.path()));
    }

    #[test]
    fn assets_ready_true_when_required_assets_plausible() {
        let tmp = TempDir::new().unwrap();
        for a in REQUIRED {
            let p = asset_path(tmp.path(), a);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            // 60 MB stub, clears `min_plausible_bytes`.
            let bytes = vec![0u8; 60 * 1024 * 1024];
            fs::write(&p, bytes).unwrap();
        }
        assert!(assets_ready(tmp.path()));
        assert!(!ft_ready(tmp.path()));
    }

    #[test]
    fn ready_requires_both_runtime_and_assets() {
        let tmp = TempDir::new().unwrap();
        // Models alone are not enough.
        for a in REQUIRED {
            let p = asset_path(tmp.path(), a);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, vec![0u8; 60 * 1024 * 1024]).unwrap();
        }
        assert!(assets_ready(tmp.path()));
        assert!(!ready(tmp.path()));
    }
}
