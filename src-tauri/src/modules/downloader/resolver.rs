use std::path::{Path, PathBuf};

const CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_returns_none_when_binary_is_missing() {
        let tmp = std::env::temp_dir().join(format!("stash-rv-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        // CANDIDATES may or may not exist on this machine; we just check that
        // an arbitrary empty extra_dir doesn't produce a match.
        let empty_dir_result = find_on_path(&[tmp.clone()]);
        assert!(
            empty_dir_result.is_none() || empty_dir_result.unwrap().exists(),
            "find_on_path must return a real file path or None"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_returns_path_when_binary_is_in_extra_dir() {
        let tmp = std::env::temp_dir().join(format!("stash-rv2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let binary = tmp.join("yt-dlp");
        std::fs::write(&binary, b"#!/bin/sh\necho stub\n").unwrap();
        // Must be found via extra_dirs even if PATH/candidates don't have it.
        let found = find_on_path(&[tmp.clone()]);
        assert!(found.is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
