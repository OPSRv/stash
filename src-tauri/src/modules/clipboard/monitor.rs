use crate::modules::clipboard::repo::ClipboardRepo;
use rusqlite::Result;

pub trait ClipboardReader {
    fn read_text(&mut self) -> Option<String>;
}

pub struct Monitor<R: ClipboardReader> {
    reader: R,
    last_seen: Option<String>,
}

impl<R: ClipboardReader> Monitor<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            last_seen: None,
        }
    }

    /// Read current clipboard contents; if they differ from the last non-empty
    /// value we saw, persist them and return the new row id.
    pub fn poll_once(&mut self, repo: &mut ClipboardRepo, now: i64) -> Result<Option<i64>> {
        let Some(text) = self.reader.read_text() else {
            return Ok(None);
        };
        if text.trim().is_empty() {
            return Ok(None);
        }
        if self.last_seen.as_deref() == Some(text.as_str()) {
            return Ok(None);
        }
        let id = repo.insert_text(&text, now)?;
        self.last_seen = Some(text);
        Ok(Some(id))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::clipboard::repo::ClipboardRepo;
    use rusqlite::Connection;

    struct FakeReader {
        queue: Vec<Option<String>>,
    }

    impl FakeReader {
        fn new(values: Vec<Option<&str>>) -> Self {
            Self {
                queue: values.into_iter().map(|v| v.map(str::to_string)).collect(),
            }
        }
    }

    impl ClipboardReader for FakeReader {
        fn read_text(&mut self) -> Option<String> {
            if self.queue.is_empty() {
                None
            } else {
                self.queue.remove(0)
            }
        }
    }

    fn setup() -> ClipboardRepo {
        ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn poll_on_empty_clipboard_inserts_nothing() {
        let mut repo = setup();
        let reader = FakeReader::new(vec![None]);
        let mut monitor = Monitor::new(reader);

        let inserted = monitor.poll_once(&mut repo, 100).unwrap();

        assert_eq!(inserted, None);
        assert_eq!(repo.list(10).unwrap().len(), 0);
    }

    #[test]
    fn poll_with_new_text_inserts_item() {
        let mut repo = setup();
        let reader = FakeReader::new(vec![Some("hello")]);
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
        let reader = FakeReader::new(vec![Some("dup"), Some("dup"), Some("dup")]);
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
        let reader = FakeReader::new(vec![Some("first"), Some("second")]);
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
        let reader = FakeReader::new(vec![Some("   \n\t  ")]);
        let mut monitor = Monitor::new(reader);

        let inserted = monitor.poll_once(&mut repo, 100).unwrap();

        assert_eq!(inserted, None);
        assert_eq!(repo.list(10).unwrap().len(), 0);
    }
}
