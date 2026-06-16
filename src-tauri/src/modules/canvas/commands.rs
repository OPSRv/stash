//! Canvas IPC surface: project persistence (SQLite) + raster assets on disk +
//! file export. The scene JSON is opaque here; only `assetId` references are
//! parsed, for garbage collection.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::State;

use super::repo::{CanvasRepo, ProjectRecord};

pub struct CanvasState {
    pub repo: Arc<Mutex<CanvasRepo>>,
    pub assets_dir: PathBuf,
}

impl CanvasState {
    pub fn new(repo: CanvasRepo, assets_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&assets_dir);
        Self {
            repo: Arc::new(Mutex::new(repo)),
            assets_dir,
        }
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Reject anything that isn't a plain asset id so a compromised frontend can't
/// escape the assets dir via `../`.
fn sanitize_asset_id(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid asset id: {id}"));
    }
    Ok(id.to_string())
}

fn asset_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.png", sanitize_asset_id(id)?)))
}

#[tauri::command]
pub fn canvas_list_projects(
    state: State<'_, CanvasState>,
) -> Result<Vec<ProjectRecord>, String> {
    state.repo.lock().map_err(err)?.list().map_err(err)
}

#[tauri::command]
pub fn canvas_save_project(
    state: State<'_, CanvasState>,
    id: String,
    title: String,
    scene_json: String,
    updated_at: i64,
    sort_order: i64,
) -> Result<(), String> {
    let rec = ProjectRecord {
        id,
        title,
        scene_json,
        updated_at,
        sort_order,
    };
    state.repo.lock().map_err(err)?.upsert(&rec).map_err(err)
}

#[tauri::command]
pub fn canvas_delete_project(state: State<'_, CanvasState>, id: String) -> Result<(), String> {
    {
        let repo = state.repo.lock().map_err(err)?;
        repo.delete(&id).map_err(err)?;
    }
    gc_assets(&state)?;
    Ok(())
}

/// Persist a raster asset (base64-encoded PNG bytes) to the assets dir.
#[tauri::command]
pub fn canvas_save_asset(
    state: State<'_, CanvasState>,
    asset_id: String,
    data_base64: String,
) -> Result<(), String> {
    let path = asset_path(&state.assets_dir, &asset_id)?;
    let bytes = STANDARD.decode(strip_data_url(&data_base64)).map_err(err)?;
    std::fs::write(path, bytes).map_err(err)
}

/// Read an asset back as base64 so the frontend can rebuild a data-URL.
#[tauri::command]
pub fn canvas_load_asset(
    state: State<'_, CanvasState>,
    asset_id: String,
) -> Result<String, String> {
    let path = asset_path(&state.assets_dir, &asset_id)?;
    let bytes = std::fs::read(path).map_err(err)?;
    Ok(STANDARD.encode(bytes))
}

/// Write a PNG (base64) to an absolute path the user picked via the save
/// dialog — backs the "Save" action.
#[tauri::command]
pub fn canvas_write_png(path: String, data_base64: String) -> Result<(), String> {
    let bytes = STANDARD.decode(strip_data_url(&data_base64)).map_err(err)?;
    std::fs::write(path, bytes).map_err(err)
}

/// Accept either a bare base64 string or a full `data:image/png;base64,…` URL.
fn strip_data_url(s: &str) -> &str {
    s.split_once(",").map(|(_, b)| b).unwrap_or(s)
}

/// Delete asset files no longer referenced by any project scene.
fn gc_assets(state: &CanvasState) -> Result<(), String> {
    let scenes = state.repo.lock().map_err(err)?.all_scene_jsons().map_err(err)?;
    let mut referenced: HashSet<String> = HashSet::new();
    for scene in &scenes {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(scene) {
            collect_asset_ids(&v, &mut referenced);
        }
    }
    let Ok(entries) = std::fs::read_dir(&state.assets_dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if !referenced.contains(stem) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    Ok(())
}

/// Walk a scene JSON value collecting every non-null `assetId` string.
fn collect_asset_ids(value: &serde_json::Value, out: &mut HashSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(id)) = map.get("assetId") {
                out.insert(id.clone());
            }
            for v in map.values() {
                collect_asset_ids(v, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_asset_ids(v, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize_asset_id("../etc").is_err());
        assert!(sanitize_asset_id("a/b").is_err());
        assert!(sanitize_asset_id("").is_err());
        assert!(sanitize_asset_id("image_abc-123").is_ok());
    }

    #[test]
    fn strip_data_url_handles_both_forms() {
        assert_eq!(strip_data_url("AAAA"), "AAAA");
        assert_eq!(strip_data_url("data:image/png;base64,AAAA"), "AAAA");
    }

    #[test]
    fn collect_asset_ids_walks_nested_scene() {
        let scene = serde_json::json!({
            "nodes": [
                { "tool": "image", "assetId": "img_1" },
                { "tool": "rect", "assetId": serde_json::Value::Null },
                { "tool": "group", "children": [ { "assetId": "img_2" } ] }
            ]
        });
        let mut set = HashSet::new();
        collect_asset_ids(&scene, &mut set);
        assert!(set.contains("img_1"));
        assert!(set.contains("img_2"));
        assert_eq!(set.len(), 2, "null assetId must be skipped");
    }
}
