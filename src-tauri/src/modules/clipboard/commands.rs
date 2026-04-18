use crate::modules::clipboard::repo::{ClipboardItem, ClipboardRepo};
use rusqlite::Result;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct ClipboardState {
    pub repo: Mutex<ClipboardRepo>,
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

pub fn paste_prepare(state: &ClipboardState, id: i64, now: i64) -> Result<String> {
    let mut repo = state.repo.lock().unwrap();
    let item = repo
        .get(id)?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
    repo.touch(id, now)?;
    Ok(item.content)
}

fn to_string_err<T, E: std::fmt::Display>(r: std::result::Result<T, E>) -> std::result::Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_list(state: State<'_, Arc<ClipboardState>>) -> std::result::Result<Vec<ClipboardItem>, String> {
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
    let content = to_string_err(paste_prepare(&state, id, now))?;

    if let Some(win) = tauri::Manager::get_webview_window(&app, "popup") {
        let _ = win.hide();
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(content).map_err(|e| e.to_string())?;

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
    fn paste_prepare_returns_content_and_touches_timestamp() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("paste me", 100).unwrap();

        let content = paste_prepare(&state, id, 999).unwrap();

        assert_eq!(content, "paste me");
        let item = state.repo.lock().unwrap().get(id).unwrap().unwrap();
        assert_eq!(item.created_at, 999);
    }

    #[test]
    fn paste_prepare_errors_for_unknown_id() {
        let state = fresh_state();
        let result = paste_prepare(&state, 9999, 0);
        assert!(result.is_err());
    }

    #[test]
    fn delete_item_removes_it() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("bye", 1).unwrap();

        delete_item(&state, id).unwrap();

        assert!(list_items(&state, 10).unwrap().is_empty());
    }
}
