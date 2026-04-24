use super::battery::{self, BatteryHealth};
use super::caches::{self, CacheEntry};
use super::cancel;
use super::dashboard::{self, DashboardMetrics};
use super::disk_hogs::{
    self, IosBackup, MailAttachmentsBucket, Screenshot, TmSnapshot, XcodeSimulator,
};
use super::displays::{self, DisplayDevice, DisplayInfo};
use super::docker::{self, DockerStatus, PruneResult};
use super::duplicates::{self, DuplicateGroup};
use super::large_files::{self, ScanSummary};
use super::launch_agents::{self, LaunchAgent};
use super::network::{self, NetConnection};
use super::node_modules::{self, NodeModulesEntry};
use super::privacy::{self, PrivacyItem};
use super::processes::{self, ProcessInfo};
use super::quick_actions;
use super::trash_bins::{self, TrashBin};
use super::uninstaller::{self, Application, Leftover};
use std::path::PathBuf;

#[cfg(target_os = "macos")]
use super::frontmost::{self, FrontmostApp};

/// Return the currently-frontmost macOS app. `None` is valid — during
/// login-window transitions the system briefly has no active app.
/// Cross-platform stub returns `Ok(None)` so frontend callers don't
/// have to branch on platform.
#[tauri::command]
pub async fn system_frontmost_app() -> Result<Option<FrontmostAppDto>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(frontmost::current().map(Into::into))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
#[derive(serde::Serialize)]
pub struct FrontmostAppDto {
    pub bundle_id: Option<String>,
    pub name: String,
    pub pid: i32,
}

#[cfg(target_os = "macos")]
impl From<FrontmostApp> for FrontmostAppDto {
    fn from(f: FrontmostApp) -> Self {
        Self {
            bundle_id: f.bundle_id,
            name: f.name,
            pid: f.pid,
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[derive(serde::Serialize)]
pub struct FrontmostAppDto {
    pub bundle_id: Option<String>,
    pub name: String,
    pub pid: i32,
}

fn resolve_home() -> Result<PathBuf, String> {
    dirs_next::home_dir().ok_or_else(|| "no home dir".to_string())
}

#[tauri::command]
pub async fn system_list_processes() -> Result<Vec<ProcessInfo>, String> {
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

#[tauri::command]
pub async fn system_list_displays() -> Result<Vec<DisplayInfo>, String> {
    tauri::async_runtime::spawn_blocking(displays::list_displays)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_sleep_displays() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(displays::sleep_displays)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_adjust_brightness(up: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || displays::adjust_brightness(up))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_hardware_displays() -> Result<Vec<DisplayDevice>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok::<_, String>(displays::list_hardware_displays()))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_set_display_brightness(id: u32, value: f32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || displays::set_display_brightness(id, value))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_set_display_hidden(
    secondary: u32,
    master: u32,
    hide: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        displays::set_display_hidden(secondary, master, hide)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_power_off_display(secondary: u32, master: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || displays::power_off_display(secondary, master))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_power_on_display(secondary: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || displays::power_on_display(secondary))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- docker ----

#[tauri::command]
pub async fn system_docker_status() -> Result<DockerStatus, String> {
    tauri::async_runtime::spawn_blocking(|| Ok::<_, String>(docker::status()))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_docker_prune() -> Result<PruneResult, String> {
    tauri::async_runtime::spawn_blocking(docker::prune)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_scan_large_files(
    root: Option<String>,
    min_bytes: u64,
    limit: Option<usize>,
) -> Result<ScanSummary, String> {
    let root_path = match root {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => resolve_home()?,
    };
    let cap = limit.unwrap_or(500);
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(large_files::scan(&root_path, min_bytes, cap))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || large_files::move_to_trash(&path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_caches() -> Result<Vec<CacheEntry>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(caches::list_caches(&home)))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_launch_agents() -> Result<Vec<LaunchAgent>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(launch_agents::list_agents(&home)))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_toggle_launch_agent(path: String, enable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch_agents::toggle_agent(&path, enable))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_apps() -> Result<Vec<Application>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(uninstaller::list_apps(&home)))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_find_leftovers(
    bundle_id: Option<String>,
    app_name: String,
) -> Result<Vec<Leftover>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(uninstaller::find_leftovers(
            &home,
            bundle_id.as_deref(),
            &app_name,
        ))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ---- dashboard ----

#[tauri::command]
pub async fn system_dashboard_metrics() -> Result<DashboardMetrics, String> {
    tauri::async_runtime::spawn_blocking(|| Ok::<_, String>(dashboard::metrics()))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- trash bins ----

#[tauri::command]
pub async fn system_list_trash_bins() -> Result<Vec<TrashBin>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(trash_bins::list_bins(&home)))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_empty_trash() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(trash_bins::empty_all)
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- node_modules ----

#[tauri::command]
pub async fn system_scan_node_modules(root: String) -> Result<Vec<NodeModulesEntry>, String> {
    if root.is_empty() {
        return Err("empty root".into());
    }
    let rootp = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(node_modules::scan(&rootp)))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- disk hogs (screenshots, iOS, mail, Xcode, TM) ----

#[tauri::command]
pub async fn system_list_screenshots() -> Result<Vec<Screenshot>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(disk_hogs::list_screenshots(&home))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_ios_backups() -> Result<Vec<IosBackup>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(disk_hogs::list_ios_backups(&home))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_mail_attachments() -> Result<Vec<MailAttachmentsBucket>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(disk_hogs::list_mail_attachments(&home))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_xcode_simulators() -> Result<Vec<XcodeSimulator>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(disk_hogs::list_xcode_simulators(&home))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_delete_unavailable_simulators() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(disk_hogs::delete_unavailable_simulators)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_list_tm_snapshots() -> Result<Vec<TmSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok::<_, String>(disk_hogs::list_tm_snapshots()))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_delete_tm_snapshot(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || disk_hogs::delete_tm_snapshot(&name))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- duplicates ----

#[tauri::command]
pub async fn system_find_duplicates(
    root: String,
    min_bytes: Option<u64>,
) -> Result<Vec<DuplicateGroup>, String> {
    if root.is_empty() {
        return Err("empty root".into());
    }
    let rootp = PathBuf::from(root);
    let threshold = min_bytes.unwrap_or(1024 * 1024); // 1 MiB default
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(duplicates::find(&rootp, threshold))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ---- battery ----

#[tauri::command]
pub async fn system_battery_health() -> Result<BatteryHealth, String> {
    tauri::async_runtime::spawn_blocking(|| Ok::<_, String>(battery::read_health()))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- quick actions ----

#[tauri::command]
pub async fn system_sleep_now() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(quick_actions::sleep_now)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_lock_screen() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(quick_actions::lock_screen)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_flush_dns() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(quick_actions::flush_dns)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_reindex_spotlight() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(quick_actions::reindex_spotlight)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn system_empty_memory_pressure() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(quick_actions::empty_memory_pressure)
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- privacy ----

#[tauri::command]
pub async fn system_list_privacy() -> Result<Vec<PrivacyItem>, String> {
    let home = resolve_home()?;
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(privacy::list_privacy(&home)))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---- cancellation ----

#[tauri::command]
pub async fn system_cancel_scan(kind: String) -> Result<bool, String> {
    Ok(cancel::cancel(&kind))
}

// ---- network ----

#[tauri::command]
pub async fn system_list_connections() -> Result<Vec<NetConnection>, String> {
    tauri::async_runtime::spawn_blocking(network::list_connections)
        .await
        .map_err(|e| format!("join: {e}"))?
}
