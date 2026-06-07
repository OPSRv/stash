use rusqlite::{params, Connection, Result};

/// One stored take. `file_name` is relative to the recorder audio dir so the
/// database stays portable if the app-data root ever moves; commands join it
/// with the live dir to hand the frontend an absolute path.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordingRow {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub ext: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub device: Option<String>,
    pub favorite: bool,
    pub created_at: i64,
}

pub struct RecorderRepo {
    conn: Connection,
}

impl RecorderRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS recordings (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                file_name   TEXT NOT NULL,
                ext         TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                size_bytes  INTEGER NOT NULL DEFAULT 0,
                device      TEXT,
                favorite    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_recordings_created
                ON recordings(created_at DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn insert(&mut self, row: &RecordingRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO recordings
                (id, name, file_name, ext, duration_ms, size_bytes, device, favorite, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                row.id,
                row.name,
                row.file_name,
                row.ext,
                row.duration_ms,
                row.size_bytes,
                row.device,
                row.favorite as i64,
                row.created_at,
            ],
        )?;
        Ok(())
    }

    /// Newest first — the embedded list reads top-down and the freshest take
    /// is what the user just cut, so it should sit at the top.
    pub fn list(&self) -> Result<Vec<RecordingRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, file_name, ext, duration_ms, size_bytes, device, favorite, created_at
             FROM recordings
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::map_row)?;
        rows.collect()
    }

    pub fn get(&self, id: &str) -> Result<Option<RecordingRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, file_name, ext, duration_ms, size_bytes, device, favorite, created_at
             FROM recordings WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Self::map_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<()> {
        self.conn
            .execute("UPDATE recordings SET name = ?1 WHERE id = ?2", params![name, id])?;
        Ok(())
    }

    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET favorite = ?1 WHERE id = ?2",
            params![favorite as i64, id],
        )?;
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM recordings WHERE id = ?1", params![id])?;
        Ok(())
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<RecordingRow> {
        Ok(RecordingRow {
            id: row.get("id")?,
            name: row.get("name")?,
            file_name: row.get("file_name")?,
            ext: row.get("ext")?,
            duration_ms: row.get("duration_ms")?,
            size_bytes: row.get("size_bytes")?,
            device: row.get("device")?,
            favorite: row.get::<_, i64>("favorite")? != 0,
            created_at: row.get("created_at")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> RecorderRepo {
        RecorderRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn sample(id: &str, created_at: i64) -> RecordingRow {
        RecordingRow {
            id: id.into(),
            name: format!("Take {id}"),
            file_name: format!("{id}.webm"),
            ext: "webm".into(),
            duration_ms: 1500,
            size_bytes: 4096,
            device: Some("Built-in Microphone".into()),
            favorite: false,
            created_at,
        }
    }

    #[test]
    fn insert_and_list_newest_first() {
        let mut r = repo();
        r.insert(&sample("a", 100)).unwrap();
        r.insert(&sample("b", 200)).unwrap();
        let all = r.list().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "b");
        assert_eq!(all[1].id, "a");
    }

    #[test]
    fn rename_and_favorite_roundtrip() {
        let mut r = repo();
        r.insert(&sample("a", 100)).unwrap();
        r.rename("a", "First riff").unwrap();
        r.set_favorite("a", true).unwrap();
        let got = r.get("a").unwrap().unwrap();
        assert_eq!(got.name, "First riff");
        assert!(got.favorite);
    }

    #[test]
    fn delete_removes_row() {
        let mut r = repo();
        r.insert(&sample("a", 100)).unwrap();
        r.delete("a").unwrap();
        assert!(r.get("a").unwrap().is_none());
        assert!(r.list().unwrap().is_empty());
    }
}
