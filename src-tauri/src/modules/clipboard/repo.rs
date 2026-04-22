use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

/// Escape SQL LIKE wildcards (`%`, `_`) and the escape character (`\`) so
/// literal user input is matched verbatim rather than interpreted as a
/// pattern. Paired with `LIKE ? ESCAPE '\'` in the query.
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

#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct ClipboardItem {
    pub id: i64,
    pub kind: String,
    pub content: String,
    pub meta: Option<String>,
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
            CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_items(created_at DESC);
            -- Every listing does `ORDER BY pinned DESC, created_at DESC`. A
            -- standalone `created_at` index forces SQLite to do a filesort
            -- by pinned; a composite lets the planner stream the table in
            -- the final order and stop at LIMIT.
            CREATE INDEX IF NOT EXISTS idx_clipboard_pinned_created
                ON clipboard_items(pinned DESC, created_at DESC);",
        )?;
        // Migration: add kind + meta columns for clients that predate image support.
        Self::ensure_column(&conn, "kind", "TEXT NOT NULL DEFAULT 'text'")?;
        Self::ensure_column(&conn, "meta", "TEXT")?;
        Ok(Self { conn })
    }

    fn ensure_column(conn: &Connection, name: &str, decl: &str) -> Result<()> {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('clipboard_items') WHERE name=?1",
                params![name],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            conn.execute(
                &format!("ALTER TABLE clipboard_items ADD COLUMN {} {}", name, decl),
                [],
            )?;
        }
        Ok(())
    }

    pub fn insert_text(&mut self, content: &str, created_at: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO clipboard_items (kind, content, created_at) VALUES ('text', ?1, ?2)
             ON CONFLICT(content) DO UPDATE SET created_at = excluded.created_at",
            params![content, created_at],
        )?;
        self.id_by_content(content)
    }

    pub fn insert_image(&mut self, hash: &str, meta_json: &str, created_at: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO clipboard_items (kind, content, meta, created_at)
             VALUES ('image', ?1, ?2, ?3)
             ON CONFLICT(content) DO UPDATE SET created_at = excluded.created_at",
            params![hash, meta_json, created_at],
        )?;
        self.id_by_content(hash)
    }

    /// Insert (or refresh) a clipboard row that represents one or more
    /// files copied from Finder. `content` is a synthetic stable key —
    /// typically a sha256 of the joined paths so repeated copies of the
    /// same selection deduplicate instead of accumulating. `meta_json`
    /// carries the full `{files: [{path, name, size?, mime?}, ...]}`
    /// payload the UI renders via `FilePreviewList`.
    pub fn insert_files(
        &mut self,
        content_key: &str,
        meta_json: &str,
        created_at: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO clipboard_items (kind, content, meta, created_at)
             VALUES ('file', ?1, ?2, ?3)
             ON CONFLICT(content) DO UPDATE SET created_at = excluded.created_at",
            params![content_key, meta_json, created_at],
        )?;
        self.id_by_content(content_key)
    }

    fn id_by_content(&self, content: &str) -> Result<i64> {
        self.conn.query_row(
            "SELECT id FROM clipboard_items WHERE content = ?1",
            params![content],
            |row| row.get(0),
        )
    }

    pub fn list(&self, limit: usize) -> Result<Vec<ClipboardItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, content, meta, created_at, pinned FROM clipboard_items
             ORDER BY pinned DESC, created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<ClipboardItem>> {
        let like = format!("%{}%", escape_like(query));
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, content, meta, created_at, pinned FROM clipboard_items
             WHERE kind = 'text' AND content LIKE ?1 ESCAPE '\\' COLLATE NOCASE
             ORDER BY pinned DESC, created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![like, limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        self.conn
            .query_row(
                "SELECT id, kind, content, meta, created_at, pinned FROM clipboard_items WHERE id = ?1",
                params![id],
                Self::map_row,
            )
            .optional()
    }

    pub fn touch(&mut self, id: i64, created_at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE clipboard_items SET created_at = ?1 WHERE id = ?2",
            params![created_at, id],
        )?;
        Ok(())
    }

    pub fn toggle_pin(&mut self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE clipboard_items SET pinned = 1 - pinned WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM clipboard_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete every unpinned item. Returns how many rows were removed.
    pub fn clear_all(&mut self) -> Result<usize> {
        let removed = self
            .conn
            .execute("DELETE FROM clipboard_items WHERE pinned = 0", [])?;
        Ok(removed)
    }

    /// Return `(id, meta)` pairs for every `kind='file'` row. Used by
    /// the cleanup command to drop rows whose paths no longer exist
    /// on disk or were never-actionable WebKit promise-IDs to begin
    /// with (those snuck in before we added the pasteboard filter).
    pub fn file_rows_with_meta(&self) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, meta FROM clipboard_items
             WHERE kind = 'file' AND meta IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect()
    }

    /// Return the raw `meta` JSON strings for every unpinned image row, so a
    /// caller can parse out file paths and delete the backing files before
    /// `clear_all` drops the rows that point at them.
    pub fn unpinned_image_metas(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT meta FROM clipboard_items
             WHERE pinned = 0 AND kind = 'image' AND meta IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    /// Keep at most `cap` unpinned items (newest first). Pinned items are
    /// always retained. Returns how many rows were removed.
    pub fn trim_to_cap(&mut self, cap: usize) -> Result<usize> {
        let removed = self.conn.execute(
            "DELETE FROM clipboard_items
             WHERE pinned = 0 AND id NOT IN (
                 SELECT id FROM clipboard_items
                 WHERE pinned = 0
                 ORDER BY created_at DESC
                 LIMIT ?1
             )",
            params![cap as i64],
        )?;
        Ok(removed)
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<ClipboardItem> {
        Ok(ClipboardItem {
            id: row.get(0)?,
            kind: row.get(1)?,
            content: row.get(2)?,
            meta: row.get(3)?,
            created_at: row.get(4)?,
            pinned: row.get::<_, i64>(5)? != 0,
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
        assert_eq!(items[0].kind, "text");
    }

    #[test]
    fn unpinned_image_metas_returns_only_image_rows_and_skips_pinned() {
        let mut repo = ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        repo.insert_text("plain", 1).unwrap();
        let img1 = repo
            .insert_image("h1", r#"{"path":"/tmp/a.png"}"#, 2)
            .unwrap();
        repo.insert_image("h2", r#"{"path":"/tmp/b.png"}"#, 3)
            .unwrap();
        repo.toggle_pin(img1).unwrap();
        let metas = repo.unpinned_image_metas().unwrap();
        assert_eq!(metas.len(), 1);
        assert!(metas[0].contains("/tmp/b.png"));
    }

    #[test]
    fn insert_image_stores_kind_and_meta() {
        let mut repo = fresh_repo();
        let id = repo
            .insert_image("abc123", r#"{"path":"/tmp/a.png","w":10,"h":10}"#, 500)
            .unwrap();
        let item = repo.get(id).unwrap().unwrap();
        assert_eq!(item.kind, "image");
        assert_eq!(item.content, "abc123");
        assert_eq!(
            item.meta.as_deref(),
            Some(r#"{"path":"/tmp/a.png","w":10,"h":10}"#)
        );
    }

    #[test]
    fn search_treats_like_wildcards_as_literals() {
        let mut repo = fresh_repo();
        repo.insert_text("foo_bar", 1).unwrap();
        repo.insert_text("fooXbar", 2).unwrap();
        let hits = repo.search("foo_bar", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "foo_bar");
        let pct = repo.search("50%", 10).unwrap();
        assert_eq!(pct.len(), 0);
    }

    #[test]
    fn search_ignores_images() {
        let mut repo = fresh_repo();
        repo.insert_text("findme", 1).unwrap();
        repo.insert_image("hash-findme", "{}", 2).unwrap();
        let results = repo.search("findme", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].kind, "text");
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
    fn clear_all_deletes_unpinned_items_and_keeps_pinned() {
        let mut repo = fresh_repo();
        let pinned = repo.insert_text("keep me", 1).unwrap();
        repo.toggle_pin(pinned).unwrap();
        repo.insert_text("go away 1", 2).unwrap();
        repo.insert_text("go away 2", 3).unwrap();

        let removed = repo.clear_all().unwrap();

        assert_eq!(removed, 2);
        let items = repo.list(10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, pinned);
    }

    #[test]
    fn trim_to_cap_keeps_only_latest_n_unpinned() {
        let mut repo = fresh_repo();
        let pinned = repo.insert_text("pinned", 1).unwrap();
        repo.toggle_pin(pinned).unwrap();
        for i in 0..10 {
            repo.insert_text(&format!("item-{i}"), 100 + i).unwrap();
        }

        let removed = repo.trim_to_cap(3).unwrap();

        assert_eq!(removed, 7);
        let items = repo.list(20).unwrap();
        // 1 pinned + 3 most recent unpinned = 4
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].content, "pinned");
        assert_eq!(items[1].content, "item-9");
        assert_eq!(items[2].content, "item-8");
        assert_eq!(items[3].content, "item-7");
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
