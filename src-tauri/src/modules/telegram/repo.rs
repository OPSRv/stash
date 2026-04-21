use rusqlite::{params, Connection, OptionalExtension, Result};

pub struct TelegramRepo {
    conn: Connection,
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
}
