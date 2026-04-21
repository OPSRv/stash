use super::processes::{self, ProcessInfo};

#[tauri::command]
pub async fn system_list_processes() -> Result<Vec<ProcessInfo>, String> {
    // `ps` is cheap (~5–20 ms) but we still run it off the UI/command thread
    // so a long-tail spike on a busy host doesn't stall other invocations.
    tauri::async_runtime::spawn_blocking(processes::list_processes)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_kill_process(pid: i32, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || processes::kill_process(pid, force))
        .await
        .map_err(|e| format!("join: {e}"))?
}
