use rusqlite::{params, Connection, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Origin of the session — `None` for a regular chat opened from the AI
    /// tab, `Some("note")` / `Some("clipboard")` / etc. for context-bound
    /// chats owned by a specific module. Present in the shared sidebar so
    /// the user can tell at a glance which chat belongs to what feature.
    pub kind: Option<String>,
    /// Opaque per-kind identifier (e.g. a note id as string). Used to
    /// resolve "the chat for this note" on demand without a separate
    /// mapping table.
    pub context_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    pub stopped: bool,
}

pub struct AiRepo {
    conn: Connection,
}

impl AiRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        // ON DELETE CASCADE on ai_messages depends on foreign_keys being ON;
        // rusqlite disables them per-connection by default.
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS ai_sessions (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated
                ON ai_sessions(updated_at DESC);

             CREATE TABLE IF NOT EXISTS ai_messages (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
                role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
                content     TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                stopped     INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_ai_messages_session
                ON ai_messages(session_id, created_at);",
        )?;
        // Additive migration: `kind` / `context_ref` land on existing DBs
        // without a rebuild, and lookups-by-context stay cheap via a
        // covering index.
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(ai_sessions)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_>>()?;
        if !cols.iter().any(|c| c == "kind") {
            conn.execute("ALTER TABLE ai_sessions ADD COLUMN kind TEXT", [])?;
        }
        if !cols.iter().any(|c| c == "context_ref") {
            conn.execute("ALTER TABLE ai_sessions ADD COLUMN context_ref TEXT", [])?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_ai_sessions_kind_ctx
                ON ai_sessions(kind, context_ref);",
        )?;
        Ok(Self { conn })
    }

    pub fn create_session(
        &mut self,
        id: &str,
        title: &str,
        now: i64,
        kind: Option<&str>,
        context_ref: Option<&str>,
    ) -> Result<Session> {
        self.conn.execute(
            "INSERT INTO ai_sessions (id, title, created_at, updated_at, kind, context_ref)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![id, title, now, kind, context_ref],
        )?;
        Ok(Session {
            id: id.to_string(),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            kind: kind.map(|s| s.to_string()),
            context_ref: context_ref.map(|s| s.to_string()),
        })
    }

    /// Find the existing session that belongs to a `(kind, context_ref)` pair
    /// — e.g. the chat attached to a particular note. Returns `None` when the
    /// caller should create one.
    pub fn find_session_by_context(
        &self,
        kind: &str,
        context_ref: &str,
    ) -> Result<Option<Session>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, created_at, updated_at, kind, context_ref
             FROM ai_sessions
             WHERE kind = ?1 AND context_ref = ?2
             ORDER BY updated_at DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query(params![kind, context_ref])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Self::map_session(row)?))
        } else {
            Ok(None)
        }
    }

    pub fn rename_session(&mut self, id: &str, title: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE ai_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;
        Ok(())
    }

    pub fn touch_session(&mut self, id: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE ai_sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    pub fn delete_session(&mut self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM ai_sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, created_at, updated_at, kind, context_ref
             FROM ai_sessions
             ORDER BY updated_at DESC
             LIMIT 500",
        )?;
        let rows = stmt.query_map([], Self::map_session)?;
        rows.collect()
    }

    pub fn append_message(
        &mut self,
        id: &str,
        session_id: &str,
        role: &str,
        content: &str,
        now: i64,
        stopped: bool,
    ) -> Result<Message> {
        self.conn.execute(
            "INSERT INTO ai_messages (id, session_id, role, content, created_at, stopped)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, role, content, now, stopped as i64],
        )?;
        self.touch_session(session_id, now)?;
        Ok(Message {
            id: id.to_string(),
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            created_at: now,
            stopped,
        })
    }

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, role, content, created_at, stopped
             FROM ai_messages
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], Self::map_message)?;
        rows.collect()
    }

    fn map_session(row: &rusqlite::Row<'_>) -> Result<Session> {
        Ok(Session {
            id: row.get("id")?,
            title: row.get("title")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            kind: row.get("kind").ok(),
            context_ref: row.get("context_ref").ok(),
        })
    }

    fn map_message(row: &rusqlite::Row<'_>) -> Result<Message> {
        let stopped: i64 = row.get("stopped")?;
        Ok(Message {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            role: row.get("role")?,
            content: row.get("content")?,
            created_at: row.get("created_at")?,
            stopped: stopped != 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> AiRepo {
        AiRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn create_then_list_returns_session() {
        let mut repo = fresh();
        repo.create_session("s1", "Hello", 100, None, None).unwrap();
        let list = repo.list_sessions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "s1");
        assert_eq!(list[0].title, "Hello");
        assert_eq!(list[0].updated_at, 100);
    }

    #[test]
    fn list_orders_by_updated_desc() {
        let mut repo = fresh();
        repo.create_session("old", "A", 10, None, None).unwrap();
        repo.create_session("new", "B", 20, None, None).unwrap();
        repo.touch_session("old", 30).unwrap();
        let list = repo.list_sessions().unwrap();
        assert_eq!(list[0].id, "old");
        assert_eq!(list[1].id, "new");
    }

    #[test]
    fn rename_changes_title_and_bumps_updated() {
        let mut repo = fresh();
        repo.create_session("s", "Old", 1, None, None).unwrap();
        repo.rename_session("s", "New", 50).unwrap();
        let list = repo.list_sessions().unwrap();
        assert_eq!(list[0].title, "New");
        assert_eq!(list[0].updated_at, 50);
    }

    #[test]
    fn delete_session_cascades_to_messages() {
        let mut repo = fresh();
        repo.create_session("s", "t", 1, None, None).unwrap();
        repo.append_message("m1", "s", "user", "hi", 2, false)
            .unwrap();
        repo.append_message("m2", "s", "assistant", "hello", 3, false)
            .unwrap();
        repo.delete_session("s").unwrap();
        let msgs = repo.list_messages("s").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn append_message_bumps_session_updated() {
        let mut repo = fresh();
        repo.create_session("s", "t", 1, None, None).unwrap();
        repo.append_message("m", "s", "user", "hi", 99, false)
            .unwrap();
        let list = repo.list_sessions().unwrap();
        assert_eq!(list[0].updated_at, 99);
    }

    #[test]
    fn list_messages_in_created_order() {
        let mut repo = fresh();
        repo.create_session("s", "t", 1, None, None).unwrap();
        repo.append_message("m1", "s", "user", "a", 10, false)
            .unwrap();
        repo.append_message("m2", "s", "assistant", "b", 20, false)
            .unwrap();
        repo.append_message("m3", "s", "user", "c", 30, false)
            .unwrap();
        let msgs = repo.list_messages("s").unwrap();
        assert_eq!(msgs.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
                   vec!["m1", "m2", "m3"]);
    }

    #[test]
    fn stopped_flag_round_trips() {
        let mut repo = fresh();
        repo.create_session("s", "t", 1, None, None).unwrap();
        repo.append_message("m", "s", "assistant", "partial", 2, true)
            .unwrap();
        let msgs = repo.list_messages("s").unwrap();
        assert!(msgs[0].stopped);
    }

    #[test]
    fn role_check_rejects_invalid_role() {
        let mut repo = fresh();
        repo.create_session("s", "t", 1, None, None).unwrap();
        let err = repo.append_message("m", "s", "system", "x", 2, false);
        assert!(err.is_err(), "system role must be rejected by CHECK");
    }
}
