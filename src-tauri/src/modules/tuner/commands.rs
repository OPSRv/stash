use crate::modules::tuner::state::TunerState;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct TunerStateHandle {
    pub path: Mutex<PathBuf>,
}

impl TunerStateHandle {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Mutex::new(path),
        }
    }
}

fn resolve_path(app: &tauri::AppHandle, fallback: &PathBuf) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("tuner.json"))
        .unwrap_or_else(|_| fallback.clone())
}

#[tauri::command]
pub fn tuner_get_state(
    app: tauri::AppHandle,
    state: State<'_, TunerStateHandle>,
) -> Result<TunerState, String> {
    let fallback = state.path.lock().unwrap().clone();
    let path = resolve_path(&app, &fallback);
    Ok(TunerState::load(&path))
}

#[tauri::command]
pub fn tuner_save_state(
    app: tauri::AppHandle,
    state: State<'_, TunerStateHandle>,
    payload: TunerState,
) -> Result<(), String> {
    let fallback = state.path.lock().unwrap().clone();
    let path = resolve_path(&app, &fallback);
    let mut next = payload;
    next.normalize();
    next.save(&path)
}
