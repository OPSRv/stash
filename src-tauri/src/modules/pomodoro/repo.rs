use rusqlite::{params, Connection, OptionalExtension, Result};

use super::model::{Block, Preset, SessionRow};

pub struct PomodoroRepo {
    conn: Connection,
}

impl PomodoroRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pomodoro_presets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                blocks_json TEXT NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pomodoro_sessions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                preset_id     INTEGER,
                started_at    INTEGER NOT NULL,
                ended_at      INTEGER,
                blocks_json   TEXT NOT NULL,
                completed_idx INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_started
                ON pomodoro_sessions(started_at DESC);",
        )?;
        Ok(Self { conn })
    }

    // --- Presets ---------------------------------------------------------

    /// Upsert by unique `name`. Returns the resulting row. Using name as the
    /// upsert key keeps the preset library small (no "Untitled 7" accidental
    /// duplicates) and matches how a casual user thinks about "save over".
    pub fn save_preset(&mut self, name: &str, blocks: &[Block], now: i64) -> Result<Preset> {
        let blocks_json = serde_json::to_string(blocks).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(e))
        })?;
        self.conn.execute(
            "INSERT INTO pomodoro_presets (name, blocks_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET
                blocks_json = excluded.blocks_json,
                updated_at = excluded.updated_at",
            params![name, blocks_json, now],
        )?;
        let id: i64 = self.conn.query_row(
            "SELECT id FROM pomodoro_presets WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        Ok(Preset {
            id,
            name: name.to_string(),
            blocks: blocks.to_vec(),
            updated_at: now,
        })
    }

    pub fn list_presets(&self) -> Result<Vec<Preset>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, blocks_json, updated_at
             FROM pomodoro_presets ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::map_preset)?;
        rows.collect()
    }

    pub fn get_preset(&self, id: i64) -> Result<Option<Preset>> {
        self.conn
            .query_row(
                "SELECT id, name, blocks_json, updated_at
                 FROM pomodoro_presets WHERE id = ?1",
                params![id],
                Self::map_preset,
            )
            .optional()
    }

    pub fn delete_preset(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM pomodoro_presets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Sessions --------------------------------------------------------

    pub fn insert_session_start(
        &mut self,
        preset_id: Option<i64>,
        blocks: &[Block],
        started_at: i64,
    ) -> Result<i64> {
        let blocks_json = serde_json::to_string(blocks).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(e))
        })?;
        self.conn.execute(
            "INSERT INTO pomodoro_sessions
                (preset_id, started_at, ended_at, blocks_json, completed_idx)
             VALUES (?1, ?2, NULL, ?3, 0)",
            params![preset_id, started_at, blocks_json],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn finalize_session(
        &mut self,
        id: i64,
        ended_at: i64,
        completed_idx: usize,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE pomodoro_sessions
             SET ended_at = ?1, completed_idx = ?2
             WHERE id = ?3",
            params![ended_at, completed_idx as i64, id],
        )?;
        Ok(())
    }

    pub fn list_sessions(&self, limit: u32) -> Result<Vec<SessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, preset_id, started_at, ended_at, blocks_json, completed_idx
             FROM pomodoro_sessions ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_session)?;
        rows.collect()
    }

    fn map_preset(row: &rusqlite::Row<'_>) -> Result<Preset> {
        let blocks_json: String = row.get("blocks_json")?;
        let blocks: Vec<Block> = serde_json::from_str(&blocks_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(e),
            )
        })?;
        Ok(Preset {
            id: row.get("id")?,
            name: row.get("name")?,
            blocks,
            updated_at: row.get("updated_at")?,
        })
    }

    fn map_session(row: &rusqlite::Row<'_>) -> Result<SessionRow> {
        let blocks_json: String = row.get("blocks_json")?;
        let blocks: Vec<Block> = serde_json::from_str(&blocks_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(e),
            )
        })?;
        let completed_idx: i64 = row.get("completed_idx")?;
        Ok(SessionRow {
            id: row.get("id")?,
            preset_id: row.get("preset_id")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            blocks,
            completed_idx: completed_idx.max(0) as usize,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pomodoro::model::Posture;

    fn fresh() -> PomodoroRepo {
        PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn block(id: &str, name: &str, dur: u32, posture: Posture) -> Block {
        Block {
            id: id.into(),
            name: name.into(),
            duration_sec: dur,
            posture,
            mid_nudge_sec: None,
        }
    }

    #[test]
    fn save_then_list_roundtrips_blocks() {
        let mut repo = fresh();
        let blocks = vec![
            block("a", "Focus", 1500, Posture::Sit),
            block("b", "Walk", 600, Posture::Walk),
        ];
        let saved = repo.save_preset("Default", &blocks, 100).unwrap();
        assert!(saved.id > 0);
        let listed = repo.list_presets().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Default");
        assert_eq!(listed[0].blocks, blocks);
        assert_eq!(listed[0].updated_at, 100);
    }

    #[test]
    fn save_preset_upserts_by_name() {
        let mut repo = fresh();
        repo.save_preset("Day", &[block("a", "A", 60, Posture::Sit)], 10)
            .unwrap();
        repo.save_preset(
            "Day",
            &[
                block("a", "A", 60, Posture::Sit),
                block("b", "B", 60, Posture::Stand),
            ],
            20,
        )
        .unwrap();
        let listed = repo.list_presets().unwrap();
        assert_eq!(listed.len(), 1, "name-collisions replace instead of dup");
        assert_eq!(listed[0].blocks.len(), 2);
        assert_eq!(listed[0].updated_at, 20);
    }

    #[test]
    fn delete_preset_removes_row() {
        let mut repo = fresh();
        let saved = repo
            .save_preset("Gone", &[block("a", "A", 60, Posture::Sit)], 10)
            .unwrap();
        repo.delete_preset(saved.id).unwrap();
        assert!(repo.get_preset(saved.id).unwrap().is_none());
        assert_eq!(repo.list_presets().unwrap().len(), 0);
    }

    #[test]
    fn session_start_then_finalize_roundtrips() {
        let mut repo = fresh();
        let blocks = vec![block("a", "Focus", 1500, Posture::Sit)];
        let sid = repo.insert_session_start(None, &blocks, 1000).unwrap();
        assert!(sid > 0);
        repo.finalize_session(sid, 2000, 1).unwrap();
        let rows = repo.list_sessions(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].started_at, 1000);
        assert_eq!(rows[0].ended_at, Some(2000));
        assert_eq!(rows[0].completed_idx, 1);
        assert_eq!(rows[0].blocks, blocks);
    }

    #[test]
    fn list_sessions_newest_first_and_bounded_by_limit() {
        let mut repo = fresh();
        let blocks = vec![block("a", "A", 60, Posture::Sit)];
        repo.insert_session_start(None, &blocks, 100).unwrap();
        repo.insert_session_start(None, &blocks, 300).unwrap();
        repo.insert_session_start(None, &blocks, 200).unwrap();
        let all = repo.list_sessions(10).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].started_at, 300);
        assert_eq!(all[1].started_at, 200);
        let limited = repo.list_sessions(2).unwrap();
        assert_eq!(limited.len(), 2);
    }

    #[test]
    fn posture_roundtrips_as_lowercase_in_blocks_json() {
        let mut repo = fresh();
        let blocks = vec![
            block("a", "Sit", 60, Posture::Sit),
            block("b", "Stand", 60, Posture::Stand),
            block("c", "Walk", 60, Posture::Walk),
        ];
        let saved = repo.save_preset("All", &blocks, 10).unwrap();
        let got = repo.get_preset(saved.id).unwrap().unwrap();
        assert_eq!(got.blocks[0].posture, Posture::Sit);
        assert_eq!(got.blocks[1].posture, Posture::Stand);
        assert_eq!(got.blocks[2].posture, Posture::Walk);
    }
}
