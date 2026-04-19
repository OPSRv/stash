use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DownloadJob {
    pub id: i64,
    pub url: String,
    pub platform: String,
    pub title: Option<String>,
    pub thumbnail_url: Option<String>,
    pub format_id: Option<String>,
    pub target_path: Option<String>,
    pub status: String, // pending, active, paused, completed, failed, cancelled
    pub progress: f64,
    pub bytes_total: Option<i64>,
    pub bytes_done: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

pub struct JobRepo {
    conn: Connection,
}

impl JobRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS download_jobs (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                url            TEXT NOT NULL,
                platform       TEXT NOT NULL,
                title          TEXT,
                thumbnail_url  TEXT,
                format_id      TEXT,
                target_path    TEXT,
                status         TEXT NOT NULL DEFAULT 'pending',
                progress       REAL NOT NULL DEFAULT 0,
                bytes_total    INTEGER,
                bytes_done     INTEGER,
                error          TEXT,
                created_at     INTEGER NOT NULL,
                completed_at   INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_download_jobs_created
                ON download_jobs(created_at DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn create(
        &mut self,
        url: &str,
        platform: &str,
        title: Option<&str>,
        thumbnail_url: Option<&str>,
        format_id: Option<&str>,
        created_at: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO download_jobs
             (url, platform, title, thumbnail_url, format_id, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
            params![url, platform, title, thumbnail_url, format_id, created_at],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn set_status(&mut self, id: i64, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE download_jobs SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn set_progress(
        &mut self,
        id: i64,
        progress: f64,
        bytes_done: Option<i64>,
        bytes_total: Option<i64>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE download_jobs
             SET progress = ?1, bytes_done = ?2, bytes_total = ?3, status = 'active'
             WHERE id = ?4",
            params![progress, bytes_done, bytes_total, id],
        )?;
        Ok(())
    }

    pub fn set_completed(&mut self, id: i64, target_path: &str, completed_at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE download_jobs
             SET status = 'completed', progress = 1.0, target_path = ?1, completed_at = ?2
             WHERE id = ?3",
            params![target_path, completed_at, id],
        )?;
        Ok(())
    }

    pub fn set_failed(&mut self, id: i64, error: &str, completed_at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE download_jobs
             SET status = 'failed', error = ?1, completed_at = ?2
             WHERE id = ?3",
            params![error, completed_at, id],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get(&self, id: i64) -> Result<Option<DownloadJob>> {
        self.conn
            .query_row(
                "SELECT * FROM download_jobs WHERE id = ?1",
                params![id],
                Self::map_row,
            )
            .optional()
    }

    pub fn list(&self, limit: usize) -> Result<Vec<DownloadJob>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM download_jobs ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        rows.collect()
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM download_jobs WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_completed(&mut self) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM download_jobs WHERE status IN ('completed', 'failed', 'cancelled')",
            [],
        )?)
    }

    /// Delete terminal-state jobs whose `completed_at` is older than
    /// `cutoff_ts` (unix seconds). Rows without a completed_at are left
    /// alone. Returns how many rows were removed. Files on disk are not
    /// touched — only DB bookkeeping.
    pub fn prune_completed_older_than(&mut self, cutoff_ts: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM download_jobs
             WHERE status IN ('completed', 'failed', 'cancelled')
               AND completed_at IS NOT NULL
               AND completed_at < ?1",
            params![cutoff_ts],
        )?)
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<DownloadJob> {
        Ok(DownloadJob {
            id: row.get("id")?,
            url: row.get("url")?,
            platform: row.get("platform")?,
            title: row.get("title")?,
            thumbnail_url: row.get("thumbnail_url")?,
            format_id: row.get("format_id")?,
            target_path: row.get("target_path")?,
            status: row.get("status")?,
            progress: row.get("progress")?,
            bytes_total: row.get("bytes_total")?,
            bytes_done: row.get("bytes_done")?,
            error: row.get("error")?,
            created_at: row.get("created_at")?,
            completed_at: row.get("completed_at")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> JobRepo {
        JobRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn create_then_get_returns_job() {
        let mut repo = fresh();
        let id = repo
            .create("https://x.com/a", "twitter", Some("Nice post"), None, Some("22"), 100)
            .unwrap();
        let job = repo.get(id).unwrap().unwrap();
        assert_eq!(job.url, "https://x.com/a");
        assert_eq!(job.platform, "twitter");
        assert_eq!(job.title.as_deref(), Some("Nice post"));
        assert_eq!(job.status, "pending");
        assert_eq!(job.progress, 0.0);
    }

    #[test]
    fn set_progress_flips_status_to_active() {
        let mut repo = fresh();
        let id = repo.create("u", "g", None, None, None, 1).unwrap();
        repo.set_progress(id, 0.5, Some(500), Some(1000)).unwrap();
        let job = repo.get(id).unwrap().unwrap();
        assert_eq!(job.status, "active");
        assert_eq!(job.progress, 0.5);
        assert_eq!(job.bytes_done, Some(500));
    }

    #[test]
    fn set_completed_stores_target_path() {
        let mut repo = fresh();
        let id = repo.create("u", "g", None, None, None, 1).unwrap();
        repo.set_completed(id, "/Movies/a.mp4", 999).unwrap();
        let job = repo.get(id).unwrap().unwrap();
        assert_eq!(job.status, "completed");
        assert_eq!(job.progress, 1.0);
        assert_eq!(job.target_path.as_deref(), Some("/Movies/a.mp4"));
        assert_eq!(job.completed_at, Some(999));
    }

    #[test]
    fn set_failed_keeps_error_message() {
        let mut repo = fresh();
        let id = repo.create("u", "g", None, None, None, 1).unwrap();
        repo.set_failed(id, "yt-dlp exploded", 5).unwrap();
        let job = repo.get(id).unwrap().unwrap();
        assert_eq!(job.status, "failed");
        assert_eq!(job.error.as_deref(), Some("yt-dlp exploded"));
    }

    #[test]
    fn list_returns_newest_first() {
        let mut repo = fresh();
        repo.create("older", "g", None, None, None, 100).unwrap();
        repo.create("newer", "g", None, None, None, 200).unwrap();
        let jobs = repo.list(10).unwrap();
        assert_eq!(jobs[0].url, "newer");
        assert_eq!(jobs[1].url, "older");
    }

    #[test]
    fn clear_completed_keeps_active_jobs() {
        let mut repo = fresh();
        let active = repo.create("a", "g", None, None, None, 1).unwrap();
        repo.set_progress(active, 0.3, None, None).unwrap();
        let done = repo.create("d", "g", None, None, None, 2).unwrap();
        repo.set_completed(done, "/x", 10).unwrap();
        let failed = repo.create("f", "g", None, None, None, 3).unwrap();
        repo.set_failed(failed, "oops", 20).unwrap();

        let removed = repo.clear_completed().unwrap();
        assert_eq!(removed, 2);
        let jobs = repo.list(10).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, active);
    }

    #[test]
    fn prune_completed_older_than_respects_cutoff() {
        let mut repo = fresh();
        let old = repo.create("old", "g", None, None, None, 1).unwrap();
        repo.set_completed(old, "/x", 100).unwrap();
        let recent = repo.create("recent", "g", None, None, None, 2).unwrap();
        repo.set_completed(recent, "/y", 900).unwrap();
        let active = repo.create("active", "g", None, None, None, 3).unwrap();
        repo.set_progress(active, 0.1, None, None).unwrap();

        let removed = repo.prune_completed_older_than(500).unwrap();
        assert_eq!(removed, 1);
        assert!(repo.get(old).unwrap().is_none());
        assert!(repo.get(recent).unwrap().is_some());
        assert!(repo.get(active).unwrap().is_some());
    }

    #[test]
    fn delete_removes_single_job() {
        let mut repo = fresh();
        let id = repo.create("u", "g", None, None, None, 1).unwrap();
        repo.delete(id).unwrap();
        assert!(repo.get(id).unwrap().is_none());
    }
}
