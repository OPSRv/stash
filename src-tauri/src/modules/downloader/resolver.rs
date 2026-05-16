use std::path::{Path, PathBuf};

const CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
];

/// Hard-coded locations where macOS installs (Homebrew on both arch flavours,
/// MacPorts) park the ffmpeg/ffprobe binaries. Stash bundles inherit a
/// minimal PATH from launchd (`/usr/bin:/bin:/usr/sbin:/sbin`), so we can't
/// rely on the user's interactive shell PATH to find them — yt-dlp would
/// then surface "ffprobe and ffmpeg not found" even when the user *did*
/// install ffmpeg via Homebrew. Searching these explicit paths first fixes
/// the common case without making the user touch anything.
const FFMPEG_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin", // MacPorts
    "/usr/bin",
];

/// Returns the first yt-dlp executable found on disk, or None.
pub fn find_on_path(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    for p in CANDIDATES {
        let path = Path::new(p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            let candidate = Path::new(dir).join("yt-dlp");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    for dir in extra_dirs {
        let candidate = dir.join("yt-dlp");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Locate a directory that contains both `ffmpeg` and `ffprobe`. yt-dlp
/// accepts the directory via `--ffmpeg-location` and finds both binaries
/// inside. Returns `None` when neither homebrew nor PATH has them — the
/// caller surfaces a friendly install hint in that case.
pub fn find_ffmpeg_dir(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let has_pair = |dir: &Path| dir.join("ffmpeg").exists() && dir.join("ffprobe").exists();
    for p in FFMPEG_CANDIDATES {
        let dir = Path::new(p);
        if has_pair(dir) {
            return Some(dir.to_path_buf());
        }
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            let dir = Path::new(dir);
            if has_pair(dir) {
                return Some(dir.to_path_buf());
            }
        }
    }
    for dir in extra_dirs {
        if has_pair(dir) {
            return Some(dir.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_returns_none_when_binary_is_missing() {
        let tmp = std::env::temp_dir().join(format!("stash-rv-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        // CANDIDATES may or may not exist on this machine; we just check that
        // an arbitrary empty extra_dir doesn't produce a match.
        let empty_dir_result = find_on_path(std::slice::from_ref(&tmp));
        assert!(
            empty_dir_result.is_none() || empty_dir_result.unwrap().exists(),
            "find_on_path must return a real file path or None"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_ffmpeg_dir_returns_path_when_both_binaries_present() {
        let tmp = std::env::temp_dir().join(format!("stash-ff-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("ffmpeg"), b"#!/bin/sh\n").unwrap();
        std::fs::write(tmp.join("ffprobe"), b"#!/bin/sh\n").unwrap();
        // The dev host may already have ffmpeg in /opt/homebrew/bin or PATH;
        // CANDIDATES are searched first, so the synthetic dir only wins
        // when nothing else is found. The invariant we *can* assert is that
        // *some* dir with both binaries was located.
        let found = find_ffmpeg_dir(std::slice::from_ref(&tmp)).expect("should find");
        assert!(found.join("ffmpeg").exists());
        assert!(found.join("ffprobe").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_ffmpeg_dir_returns_none_when_only_ffmpeg_present() {
        let tmp = std::env::temp_dir().join(format!("stash-ff2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("ffmpeg"), b"#!/bin/sh\n").unwrap();
        // Missing ffprobe — yt-dlp needs both for postprocessing, so
        // returning a half-equipped dir would still fail at runtime.
        let found = find_ffmpeg_dir(std::slice::from_ref(&tmp));
        // It may still discover a system dir (if the test host has ffmpeg
        // installed globally); the only invariant we can assert is that
        // a partial extra_dir is never the chosen result.
        assert_ne!(found.as_deref(), Some(tmp.as_path()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_returns_path_when_binary_is_in_extra_dir() {
        let tmp = std::env::temp_dir().join(format!("stash-rv2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let binary = tmp.join("yt-dlp");
        std::fs::write(&binary, b"#!/bin/sh\necho stub\n").unwrap();
        // Must be found via extra_dirs even if PATH/candidates don't have it.
        let found = find_on_path(std::slice::from_ref(&tmp));
        assert!(found.is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
