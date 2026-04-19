use crate::modules::clipboard::og::{self, LinkPreview};
use crate::modules::clipboard::repo::{ClipboardItem, ClipboardRepo};
use rusqlite::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

/// In-memory cache for LinkPreview lookups. Keyed by URL. Stores both hits
/// (Some) and misses (None) so the UI never re-hammers a URL that doesn't
/// expose og metadata.
pub struct LinkPreviewState {
    cache: Mutex<HashMap<String, Option<LinkPreview>>>,
}

const LINK_PREVIEW_CACHE_CAP: usize = 500;

impl LinkPreviewState {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, url: &str) -> Option<Option<LinkPreview>> {
        self.cache.lock().unwrap().get(url).cloned()
    }

    fn put(&self, url: String, value: Option<LinkPreview>) {
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= LINK_PREVIEW_CACHE_CAP {
            // Very coarse eviction — drop a random chunk. This cache is
            // per-process and short-lived, so precise LRU is overkill.
            let to_drop: Vec<String> = cache.keys().take(LINK_PREVIEW_CACHE_CAP / 4).cloned().collect();
            for k in to_drop {
                cache.remove(&k);
            }
        }
        cache.insert(url, value);
    }
}

pub struct ClipboardState {
    pub repo: Mutex<ClipboardRepo>,
    #[allow(dead_code)]
    pub images_dir: PathBuf,
}

const DEFAULT_LIMIT: usize = 200;

pub fn list_items(state: &ClipboardState, limit: usize) -> Result<Vec<ClipboardItem>> {
    state.repo.lock().unwrap().list(limit)
}

pub fn search_items(
    state: &ClipboardState,
    query: &str,
    limit: usize,
) -> Result<Vec<ClipboardItem>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return state.repo.lock().unwrap().list(limit);
    }
    state.repo.lock().unwrap().search(trimmed, limit)
}

pub fn toggle_pin(state: &ClipboardState, id: i64) -> Result<()> {
    state.repo.lock().unwrap().toggle_pin(id)
}

pub fn delete_item(state: &ClipboardState, id: i64) -> Result<()> {
    state.repo.lock().unwrap().delete(id)
}

pub fn clear_all(state: &ClipboardState) -> Result<usize> {
    state.repo.lock().unwrap().clear_all()
}

#[allow(dead_code)]
pub fn trim_to_cap(state: &ClipboardState, cap: usize) -> Result<usize> {
    state.repo.lock().unwrap().trim_to_cap(cap)
}

pub fn paste_prepare(state: &ClipboardState, id: i64, now: i64) -> Result<ClipboardItem> {
    let mut repo = state.repo.lock().unwrap();
    let item = repo
        .get(id)?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
    repo.touch(id, now)?;
    Ok(item)
}

fn to_string_err<T, E: std::fmt::Display>(r: std::result::Result<T, E>) -> std::result::Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_list(
    state: State<'_, Arc<ClipboardState>>,
) -> std::result::Result<Vec<ClipboardItem>, String> {
    to_string_err(list_items(&state, DEFAULT_LIMIT))
}

#[tauri::command]
pub fn clipboard_search(
    state: State<'_, Arc<ClipboardState>>,
    query: String,
) -> std::result::Result<Vec<ClipboardItem>, String> {
    to_string_err(search_items(&state, &query, DEFAULT_LIMIT))
}

#[tauri::command]
pub fn clipboard_toggle_pin(
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    to_string_err(toggle_pin(&state, id))
}

#[tauri::command]
pub fn clipboard_clear(
    state: State<'_, Arc<ClipboardState>>,
) -> std::result::Result<usize, String> {
    to_string_err(clear_all(&state))
}

#[tauri::command]
pub fn clipboard_copy_only(
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let item = to_string_err(paste_prepare(&state, id, now))?;
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match item.kind.as_str() {
        "text" => clipboard.set_text(item.content).map_err(|e| e.to_string())?,
        "image" => {
            let meta = item.meta.unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
            let path = parsed
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "image meta.path missing".to_string())?;
            let img = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
            let (w, h) = img.dimensions();
            let data = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(img.into_raw()),
            };
            clipboard.set_image(data).map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(())
}

/// Resolve and cache a link preview for the given URL. Returns None when
/// the page has no usable og/twitter metadata (the miss is also cached).
#[tauri::command]
pub async fn clipboard_link_preview(
    state: State<'_, Arc<LinkPreviewState>>,
    url: String,
) -> std::result::Result<Option<LinkPreview>, String> {
    let url = url.trim().to_string();
    if url.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(None);
    }
    if let Some(cached) = state.get(&url) {
        return Ok(cached);
    }
    let url_for_fetch = url.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || og::fetch_preview(&url_for_fetch))
        .await
        .map_err(|e| e.to_string())?;
    state.put(url, preview.clone());
    Ok(preview)
}

#[tauri::command]
pub fn clipboard_delete(
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    to_string_err(delete_item(&state, id))
}

#[tauri::command]
pub fn clipboard_paste(
    app: tauri::AppHandle,
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let item = to_string_err(paste_prepare(&state, id, now))?;

    if let Some(win) = tauri::Manager::get_webview_window(&app, "popup") {
        let _ = win.hide();
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;

    match item.kind.as_str() {
        "text" => {
            clipboard.set_text(item.content).map_err(|e| e.to_string())?;
        }
        "image" => {
            let meta = item.meta.unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
            let path = parsed
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "image meta.path missing".to_string())?;
            let img = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
            let (w, h) = img.dimensions();
            let data = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(img.into_raw()),
            };
            clipboard.set_image(data).map_err(|e| e.to_string())?;
        }
        other => return Err(format!("unknown kind: {other}")),
    }

    #[cfg(target_os = "macos")]
    simulate_cmd_v()?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn simulate_cmd_v() -> std::result::Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    std::thread::sleep(std::time::Duration::from_millis(80));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.key(Key::Meta, Direction::Press).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo.key(Key::Meta, Direction::Release).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_state() -> ClipboardState {
        let repo = ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        ClipboardState {
            repo: Mutex::new(repo),
            images_dir: PathBuf::from("/tmp/stash-test"),
        }
    }

    #[test]
    fn list_returns_inserted_items_newest_first() {
        let state = fresh_state();
        state.repo.lock().unwrap().insert_text("older", 100).unwrap();
        state.repo.lock().unwrap().insert_text("newer", 200).unwrap();

        let items = list_items(&state, 10).unwrap();

        assert_eq!(items[0].content, "newer");
        assert_eq!(items[1].content, "older");
    }

    #[test]
    fn search_filters_items_by_substring() {
        let state = fresh_state();
        state.repo.lock().unwrap().insert_text("apple", 1).unwrap();
        state.repo.lock().unwrap().insert_text("banana", 2).unwrap();

        let items = search_items(&state, "ban", 10).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content, "banana");
    }

    #[test]
    fn empty_search_query_returns_list() {
        let state = fresh_state();
        state.repo.lock().unwrap().insert_text("only", 1).unwrap();

        let items = search_items(&state, "", 10).unwrap();

        assert_eq!(items.len(), 1);
    }

    #[test]
    fn toggle_pin_flips_flag() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("pin", 1).unwrap();

        toggle_pin(&state, id).unwrap();

        let items = list_items(&state, 10).unwrap();
        assert!(items[0].pinned);
    }

    #[test]
    fn paste_prepare_returns_item_and_touches_timestamp() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("paste me", 100).unwrap();

        let item = paste_prepare(&state, id, 999).unwrap();

        assert_eq!(item.content, "paste me");
        assert_eq!(item.kind, "text");
        let reloaded = state.repo.lock().unwrap().get(id).unwrap().unwrap();
        assert_eq!(reloaded.created_at, 999);
    }

    #[test]
    fn paste_prepare_errors_for_unknown_id() {
        let state = fresh_state();
        let result = paste_prepare(&state, 9999, 0);
        assert!(result.is_err());
    }

    #[test]
    fn link_preview_state_caches_hits_and_misses() {
        let state = LinkPreviewState::new();
        let url = "https://example.com/page".to_string();
        assert!(state.get(&url).is_none());
        state.put(url.clone(), None);
        assert_eq!(state.get(&url), Some(None));
        let hit = LinkPreview {
            url: url.clone(),
            image: Some("https://cdn/og.png".into()),
            title: Some("T".into()),
            description: None,
            site_name: None,
        };
        state.put(url.clone(), Some(hit.clone()));
        assert_eq!(state.get(&url), Some(Some(hit)));
    }

    #[test]
    fn delete_item_removes_it() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("bye", 1).unwrap();

        delete_item(&state, id).unwrap();

        assert!(list_items(&state, 10).unwrap().is_empty());
    }
}
