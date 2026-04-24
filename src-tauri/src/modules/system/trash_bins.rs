use super::caches::dir_size;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrashBin {
    pub path: String,
    pub volume: String,
    pub size_bytes: u64,
    pub item_count: u64,
}

fn count_items_fs(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .map(|it| it.filter_map(Result::ok).count() as u64)
        .unwrap_or(0)
}

/// macOS TCC blocks direct `readdir`/`stat` on `~/.Trash` unless the app
/// has Full Disk Access. Finder, however, always has access — so we ask
/// it through a single AppleScript that returns both count and the sum of
/// `physical size` over every item. We sum ourselves because
/// `size of the trash` silently returns 0 on modern macOS (Sonoma+) if
/// Finder hasn't pre-computed it, which is exactly what we saw in the
/// "0 B · 11 items" report.
fn finder_trash_stats() -> (u64, u64) {
    // `physical size` is Finder's disk-block count; it's what iTunes / Get
    // Info shows but it's *reference-only* for items-of-trash on modern
    // macOS (Finder throws "Can't get physical size of item" for some
    // types — folders most notably). Falling back to `size` (logical
    // bytes) is almost always populated since it comes straight out of
    // the stat struct Finder already holds. We also cast lazily (no
    // `as integer`) — large files overflow AppleScript's small-integer
    // implicit conversion and throw otherwise.
    let script = r#"tell application "Finder"
  set n to count of items in trash
  set s to 0
  try
    repeat with i in (get items of trash)
      try
        set s to s + (size of i)
      on error
        try
          set s to s + (physical size of i)
        end try
      end try
    end repeat
  end try
  return (n as text) & "|" & (s as text)
end tell"#;
    let out = match Command::new("osascript").args(["-e", script]).output() {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let mut parts = s.trim().splitn(2, '|');
    let count = parts
        .next()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    // AppleScript formats large integers in scientific notation, and
    // (crucially) localises the output: a Ukrainian-locale Mac returns
    // `2,632136114Е+9` — Cyrillic "Е", comma as decimal separator. The
    // Rust `f64` parser understands neither, so both would silently
    // become 0. We normalise before parsing.
    let size = parts
        .next()
        .and_then(|v| {
            let t = v.trim().replace(',', ".").replace('Е', "E"); // U+0415 Cyrillic Ie → U+0045 Latin E
            t.parse::<u64>()
                .or_else(|_| t.parse::<f64>().map(|f| f as u64))
                .ok()
        })
        .unwrap_or(0);
    (count, size)
}

pub fn list_bins(home: &Path) -> Vec<TrashBin> {
    let mut out = Vec::new();
    let user_trash = home.join(".Trash");
    // Always surface the user trash entry even when TCC blocks us from
    // measuring it — the alternative (hiding it entirely) left the panel
    // blank on first run. We try FS first (cheap, no osascript cost when
    // the user has granted FDA), and fall back to Finder for the TCC case.
    let (user_count_fs, user_size_fs) = (count_items_fs(&user_trash), dir_size(&user_trash));
    let (user_count, user_size) = if user_count_fs == 0 && user_size_fs == 0 {
        finder_trash_stats()
    } else {
        (user_count_fs, user_size_fs)
    };
    out.push(TrashBin {
        path: user_trash.to_string_lossy().into_owned(),
        volume: "Macintosh HD".into(),
        size_bytes: user_size,
        item_count: user_count,
    });

    // External volumes keep per-user trashes at /Volumes/<Vol>/.Trashes/<uid>.
    // On APFS the boot container exposes *three* aliases in /Volumes — the
    // System volume symlink (`Macintosh HD -> /`), the firmlinked Data
    // volume (`Macintosh HD - Data`), and real external mounts. We dedupe:
    //
    //   1. Skip symlinks — that drops `Macintosh HD -> /`.
    //   2. Skip any volume whose name ends with " - Data" — that's the
    //      APFS firmlinked Data-volume convention, fixed since Catalina.
    //      Trying to match it via `stat().dev()` doesn't work because
    //      APFS firmlinks deliberately report the SYSTEM volume's dev on
    //      firmlinked paths, while the standalone mount reports the Data
    //      volume's dev — the two never compare equal.
    //
    // The only false negative is a user-created external APFS volume whose
    // name literally ends in " - Data" — exceedingly rare, and trashing
    // its contents would still match the user's intent anyway.
    let uid = unsafe { libc::getuid() };
    if let Ok(volumes) = std::fs::read_dir("/Volumes") {
        for vol in volumes.flatten() {
            let vol_path = vol.path();
            if std::fs::symlink_metadata(&vol_path)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            let volume = vol.file_name().to_string_lossy().into_owned();
            if volume.ends_with(" - Data") {
                continue;
            }
            let vol_trash: PathBuf = vol_path.join(".Trashes").join(uid.to_string());
            if !vol_trash.is_dir() {
                continue;
            }
            out.push(TrashBin {
                path: vol_trash.to_string_lossy().into_owned(),
                volume,
                size_bytes: dir_size(&vol_trash),
                item_count: count_items_fs(&vol_trash),
            });
        }
    }
    out
}

/// Ask Finder to empty the trash. We don't rm -rf the directory ourselves
/// because Finder performs cross-volume coordination and fires the "trash
/// emptied" notification that other apps observe.
pub fn empty_all() -> Result<(), String> {
    let out = Command::new("osascript")
        .args(["-e", "tell application \"Finder\" to empty trash"])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn list_bins_finds_user_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path().join(".Trash");
        fs::create_dir_all(&t).unwrap();
        fs::write(t.join("a"), vec![0u8; 2048]).unwrap();
        let bins = list_bins(tmp.path());
        assert!(bins
            .iter()
            .any(|b| b.size_bytes >= 2048 && b.item_count >= 1));
    }

    fn normalize_and_parse(s: &str) -> Option<u64> {
        let t = s.trim().replace(',', ".").replace('Е', "E");
        t.parse::<u64>()
            .or_else(|_| t.parse::<f64>().map(|f| f as u64))
            .ok()
    }

    #[test]
    fn applescript_size_parser_handles_ukrainian_locale() {
        // Regression: Ukrainian-locale macOS emits `2,632136114Е+9` from
        // `return size as text` — Cyrillic Е, comma decimal — and the
        // standard f64 parser silently returned 0.
        assert_eq!(normalize_and_parse("2,632136114Е+9"), Some(2_632_136_114));
        assert_eq!(normalize_and_parse("1234567"), Some(1234567));
        assert_eq!(normalize_and_parse("1.5E+6"), Some(1_500_000));
    }

    #[test]
    fn list_bins_always_includes_user_trash_entry() {
        // Regression for "кошик не показується": when TCC denies FS access
        // to ~/.Trash on real macOS, we still surface the row (size 0)
        // rather than hiding the bin entirely, so the user at least sees
        // that the trash panel is working.
        let tmp = tempfile::tempdir().unwrap();
        // No .Trash created → FS path returns 0/0, Finder call in test env
        // also fails (sandboxed), and we expect the row anyway.
        let bins = list_bins(tmp.path());
        assert!(bins.iter().any(|b| b.path.ends_with(".Trash")));
    }
}
