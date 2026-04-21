use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

pub struct TelegramRepo {
    conn: Connection,
}

/// Role of a chat row. Mirrors the `role` CHECK constraint so the
/// mapping lives in one place; `as_str` is the single source of truth
/// for the serialized form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
    System,
    Tool,
}

impl ChatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
            ChatRole::System => "system",
            ChatRole::Tool => "tool",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "system" => Some(Self::System),
            "tool" => Some(Self::Tool),
            _ => None,
        }
    }
}

/// Single row in the chat history table. Tool rows carry
/// `tool_call_id` + `tool_name`; other roles leave them `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRow {
    pub id: i64,
    pub role: ChatRole,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub created_at: i64,
}

/// Shape handed to `chat_insert` — same as `ChatRow` minus `id`, which
/// SQLite assigns on insert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewChatRow {
    pub role: ChatRole,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MemoryRow {
    pub id: i64,
    pub fact: String,
    pub created_at: i64,
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

    pub fn set_inbox_transcript(&mut self, id: i64, transcript: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE inbox SET transcript = ?1 WHERE id = ?2",
            params![transcript, id],
        )?;
        Ok(())
    }

    // -------------------- reminders --------------------

    pub fn insert_reminder(&mut self, text: &str, due_at: i64, created_at: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO reminders(text, due_at, sent, cancelled, created_at)
             VALUES(?1, ?2, 0, 0, ?3)",
            params![text, due_at, created_at],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_active_reminders(&self) -> Result<Vec<super::reminders::Reminder>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, text, due_at, sent, cancelled
             FROM reminders
             WHERE cancelled = 0 AND sent = 0
             ORDER BY due_at ASC
             LIMIT 200",
        )?;
        let rows = stmt.query_map([], map_reminder_row)?;
        rows.collect()
    }

    pub fn due_reminders(
        &self,
        now: i64,
        limit: usize,
    ) -> Result<Vec<super::reminders::Reminder>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, text, due_at, sent, cancelled
             FROM reminders
             WHERE cancelled = 0 AND sent = 0 AND due_at <= ?1
             ORDER BY due_at ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![now, limit as i64], map_reminder_row)?;
        rows.collect()
    }

    pub fn mark_reminder_sent(&mut self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE reminders SET sent = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Insert a memory fact. Empty / whitespace-only facts are rejected
    /// here rather than relying on a CHECK constraint — the error
    /// message is friendlier surfaced at this layer.
    pub fn memory_insert(&mut self, fact: &str, created_at: i64) -> Result<i64> {
        let trimmed = fact.trim();
        if trimmed.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "fact must not be empty".into(),
            ));
        }
        self.conn.execute(
            "INSERT INTO memory(fact, created_at) VALUES(?1, ?2)",
            params![trimmed, created_at],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// List memory facts, newest first.
    pub fn memory_list(&self) -> Result<Vec<MemoryRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, fact, created_at FROM memory ORDER BY id DESC")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(MemoryRow {
                    id: r.get(0)?,
                    fact: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Delete a memory fact. Returns `true` when a row was removed,
    /// `false` when the id was unknown — handlers surface that as a
    /// user-facing "unknown id" reply rather than a hard error.
    pub fn memory_delete(&mut self, id: i64) -> Result<bool> {
        let changed = self
            .conn
            .execute("DELETE FROM memory WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    /// Append chat rows in a single transaction. Rows are inserted in
    /// the order supplied so a user + assistant (+ tool) turn lands
    /// atomically — partial writes on crash would confuse the history
    /// loader.
    pub fn chat_insert(&mut self, rows: &[NewChatRow]) -> Result<Vec<i64>> {
        let tx = self.conn.transaction()?;
        let mut ids = Vec::with_capacity(rows.len());
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chat(role, content, tool_call_id, tool_name, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5)",
            )?;
            for row in rows {
                stmt.execute(params![
                    row.role.as_str(),
                    row.content,
                    row.tool_call_id,
                    row.tool_name,
                    row.created_at,
                ])?;
                ids.push(tx.last_insert_rowid());
            }
        }
        tx.commit()?;
        Ok(ids)
    }

    /// Load the most recent `limit` chat rows in chronological order
    /// (oldest first), ready to feed straight into an LLM prompt.
    pub fn chat_load_recent(&self, limit: usize) -> Result<Vec<ChatRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, role, content, tool_call_id, tool_name, created_at
             FROM chat ORDER BY id DESC LIMIT ?1",
        )?;
        let mut rows: Vec<ChatRow> = stmt
            .query_map(params![limit as i64], |r| {
                let role_str: String = r.get(1)?;
                let role = ChatRole::parse(&role_str).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        format!("unknown chat role {role_str}").into(),
                    )
                })?;
                Ok(ChatRow {
                    id: r.get(0)?,
                    role,
                    content: r.get(2)?,
                    tool_call_id: r.get(3)?,
                    tool_name: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        rows.reverse();
        Ok(rows)
    }

    /// Keep the newest `keep` rows; delete the rest. Returns the number
    /// of rows removed. No-op when the table already fits.
    pub fn chat_prune(&mut self, keep: usize) -> Result<usize> {
        let deleted = self.conn.execute(
            "DELETE FROM chat WHERE id NOT IN (
                 SELECT id FROM chat ORDER BY id DESC LIMIT ?1
             )",
            params![keep as i64],
        )?;
        Ok(deleted)
    }

    pub fn cancel_reminder(&mut self, id: i64) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE reminders SET cancelled = 1
             WHERE id = ?1 AND cancelled = 0 AND sent = 0",
            params![id],
        )?;
        Ok(changed > 0)
    }
}

fn map_reminder_row(row: &rusqlite::Row<'_>) -> Result<super::reminders::Reminder> {
    let sent: i64 = row.get(3)?;
    let cancelled: i64 = row.get(4)?;
    Ok(super::reminders::Reminder {
        id: row.get(0)?,
        text: row.get(1)?,
        due_at: row.get(2)?,
        sent: sent != 0,
        cancelled: cancelled != 0,
    })
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

    #[test]
    fn set_inbox_transcript_persists() {
        let mut repo = fresh();
        let id = repo
            .insert_media_inbox(1, "voice", Some("a.ogg"), Some("audio/ogg"), Some(3), None, 1)
            .unwrap();
        repo.set_inbox_transcript(id, "hello world").unwrap();
        let items = repo.list_inbox(10).unwrap();
        assert_eq!(items[0].transcript.as_deref(), Some("hello world"));
    }

    fn chat_row(role: ChatRole, content: &str, created_at: i64) -> NewChatRow {
        NewChatRow {
            role,
            content: content.to_string(),
            tool_call_id: None,
            tool_name: None,
            created_at,
        }
    }

    #[test]
    fn chat_insert_and_load_recent_chronological() {
        let mut repo = fresh();
        let ids = repo
            .chat_insert(&[
                chat_row(ChatRole::User, "hello", 1),
                chat_row(ChatRole::Assistant, "hi there", 2),
            ])
            .unwrap();
        assert_eq!(ids.len(), 2);
        let rows = repo.chat_load_recent(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role, ChatRole::User);
        assert_eq!(rows[0].content, "hello");
        assert_eq!(rows[1].role, ChatRole::Assistant);
        assert_eq!(rows[1].content, "hi there");
    }

    #[test]
    fn chat_load_recent_caps_and_returns_newest_window() {
        let mut repo = fresh();
        for i in 0..6 {
            repo.chat_insert(&[chat_row(ChatRole::User, &format!("m{i}"), i as i64)])
                .unwrap();
        }
        let rows = repo.chat_load_recent(3).unwrap();
        assert_eq!(rows.len(), 3);
        // Chronological within the window, so we get the three newest in
        // insertion order.
        assert_eq!(rows[0].content, "m3");
        assert_eq!(rows[1].content, "m4");
        assert_eq!(rows[2].content, "m5");
    }

    #[test]
    fn chat_prune_keeps_newest_and_returns_deleted_count() {
        let mut repo = fresh();
        for i in 0..5 {
            repo.chat_insert(&[chat_row(ChatRole::User, &format!("m{i}"), i as i64)])
                .unwrap();
        }
        let deleted = repo.chat_prune(2).unwrap();
        assert_eq!(deleted, 3);
        let rows = repo.chat_load_recent(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].content, "m3");
        assert_eq!(rows[1].content, "m4");
    }

    #[test]
    fn chat_prune_is_noop_when_under_cap() {
        let mut repo = fresh();
        repo.chat_insert(&[chat_row(ChatRole::User, "only", 1)])
            .unwrap();
        let deleted = repo.chat_prune(10).unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(repo.chat_load_recent(10).unwrap().len(), 1);
    }

    #[test]
    fn memory_insert_list_delete_round_trip() {
        let mut repo = fresh();
        assert!(repo.memory_list().unwrap().is_empty());

        let a = repo.memory_insert("likes tea", 1).unwrap();
        let b = repo.memory_insert("works from Kyiv", 2).unwrap();
        let rows = repo.memory_list().unwrap();
        assert_eq!(rows.len(), 2);
        // Newest first — `b` comes before `a`.
        assert_eq!(rows[0].id, b);
        assert_eq!(rows[0].fact, "works from Kyiv");
        assert_eq!(rows[1].id, a);

        assert!(repo.memory_delete(a).unwrap());
        assert_eq!(repo.memory_list().unwrap().len(), 1);
        assert!(!repo.memory_delete(a).unwrap());
    }

    #[test]
    fn memory_insert_rejects_empty_fact() {
        let mut repo = fresh();
        assert!(repo.memory_insert("   ", 1).is_err());
        assert!(repo.memory_insert("", 1).is_err());
        assert!(repo.memory_list().unwrap().is_empty());
    }

    #[test]
    fn chat_insert_preserves_tool_metadata() {
        let mut repo = fresh();
        repo.chat_insert(&[NewChatRow {
            role: ChatRole::Tool,
            content: "{\"ok\":true}".into(),
            tool_call_id: Some("call_123".into()),
            tool_name: Some("get_battery".into()),
            created_at: 1,
        }])
        .unwrap();
        let rows = repo.chat_load_recent(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, ChatRole::Tool);
        assert_eq!(rows[0].tool_call_id.as_deref(), Some("call_123"));
        assert_eq!(rows[0].tool_name.as_deref(), Some("get_battery"));
    }
}
