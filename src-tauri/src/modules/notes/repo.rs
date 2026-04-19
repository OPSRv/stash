use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

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
        Ok(Self { conn })
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

    #[allow(dead_code)]
    pub fn get(&self, id: i64) -> Result<Option<Note>> {
        self.conn
            .query_row(
                "SELECT * FROM notes WHERE id = ?1",
                params![id],
                Self::map_row,
            )
            .optional()
    }

    pub fn list(&self) -> Result<Vec<Note>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM notes ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], Self::map_row)?;
        rows.collect()
    }

    /// Case-insensitive LIKE search over title + body.
    pub fn search(&self, query: &str) -> Result<Vec<Note>> {
        let like = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT * FROM notes
             WHERE title LIKE ?1 COLLATE NOCASE OR body LIKE ?1 COLLATE NOCASE
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![like], Self::map_row)?;
        rows.collect()
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<Note> {
        Ok(Note {
            id: row.get("id")?,
            title: row.get("title")?,
            body: row.get("body")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
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
    fn list_returns_newest_first_by_update_time() {
        let mut repo = fresh();
        let older = repo.create("older", "", 10).unwrap();
        let newer = repo.create("newer", "", 20).unwrap();
        repo.update(older, "older", "touched", 30).unwrap();
        let notes = repo.list().unwrap();
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
    fn delete_removes_note() {
        let mut repo = fresh();
        let id = repo.create("gone", "", 1).unwrap();
        repo.delete(id).unwrap();
        assert!(repo.get(id).unwrap().is_none());
    }
}
