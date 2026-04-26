use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
const YT_DLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";

#[cfg(not(target_os = "macos"))]
const YT_DLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

#[cfg(target_os = "macos")]
const YT_DLP_FILENAME_IN_SUMS: &str = "yt-dlp_macos";

#[cfg(not(target_os = "macos"))]
const YT_DLP_FILENAME_IN_SUMS: &str = "yt-dlp";

/// SHA-256 manifest published alongside each yt-dlp release. We fetch
/// it via the same GitHub HTTPS path as the binary itself; if the TLS
/// chain is intact, both transfers come from the same origin and a
/// matching digest proves the binary wasn't swapped on the wire.
const YT_DLP_SUMS_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

/// Ensure a yt-dlp binary exists inside `bin_dir`. Returns its path.
/// If already present, returns immediately. Otherwise fetches via curl
/// and makes it executable.
pub fn ensure_bundled(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    let target = bin_dir.join("yt-dlp");
    if target.exists() {
        return Ok(target);
    }
    download_verified(YT_DLP_URL, &target)?;
    set_executable(&target)?;
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
    if let Err(e) = download_verified(YT_DLP_URL, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    set_executable(&tmp)?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(target)
}

/// Download `url` to `dest` via curl, then verify its SHA-256 against the
/// release's `SHA2-256SUMS` manifest. On digest mismatch the partial file
/// is removed and an error is returned — that prevents a tampered binary
/// (TLS proxy, mirror compromise) from being marked executable and run.
///
/// Why curl + manifest, not signature:
/// - The yt-dlp project does publish GPG signatures, but verifying them
///   would require shipping a pinned public key plus a `gpg` runtime.
///   The sums manifest covers the realistic attack surface for our use
///   case (TLS-MITM / mirror swap) without that build-time tax.
/// - Both files are fetched from the same `releases/latest/download/`
///   origin, so an attacker would need to swap *both* the binary and the
///   sums manifest *and* keep them consistent — the same level of trust
///   we already place in GitHub's TLS for the rest of the app.
fn download_verified(url: &str, dest: &Path) -> Result<(), String> {
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

    let expected = match fetch_expected_sha256(YT_DLP_FILENAME_IN_SUMS) {
        Ok(s) => s,
        Err(e) => {
            // Hard-fail if the manifest fetch fails: a silent fallback
            // here would defeat the whole purpose of this guard. The
            // user sees a download error and can retry.
            let _ = std::fs::remove_file(dest);
            return Err(format!("fetch SHA2-256SUMS: {e}"));
        }
    };
    let actual = sha256_of_file(dest)?;
    if !actual.eq_ignore_ascii_case(&expected) {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "yt-dlp digest mismatch: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// Curl the SHA-256 manifest for the latest release and pull out the
/// digest for `filename`. Returns the lowercase hex digest as a String.
fn fetch_expected_sha256(filename: &str) -> Result<String, String> {
    let out = Command::new("curl")
        .args(["-L", "--fail", "-s", YT_DLP_SUMS_URL])
        .output()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("curl exited with {}", out.status));
    }
    let body = String::from_utf8_lossy(&out.stdout);
    parse_sha256_manifest(&body, filename)
        .ok_or_else(|| format!("filename {filename} not found in SHA2-256SUMS"))
}

/// Parse a coreutils-style `sha256sum` manifest — each line is either
/// `<hex>  <name>` or `<hex> *<name>`. Returns the hex digest paired
/// with `target`. Blank lines and lines that don't have at least two
/// whitespace-separated tokens are skipped, not fatal — that lets
/// future yt-dlp manifests grow header/footer comments without breaking
/// the parser.
fn parse_sha256_manifest(body: &str, target: &str) -> Option<String> {
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let Some(digest) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        // Strip the leading `*` that some sha256sum impls add for
        // binary-mode entries; we treat both modes identically.
        let name = name.strip_prefix('*').unwrap_or(name);
        if name == target {
            return Some(digest.to_string());
        }
    }
    None
}

/// Streaming SHA-256 over a file path. We avoid `std::fs::read` so a
/// future jump in yt-dlp size doesn't materialise the whole binary in
/// RAM just to hash it.
fn sha256_of_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read {path:?}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(hex_lower(&digest))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
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

    #[test]
    fn parse_sha256_manifest_handles_text_and_binary_modes() {
        let body = "abc123  yt-dlp\n\
                    def456 *yt-dlp_macos\n\
                    ff00aa  yt-dlp.exe\n";
        assert_eq!(
            parse_sha256_manifest(body, "yt-dlp"),
            Some("abc123".to_string())
        );
        assert_eq!(
            parse_sha256_manifest(body, "yt-dlp_macos"),
            Some("def456".to_string())
        );
        assert_eq!(parse_sha256_manifest(body, "missing"), None);
    }

    #[test]
    fn sha256_of_file_matches_known_vector() {
        // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        let tmp = std::env::temp_dir().join(format!("stash-sha-{}", std::process::id()));
        std::fs::write(&tmp, b"abc").unwrap();
        let digest = sha256_of_file(&tmp).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn parse_manifest_skips_blank_lines_and_comments() {
        let body = "\n# header comment\nabc  yt-dlp\n";
        // Comment line `# header comment` parses as digest=`#` name=`header`,
        // so it doesn't match `yt-dlp` and is skipped — exactly what we want.
        assert_eq!(
            parse_sha256_manifest(body, "yt-dlp"),
            Some("abc".to_string())
        );
    }
}
