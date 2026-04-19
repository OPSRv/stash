use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
const YT_DLP_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";

#[cfg(not(target_os = "macos"))]
const YT_DLP_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

/// Ensure a yt-dlp binary exists inside `bin_dir`. Returns its path.
/// If already present, returns immediately. Otherwise fetches via curl
/// and makes it executable.
pub fn ensure_bundled(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    let target = bin_dir.join("yt-dlp");
    if target.exists() {
        return Ok(target);
    }
    let status = Command::new("curl")
        .args(["-L", "--fail", "-o"])
        .arg(&target)
        .arg(YT_DLP_URL)
        .status()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !status.success() {
        return Err(format!("curl exited with {status}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&target)
            .map_err(|e| format!("stat {target:?}: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&target, perms)
            .map_err(|e| format!("chmod {target:?}: {e}"))?;
    }
    Ok(target)
}

/// Full resolution chain: system PATH → homebrew → bundled (auto-install if missing).
pub fn resolve(bin_dir: &Path) -> Result<PathBuf, String> {
    if let Some(p) = super::resolver::find_on_path(&[bin_dir.to_path_buf()]) {
        return Ok(p);
    }
    ensure_bundled(bin_dir)
}

/// Query installed yt-dlp version by running `yt-dlp --version`.
pub fn installed_version(yt_dlp: &Path) -> Result<String, String> {
    let out = Command::new(yt_dlp)
        .arg("--version")
        .output()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !out.status.success() {
        return Err(format!("yt-dlp --version exited with {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Fetch latest yt-dlp version tag from GitHub (without curl/jq, via HTTP redirect).
pub fn latest_version() -> Result<String, String> {
    // Use curl to follow the "latest" redirect — the Location header exposes
    // the tag without needing a JSON parser or GitHub token.
    let out = Command::new("curl")
        .args([
            "-sI",
            "-o",
            "/dev/null",
            "-w",
            "%{redirect_url}",
            "https://github.com/yt-dlp/yt-dlp/releases/latest",
        ])
        .output()
        .map_err(|e| format!("spawn curl: {e}"))?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    url.rsplit('/')
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("unexpected redirect: {url}"))
}

/// Force-redownload yt-dlp, overwriting whatever is at `bin_dir/yt-dlp`.
/// Uses the GitHub latest release download URL, which works for our signed
/// macOS binary even when `yt-dlp -U` cannot self-replace.
pub fn force_reinstall(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    let target = bin_dir.join("yt-dlp");
    let tmp = bin_dir.join("yt-dlp.new");
    let status = Command::new("curl")
        .args(["-L", "--fail", "-o"])
        .arg(&tmp)
        .arg(YT_DLP_URL)
        .status()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("curl exited with {status}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)
            .map_err(|e| format!("stat {tmp:?}: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp, perms)
            .map_err(|e| format!("chmod {tmp:?}: {e}"))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_bundled_returns_existing_binary_without_downloading() {
        let tmp = std::env::temp_dir().join(format!("stash-inst-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let stub = tmp.join("yt-dlp");
        std::fs::write(&stub, b"stub").unwrap();

        let out = ensure_bundled(&tmp).unwrap();
        assert_eq!(out, stub);
        assert_eq!(std::fs::read(&out).unwrap(), b"stub");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
