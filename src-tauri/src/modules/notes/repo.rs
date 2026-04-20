use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

/// Escape SQL LIKE wildcards so user input matches literally. Paired with
/// `LIKE ? ESCAPE '\'` in the query.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Absolute path to the recorded audio file, if this note originated from
    /// a voice recording. `None` for plain markdown notes.
    pub audio_path: Option<String>,
    /// Recording length in milliseconds, when known. Used for list previews.
    pub audio_duration_ms: Option<i64>,
    /// User-pinned notes float to the top of the side-list regardless of
    /// their `updated_at`.
    pub pinned: bool,
}

/// Projection used for the side-list. Carries only what the list row needs so
/// large bodies aren't shipped across IPC on every open — the full note is
/// fetched with `notes_get` when the user actually picks one.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteSummary {
    pub id: i64,
    pub title: String,
    /// Leading slice of the body (capped in SQL), enough to render one line of
    /// preview text without shipping the full note.
    pub preview: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub audio_path: Option<String>,
    pub audio_duration_ms: Option<i64>,
    pub pinned: bool,
}

/// How many leading body chars the list projection returns. Large enough for
/// any reasonable single-line preview, small enough that 500 notes stay under
/// ~150 KB across IPC even when bodies are long.
const LIST_PREVIEW_CHARS: usize = 280;

pub struct NotesRepo {
    conn: Connection,
}

impl NotesRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL DEFAULT '',
                body        TEXT NOT NULL DEFAULT '',
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notes_updated
                ON notes(updated_at DESC);",
        )?;
        // Additive migrations. `ALTER TABLE ADD COLUMN` is not idempotent in
        // SQLite, so we check the existing columns first.
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(notes)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_>>()?;
        if !cols.iter().any(|c| c == "audio_path") {
            conn.execute("ALTER TABLE notes ADD COLUMN audio_path TEXT", [])?;
        }
        if !cols.iter().any(|c| c == "audio_duration_ms") {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN audio_duration_ms INTEGER",
                [],
            )?;
        }
        if !cols.iter().any(|c| c == "pinned") {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(Self { conn })
    }

    pub fn set_pinned(&mut self, id: i64, pinned: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET pinned = ?1 WHERE id = ?2",
            params![pinned as i64, id],
        )?;
        Ok(())
    }

    pub fn create(&mut self, title: &str, body: &str, now: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO notes (title, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)",
            params![title, body, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn update(&mut self, id: i64, title: &str, body: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, body, now, id],
        )?;
        Ok(())
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get(&self, id: i64) -> Result<Option<Note>> {
        self.conn
            .query_row(
                "SELECT id, title, body, created_at, updated_at, audio_path, audio_duration_ms, pinned
                 FROM notes WHERE id = ?1",
                params![id],
                Self::map_row,
            )
            .optional()
    }

    /// Lightweight projection used by the side-list. `substr(body, 1, ?)` is
    /// evaluated inside SQLite, so the full body never leaves the DB page.
    /// Pinned notes float to the top.
    pub fn list_summaries(&self) -> Result<Vec<NoteSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, substr(body, 1, ?1) AS preview,
                    created_at, updated_at, audio_path, audio_duration_ms, pinned
             FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map(params![LIST_PREVIEW_CHARS as i64], Self::map_summary)?;
        rows.collect()
    }

    /// Case-insensitive LIKE search over title + body.
    pub fn search(&self, query: &str) -> Result<Vec<Note>> {
        let like = format!("%{}%", escape_like(query.trim()));
        let mut stmt = self.conn.prepare(
            "SELECT id, title, body, created_at, updated_at, audio_path, audio_duration_ms, pinned
             FROM notes
             WHERE title LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                OR body  LIKE ?1 ESCAPE '\\' COLLATE NOCASE
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let rows = stmt.query_map(params![like], Self::map_row)?;
        rows.collect()
    }

    pub fn search_summaries(&self, query: &str) -> Result<Vec<NoteSummary>> {
        let like = format!("%{}%", escape_like(query.trim()));
        let mut stmt = self.conn.prepare(
            "SELECT id, title, substr(body, 1, ?2) AS preview,
                    created_at, updated_at, audio_path, audio_duration_ms, pinned
             FROM notes
             WHERE title LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                OR body  LIKE ?1 ESCAPE '\\' COLLATE NOCASE
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let rows = stmt.query_map(params![like, LIST_PREVIEW_CHARS as i64], Self::map_summary)?;
        rows.collect()
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<Note> {
        Ok(Note {
            id: row.get("id")?,
            title: row.get("title")?,
            body: row.get("body")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            audio_path: row.get("audio_path").ok(),
            audio_duration_ms: row.get("audio_duration_ms").ok(),
            pinned: row.get::<_, i64>("pinned").unwrap_or(0) != 0,
        })
    }

    fn map_summary(row: &rusqlite::Row<'_>) -> Result<NoteSummary> {
        Ok(NoteSummary {
            id: row.get("id")?,
            title: row.get("title")?,
            preview: row.get("preview")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            audio_path: row.get("audio_path").ok(),
            audio_duration_ms: row.get("audio_duration_ms").ok(),
            pinned: row.get::<_, i64>("pinned").unwrap_or(0) != 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> NotesRepo {
        NotesRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn create_then_get_returns_note() {
        let mut repo = fresh();
        let id = repo.create("Hello", "World", 100).unwrap();
        let note = repo.get(id).unwrap().unwrap();
        assert_eq!(note.title, "Hello");
        assert_eq!(note.body, "World");
        assert_eq!(note.created_at, 100);
        assert_eq!(note.updated_at, 100);
        assert_eq!(note.audio_path, None);
        assert_eq!(note.audio_duration_ms, None);
    }

    #[test]
    fn update_changes_body_and_timestamp() {
        let mut repo = fresh();
        let id = repo.create("t", "v1", 1).unwrap();
        repo.update(id, "t", "v2", 50).unwrap();
        let note = repo.get(id).unwrap().unwrap();
        assert_eq!(note.body, "v2");
        assert_eq!(note.updated_at, 50);
        assert_eq!(note.created_at, 1);
    }

    #[test]
    fn list_summaries_caps_preview_length() {
        let mut repo = fresh();
        let long = "x".repeat(5_000);
        repo.create("big", &long, 1).unwrap();
        let summaries = repo.list_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].preview.len(), LIST_PREVIEW_CHARS);
        assert!(summaries[0].preview.chars().all(|c| c == 'x'));
    }

    #[test]
    fn list_returns_newest_first_by_update_time() {
        let mut repo = fresh();
        let older = repo.create("older", "", 10).unwrap();
        let newer = repo.create("newer", "", 20).unwrap();
        repo.update(older, "older", "touched", 30).unwrap();
        let notes = repo.list_summaries().unwrap();
        assert_eq!(notes[0].id, older);
        assert_eq!(notes[1].id, newer);
    }

    #[test]
    fn search_matches_title_and_body_case_insensitive() {
        let mut repo = fresh();
        repo.create("Recipe", "Cook at 180C", 1).unwrap();
        repo.create("Meeting", "Discuss MVP", 2).unwrap();
        let hits = repo.search("mvp").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Meeting");
        let title_hits = repo.search("RECIPE").unwrap();
        assert_eq!(title_hits.len(), 1);
    }

    #[test]
    fn search_treats_like_wildcards_as_literals() {
        let mut repo = fresh();
        repo.create("foo_bar", "", 1).unwrap();
        repo.create("fooXbar", "", 2).unwrap();
        let hits = repo.search("foo_bar").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "foo_bar");
        let pct = repo.search("50%").unwrap();
        assert_eq!(pct.len(), 0);
    }

    #[test]
    fn delete_removes_note() {
        let mut repo = fresh();
        let id = repo.create("gone", "", 1).unwrap();
        repo.delete(id).unwrap();
        assert!(repo.get(id).unwrap().is_none());
    }

    #[test]
    fn pinned_notes_float_to_top() {
        let mut repo = fresh();
        let _a = repo.create("a", "", 10).unwrap();
        let b = repo.create("b", "", 20).unwrap();
        let _c = repo.create("c", "", 30).unwrap();
        repo.set_pinned(b, true).unwrap();
        let summaries = repo.list_summaries().unwrap();
        assert_eq!(summaries[0].id, b);
        assert!(summaries[0].pinned);
        assert!(!summaries[1].pinned);
    }

    #[test]
    fn search_keeps_pinned_first() {
        let mut repo = fresh();
        let new = repo.create("new pin", "x", 30).unwrap();
        let old = repo.create("old pin", "x", 10).unwrap();
        repo.set_pinned(old, true).unwrap();
        let hits = repo.search_summaries("pin").unwrap();
        assert_eq!(hits[0].id, old);
        assert_eq!(hits[1].id, new);
    }

    #[test]
    fn migration_adds_columns_to_legacy_schema() {
        // Simulate a pre-existing DB that has the old 5-column schema.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO notes (title, body, created_at, updated_at)
            VALUES ('old', 'x', 1, 1);",
        )
        .unwrap();
        let repo = NotesRepo::new(conn).unwrap();
        let notes = repo.list_summaries().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "old");
        assert_eq!(notes[0].audio_path, None);
    }
}
