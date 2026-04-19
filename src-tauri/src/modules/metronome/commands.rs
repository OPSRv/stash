use crate::modules::metronome::state::MetronomeState;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct MetronomeStateHandle {
    pub path: Mutex<PathBuf>,
}

impl MetronomeStateHandle {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Mutex::new(path),
        }
    }
}

fn resolve_path(app: &tauri::AppHandle, fallback: &PathBuf) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("metronome.json"))
        .unwrap_or_else(|_| fallback.clone())
}

#[tauri::command]
pub fn metronome_get_state(
    app: tauri::AppHandle,
    state: State<'_, MetronomeStateHandle>,
) -> Result<MetronomeState, String> {
    let fallback = state.path.lock().unwrap().clone();
    let path = resolve_path(&app, &fallback);
    Ok(MetronomeState::load(&path))
}

#[tauri::command]
pub fn metronome_save_state(
    app: tauri::AppHandle,
    state: State<'_, MetronomeStateHandle>,
    payload: MetronomeState,
) -> Result<(), String> {
    let fallback = state.path.lock().unwrap().clone();
    let path = resolve_path(&app, &fallback);
    let mut next = payload;
    next.normalize();
    next.save(&path)
}
