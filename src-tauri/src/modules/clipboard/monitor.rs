use crate::modules::clipboard::repo::ClipboardRepo;
use rusqlite::Result;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct RgbaImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub trait ClipboardReader {
    fn read_text(&mut self) -> Option<String>;
    fn read_image(&mut self) -> Option<RgbaImage> {
        None
    }
}

pub struct Monitor<R: ClipboardReader> {
    reader: R,
    last_text: Option<String>,
    last_image_hash: Option<String>,
    images_dir: Option<PathBuf>,
}

impl<R: ClipboardReader> Monitor<R> {
    #[allow(dead_code)]
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            last_text: None,
            last_image_hash: None,
            images_dir: None,
        }
    }

    pub fn with_images_dir(reader: R, dir: PathBuf) -> Self {
        Self {
            reader,
            last_text: None,
            last_image_hash: None,
            images_dir: Some(dir),
        }
    }

    pub fn poll_once(&mut self, repo: &mut ClipboardRepo, now: i64) -> Result<Option<i64>> {
        if let Some(text) = self.reader.read_text() {
            let trimmed = text.trim();
            if !trimmed.is_empty() && self.last_text.as_deref() != Some(text.as_str()) {
                let id = repo.insert_text(&text, now)?;
                self.last_text = Some(text);
                self.last_image_hash = None;
                return Ok(Some(id));
            }
        }
        if let Some(image) = self.reader.read_image() {
            let hash = Self::hash_image(&image);
            if self.last_image_hash.as_deref() == Some(hash.as_str()) {
                return Ok(None);
            }
            if let Some(dir) = &self.images_dir {
                let path = Self::save_png(&image, dir, &hash).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        e,
                    )))
                })?;
                let meta = format!(
                    r#"{{"path":{},"w":{},"h":{}}}"#,
                    serde_json::to_string(&path.to_string_lossy().to_string()).unwrap_or_default(),
                    image.width,
                    image.height
                );
                let id = repo.insert_image(&hash, &meta, now)?;
                self.last_image_hash = Some(hash);
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    fn hash_image(image: &RgbaImage) -> String {
        let mut hasher = Sha256::new();
        hasher.update(image.width.to_le_bytes());
        hasher.update(image.height.to_le_bytes());
        hasher.update(&image.bytes);
        format!("{:x}", hasher.finalize())
    }

    fn save_png(image: &RgbaImage, dir: &Path, hash: &str) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{hash}.png"));
        if !path.exists() {
            let buf = image::RgbaImage::from_raw(image.width, image.height, image.bytes.clone())
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad rgba"))?;
            buf.save(&path)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
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
    }

    impl FakeReader {
        fn text_only(values: Vec<Option<&str>>) -> Self {
            Self {
                text_queue: values.into_iter().map(|v| v.map(str::to_string)).collect(),
                image_queue: vec![],
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
        let bytes = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];
        let reader = FakeReader {
            text_queue: vec![None],
            image_queue: vec![Some(RgbaImage { bytes, width: 2, height: 2 })],
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
}
