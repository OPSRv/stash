use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TranslationRow {
    pub id: i64,
    pub original: String,
    pub translated: String,
    pub from_lang: String,
    pub to_lang: String,
    pub created_at: i64,
}

pub struct TranslationsRepo {
    conn: Connection,
}

const DEFAULT_CAP: usize = 500;

impl TranslationsRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS translations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                original    TEXT NOT NULL,
                translated  TEXT NOT NULL,
                from_lang   TEXT NOT NULL DEFAULT 'auto',
                to_lang     TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_translations_created
                ON translations(created_at DESC);",
        )?;
        Ok(Self { conn })
    }

    /// Insert and auto-trim to `DEFAULT_CAP` rows to keep the list manageable.
    /// Returns the new row id. Identical (original, to_lang) within the last
    /// minute is a no-op — prevents dupes from the 10-minute in-memory cache
    /// being bypassed by a restart.
    pub fn insert(
        &mut self,
        original: &str,
        translated: &str,
        from_lang: &str,
        to_lang: &str,
        created_at: i64,
    ) -> Result<i64> {
        let recent: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM translations
                 WHERE original = ?1 AND to_lang = ?2 AND created_at > ?3
                 ORDER BY created_at DESC LIMIT 1",
                params![original, to_lang, created_at - 60],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = recent {
            return Ok(id);
        }
        self.conn.execute(
            "INSERT INTO translations (original, translated, from_lang, to_lang, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![original, translated, from_lang, to_lang, created_at],
        )?;
        let id = self.conn.last_insert_rowid();
        self.trim_to_cap(DEFAULT_CAP)?;
        Ok(id)
    }

    pub fn list(&self, limit: usize) -> Result<Vec<TranslationRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, original, translated, from_lang, to_lang, created_at
             FROM translations ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<TranslationRow>> {
        let like = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT id, original, translated, from_lang, to_lang, created_at
             FROM translations
             WHERE original LIKE ?1 COLLATE NOCASE
                OR translated LIKE ?1 COLLATE NOCASE
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![like, limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM translations WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear(&mut self) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM translations", [])?)
    }

    fn trim_to_cap(&mut self, cap: usize) -> Result<()> {
        self.conn.execute(
            "DELETE FROM translations WHERE id NOT IN
               (SELECT id FROM translations ORDER BY created_at DESC LIMIT ?1)",
            params![cap as i64],
        )?;
        Ok(())
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<TranslationRow> {
        Ok(TranslationRow {
            id: row.get(0)?,
            original: row.get(1)?,
            translated: row.get(2)?,
            from_lang: row.get(3)?,
            to_lang: row.get(4)?,
            created_at: row.get(5)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> TranslationsRepo {
        TranslationsRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn insert_then_list_returns_newest_first() {
        let mut r = fresh();
        r.insert("hello", "привіт", "auto", "uk", 100).unwrap();
        r.insert("world", "світ", "auto", "uk", 200).unwrap();
        let rows = r.list(10).unwrap();
        assert_eq!(rows[0].original, "world");
        assert_eq!(rows[1].original, "hello");
    }

    #[test]
    fn insert_dedupes_recent_duplicates() {
        let mut r = fresh();
        let a = r.insert("hello", "привіт", "auto", "uk", 100).unwrap();
        let b = r.insert("hello", "привіт", "auto", "uk", 130).unwrap();
        assert_eq!(a, b);
        assert_eq!(r.list(10).unwrap().len(), 1);
    }

    #[test]
    fn insert_allows_same_text_after_dedupe_window() {
        let mut r = fresh();
        r.insert("hello", "привіт", "auto", "uk", 100).unwrap();
        r.insert("hello", "привіт", "auto", "uk", 300).unwrap();
        assert_eq!(r.list(10).unwrap().len(), 2);
    }

    #[test]
    fn search_matches_original_and_translated() {
        // SQLite's NOCASE collation is ASCII-only; for ASCII we exercise
        // case-insensitive matching, for Cyrillic the substring must match
        // the stored case.
        let mut r = fresh();
        r.insert("Hello world", "Привіт світ", "auto", "uk", 1)
            .unwrap();
        r.insert("Bonjour", "Вітаю", "auto", "uk", 2).unwrap();
        assert_eq!(r.search("WORLD", 10).unwrap().len(), 1);
        assert_eq!(r.search("Вітаю", 10).unwrap().len(), 1);
        assert_eq!(r.search("missing", 10).unwrap().len(), 0);
    }

    #[test]
    fn clear_wipes_everything() {
        let mut r = fresh();
        r.insert("a", "b", "auto", "uk", 1).unwrap();
        r.insert("c", "d", "auto", "uk", 2).unwrap();
        let removed = r.clear().unwrap();
        assert_eq!(removed, 2);
        assert!(r.list(10).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_single_row() {
        let mut r = fresh();
        let id = r.insert("a", "b", "auto", "uk", 1).unwrap();
        r.delete(id).unwrap();
        assert!(r.list(10).unwrap().is_empty());
    }
}
