use crate::modules::clipboard::repo::ClipboardRepo;
use rusqlite::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct RgbaImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// One file entry inside the clipboard row's `meta` JSON for a
/// `kind = 'file'` item. Mirrors the frontend `FileMeta` shape in
/// `src/modules/clipboard/api.ts` (`parseFileMeta`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size: Option<u64>,
    pub mime: Option<String>,
}

pub trait ClipboardReader {
    fn read_text(&mut self) -> Option<String>;
    fn read_image(&mut self) -> Option<RgbaImage> {
        None
    }
    /// List of absolute filesystem paths currently on the pasteboard
    /// as `public.file-url`. Default impl returns empty so non-macOS
    /// readers and older tests don't need to care. Monitor checks files
    /// BEFORE image so a Finder-copied folder doesn't get stored as
    /// its drag-icon PNG.
    fn read_files(&mut self) -> Vec<PathBuf> {
        Vec::new()
    }
    /// Unfiltered "is there any `public.file-url` on the pasteboard?"
    /// probe. Separate from `read_files` because the latter applies
    /// the promise-ID + existence filter and can return empty even
    /// when a file-url IS there — the monitor uses this probe to
    /// skip the image-read path in that case (otherwise Finder's
    /// drag icon lands in the history as a fake screenshot).
    fn has_files(&mut self) -> bool {
        !self.read_files().is_empty()
    }
}

pub struct Monitor<R: ClipboardReader> {
    reader: R,
    last_text: Option<String>,
    last_image_hash: Option<String>,
    last_files_key: Option<String>,
    images_dir: Option<PathBuf>,
}

impl<R: ClipboardReader> Monitor<R> {
    #[allow(dead_code)]
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            last_text: None,
            last_image_hash: None,
            last_files_key: None,
            images_dir: None,
        }
    }

    pub fn with_images_dir(reader: R, dir: PathBuf) -> Self {
        Self {
            reader,
            last_text: None,
            last_image_hash: None,
            last_files_key: None,
            images_dir: Some(dir),
        }
    }

    pub fn poll_once(&mut self, repo: &mut ClipboardRepo, now: i64) -> Result<Option<i64>> {
        // Files go BEFORE image on purpose. When Finder copies a file
        // or folder, macOS seeds the pasteboard with both `public.file-url`
        // AND the drag icon as `public.tiff` — if we checked image first
        // we'd store the Finder icon PNG and mis-classify the clip as
        // an image. Checking files first and returning early when they
        // exist keeps folder/file copies as real file rows.
        // Pasteboard-source priority:
        //   1. Actionable files (`public.file-url` + the path passes
        //      the user-visible filter) → `kind='file'` row.
        //   2. Text → `kind='text'` row. Text runs regardless of
        //      whether file-urls are present, because browsers
        //      routinely co-seed `text/plain` with a `public.file-url`
        //      for their own drag source — and we want the user's
        //      copied URL to land as a normal text clip.
        //   3. Image → `kind='image'` row, but ONLY when no
        //      file-url is on the pasteboard. Finder folder copies
        //      write both a file-url AND a `public.tiff` drag icon;
        //      skipping the image in that case avoids the phantom
        //      `Image · 1024×1024` clip the user kept seeing.
        let has_files_on_pb = self.reader.has_files();
        let files = if has_files_on_pb {
            self.reader.read_files()
        } else {
            Vec::new()
        };
        if !files.is_empty() {
            let key = Self::files_key(&files);
            if self.last_files_key.as_deref() == Some(key.as_str()) {
                return Ok(None);
            }
            let entries = Self::file_entries(&files);
            if entries.is_empty() {
                self.last_files_key = Some(key);
                return Ok(None);
            }
            let meta = serde_json::to_string(&serde_json::json!({ "files": entries }))
                .unwrap_or_else(|_| "{\"files\":[]}".to_string());
            let id = repo.insert_files(&key, &meta, now)?;
            self.last_files_key = Some(key);
            self.last_image_hash = None;
            self.last_text = None;
            return Ok(Some(id));
        }
        if let Some(text) = self.reader.read_text() {
            let trimmed = text.trim();
            if !trimmed.is_empty() && self.last_text.as_deref() != Some(text.as_str()) {
                let id = repo.insert_text(&text, now)?;
                self.last_text = Some(text);
                self.last_image_hash = None;
                self.last_files_key = None;
                return Ok(Some(id));
            }
        }
        if has_files_on_pb {
            // A file-url is on the pasteboard but no path survived
            // the user-visible filter, AND there's no new text.
            // Whatever image is there is the Finder drag icon —
            // don't store it.
            return Ok(None);
        }
        if let Some(image) = self.reader.read_image() {
            let hash = Self::hash_image(&image);
            if self.last_image_hash.as_deref() == Some(hash.as_str()) {
                return Ok(None);
            }
            if let Some(dir) = &self.images_dir {
                let path = Self::save_png(&image, dir, &hash).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e)))
                })?;
                let meta = format!(
                    r#"{{"path":{},"w":{},"h":{}}}"#,
                    serde_json::to_string(&path.to_string_lossy().to_string()).unwrap_or_default(),
                    image.width,
                    image.height
                );
                let id = repo.insert_image(&hash, &meta, now)?;
                self.last_image_hash = Some(hash);
                self.last_files_key = None;
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// Stable deduplication key for a file selection. We hash the
    /// concatenated, newline-joined paths (order-preserving) so that
    /// copying the same set of files twice updates `created_at` rather
    /// than creating a duplicate row. Same shape as image hashing for
    /// consistency.
    fn files_key(paths: &[PathBuf]) -> String {
        let mut h = Sha256::new();
        h.update(b"files:");
        for p in paths {
            h.update(p.to_string_lossy().as_bytes());
            h.update(b"\n");
        }
        format!("files:{:x}", h.finalize())
    }

    /// Build per-file metadata without failing the whole clip when one
    /// path is inaccessible (permission denied, file gone): missing
    /// size/mime simply drop to null in the JSON. The name defaults to
    /// the path basename; the MIME is guessed from the extension — the
    /// frontend's `detectFileKind` is authoritative anyway.
    fn file_entries(paths: &[PathBuf]) -> Vec<FileEntry> {
        paths
            .iter()
            .map(|p| {
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| p.to_string_lossy().into_owned());
                let size = std::fs::metadata(p).ok().map(|m| m.len());
                let mime = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| guess_mime(&e.to_lowercase()));
                FileEntry {
                    path: p.to_string_lossy().into_owned(),
                    name,
                    size,
                    mime,
                }
            })
            .collect()
    }

    fn hash_image(image: &RgbaImage) -> String {
        let mut hasher = Sha256::new();
        hasher.update(image.width.to_le_bytes());
        hasher.update(image.height.to_le_bytes());
        hasher.update(&image.bytes);
        format!("{:x}", hasher.finalize())
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn test_files_key(paths: &[PathBuf]) -> String {
        Self::files_key(paths)
    }

    fn save_png(image: &RgbaImage, dir: &Path, hash: &str) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{hash}.png"));
        if !path.exists() {
            let buf = image::RgbaImage::from_raw(image.width, image.height, image.bytes.clone())
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad rgba"))?;
            buf.save(&path)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
        }
        Ok(path)
    }
}

#[cfg(target_os = "macos")]
pub struct ArboardReader {
    inner: arboard::Clipboard,
}

#[cfg(target_os = "macos")]
impl ArboardReader {
    pub fn new() -> Result<Self, arboard::Error> {
        Ok(Self {
            inner: arboard::Clipboard::new()?,
        })
    }
}

#[cfg(target_os = "macos")]
impl ClipboardReader for ArboardReader {
    fn read_text(&mut self) -> Option<String> {
        self.inner.get_text().ok()
    }
    fn read_files(&mut self) -> Vec<PathBuf> {
        super::pasteboard::read_file_urls()
    }
    fn has_files(&mut self) -> bool {
        super::pasteboard::has_file_urls()
    }
    fn read_image(&mut self) -> Option<RgbaImage> {
        let img = self.inner.get_image().ok()?;
        Some(RgbaImage {
            bytes: img.bytes.into_owned(),
            width: img.width as u32,
            height: img.height as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::clipboard::repo::ClipboardRepo;
    use rusqlite::Connection;

    struct FakeReader {
        text_queue: Vec<Option<String>>,
        image_queue: Vec<Option<RgbaImage>>,
        files_queue: Vec<Vec<PathBuf>>,
        /// Per-tick "does the pasteboard claim to hold any file-url?"
        /// answer, independent of whether `files_queue` has anything
        /// passing the user-visible filter. Separate because the
        /// monitor needs to know about promise-ID-only pasteboards
        /// so it can skip reading the Finder drag icon image.
        has_files_queue: Vec<bool>,
    }

    impl FakeReader {
        fn text_only(values: Vec<Option<&str>>) -> Self {
            Self {
                text_queue: values.into_iter().map(|v| v.map(str::to_string)).collect(),
                image_queue: vec![],
                files_queue: vec![],
                has_files_queue: vec![],
            }
        }
    }

    impl ClipboardReader for FakeReader {
        fn read_text(&mut self) -> Option<String> {
            if self.text_queue.is_empty() {
                None
            } else {
                self.text_queue.remove(0)
            }
        }
        fn read_image(&mut self) -> Option<RgbaImage> {
            if self.image_queue.is_empty() {
                None
            } else {
                self.image_queue.remove(0)
            }
        }
        fn read_files(&mut self) -> Vec<PathBuf> {
            if self.files_queue.is_empty() {
                Vec::new()
            } else {
                self.files_queue.remove(0)
            }
        }
        fn has_files(&mut self) -> bool {
            if self.has_files_queue.is_empty() {
                // Default: inferred from whether the next read_files
                // tick has anything. Matches production behaviour
                // closely enough for legacy test callers.
                self.files_queue.first().map_or(false, |f| !f.is_empty())
            } else {
                self.has_files_queue.remove(0)
            }
        }
    }

    fn setup() -> ClipboardRepo {
        ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn poll_on_empty_clipboard_inserts_nothing() {
        let mut repo = setup();
        let reader = FakeReader::text_only(vec![None]);
        let mut monitor = Monitor::new(reader);

        let inserted = monitor.poll_once(&mut repo, 100).unwrap();

        assert_eq!(inserted, None);
        assert_eq!(repo.list(10).unwrap().len(), 0);
    }

    #[test]
    fn poll_with_new_text_inserts_item() {
        let mut repo = setup();
        let reader = FakeReader::text_only(vec![Some("hello")]);
        let mut monitor = Monitor::new(reader);

        let id = monitor.poll_once(&mut repo, 100).unwrap();

        assert!(id.is_some());
        let items = repo.list(10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content, "hello");
    }

    #[test]
    fn consecutive_polls_with_same_text_insert_only_once() {
        let mut repo = setup();
        let reader = FakeReader::text_only(vec![Some("dup"), Some("dup"), Some("dup")]);
        let mut monitor = Monitor::new(reader);

        monitor.poll_once(&mut repo, 100).unwrap();
        let second = monitor.poll_once(&mut repo, 200).unwrap();
        let third = monitor.poll_once(&mut repo, 300).unwrap();

        assert_eq!(second, None);
        assert_eq!(third, None);
        let items = repo.list(10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].created_at, 100);
    }

    #[test]
    fn poll_after_content_changes_inserts_new_item() {
        let mut repo = setup();
        let reader = FakeReader::text_only(vec![Some("first"), Some("second")]);
        let mut monitor = Monitor::new(reader);

        monitor.poll_once(&mut repo, 100).unwrap();
        monitor.poll_once(&mut repo, 200).unwrap();

        let items = repo.list(10).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].content, "second");
    }

    #[test]
    fn whitespace_only_content_is_ignored() {
        let mut repo = setup();
        let reader = FakeReader::text_only(vec![Some("   \n\t  ")]);
        let mut monitor = Monitor::new(reader);

        let inserted = monitor.poll_once(&mut repo, 100).unwrap();

        assert_eq!(inserted, None);
        assert_eq!(repo.list(10).unwrap().len(), 0);
    }

    #[test]
    fn poll_saves_image_and_inserts_image_row() {
        let mut repo = setup();
        // 2x2 red RGBA
        let bytes = vec![
            255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
        ];
        let reader = FakeReader {
            text_queue: vec![None],
            image_queue: vec![Some(RgbaImage {
                bytes,
                width: 2,
                height: 2,
            })],
            files_queue: vec![],
            has_files_queue: vec![],
        };
        let tmp = std::env::temp_dir().join(format!("stash-test-{}", std::process::id()));
        let mut monitor = Monitor::with_images_dir(reader, tmp.clone());

        let id = monitor.poll_once(&mut repo, 100).unwrap().unwrap();

        let item = repo.get(id).unwrap().unwrap();
        assert_eq!(item.kind, "image");
        assert!(item.meta.as_deref().unwrap().contains(".png"));
        // cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- file-url handling ----

    #[test]
    fn poll_with_files_inserts_file_kind_and_records_paths() {
        let mut repo = setup();
        let reader = FakeReader {
            text_queue: vec![None],
            image_queue: vec![None],
            files_queue: vec![vec![
                PathBuf::from("/tmp/a.png"),
                PathBuf::from("/tmp/b.mp4"),
            ]],
            has_files_queue: vec![true],
        };
        let mut monitor = Monitor::new(reader);

        let id = monitor.poll_once(&mut repo, 500).unwrap().unwrap();

        let item = repo.get(id).unwrap().unwrap();
        assert_eq!(item.kind, "file");
        let meta = item.meta.as_deref().unwrap();
        assert!(meta.contains("\"/tmp/a.png\""));
        assert!(meta.contains("\"/tmp/b.mp4\""));
        assert!(meta.contains("\"name\":\"a.png\""));
        assert!(meta.contains("\"mime\":\"image/png\""));
    }

    #[test]
    fn files_take_priority_over_drag_icon_image() {
        // Finder copy seeds BOTH public.file-url AND public.tiff on the
        // pasteboard. Without the files-first check we'd save the icon
        // PNG and mis-classify the clip as an image.
        let mut repo = setup();
        let bytes = vec![
            255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
        ];
        let reader = FakeReader {
            text_queue: vec![None],
            image_queue: vec![Some(RgbaImage {
                bytes,
                width: 2,
                height: 2,
            })],
            files_queue: vec![vec![PathBuf::from("/tmp/finder-folder")]],
            has_files_queue: vec![true],
        };
        let tmp = std::env::temp_dir().join(format!("stash-test-priority-{}", std::process::id()));
        let mut monitor = Monitor::with_images_dir(reader, tmp.clone());

        let id = monitor.poll_once(&mut repo, 100).unwrap().unwrap();

        let item = repo.get(id).unwrap().unwrap();
        assert_eq!(
            item.kind, "file",
            "folder copy must store as file, not image"
        );
        assert_eq!(repo.list(10).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn same_file_selection_deduplicates_on_second_poll() {
        let mut repo = setup();
        let paths = vec![PathBuf::from("/tmp/a.txt")];
        let reader = FakeReader {
            text_queue: vec![None, None],
            image_queue: vec![None, None],
            files_queue: vec![paths.clone(), paths.clone()],
            has_files_queue: vec![true, true],
        };
        let mut monitor = Monitor::new(reader);

        let first = monitor.poll_once(&mut repo, 100).unwrap();
        let second = monitor.poll_once(&mut repo, 200).unwrap();

        assert!(first.is_some());
        assert_eq!(second, None, "identical file selection must not reinsert");
        assert_eq!(repo.list(10).unwrap().len(), 1);
    }

    #[test]
    fn different_file_selection_inserts_new_row() {
        let mut repo = setup();
        let reader = FakeReader {
            text_queue: vec![None, None],
            image_queue: vec![None, None],
            files_queue: vec![
                vec![PathBuf::from("/tmp/a.txt")],
                vec![PathBuf::from("/tmp/b.txt")],
            ],
            has_files_queue: vec![true, true],
        };
        let mut monitor = Monitor::new(reader);

        monitor.poll_once(&mut repo, 100).unwrap();
        monitor.poll_once(&mut repo, 200).unwrap();

        assert_eq!(repo.list(10).unwrap().len(), 2);
    }

    #[test]
    fn pasteboard_with_file_urls_skips_image_read_even_when_filter_rejects_all_paths() {
        // The exact scenario from the `Image · 1024×1024` bug: Finder
        // put BOTH a file-url and its drag icon on the pasteboard,
        // but `read_files()` returned empty (say the path got
        // filtered out for some reason). Monitor must not fall
        // through and store the icon as a standalone screenshot.
        let mut repo = setup();
        let bytes = vec![1u8; 16]; // 2×2 RGBA
        let reader = FakeReader {
            text_queue: vec![None],
            image_queue: vec![Some(RgbaImage {
                bytes,
                width: 2,
                height: 2,
            })],
            files_queue: vec![vec![]],   // filter stripped every path
            has_files_queue: vec![true], // …but the pb still has file-urls
        };
        let tmp = std::env::temp_dir().join(format!("stash-test-filter-{}", std::process::id()));
        let mut monitor = Monitor::with_images_dir(reader, tmp.clone());

        let result = monitor.poll_once(&mut repo, 100).unwrap();

        assert_eq!(result, None, "must not insert the Finder drag icon");
        assert_eq!(repo.list(10).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn text_still_captured_when_pasteboard_has_both_text_and_file_url() {
        // Browsers dragging a link commonly seed BOTH `text/plain`
        // and `public.file-url`. The user expects the URL to land
        // as a normal text clip — we must not let the file-url
        // presence swallow the text tick.
        let mut repo = setup();
        let reader = FakeReader {
            text_queue: vec![Some("https://example.com/page".to_string())],
            image_queue: vec![None],
            files_queue: vec![vec![]], // filter stripped all (promise-id)
            has_files_queue: vec![true],
        };
        let mut monitor = Monitor::new(reader);

        let id = monitor.poll_once(&mut repo, 100).unwrap().unwrap();

        let item = repo.get(id).unwrap().unwrap();
        assert_eq!(item.kind, "text");
        assert_eq!(item.content, "https://example.com/page");
    }

    #[test]
    fn files_key_is_deterministic_and_order_sensitive() {
        let a = Monitor::<FakeReader>::test_files_key(&[PathBuf::from("/a"), PathBuf::from("/b")]);
        let b = Monitor::<FakeReader>::test_files_key(&[PathBuf::from("/a"), PathBuf::from("/b")]);
        let reversed =
            Monitor::<FakeReader>::test_files_key(&[PathBuf::from("/b"), PathBuf::from("/a")]);
        assert_eq!(a, b);
        assert_ne!(a, reversed, "order difference must produce a different key");
        assert!(a.starts_with("files:"));
    }

    #[test]
    fn guess_mime_covers_common_extensions() {
        assert_eq!(guess_mime("png"), "image/png");
        assert_eq!(guess_mime("jpg"), "image/jpeg");
        assert_eq!(guess_mime("mp4"), "video/mp4");
        assert_eq!(guess_mime("mp3"), "audio/mpeg");
        assert_eq!(guess_mime("json"), "application/json");
        assert_eq!(guess_mime("tsx"), "application/typescript");
        assert_eq!(guess_mime("unknown-ext-xyz"), "application/octet-stream");
    }
}

/// Extension → MIME lookup for file-clip metadata. Intentionally small
/// and opinionated: the frontend's `detectFileKind` is authoritative
/// for rendering, so this just needs to give downstream consumers
/// (drag-out, export, AI context) a sensible content-type header.
pub fn guess_mime(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "json" => "application/json",
        "js" | "mjs" | "cjs" => "application/javascript",
        "jsx" => "application/javascript",
        "ts" | "tsx" => "application/typescript",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "md" | "markdown" | "mdx" => "text/markdown",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "yaml" | "yml" => "application/x-yaml",
        "sh" | "bash" | "zsh" => "application/x-sh",
        _ => "application/octet-stream",
    }
    .to_string()
}
