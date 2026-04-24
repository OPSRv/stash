//! Tauri commands glueing the backup crate to the frontend.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

use super::export::{describe_all, export_to, suggested_filename, ExportOptions, ExportReport};
use super::import::{inspect, stage, ImportSelection, InspectReport, LAST_ERROR_FILE};
use super::ModuleDescription;

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("data_dir: {e}"))
}

#[tauri::command]
pub fn backup_describe<R: Runtime>(app: AppHandle<R>) -> Result<Vec<ModuleDescription>, String> {
    let d = data_dir(&app)?;
    Ok(describe_all(&d).into_values().collect())
}

#[tauri::command]
pub fn backup_export<R: Runtime>(
    app: AppHandle<R>,
    out_path: String,
    options: ExportOptions,
) -> Result<ExportReport, String> {
    let d = data_dir(&app)?;
    let out = PathBuf::from(out_path);
    export_to(&d, &out, &options)
}

#[tauri::command]
pub fn backup_suggest_filename() -> String {
    suggested_filename()
}

#[tauri::command]
pub fn backup_inspect(path: String) -> Result<InspectReport, String> {
    inspect(&PathBuf::from(path))
}

/// Stages the archive for the next startup and triggers a restart. The
/// frontend should show a blocking confirmation before invoking this,
/// because the popup will disappear and the app will relaunch.
#[tauri::command]
pub fn backup_import<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    selection: ImportSelection,
) -> Result<(), String> {
    let d = data_dir(&app)?;
    stage(&d, &PathBuf::from(path), &selection)?;
    // Give Tauri a tick to serialise the response before exiting.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        app_clone.restart();
    });
    Ok(())
}

/// Returns the JSON body of `last-import-error.json` if present. The UI
/// reads this on startup so a failed apply-pending can be surfaced.
#[tauri::command]
pub fn backup_last_error<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let p = data_dir(&app)?.join(LAST_ERROR_FILE);
    if !p.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    Ok(Some(s))
}

#[tauri::command]
pub fn backup_dismiss_error<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let p = data_dir(&app)?.join(LAST_ERROR_FILE);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("remove: {e}"))?;
    }
    Ok(())
}
