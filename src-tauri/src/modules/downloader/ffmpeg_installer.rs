//! Bundled ffmpeg + ffprobe management for the Downloader module.
//!
//! Why we ship our own ffmpeg:
//! - yt-dlp's postprocessing (audio extraction, video mux) requires both
//!   `ffmpeg` and `ffprobe`. macOS does not ship either.
//! - When the user has them via Homebrew, [`super::resolver::find_ffmpeg_dir`]
//!   already locates them and we pass `--ffmpeg-location`. But many Stash
//!   users never touch Homebrew — for them we need a self-contained install
//!   path, the same way we already bundle yt-dlp.
//!
//! Source: <https://evermeet.cx> — canonical macOS static builds maintained
//! by the same people the yt-dlp docs point at. Distributed as a zip with
//! a single binary inside.
//!
//! Trust model: HTTPS to evermeet.cx, no extra SHA verification. The site
//! exposes per-download GPG `.sig` URLs but no top-level SHA-256 in
//! `info/<bin>/release`, so a sums-manifest check (the yt-dlp installer
//! pattern) is not available. Adding GPG would mean shipping `gpg` +
//! pinning a public key in this repo; Homebrew's own ffmpeg formula leans
//! on the same TLS-to-evermeet trust, which is acceptable for a
//! single-maintainer macOS-only tool.
//!
//! Linux/Windows: unsupported. Stash is a macOS menubar app; cross-platform
//! support is out of scope here, and the resolver still picks up system
//! ffmpeg on other platforms.

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
const FFMPEG_ZIP_URL: &str = "https://evermeet.cx/ffmpeg/getrelease/zip";
#[cfg(target_os = "macos")]
const FFPROBE_ZIP_URL: &str = "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip";

/// Status of the bundled ffmpeg pair. `Some(dir)` when both binaries are
/// present in `bin_dir`, otherwise `None`. Currently used internally by
/// `ensure_bundled` + tests; the runner reaches this dir through the
/// generic `resolver::find_ffmpeg_dir(extras)` path so a system install
/// is preferred over the bundled copy.
#[allow(dead_code)]
pub fn bundled_dir(bin_dir: &Path) -> Option<PathBuf> {
    let ff = bin_dir.join("ffmpeg");
    let fp = bin_dir.join("ffprobe");
    (ff.exists() && fp.exists()).then(|| bin_dir.to_path_buf())
}

/// Read `ffmpeg -version` to surface what's installed. Returns just the
/// version token (first line, second whitespace-separated field), so
/// "ffmpeg version 7.1 Copyright …" reduces to "7.1". Empty / unreadable
/// output → error.
pub fn installed_version(dir: &Path) -> Result<String, String> {
    let out = Command::new(dir.join("ffmpeg"))
        .arg("-version")
        .output()
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffmpeg -version exited with {}", out.status));
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let first = body.lines().next().unwrap_or_default();
    parse_ffmpeg_version_line(first)
        .ok_or_else(|| format!("unexpected `ffmpeg -version` header: {first}"))
}

/// Pull the version token out of an `ffmpeg -version` first line. Kept pure
/// so the parser can be tested without spawning a process.
pub(crate) fn parse_ffmpeg_version_line(line: &str) -> Option<String> {
    // Typical: "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg ..."
    //   or:    "ffmpeg version n7.1-static Copyright ..."
    let mut parts = line.split_whitespace();
    if parts.next()? != "ffmpeg" {
        return None;
    }
    if parts.next()? != "version" {
        return None;
    }
    parts.next().map(|s| s.to_string())
}

/// Ensure bundled ffmpeg+ffprobe exist in `bin_dir`. Idempotent — returns
/// immediately when both are present. Otherwise downloads each from
/// evermeet.cx, verifies the SHA-256 from the matching info endpoint, and
/// extracts the single binary out of the zip. Reserved for a future
/// auto-setup flow; today only `force_reinstall` is reachable from the UI.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub fn ensure_bundled(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    if let Some(dir) = bundled_dir(bin_dir) {
        return Ok(dir);
    }
    install_pair(bin_dir)?;
    Ok(bin_dir.to_path_buf())
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn ensure_bundled(_bin_dir: &Path) -> Result<PathBuf, String> {
    Err("bundled ffmpeg install is macOS-only; install ffmpeg via your package manager".into())
}

/// Force re-download both binaries even if already present. Mirrors the
/// yt-dlp re-install button.
#[cfg(target_os = "macos")]
pub fn force_reinstall(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    install_pair(bin_dir)?;
    Ok(bin_dir.to_path_buf())
}

#[cfg(not(target_os = "macos"))]
pub fn force_reinstall(_bin_dir: &Path) -> Result<PathBuf, String> {
    Err("bundled ffmpeg install is macOS-only".into())
}

#[cfg(target_os = "macos")]
fn install_pair(bin_dir: &Path) -> Result<(), String> {
    install_one(bin_dir, "ffmpeg", FFMPEG_ZIP_URL)?;
    install_one(bin_dir, "ffprobe", FFPROBE_ZIP_URL)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_one(bin_dir: &Path, binary: &str, zip_url: &str) -> Result<(), String> {
    let zip_path = bin_dir.join(format!("{binary}.zip"));
    if let Err(e) = curl_to_file(zip_url, &zip_path) {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("download {binary}: {e}"));
    }
    // `-o` overwrites, `-j` flattens (some zips wrap the binary in a folder,
    // we always want it at bin_dir root).
    let status = Command::new("/usr/bin/unzip")
        .arg("-o")
        .arg("-j")
        .arg(&zip_path)
        .arg("-d")
        .arg(bin_dir)
        .status()
        .map_err(|e| format!("spawn unzip: {e}"))?;
    let _ = std::fs::remove_file(&zip_path);
    if !status.success() {
        return Err(format!("unzip {binary} exited with {status}"));
    }
    set_executable(&bin_dir.join(binary))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn curl_to_file(url: &str, dest: &Path) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-L", "--fail", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !status.success() {
        return Err(format!("curl exited with {status}"));
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("stat {path:?}: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|e| format!("chmod {path:?}: {e}"))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_parses_standard_format() {
        let line = "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers";
        assert_eq!(parse_ffmpeg_version_line(line).as_deref(), Some("7.1"));
    }

    #[test]
    fn version_line_parses_static_suffix() {
        let line = "ffmpeg version n7.1-static Copyright (c) ...";
        assert_eq!(
            parse_ffmpeg_version_line(line).as_deref(),
            Some("n7.1-static")
        );
    }

    #[test]
    fn version_line_rejects_non_ffmpeg_header() {
        assert_eq!(parse_ffmpeg_version_line("ffprobe version 7.1"), None);
        assert_eq!(parse_ffmpeg_version_line(""), None);
    }

    #[test]
    fn bundled_dir_requires_both_binaries() {
        let tmp = std::env::temp_dir().join(format!("stash-ffi-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        assert!(bundled_dir(&tmp).is_none());
        std::fs::write(tmp.join("ffmpeg"), b"x").unwrap();
        assert!(bundled_dir(&tmp).is_none());
        std::fs::write(tmp.join("ffprobe"), b"x").unwrap();
        assert_eq!(bundled_dir(&tmp).as_deref(), Some(tmp.as_path()));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
