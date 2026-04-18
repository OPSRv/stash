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
    fn delete_item_removes_it() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("bye", 1).unwrap();

        delete_item(&state, id).unwrap();

        assert!(list_items(&state, 10).unwrap().is_empty());
    }
}
