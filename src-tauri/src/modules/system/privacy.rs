use super::caches::dir_size;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PrivacyItem {
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    /// Short category for the UI pill.
    pub category: String,
}

fn push_if_exists(out: &mut Vec<PrivacyItem>, label: &str, path: PathBuf, category: &str) {
    if path.is_file() {
        if let Ok(meta) = path.metadata() {
            if meta.len() > 0 {
                out.push(PrivacyItem {
                    label: label.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    size_bytes: meta.len(),
                    category: category.to_string(),
                });
            }
        }
        return;
    }
    if path.is_dir() {
        let size = dir_size(&path);
        if size > 0 {
            out.push(PrivacyItem {
                label: label.to_string(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: size,
                category: category.to_string(),
            });
        }
    }
}

/// Curated "usage traces" worth surfacing. We DO surface browser history
/// files, but with a clear category pill — deleting them logs the user out
/// of sites only if they trash cookies separately, which we don't touch.
pub fn list_privacy(home: &Path) -> Vec<PrivacyItem> {
    let mut out = Vec::new();

    // Browsers — history only.
    push_if_exists(
        &mut out,
        "Safari history",
        home.join("Library/Safari/History.db"),
        "browser",
    );
    push_if_exists(
        &mut out,
        "Chrome history",
        home.join("Library/Application Support/Google/Chrome/Default/History"),
        "browser",
    );
    push_if_exists(
        &mut out,
        "Firefox profiles",
        home.join("Library/Application Support/Firefox/Profiles"),
        "browser",
    );
    push_if_exists(
        &mut out,
        "Arc history",
        home.join("Library/Application Support/Arc/User Data/Default/History"),
        "browser",
    );

    // Recent items / Quick Look thumbs. Note: we DELIBERATELY do NOT
    // surface `com.apple.finder.plist` or `.../com.apple.sharedfilelist`
    // as privacy targets — those plists hold the user's Dock layout,
    // Finder preferences, and sidebar favourites. Trashing them wipes
    // settings, not just "traces". The QuickLook thumbnail cache IS safe
    // to trash (macOS regenerates it on demand).
    push_if_exists(
        &mut out,
        "QuickLook thumbnails",
        home.join("Library/Caches/com.apple.QuickLook.thumbnailcache"),
        "system",
    );

    // Terminal history.
    push_if_exists(
        &mut out,
        "Shell history (zsh)",
        home.join(".zsh_history"),
        "terminal",
    );
    push_if_exists(
        &mut out,
        "Shell history (bash)",
        home.join(".bash_history"),
        "terminal",
    );

    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn list_privacy_picks_up_zsh_history() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(".zsh_history"), b"ls -la\n").unwrap();
        let list = list_privacy(tmp.path());
        assert!(list.iter().any(|i| i.label == "Shell history (zsh)"));
    }

    #[test]
    fn list_privacy_never_surfaces_finder_preferences() {
        // Regression: we used to offer `com.apple.finder.plist` and
        // `com.apple.sharedfilelist` as "privacy traces", but those hold
        // the user's Dock layout and Finder settings. Trashing them wipes
        // preferences, not just traces — so they must stay off the list
        // no matter how big they are.
        let tmp = tempfile::tempdir().unwrap();
        let prefs = tmp.path().join("Library/Preferences");
        let asup = tmp.path().join("Library/Application Support");
        fs::create_dir_all(&prefs).unwrap();
        fs::create_dir_all(&asup).unwrap();
        fs::write(prefs.join("com.apple.finder.plist"), vec![0u8; 2048]).unwrap();
        fs::create_dir_all(asup.join("com.apple.sharedfilelist")).unwrap();
        fs::write(
            asup.join("com.apple.sharedfilelist/foo.sfl"),
            vec![0u8; 1024],
        )
        .unwrap();
        let list = list_privacy(tmp.path());
        assert!(
            list.iter().all(|i| !i.path.ends_with("com.apple.finder.plist")
                && !i.path.contains("sharedfilelist")),
            "privacy list must not surface Finder preferences, got: {:?}",
            list.iter().map(|i| &i.path).collect::<Vec<_>>()
        );
    }
}
