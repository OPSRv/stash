use crate::modules::notes::repo::{Note, NotesRepo};
use std::sync::Mutex;
use tauri::State;

pub struct NotesState {
    pub repo: Mutex<NotesRepo>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn to_string_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_list(state: State<'_, NotesState>) -> Result<Vec<Note>, String> {
    to_string_err(state.repo.lock().unwrap().list())
}

#[tauri::command]
pub fn notes_search(state: State<'_, NotesState>, query: String) -> Result<Vec<Note>, String> {
    if query.trim().is_empty() {
        return to_string_err(state.repo.lock().unwrap().list());
    }
    to_string_err(state.repo.lock().unwrap().search(&query))
}

#[tauri::command]
pub fn notes_create(
    state: State<'_, NotesState>,
    title: String,
    body: String,
) -> Result<i64, String> {
    to_string_err(state.repo.lock().unwrap().create(&title, &body, now()))
}

#[tauri::command]
pub fn notes_update(
    state: State<'_, NotesState>,
    id: i64,
    title: String,
    body: String,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().update(id, &title, &body, now()))
}

#[tauri::command]
pub fn notes_delete(state: State<'_, NotesState>, id: i64) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().delete(id))
}
