//! SQLite store for Canvas projects. One row per project; the scene itself is
//! an opaque JSON blob owned by the frontend (`scene_json`) so the Rust side
//! never has to track the editor's evolving node model. Raster bytes live as
//! files under the assets dir (see `commands::assets_dir`) and are referenced
//! from the scene by `assetId`, keeping these rows small.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub title: String,
    pub scene_json: String,
    pub updated_at: i64,
    pub sort_order: i64,
}

pub struct CanvasRepo {
    conn: Connection,
}

impl CanvasRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                scene_json  TEXT NOT NULL,
                updated_at  INTEGER NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        Ok(Self { conn })
    }

    /// Projects in display order (sort_order ASC, then updated_at DESC).
    pub fn list(&self) -> Result<Vec<ProjectRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, scene_json, updated_at, sort_order
             FROM projects ORDER BY sort_order ASC, updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProjectRecord {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    scene_json: r.get(2)?,
                    updated_at: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Insert or replace a project by id.
    pub fn upsert(&self, rec: &ProjectRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO projects (id, title, scene_json, updated_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                scene_json = excluded.scene_json,
                updated_at = excluded.updated_at,
                sort_order = excluded.sort_order",
            params![rec.id, rec.title, rec.scene_json, rec.updated_at, rec.sort_order],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Every project's scene JSON — used by asset garbage collection to find
    /// which `assetId`s are still referenced.
    pub fn all_scene_jsons(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT scene_json FROM projects")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> CanvasRepo {
        CanvasRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn rec(id: &str, order: i64, updated: i64) -> ProjectRecord {
        ProjectRecord {
            id: id.into(),
            title: format!("Project {id}"),
            scene_json: format!("{{\"id\":\"{id}\",\"nodes\":[]}}"),
            updated_at: updated,
            sort_order: order,
        }
    }

    #[test]
    fn upsert_then_list_roundtrips() {
        let r = repo();
        r.upsert(&rec("a", 0, 100)).unwrap();
        let got = r.list().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "a");
        assert_eq!(got[0].title, "Project a");
    }

    #[test]
    fn upsert_updates_existing_row() {
        let r = repo();
        r.upsert(&rec("a", 0, 100)).unwrap();
        let mut updated = rec("a", 0, 200);
        updated.title = "Renamed".into();
        r.upsert(&updated).unwrap();
        let got = r.list().unwrap();
        assert_eq!(got.len(), 1, "upsert must not create a duplicate row");
        assert_eq!(got[0].title, "Renamed");
        assert_eq!(got[0].updated_at, 200);
    }

    #[test]
    fn list_orders_by_sort_then_recency() {
        let r = repo();
        r.upsert(&rec("a", 1, 100)).unwrap();
        r.upsert(&rec("b", 0, 50)).unwrap();
        r.upsert(&rec("c", 0, 90)).unwrap();
        let ids: Vec<_> = r.list().unwrap().into_iter().map(|p| p.id).collect();
        // sort_order 0 first (c newer than b), then sort_order 1.
        assert_eq!(ids, vec!["c", "b", "a"]);
    }

    #[test]
    fn delete_removes_only_target() {
        let r = repo();
        r.upsert(&rec("a", 0, 100)).unwrap();
        r.upsert(&rec("b", 1, 100)).unwrap();
        r.delete("a").unwrap();
        let ids: Vec<_> = r.list().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn all_scene_jsons_returns_every_row() {
        let r = repo();
        r.upsert(&rec("a", 0, 1)).unwrap();
        r.upsert(&rec("b", 0, 1)).unwrap();
        assert_eq!(r.all_scene_jsons().unwrap().len(), 2);
    }
}
