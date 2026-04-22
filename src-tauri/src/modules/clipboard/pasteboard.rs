//! Direct NSPasteboard access for the clipboard module.
//!
//! Arboard (our existing clipboard crate) exposes only text + image. It
//! has no notion of `public.file-url`, which is the pasteboard type
//! Finder uses when the user copies one or more files or folders. Without
//! this module the monitor falls through to `read_image()`, which on
//! macOS returns the *drag icon* for the copied item — the user ends up
//! with a Finder-icon PNG in their clipboard history instead of the
//! actual file they copied.
//!
//! This module exposes one primary:
//!   - [`read_file_urls`] — returns every `public.file-url` entry on the
//!     general pasteboard as a `Vec<PathBuf>`. An empty vec means either
//!     "no files" or an OS failure — callers treat both the same way.
//!
//! Non-macOS builds get a stub that always returns empty so the rest of
//! the clipboard module stays portable (Linux/Windows builds are not
//! in scope today but compiling them is still useful for CI).

use std::path::PathBuf;

/// Collect every `public.file-url` entry currently on the pasteboard.
/// Ordering follows `pasteboardItems` (i.e. the order Finder placed the
/// files on the pasteboard). Returns an empty vec if the pasteboard
/// holds no files or on any AppKit failure.
///
/// Only paths that survive `is_user_visible_path` end up in the result
/// — WebKit drag-and-drop, browsers, Figma etc. often write synthetic
/// `file://…/id=123.456` "promise" URLs that don't point at real files
/// the user copied. Without this filter the clipboard history fills
/// with `id=6571367.14836106`-style entries the user has no way to
/// interact with.
#[cfg(target_os = "macos")]
pub fn read_file_urls() -> Vec<PathBuf> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSString;

    // `NSPasteboard.general` is thread-safe per Apple's docs — the
    // monitor polls off-main-thread and we rely on that here.
    let pb = NSPasteboard::generalPasteboard();
    let Some(items) = pb.pasteboardItems() else {
        return Vec::new();
    };

    let ftype: &NSString = unsafe { NSPasteboardTypeFileURL };
    let mut out = Vec::new();
    for item in items.iter() {
        let Some(raw) = item.stringForType(ftype) else {
            continue;
        };
        let Some(path) = file_url_to_path(&raw.to_string()) else {
            continue;
        };
        if is_user_visible_path(&path) {
            out.push(path);
        }
    }
    out
}

/// Heuristic: does this path point at something the user would
/// recognise as "a file I copied"? Filters out three common sources
/// of junk file-url entries that aren't actionable:
///
///   1. Paths that don't exist on disk (WebKit promise drops — the
///      browser advertises a file URL it never actually materialises).
///   2. Basenames that look like opaque promise IDs (`id=123.456`,
///      `Promise-123`, etc.) — even if the file briefly exists, the
///      name is useless to the user.
///   3. Paths inside well-known browser WebKit drop caches — those are
///      transient and vanish within seconds of the copy.
///
/// Keep this list conservative: a false positive here deletes a
/// legitimate clip, while a false negative just lets a slightly-ugly
/// entry through. Finder copies always pass.
pub fn is_user_visible_path(path: &std::path::Path) -> bool {
    // (1) must exist on disk
    if !path.exists() {
        return false;
    }
    // (2) basename cannot look like a promise ID
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name.is_empty() || looks_like_promise_id(name) {
        return false;
    }
    // (3) avoid known WebKit / app-sandbox drag-drop scratch dirs
    let s = path.to_string_lossy();
    const SCRATCH_MARKERS: &[&str] = &[
        "/WebKit Drop/",
        "/WebKitDrag",
        "/.WebKitDropDestination",
        "/com.apple.WebKit.Drag",
        "/DerivedData/",
    ];
    if SCRATCH_MARKERS.iter().any(|m| s.contains(m)) {
        return false;
    }
    true
}

/// Pattern check for "this looks like a dragged-promise ID rather than
/// a real filename". Matches the shapes Stash has seen in the wild:
///   - `id=6571367.14836106`      (WebKit drag promise)
///   - `id=6571367`               (bare numeric variant)
///   - `Promise-123abc`           (some Electron apps)
///   - `\d+\.\d+` with no extension (purely numeric with a decimal)
fn looks_like_promise_id(name: &str) -> bool {
    if name.starts_with("id=") {
        return true;
    }
    if let Some(rest) = name.strip_prefix("Promise-") {
        if rest.chars().all(|c| c.is_ascii_alphanumeric()) {
            return true;
        }
    }
    // Pure number[.number] with no extension / alpha chars — very
    // unlikely to be a user file, very likely to be a timestamp ID.
    if !name.contains('.') {
        return name.chars().all(|c| c.is_ascii_digit()) && !name.is_empty();
    }
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() == 2
        && !parts[0].is_empty()
        && !parts[1].is_empty()
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
    {
        return true;
    }
    false
}

#[cfg(not(target_os = "macos"))]
pub fn read_file_urls() -> Vec<PathBuf> {
    Vec::new()
}

/// Cheap "does the pasteboard claim to hold any file-urls at all?"
/// check. Unlike [`read_file_urls`] this does NOT run the
/// user-visible-path filter — it answers the literal question
/// "is there at least one `public.file-url` entry on the general
/// pasteboard right now?". The monitor uses this to decide whether
/// to skip the image-read path: when the user copies a folder from
/// Finder, macOS seeds the pasteboard with BOTH a file-url AND a
/// TIFF-encoded drag icon, and we must not store that drag icon as
/// a standalone image clip even if the file-url happens to be a
/// promise-ID that our filter rejects.
#[cfg(target_os = "macos")]
pub fn has_file_urls() -> bool {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSString;
    let pb = NSPasteboard::generalPasteboard();
    let Some(items) = pb.pasteboardItems() else { return false };
    let ftype: &NSString = unsafe { NSPasteboardTypeFileURL };
    for item in items.iter() {
        if item.stringForType(ftype).is_some() {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
pub fn has_file_urls() -> bool {
    false
}

/// Replace the general pasteboard contents with the given file URLs.
/// After this returns Ok, ⌘V in Finder (or any app that accepts file
/// copies) will paste real files, not a text list. We `clearContents`
/// first so stale text/image types from the previous clip don't leak
/// through — otherwise Finder sees both and may choose the wrong
/// representation.
///
/// Empty paths is a caller bug — we return Err rather than silently
/// nuking the pasteboard.
#[cfg(target_os = "macos")]
pub fn write_file_urls(paths: &[PathBuf]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    if paths.is_empty() {
        return Err("write_file_urls called with empty path list".into());
    }

    let mut urls: Vec<Retained<NSURL>> = Vec::with_capacity(paths.len());
    for p in paths {
        let ns = NSString::from_str(&p.to_string_lossy());
        // `fileURLWithPath:` never returns nil for a valid NSString, but
        // the objc2 binding models it as Option for safety.
        let url = NSURL::fileURLWithPath(&ns);
        urls.push(url);
    }
    if urls.is_empty() {
        return Err("no paths could be converted to NSURL".into());
    }

    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();

    // `writeObjects:` takes an NSArray of objects conforming to
    // NSPasteboardWriting. NSURL conforms; wrap each as a
    // ProtocolObject so the compile-time protocol check succeeds.
    let protos: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = urls
        .into_iter()
        .map(|u| ProtocolObject::from_retained(u))
        .collect();
    let arr: Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>> =
        NSArray::from_retained_slice(&protos);

    let ok = pb.writeObjects(&arr);
    if ok {
        Ok(())
    } else {
        Err("NSPasteboard.writeObjects returned false".into())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn write_file_urls(_paths: &[PathBuf]) -> Result<(), String> {
    Err("write_file_urls is macOS-only".into())
}

/// Decode a `file://…` URL into a filesystem path. Handles the usual
/// percent-encoding (spaces, Unicode) via the `url` crate. Returns None
/// for any scheme other than `file:` — other schemes are someone else's
/// concern.
pub fn file_url_to_path(raw: &str) -> Option<PathBuf> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    parsed.to_file_path().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_simple_file_url() {
        let p = file_url_to_path("file:///Users/alice/Notes.md").unwrap();
        assert_eq!(p, PathBuf::from("/Users/alice/Notes.md"));
    }

    #[test]
    fn decodes_percent_encoded_spaces_and_unicode() {
        let p = file_url_to_path("file:///Users/alice/My%20Files/%C3%A4.txt").unwrap();
        assert_eq!(p, PathBuf::from("/Users/alice/My Files/ä.txt"));
    }

    #[test]
    fn rejects_non_file_schemes() {
        assert!(file_url_to_path("https://example.com/foo").is_none());
        assert!(file_url_to_path("mailto:a@b").is_none());
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(file_url_to_path("not a url").is_none());
        assert!(file_url_to_path("").is_none());
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let p = file_url_to_path("  file:///etc/hosts  \n").unwrap();
        assert_eq!(p, PathBuf::from("/etc/hosts"));
    }

    // ---- promise-ID filtering ----

    #[test]
    fn promise_id_detector_catches_common_shapes() {
        assert!(looks_like_promise_id("id=6571367.14836106"));
        assert!(looks_like_promise_id("id=6571367"));
        assert!(looks_like_promise_id("Promise-abc123"));
        assert!(looks_like_promise_id("1234567"));
        assert!(looks_like_promise_id("6571367.14836106"));
    }

    #[test]
    fn promise_id_detector_allows_real_filenames() {
        assert!(!looks_like_promise_id("photo.jpg"));
        assert!(!looks_like_promise_id("report.pdf"));
        assert!(!looks_like_promise_id("src/App.tsx"));
        assert!(!looks_like_promise_id("Notes 2025.md"));
        // numeric-only but with a real extension is fine — user might
        // be copying an exported `20250102.csv` from a spreadsheet.
        assert!(!looks_like_promise_id("20250102.csv"));
    }

    #[test]
    fn user_visible_path_rejects_nonexistent_files() {
        let junk = PathBuf::from("/var/tmp/definitely-not-a-real-file-xyz");
        assert!(!is_user_visible_path(&junk));
    }

    #[test]
    fn user_visible_path_accepts_a_real_existing_file() {
        // `/etc/hosts` exists on every macOS install and has a real name
        assert!(is_user_visible_path(std::path::Path::new("/etc/hosts")));
    }
}
