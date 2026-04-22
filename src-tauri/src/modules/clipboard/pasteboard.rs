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
        if let Some(path) = file_url_to_path(&raw.to_string()) {
            out.push(path);
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
pub fn read_file_urls() -> Vec<PathBuf> {
    Vec::new()
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
}
