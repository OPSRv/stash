use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CacheEntry {
    /// Human label shown in the UI ("Xcode DerivedData", "npm cache", …).
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    pub kind: CacheKind,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CacheKind {
    /// Safe to delete — pure cache directory, applications regenerate it.
    Safe,
    /// Regeneratable but deleting may cost minutes of rebuild (e.g. Xcode
    /// DerivedData forces a full project rebuild next compile).
    Regeneratable,
    /// Browser storage — might contain Service Workers / session data.
    /// We only surface the actual cache subfolders, never cookies/localStorage.
    Browser,
}

/// Walk a single directory counting bytes. Skips permission errors silently
/// so partial reads don't abort the whole aggregate.
pub fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Queue a candidate for parallel sizing. We collect every path first, then
/// size them in parallel threads — measuring 13 cache dirs serially can take
/// a noticeable fraction of a second on a busy disk.
fn maybe_queue(
    queue: &mut Vec<(String, PathBuf, CacheKind)>,
    label: &str,
    path: PathBuf,
    kind: CacheKind,
) {
    if path.is_dir() {
        queue.push((label.to_string(), path, kind));
    }
}

/// Curated list of user-scope caches worth surfacing. We deliberately do
/// NOT walk `~/Library/Caches/*` and list every bundle-id — the long tail
/// is noisy and some of those dirs contain data apps depend on between
/// launches. Instead we hand-pick the top offenders.
pub fn list_caches(home: &Path) -> Vec<CacheEntry> {
    let mut queue: Vec<(String, PathBuf, CacheKind)> = Vec::new();

    // Dev tooling — these regenerate on next build/install.
    maybe_queue(&mut queue, "Xcode DerivedData", home.join("Library/Developer/Xcode/DerivedData"), CacheKind::Regeneratable);
    maybe_queue(&mut queue, "Xcode iOS DeviceSupport", home.join("Library/Developer/Xcode/iOS DeviceSupport"), CacheKind::Regeneratable);
    maybe_queue(&mut queue, "Xcode Archives", home.join("Library/Developer/Xcode/Archives"), CacheKind::Regeneratable);
    maybe_queue(&mut queue, "npm cache", home.join(".npm"), CacheKind::Safe);
    maybe_queue(&mut queue, "pnpm store", home.join("Library/pnpm/store"), CacheKind::Safe);
    maybe_queue(&mut queue, "Yarn cache", home.join("Library/Caches/Yarn"), CacheKind::Safe);
    maybe_queue(&mut queue, "Cargo registry cache", home.join(".cargo/registry/cache"), CacheKind::Safe);
    maybe_queue(&mut queue, "Gradle caches", home.join(".gradle/caches"), CacheKind::Regeneratable);

    // Browsers — only the Cache sub-directories, never cookies/storage.
    maybe_queue(&mut queue, "Chrome cache", home.join("Library/Caches/Google/Chrome"), CacheKind::Browser);
    maybe_queue(&mut queue, "Safari cache", home.join("Library/Caches/com.apple.Safari"), CacheKind::Browser);
    maybe_queue(&mut queue, "Firefox cache", home.join("Library/Caches/Firefox"), CacheKind::Browser);
    maybe_queue(&mut queue, "Arc cache", home.join("Library/Caches/Arc"), CacheKind::Browser);

    // General system caches (safe).
    maybe_queue(&mut queue, "QuickLook thumbnails", home.join("Library/Caches/com.apple.QuickLook.thumbnailcache"), CacheKind::Safe);

    // Size each cache in its own thread. 13 parallel walks on SSD take
    // the same wall time as the single slowest one (Xcode DerivedData),
    // instead of a sum of all 13.
    let out: Vec<CacheEntry> = std::thread::scope(|scope| {
        let handles: Vec<_> = queue
            .into_iter()
            .map(|(label, path, kind)| {
                scope.spawn(move || {
                    let size = dir_size(&path);
                    if size == 0 {
                        None
                    } else {
                        Some(CacheEntry {
                            label,
                            path: path.to_string_lossy().into_owned(),
                            size_bytes: size,
                            kind,
                        })
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok().flatten())
            .collect()
    });

    let mut out = out;
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dir_size_sums_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a"), vec![0u8; 1024]).unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/b"), vec![0u8; 2048]).unwrap();
        assert_eq!(dir_size(tmp.path()), 3072);
    }

    #[test]
    fn list_caches_finds_seeded_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let npm = tmp.path().join(".npm");
        fs::create_dir_all(&npm).unwrap();
        fs::write(npm.join("pack.tgz"), vec![0u8; 4096]).unwrap();

        let list = list_caches(tmp.path());
        assert!(list.iter().any(|c| c.label == "npm cache" && c.size_bytes == 4096));
    }

    #[test]
    fn list_caches_ignores_empty_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".npm")).unwrap();
        let list = list_caches(tmp.path());
        assert!(list.iter().all(|c| c.label != "npm cache"));
    }
}
