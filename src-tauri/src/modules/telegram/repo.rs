use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

pub struct TelegramRepo {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InboxItem {
    pub id: i64,
    pub telegram_message_id: i64,
    pub kind: String,
    pub text_content: Option<String>,
    pub file_path: Option<String>,
    pub mime_type: Option<String>,
    pub duration_sec: Option<i64>,
    pub transcript: Option<String>,
    pub caption: Option<String>,
    pub received_at: i64,
    pub routed_to: Option<String>,
}

impl TelegramRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
                content TEXT NOT NULL,
                tool_call_id TEXT,
                tool_name TEXT,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_chat_recent ON chat(created_at DESC);

             CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fact TEXT NOT NULL,
                created_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                repeat_rule TEXT,
                sent INTEGER NOT NULL DEFAULT 0,
                cancelled INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_reminders_due
                ON reminders(due_at) WHERE sent=0 AND cancelled=0;

             CREATE TABLE IF NOT EXISTS inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_message_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('text','voice','photo','document','video','sticker')),
                text_content TEXT,
                file_path TEXT,
                mime_type TEXT,
                duration_sec INTEGER,
                transcript TEXT,
                caption TEXT,
                received_at INTEGER NOT NULL,
                routed_to TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_inbox_recent ON inbox(received_at DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
    }

    pub fn kv_set(&mut self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Record a text-only inbox item. Media types (voice, photo, document)
    /// land via a separate path that downloads the file first — added in a
    /// later phase.
    pub fn insert_text_inbox(
        &mut self,
        telegram_message_id: i64,
        text: &str,
        received_at: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO inbox(telegram_message_id, kind, text_content, received_at)
             VALUES(?1, 'text', ?2, ?3)",
            params![telegram_message_id, text, received_at],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Record a media inbox row (voice / photo / document / video). Caller
    /// has already downloaded the file and knows its relative path under
    /// the app data dir.
    pub fn insert_media_inbox(
        &mut self,
        telegram_message_id: i64,
        kind: &str,
        file_path: Option<&str>,
        mime_type: Option<&str>,
        duration_sec: Option<i64>,
        caption: Option<&str>,
        received_at: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO inbox(telegram_message_id, kind, file_path, mime_type,
                               duration_sec, caption, received_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                telegram_message_id,
                kind,
                file_path,
                mime_type,
                duration_sec,
                caption,
                received_at
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_inbox(&self, limit: usize) -> Result<Vec<InboxItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, telegram_message_id, kind, text_content, file_path,
                    mime_type, duration_sec, transcript, caption, received_at, routed_to
             FROM inbox
             ORDER BY received_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(InboxItem {
                id: r.get(0)?,
                telegram_message_id: r.get(1)?,
                kind: r.get(2)?,
                text_content: r.get(3)?,
                file_path: r.get(4)?,
                mime_type: r.get(5)?,
                duration_sec: r.get(6)?,
                transcript: r.get(7)?,
                caption: r.get(8)?,
                received_at: r.get(9)?,
                routed_to: r.get(10)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_inbox_item(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM inbox WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn mark_inbox_routed(&mut self, id: i64, target: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE inbox SET routed_to = ?1 WHERE id = ?2",
            params![target, id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> TelegramRepo {
        TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn migrations_create_all_tables() {
        let repo = fresh();
        let mut stmt = repo
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["chat", "inbox", "kv", "memory", "reminders"] {
            assert!(
                names.contains(&expected.to_string()),
                "missing table {expected} in {names:?}"
            );
        }
    }

    #[test]
    fn kv_round_trip_and_overwrite() {
        let mut repo = fresh();
        assert_eq!(repo.kv_get("last_update_id").unwrap(), None);
        repo.kv_set("last_update_id", "42").unwrap();
        assert_eq!(
            repo.kv_get("last_update_id").unwrap().as_deref(),
            Some("42")
        );
        repo.kv_set("last_update_id", "43").unwrap();
        assert_eq!(
            repo.kv_get("last_update_id").unwrap().as_deref(),
            Some("43")
        );
    }

    #[test]
    fn chat_role_check_rejects_invalid() {
        let repo = fresh();
        let err = repo.conn.execute(
            "INSERT INTO chat(role, content, created_at) VALUES ('bogus', 'x', 1)",
            [],
        );
        assert!(err.is_err(), "role CHECK must reject unknown values");
    }

    #[test]
    fn inbox_kind_check_rejects_invalid() {
        let repo = fresh();
        let err = repo.conn.execute(
            "INSERT INTO inbox(telegram_message_id, kind, received_at) VALUES (1, 'bogus', 1)",
            [],
        );
        assert!(err.is_err(), "kind CHECK must reject unknown values");
    }

    #[test]
    fn text_inbox_round_trip() {
        let mut repo = fresh();
        let id = repo.insert_text_inbox(101, "hello world", 1_000).unwrap();
        let items = repo.list_inbox(10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, id);
        assert_eq!(items[0].telegram_message_id, 101);
        assert_eq!(items[0].kind, "text");
        assert_eq!(items[0].text_content.as_deref(), Some("hello world"));
        assert_eq!(items[0].received_at, 1_000);
        assert!(items[0].routed_to.is_none());
    }

    #[test]
    fn list_inbox_orders_by_received_desc() {
        let mut repo = fresh();
        repo.insert_text_inbox(1, "old", 100).unwrap();
        repo.insert_text_inbox(2, "new", 200).unwrap();
        let items = repo.list_inbox(10).unwrap();
        assert_eq!(items[0].text_content.as_deref(), Some("new"));
        assert_eq!(items[1].text_content.as_deref(), Some("old"));
    }

    #[test]
    fn delete_inbox_item_removes_row() {
        let mut repo = fresh();
        let id = repo.insert_text_inbox(1, "x", 1).unwrap();
        repo.delete_inbox_item(id).unwrap();
        assert!(repo.list_inbox(10).unwrap().is_empty());
    }

    #[test]
    fn mark_inbox_routed_sets_target() {
        let mut repo = fresh();
        let id = repo.insert_text_inbox(1, "x", 1).unwrap();
        repo.mark_inbox_routed(id, "notes").unwrap();
        let items = repo.list_inbox(10).unwrap();
        assert_eq!(items[0].routed_to.as_deref(), Some("notes"));
    }
}
