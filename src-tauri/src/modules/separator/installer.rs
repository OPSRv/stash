//! Multi-phase install of the Python runtime that hosts demucs +
//! BeatNet.
//!
//! No tarball of our own to host: the only third-party download is
//! `uv` itself (pulled from `astral-sh/uv` releases — Astral keeps the
//! `releases/latest/download/<asset>` URL stable across versions). uv
//! then bootstraps a managed Python toolchain and the venv, and
//! `uv pip install` reaches PyPI for demucs / BeatNet / torch /
//! soundfile. Nothing here is coupled to a Stash release tag, so
//! "Settings → Завантажити" works the moment a new app is launched —
//! no re-publish, no mirror bookkeeping.
//!
//! The phase events emitted into `separator:install` mirror the steps
//! one-for-one (`uv` → `python` → `venv` → `packages` → `models`),
//! which is how the Settings UI renders a single staged progress card
//! instead of one bar per asset.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::state::{
    install_flag, python_path, requirements_path, root_dir, script_path, uv_path, venv_dir,
};

/// `uv` is small (~25 MB tarball, ~50 MB extracted), single static
/// binary. Apple Silicon only — Stash dropped Intel support, mirrors
/// the rest of the project. Astral pins their release naming to
/// `uv-aarch64-apple-darwin.tar.gz` so this URL is stable across uv
/// versions.
#[cfg(target_arch = "aarch64")]
const UV_URL: &str =
    "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz";
#[cfg(not(target_arch = "aarch64"))]
const UV_URL: &str =
    "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz";

/// Python version we pin the venv to. 3.11 is the Demucs-GUI target
/// of choice and the most-tested combination with current `torch` and
/// `BeatNet` wheels on macOS arm64.
const PYTHON_VERSION: &str = "3.11";

/// `crates/stash-separator/src/main.py` — the CLI entry the venv runs.
/// `include_str!` baked at compile time so we don't need to ship a
/// separate file alongside the .app bundle and so the script always
/// matches the host app's expectations.
const MAIN_PY: &str = include_str!("../../../crates/stash-separator/src/main.py");

/// `crates/stash-separator/requirements.txt` — pinned list fed to
/// `uv pip install`.
const REQUIREMENTS_TXT: &str =
    include_str!("../../../crates/stash-separator/requirements.txt");

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallPhase {
    Uv,
    Python,
    Venv,
    Packages,
    Models,
    Done,
}

#[derive(Debug, Clone, Serialize)]
struct InstallEvent<'a> {
    phase: InstallPhase,
    /// Human-readable status line so the UI doesn't have to localise
    /// every phase by itself. Free-text — don't pattern-match on it.
    message: &'a str,
    /// Optional 0..1 progress, for phases where we have one (uv
    /// download). `None` for steps where we can't get a meaningful
    /// percentage cheaply (`uv pip install` doesn't expose a total).
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f32>,
}

/// Emit a phase tick on `separator:install`. Pub so `commands.rs` can
/// drive the `Models` and `Done` phases too — the model-download loop
/// lives there, not here, but the UI wants the same staged card to
/// keep advancing across both halves.
pub fn emit_phase(app: &AppHandle, phase: InstallPhase, message: &str, progress: Option<f32>) {
    let _ = app.emit(
        "separator:install",
        InstallEvent {
            phase,
            message,
            progress,
        },
    );
}

fn emit(app: &AppHandle, phase: InstallPhase, message: &str, progress: Option<f32>) {
    emit_phase(app, phase, message, progress);
}

/// Run every install step in order. Idempotent — each step short-
/// circuits if its sentinel (binary present, venv present, install
/// flag stamped) already exists. Returns `Ok(())` once the runtime is
/// usable; model downloads happen in `commands.rs` against the same
/// progress channel.
pub async fn run_runtime_install(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root_dir(app_data)).map_err(|e| format!("mkdir: {e}"))?;

    // Stage main.py + requirements.txt — written every install so a
    // hot-fix to the .py is picked up automatically next time the user
    // re-runs install (e.g. after an app upgrade).
    stage_payload(app_data)?;

    ensure_uv(app, app_data).await?;
    ensure_python(app, app_data)?;
    ensure_venv(app, app_data)?;
    ensure_packages(app, app_data)?;

    // Final stamp: only written after everything succeeded. Removed
    // up-front by `purge_runtime` so a partial install is never
    // reported as ready.
    std::fs::write(install_flag(app_data), b"ok\n")
        .map_err(|e| format!("stamp install flag: {e}"))?;
    Ok(())
}

/// Cheap runtime sanity check: imports the exact symbols `main.py`
/// uses and returns the venv's demucs version. Catches a stale
/// install where the flag was stamped against a pre-fix venv (e.g.
/// demucs 3.x without `demucs.api`). Caller handles the recovery —
/// usually `purge_runtime` followed by a fresh `run_runtime_install`.
pub fn verify_runtime(app_data: &Path) -> Result<String, String> {
    let python = python_path(app_data);
    if !python.is_file() {
        return Err(format!("python missing at {}", python.display()));
    }
    let probe = Command::new(&python)
        .args([
            "-c",
            "import demucs; \
             from demucs.api import Separator; \
             from BeatNet.BeatNet import BeatNet; \
             import soundfile; \
             print(demucs.__version__)",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn probe: {e}"))?;
    if !probe.status.success() {
        let stderr = String::from_utf8_lossy(&probe.stderr);
        return Err(stderr.lines().next().unwrap_or("probe failed").to_string());
    }
    Ok(String::from_utf8_lossy(&probe.stdout).trim().to_string())
}

/// Wipe the entire runtime tree (uv, venv, staged payload, install
/// flag). Models are kept — they're separately tracked and the user
/// shouldn't have to re-download 320 MB of weights just because they
/// reset Python.
pub fn purge_runtime(app_data: &Path) -> Result<(), String> {
    // Drop the flag first so a concurrent ready-check sees `false`
    // even if the rmdir below races with it.
    let _ = std::fs::remove_file(install_flag(app_data));
    let _ = std::fs::remove_dir_all(venv_dir(app_data));
    let _ = std::fs::remove_file(uv_path(app_data));
    let _ = std::fs::remove_file(script_path(app_data));
    let _ = std::fs::remove_file(requirements_path(app_data));
    Ok(())
}

fn stage_payload(app_data: &Path) -> Result<(), String> {
    let script = script_path(app_data);
    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    write_if_changed(&script, MAIN_PY.as_bytes())?;
    let req = requirements_path(app_data);
    write_if_changed(&req, REQUIREMENTS_TXT.as_bytes())?;
    // main.py is run via `python <path>`; no execute bit needed, but a
    // future shebang dispatch wouldn't hurt to have it.
    Ok(())
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(current) = std::fs::read(path) {
        if current == bytes {
            return Ok(());
        }
    }
    std::fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

async fn ensure_uv(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    let target = uv_path(app_data);
    if target.is_file() {
        emit(app, InstallPhase::Uv, "uv вже встановлено", Some(1.0));
        return Ok(());
    }
    emit(app, InstallPhase::Uv, "Завантажую uv…", Some(0.0));
    let bin_dir = target
        .parent()
        .ok_or_else(|| "uv target has no parent dir".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("mkdir bin: {e}"))?;

    let tmp = bin_dir.join("uv.tar.gz.part");
    let _ = std::fs::remove_file(&tmp);
    download_with_progress(app, UV_URL, &tmp, InstallPhase::Uv).await?;

    emit(app, InstallPhase::Uv, "Розпаковую…", Some(0.95));
    // `tar` is part of macOS, no extra crate needed. The Astral
    // tarball lays the `uv` binary inside `uv-<triple>/`, so we
    // extract into a scratch dir and then move just the binary out.
    let scratch = bin_dir.join("uv-extract");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("mkdir scratch: {e}"))?;
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&tmp)
        .arg("-C")
        .arg(&scratch)
        .status()
        .map_err(|e| format!("spawn tar: {e}"))?;
    if !status.success() {
        return Err(format!("tar exited {status}"));
    }
    // Find the `uv` binary inside the scratch tree — Astral nests it
    // under `uv-<triple>/uv` but a future layout change shouldn't
    // require code changes; just walk until we find an executable
    // file named exactly `uv`.
    let extracted = find_named(&scratch, "uv")
        .ok_or_else(|| "uv binary not found inside tarball".to_string())?;
    std::fs::rename(&extracted, &target).map_err(|e| format!("rename uv: {e}"))?;
    let _ = std::fs::remove_dir_all(&scratch);
    let _ = std::fs::remove_file(&tmp);

    set_executable(&target)?;
    // Strip Gatekeeper quarantine so the unsigned download runs
    // without a "can't be opened because Apple cannot check it"
    // dialog. uv is signed by Astral; this attribute is just our
    // download channel's mark, not an auth signal.
    let _ = Command::new("xattr")
        .arg("-d")
        .arg("com.apple.quarantine")
        .arg(&target)
        .status();

    emit(app, InstallPhase::Uv, "uv готово", Some(1.0));
    Ok(())
}

fn ensure_python(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    emit(
        app,
        InstallPhase::Python,
        &format!("Перевіряю Python {PYTHON_VERSION}…"),
        None,
    );
    let uv = uv_path(app_data);
    // `uv python install <version>` is idempotent — exits 0 if the
    // requested version is already managed. Cheap to call every install
    // pass; saves us a separate "is python installed" probe.
    let status = Command::new(&uv)
        .args(["python", "install", PYTHON_VERSION])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("spawn uv python install: {e}"))?;
    if !status.success() {
        return Err(format!("uv python install {PYTHON_VERSION} exited {status}"));
    }
    emit(
        app,
        InstallPhase::Python,
        &format!("Python {PYTHON_VERSION} готовий"),
        None,
    );
    Ok(())
}

fn ensure_venv(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    let venv = venv_dir(app_data);
    let python = python_path(app_data);
    if python.is_file() {
        emit(app, InstallPhase::Venv, "venv вже існує", None);
        return Ok(());
    }
    emit(app, InstallPhase::Venv, "Створюю Python venv…", None);
    let uv = uv_path(app_data);
    let status = Command::new(&uv)
        .arg("venv")
        .arg("--python")
        .arg(PYTHON_VERSION)
        .arg(&venv)
        .status()
        .map_err(|e| format!("spawn uv venv: {e}"))?;
    if !status.success() {
        return Err(format!("uv venv exited {status}"));
    }
    emit(app, InstallPhase::Venv, "venv готове", None);
    Ok(())
}

fn ensure_packages(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    emit(
        app,
        InstallPhase::Packages,
        "Встановлюю demucs + BeatNet + torch (~1.5 GB, кілька хвилин)…",
        None,
    );
    let uv = uv_path(app_data);
    let python = python_path(app_data);
    let req = requirements_path(app_data);
    let status = Command::new(&uv)
        .args(["pip", "install"])
        .arg("--python")
        .arg(&python)
        .arg("-r")
        .arg(&req)
        .status()
        .map_err(|e| format!("spawn uv pip install: {e}"))?;
    if !status.success() {
        return Err(format!("uv pip install exited {status}"));
    }
    // Sanity-probe so a venv with broken/missing wheels never gets the
    // install flag stamped. We import the *exact* symbols `main.py`
    // uses — a top-level `import demucs` is too lax, it succeeds even
    // when pip dropped a 3.x demucs that lacks `demucs.api`. Catching
    // that here turns "ModuleNotFoundError at run time" into a clear
    // install-time failure with stderr attached.
    let probe = Command::new(&python)
        .args([
            "-c",
            "import demucs; \
             from demucs.api import Separator; \
             from BeatNet.BeatNet import BeatNet; \
             import soundfile; \
             print(demucs.__version__)",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn import probe: {e}"))?;
    if !probe.status.success() {
        let stderr = String::from_utf8_lossy(&probe.stderr);
        return Err(format!(
            "Python venv collected wheels but cannot import demucs.api / \
             BeatNet / soundfile. The venv is in an inconsistent state — \
             use «Settings → Separator → Видалити» and try again. \
             Detail:\n{}",
            stderr.trim()
        ));
    }
    let demucs_version = String::from_utf8_lossy(&probe.stdout).trim().to_string();
    tracing::info!(target: "separator", demucs_version, "venv import probe ok");
    emit(
        app,
        InstallPhase::Packages,
        "Пакети встановлено",
        Some(1.0),
    );
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    let mut perms = meta.permissions();
    perms.set_mode(perms.mode() | 0o755);
    std::fs::set_permissions(path, perms)
        .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn download_with_progress(
    app: &AppHandle,
    url: &str,
    tmp: &Path,
    phase: InstallPhase,
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("install asset url must be https".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("stash-app/separator-installer")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(tmp).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            let _ = std::fs::remove_file(tmp);
            e.to_string()
        })?;
        file.write_all(&bytes).map_err(|e| {
            let _ = std::fs::remove_file(tmp);
            e.to_string()
        })?;
        received += bytes.len() as u64;
        if last_emit.elapsed() >= std::time::Duration::from_millis(150) {
            last_emit = std::time::Instant::now();
            let progress = if total > 0 {
                Some((received as f32 / total as f32).clamp(0.0, 1.0))
            } else {
                None
            };
            emit(app, phase, "Завантажую uv…", progress);
        }
    }
    drop(file);
    Ok(())
}

fn find_named(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() && p.file_name().and_then(|n| n.to_str()) == Some(name) {
            return Some(p);
        }
        if p.is_dir() {
            if let Some(found) = find_named(&p, name) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn payload_constants_are_non_empty() {
        // Catches a future build-time mistake where the include_str!
        // path is wrong (would otherwise fail with a less obvious
        // runtime error halfway through install).
        assert!(MAIN_PY.contains("def main"));
        assert!(REQUIREMENTS_TXT.contains("demucs"));
        assert!(REQUIREMENTS_TXT.contains("BeatNet"));
    }

    #[test]
    fn stage_payload_writes_main_and_requirements() {
        let tmp = TempDir::new().unwrap();
        stage_payload(tmp.path()).unwrap();
        assert!(script_path(tmp.path()).is_file());
        assert!(requirements_path(tmp.path()).is_file());
        let main_body = std::fs::read_to_string(script_path(tmp.path())).unwrap();
        assert!(main_body.starts_with("#!/usr/bin/env python3"));
    }

    #[test]
    fn write_if_changed_skips_identical_writes() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("x");
        write_if_changed(&p, b"hello").unwrap();
        let m1 = std::fs::metadata(&p).unwrap().modified().unwrap();
        // Tiny sleep so any FS modification timestamp resolution
        // change would be detectable; deliberate to expose any
        // future regression where we always rewrite.
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_if_changed(&p, b"hello").unwrap();
        let m2 = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert_eq!(m1, m2, "identical content should not be rewritten");
    }

    #[test]
    fn purge_runtime_drops_flag_first() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(root_dir(tmp.path())).unwrap();
        std::fs::write(install_flag(tmp.path()), b"x").unwrap();
        purge_runtime(tmp.path()).unwrap();
        assert!(!install_flag(tmp.path()).is_file());
    }
}
