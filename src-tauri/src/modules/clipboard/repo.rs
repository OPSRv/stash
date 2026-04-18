use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct ClipboardItem {
    pub id: i64,
    pub content: String,
    pub created_at: i64,
    pub pinned: bool,
}

pub struct ClipboardRepo {
    conn: Connection,
}

impl ClipboardRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS clipboard_items (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                content    TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                pinned     INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_items(created_at DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn insert_text(&mut self, content: &str, created_at: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO clipboard_items (content, created_at) VALUES (?1, ?2)
             ON CONFLICT(content) DO UPDATE SET created_at = excluded.created_at",
            params![content, created_at],
        )?;
        let id: i64 = self.conn.query_row(
            "SELECT id FROM clipboard_items WHERE content = ?1",
            params![content],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn list(&self, limit: usize) -> Result<Vec<ClipboardItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, content, created_at, pinned FROM clipboard_items
             ORDER BY pinned DESC, created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<ClipboardItem>> {
        let like = format!("%{}%", query);
        let mut stmt = self.conn.prepare(
            "SELECT id, content, created_at, pinned FROM clipboard_items
             WHERE content LIKE ?1 COLLATE NOCASE
             ORDER BY pinned DESC, created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![like, limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        self.conn
            .query_row(
                "SELECT id, content, created_at, pinned FROM clipboard_items WHERE id = ?1",
                params![id],
                Self::map_row,
            )
            .optional()
    }

    pub fn toggle_pin(&mut self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE clipboard_items SET pinned = 1 - pinned WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn touch(&mut self, id: i64, created_at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE clipboard_items SET created_at = ?1 WHERE id = ?2",
            params![created_at, id],
        )?;
        Ok(())
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM clipboard_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<ClipboardItem> {
        Ok(ClipboardItem {
            id: row.get(0)?,
            content: row.get(1)?,
            created_at: row.get(2)?,
            pinned: row.get::<_, i64>(3)? != 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_repo() -> ClipboardRepo {
        let conn = Connection::open_in_memory().unwrap();
        ClipboardRepo::new(conn).unwrap()
    }

    #[test]
    fn insert_text_then_list_returns_it() {
        let mut repo = fresh_repo();
        let id = repo.insert_text("hello world", 1_700_000_000).unwrap();
        let items = repo.list(10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id);
        assert_eq!(items[0].content, "hello world");
    }

    #[test]
    fn list_returns_newest_first() {
        let mut repo = fresh_repo();
        repo.insert_text("old", 1_700_000_000).unwrap();
        repo.insert_text("new", 1_700_000_100).unwrap();
        let items = repo.list(10).unwrap();
        assert_eq!(items[0].content, "new");
        assert_eq!(items[1].content, "old");
    }

    #[test]
    fn list_respects_limit() {
        let mut repo = fresh_repo();
        for i in 0..5 {
            repo.insert_text(&format!("item-{i}"), 1_700_000_000 + i)
                .unwrap();
        }
        let items = repo.list(3).unwrap();
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn search_returns_only_matching_items() {
        let mut repo = fresh_repo();
        repo.insert_text("apple pie", 1).unwrap();
        repo.insert_text("banana split", 2).unwrap();
        repo.insert_text("cherry tart", 3).unwrap();
        let results = repo.search("banana", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "banana split");
    }

    #[test]
    fn search_is_case_insensitive() {
        let mut repo = fresh_repo();
        repo.insert_text("Hello World", 1).unwrap();
        let results = repo.search("hello", 10).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn inserting_same_content_twice_dedups_and_refreshes_timestamp() {
        let mut repo = fresh_repo();
        let id1 = repo.insert_text("same", 100).unwrap();
        let id2 = repo.insert_text("same", 200).unwrap();
        assert_eq!(id1, id2);
        let items = repo.list(10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].created_at, 200);
    }

    #[test]
    fn toggle_pin_sets_and_unsets_pinned_flag() {
        let mut repo = fresh_repo();
        let id = repo.insert_text("pinme", 1).unwrap();
        assert!(!repo.get(id).unwrap().unwrap().pinned);
        repo.toggle_pin(id).unwrap();
        assert!(repo.get(id).unwrap().unwrap().pinned);
        repo.toggle_pin(id).unwrap();
        assert!(!repo.get(id).unwrap().unwrap().pinned);
    }

    #[test]
    fn delete_removes_item() {
        let mut repo = fresh_repo();
        let id = repo.insert_text("byebye", 1).unwrap();
        repo.delete(id).unwrap();
        assert_eq!(repo.list(10).unwrap().len(), 0);
    }

    #[test]
    fn touch_updates_created_at_without_changing_content() {
        let mut repo = fresh_repo();
        let id = repo.insert_text("touched", 100).unwrap();
        repo.touch(id, 500).unwrap();
        let item = repo.get(id).unwrap().unwrap();
        assert_eq!(item.content, "touched");
        assert_eq!(item.created_at, 500);
    }

    #[test]
    fn list_places_pinned_items_before_unpinned() {
        let mut repo = fresh_repo();
        let older_pinned = repo.insert_text("pinned-older", 100).unwrap();
        repo.insert_text("recent-unpinned", 200).unwrap();
        repo.toggle_pin(older_pinned).unwrap();
        let items = repo.list(10).unwrap();
        assert_eq!(items[0].content, "pinned-older");
        assert_eq!(items[1].content, "recent-unpinned");
    }
}
