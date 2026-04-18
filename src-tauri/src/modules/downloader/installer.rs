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
