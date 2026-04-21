use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

use super::caches::dir_size;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Application {
    pub name: String,
    pub path: String,
    pub bundle_id: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Leftover {
    pub path: String,
    pub size_bytes: u64,
}

/// Invoke plutil to read `CFBundleIdentifier` from an app's Info.plist.
/// `plutil` ships on every macOS, which lets us keep Cargo deps unchanged.
fn read_bundle_id(app_path: &Path) -> Option<String> {
    let plist = app_path.join("Contents/Info.plist");
    if !plist.exists() {
        return None;
    }
    let out = Command::new("plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(&plist)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    json.get("CFBundleIdentifier")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Enumerate /Applications and ~/Applications, pulling name + bundle id +
/// approximate size (via `dir_size` — cheaper than du in a separate
/// process).
pub fn list_apps(home: &Path) -> Vec<Application> {
    let roots = [PathBuf::from("/Applications"), home.join("Applications")];
    // Collect candidates first — reading directory listings is cheap, the
    // expensive part (recursive size + plutil) runs in parallel below.
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    for root in roots.iter() {
        let entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.extension().and_then(|s| s.to_str()) != Some("app") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            candidates.push((name, path));
        }
    }

    // Each size walk + Info.plist read is IO-bound; measuring 100+ apps
    // serially is what used to make the uninstaller panel feel frozen for
    // the first few seconds. With a thread per app the wall time drops to
    // "slowest single app" (typically Xcode at ~300 ms).
    let mut out: Vec<Application> = std::thread::scope(|scope| {
        let handles: Vec<_> = candidates
            .into_iter()
            .map(|(name, path)| {
                scope.spawn(move || Application {
                    bundle_id: read_bundle_id(&path),
                    size_bytes: dir_size(&path),
                    path: path.to_string_lossy().into_owned(),
                    name,
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Directories where applications traditionally scatter state. Each gets
/// walked at depth 1 and anything whose basename contains the bundle id
/// (or name) is reported. We intentionally stick to user scope — nothing
/// under /Library, which would need root.
fn leftover_roots(home: &Path) -> Vec<PathBuf> {
    [
        "Library/Application Support",
        "Library/Caches",
        "Library/Preferences",
        "Library/Logs",
        "Library/Saved Application State",
        "Library/LaunchAgents",
        "Library/Containers",
        "Library/Group Containers",
        "Library/HTTPStorages",
        "Library/WebKit",
        "Library/Cookies",
    ]
    .iter()
    .map(|p| home.join(p))
    .collect()
}

/// Return true if `basename` looks like a leftover for the app identified
/// by (bundle_id, name). Prefers bundle-id matches because they're
/// globally unique (`com.example.Widget` never collides). Falls back to a
/// WORD-BOUNDARY name match to avoid catastrophic false positives — an app
/// called "Mail" must NOT match every file with "mail" in its name.
fn is_leftover_match(basename: &str, bundle_id: Option<&str>, app_name: &str) -> bool {
    let lc = basename.to_lowercase();
    if let Some(id) = bundle_id {
        let id_lc = id.to_lowercase();
        // Bundle ids are dot-separated and distinctive enough that substring
        // match is safe. "com.example.Widget" → matches anywhere.
        if lc.contains(&id_lc) {
            return true;
        }
    }
    // Name-only fallback requires the app name to be "meaningful":
    // - at least 4 chars OR the app's exact filename on disk;
    // - bounded by non-alphanumerics (so "Mail" doesn't match "mailbox.dat"
    //   but DOES match "Mail.plist" / "com.apple.Mail.plist").
    let name_lc = app_name.to_lowercase();
    if name_lc.len() < 4 {
        return false;
    }
    let is_boundary = |c: char| !c.is_alphanumeric();
    let mut idx = 0;
    while let Some(found) = lc[idx..].find(&name_lc) {
        let start = idx + found;
        let end = start + name_lc.len();
        let before_ok = start == 0 || lc[..start].chars().next_back().map(is_boundary).unwrap_or(true);
        let after_ok = end == lc.len() || lc[end..].chars().next().map(is_boundary).unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        idx = start + 1;
    }
    false
}

pub fn find_leftovers(home: &Path, bundle_id: Option<&str>, app_name: &str) -> Vec<Leftover> {
    let mut out: Vec<Leftover> = Vec::new();
    for root in leftover_roots(home) {
        // Depth 1 keeps the scan fast — leftovers live directly inside these
        // directories, not nested three levels deep.
        let walker = WalkDir::new(&root).min_depth(1).max_depth(1);
        for ent in walker.into_iter().flatten() {
            let path = ent.path();
            let base = match path.file_name().and_then(|s| s.to_str()) {
                Some(s) => s,
                None => continue,
            };
            if !is_leftover_match(base, bundle_id, app_name) {
                continue;
            }
            let size = if path.is_dir() { dir_size(path) } else {
                path.metadata().map(|m| m.len()).unwrap_or(0)
            };
            out.push(Leftover {
                path: path.to_string_lossy().into_owned(),
                size_bytes: size,
            });
        }
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn is_leftover_match_bundle_id_wins() {
        assert!(is_leftover_match(
            "com.example.widget.plist",
            Some("com.example.Widget"),
            "Widget",
        ));
    }

    #[test]
    fn is_leftover_match_name_requires_word_boundary() {
        // Regression for the `base.contains(&name_lc)` false positive bug:
        // app "Mail" should NOT match "mailbox", but should match "Mail.db",
        // "com.apple.mail.plist".
        assert!(!is_leftover_match("mailbox.dat", None, "Mail"));
        assert!(is_leftover_match("Mail.db", None, "Mail"));
        assert!(is_leftover_match("com.apple.mail.plist", None, "Mail"));
    }

    #[test]
    fn is_leftover_match_rejects_short_names_without_bundle_id() {
        // 2-3-char app names (e.g. "TV", "Mac") are too ambiguous without
        // a bundle id pin.
        assert!(!is_leftover_match("television.plist", None, "TV"));
    }

    #[test]
    fn find_leftovers_matches_bundle_id_and_name() {
        let tmp = tempfile::tempdir().unwrap();
        let asup = tmp.path().join("Library/Application Support");
        fs::create_dir_all(&asup).unwrap();
        fs::create_dir_all(asup.join("com.example.Widget")).unwrap();
        fs::write(asup.join("com.example.Widget/state"), vec![0u8; 2048]).unwrap();
        fs::create_dir_all(asup.join("Unrelated")).unwrap();

        let leftovers = find_leftovers(tmp.path(), Some("com.example.Widget"), "Widget");
        assert_eq!(leftovers.len(), 1);
        assert!(leftovers[0].path.ends_with("com.example.Widget"));
    }
}
