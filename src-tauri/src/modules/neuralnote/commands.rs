//! Install / launch / status for the NeuralNote standalone app.
//!
//! Install path: download the official .pkg from GitHub Releases to a
//! temp file and hand it to `open` so macOS's own Installer.app
//! prompts the user for admin privileges. Doing it through the system
//! installer keeps us out of the sudo-elevation business and gives the
//! user the familiar four-click flow they expect for any .pkg.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

const APP_PATH: &str = "/Applications/NeuralNote.app";
const RELEASES_LATEST_PKG: &str =
    "https://github.com/DamRsn/NeuralNote/releases/latest/download/NeuralNote_Installer_Mac.pkg";

#[derive(Serialize, Clone, Debug)]
pub struct NeuralNoteStatus {
    /// True when `/Applications/NeuralNote.app` exists. Doesn't try to
    /// match against the latest GitHub tag — once installed, the
    /// in-app updater (if any) is NeuralNote's own business.
    pub installed: bool,
    pub app_path: Option<String>,
    /// `CFBundleShortVersionString` from the bundle Info.plist, when
    /// readable. None when not installed or plist parse failed.
    pub version: Option<String>,
}

#[tauri::command]
pub fn neuralnote_status() -> NeuralNoteStatus {
    let app = std::path::Path::new(APP_PATH);
    if !app.exists() {
        return NeuralNoteStatus {
            installed: false,
            app_path: None,
            version: None,
        };
    }
    let version = read_bundle_version(app);
    NeuralNoteStatus {
        installed: true,
        app_path: Some(APP_PATH.to_string()),
        version,
    }
}

/// Download the .pkg installer and hand it to `open`, which spins up
/// the macOS Installer.app — the user is prompted for admin password
/// by the system, no sudo from our side. Returns once the installer
/// has been launched; the frontend re-polls `neuralnote_status` to
/// detect when /Applications/NeuralNote.app appears.
#[tauri::command]
pub async fn neuralnote_install() -> Result<String, String> {
    let pkg_path: PathBuf =
        std::env::temp_dir().join(format!("NeuralNote_Installer-{}.pkg", std::process::id()));
    let pkg_for_blocking = pkg_path.clone();
    let url = RELEASES_LATEST_PKG.to_string();
    tauri::async_runtime::spawn_blocking(move || download_via_curl(&url, &pkg_for_blocking))
        .await
        .map_err(|e| e.to_string())??;
    // `open` returns immediately once Installer.app launches — we do
    // not wait for the user to click Install, which can take minutes.
    let status = Command::new("/usr/bin/open")
        .arg(&pkg_path)
        .status()
        .map_err(|e| format!("spawn open: {e}"))?;
    if !status.success() {
        return Err(format!("`open` exited with {status}"));
    }
    Ok(format!("Installer launched: {}", pkg_path.display()))
}

/// Open the installed NeuralNote app (or surface a friendly error if
/// it isn't installed yet).
#[tauri::command]
pub fn neuralnote_open() -> Result<(), String> {
    if !std::path::Path::new(APP_PATH).exists() {
        return Err("NeuralNote is not installed".into());
    }
    Command::new("/usr/bin/open")
        .args(["-a", "NeuralNote"])
        .status()
        .map_err(|e| format!("spawn open -a NeuralNote: {e}"))?;
    Ok(())
}

fn download_via_curl(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-L", "--fail", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(dest);
        return Err(format!("curl exited with {status}"));
    }
    Ok(())
}

/// Scrape `CFBundleShortVersionString` out of the .app Info.plist.
/// Falls back to None when the file is missing or the key isn't there
/// — version display is nice-to-have, not load-bearing.
fn read_bundle_version(app: &std::path::Path) -> Option<String> {
    let plist = app.join("Contents").join("Info.plist");
    let out = Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(plist.with_extension(""))
        .arg("CFBundleShortVersionString")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
