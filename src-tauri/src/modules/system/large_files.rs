use super::cancel;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LargeFile {
    pub path: String,
    pub size_bytes: u64,
    /// UNIX seconds of last modification.
    pub modified_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanSummary {
    pub scanned: usize,
    pub files: Vec<LargeFile>,
}

/// Directories we never descend into: macOS system trees and caches that
/// would either block on permissions or flood results with irrelevant noise.
fn is_skipped_dir(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/Library/Caches/")
        || s.contains("/node_modules/")
        || s.contains("/.git/")
        || s.ends_with("/.Trash")
        || s.contains("/Library/Containers/")
        || s.contains("/Library/Group Containers/")
        || s.contains("/Library/Application Support/MobileSync/")
}

/// Walk `root` and collect every regular file whose size is at least
/// `min_bytes`. Symlinks are not followed. Errors on individual entries are
/// swallowed — they almost always mean "TCC refused" and we want the rest of
/// the scan to proceed. `limit` caps the returned top-N after sorting by
/// size desc.
pub fn scan(root: &Path, min_bytes: u64, limit: usize) -> ScanSummary {
    cancel::reset("large_files");
    let mut scanned = 0usize;
    let mut files: Vec<LargeFile> = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped_dir(e.path()));

    for entry in walker.flatten() {
        // Cooperative cancellation: the frontend flips the flag when the
        // user clicks "Зупинити"; we return partial results. Checking once
        // per entry is effectively free.
        if cancel::is_cancelled("large_files") {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        scanned += 1;
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        if size < min_bytes {
            continue;
        }
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        files.push(LargeFile {
            path: entry.path().to_string_lossy().into_owned(),
            size_bytes: size,
            modified_secs,
        });
    }

    files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    files.truncate(limit);
    ScanSummary { scanned, files }
}

/// Directories that must never appear as a trash target. Any direct hit on
/// these, or an attempt to trash `/` or a bare mount point, is rejected.
/// Sub-paths are fine — e.g. we allow trashing files inside `/Applications`,
/// just not the entire `/Applications` directory itself.
const FORBIDDEN_EXACT: &[&str] = &[
    "/",
    "/Applications",
    "/System",
    "/Library",
    "/Users",
    "/Volumes",
    "/private",
    "/etc",
    "/bin",
    "/sbin",
    "/usr",
    "/var",
    "/tmp",
    "/dev",
    "/opt",
    "/Network",
];

/// Whitelist: a trash target must live inside one of these roots (or be a
/// direct member of $HOME). This keeps a buggy frontend from deleting
/// anything outside the user's blast radius. `$HOME` itself is excluded —
/// trashing your own home directory is never something we should allow.
fn is_safe_trash_target(path: &std::path::Path) -> bool {
    let home = match dirs_next::home_dir() {
        Some(h) => h,
        None => return false,
    };
    let canonical = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    if canonical == home {
        return false;
    }
    let allowed_roots: &[&std::path::Path] = &[
        &home,
        std::path::Path::new("/Applications"),
        std::path::Path::new("/Volumes"),
    ];
    allowed_roots
        .iter()
        .any(|root| canonical.starts_with(root))
}

/// Move a path to the macOS Trash via Finder AppleScript. Guards:
/// - refuses empty, absolute system roots, and `/` itself;
/// - requires the resolved path to live under `$HOME`, `/Applications`,
///   or a mounted volume — every legitimate Stash flow stays within
///   those;
/// - rejects `$HOME` (the whole home dir) as a target.
pub fn move_to_trash(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("refusing to trash empty path".into());
    }
    if FORBIDDEN_EXACT.contains(&path) {
        return Err(format!("refusing to trash system path: {path}"));
    }
    let pb = PathBuf::from(path);
    if !pb.exists() {
        return Err(format!("not found: {path}"));
    }
    if !is_safe_trash_target(&pb) {
        return Err(format!("path is outside the safe trash whitelist: {path}"));
    }
    // Escape embedded quotes so the AppleScript string literal stays valid.
    let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Finder\" to delete POSIX file \"{escaped}\""
    );
    let out = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scan_returns_files_above_threshold_sorted_desc() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("small.bin"), vec![0u8; 10]).unwrap();
        fs::write(tmp.path().join("medium.bin"), vec![0u8; 2048]).unwrap();
        fs::write(tmp.path().join("big.bin"), vec![0u8; 4096]).unwrap();

        let summary = scan(tmp.path(), 1024, 10);
        let names: Vec<_> = summary
            .files
            .iter()
            .map(|f| PathBuf::from(&f.path).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["big.bin", "medium.bin"]);
        assert_eq!(summary.scanned, 3);
    }

    #[test]
    fn scan_respects_limit() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(
                tmp.path().join(format!("f{i}.bin")),
                vec![0u8; 2048 + i as usize],
            )
            .unwrap();
        }
        let summary = scan(tmp.path(), 1024, 2);
        assert_eq!(summary.files.len(), 2);
        assert_eq!(summary.scanned, 5);
    }

    #[test]
    fn scan_skips_node_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let nm = tmp.path().join("node_modules");
        fs::create_dir_all(&nm).unwrap();
        fs::write(nm.join("junk.bin"), vec![0u8; 4096]).unwrap();
        fs::write(tmp.path().join("kept.bin"), vec![0u8; 4096]).unwrap();
        let summary = scan(tmp.path(), 1024, 10);
        assert_eq!(summary.files.len(), 1);
        assert!(summary.files[0].path.ends_with("kept.bin"));
    }

    #[test]
    fn move_to_trash_refuses_suspicious_paths() {
        assert!(move_to_trash("").is_err());
        assert!(move_to_trash("/").is_err());
        assert!(move_to_trash("/System").is_err());
        assert!(move_to_trash("/Applications").is_err());
        assert!(move_to_trash("/Library").is_err());
        // Non-existent path should also fail before any osascript attempt.
        assert!(move_to_trash("/nope/does/not/exist").is_err());
    }
}
