use crate::modules::downloader::{
    detector::{fetch_info, pick_quality_options, QualityOption, VideoInfo},
    installer,
    jobs::DownloadJob,
    platform::Platform,
    runner::{cancel_download, spawn_download, RunnerState},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct DetectedVideo {
    pub platform: Platform,
    pub info: VideoInfo,
    pub qualities: Vec<QualityOption>,
}

fn to_string_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn resolve_yt_dlp(state: &RunnerState) -> Result<std::path::PathBuf, String> {
    let bin_dir = state.downloads_dir.join("bin");
    {
        let guard = state.yt_dlp_path.lock().unwrap();
        if let Some(p) = guard.clone() {
            if p.exists() {
                return Ok(p);
            }
        }
    }
    let path = installer::resolve(&bin_dir)?;
    *state.yt_dlp_path.lock().unwrap() = Some(path.clone());
    Ok(path)
}

#[tauri::command]
pub async fn dl_detect(
    state: State<'_, Arc<RunnerState>>,
    url: String,
) -> Result<DetectedVideo, String> {
    let yt_dlp = resolve_yt_dlp(&state)?;
    let url_clone = url.clone();
    let info = tauri::async_runtime::spawn_blocking(move || fetch_info(&yt_dlp, &url_clone))
        .await
        .map_err(|e| e.to_string())??;
    let qualities = pick_quality_options(&info);
    Ok(DetectedVideo {
        platform: Platform::from_url(&url),
        info,
        qualities,
    })
}

#[tauri::command]
pub fn dl_start(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    url: String,
    title: Option<String>,
    thumbnail: Option<String>,
    format_id: Option<String>,
    kind: String,
) -> Result<i64, String> {
    let yt_dlp = resolve_yt_dlp(&state)?;
    let platform = Platform::from_url(&url);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let id = {
        let mut repo = state.jobs.lock().unwrap();
        to_string_err(repo.create(
            &url,
            serde_json::to_string(&platform)
                .map(|s| s.trim_matches('"').to_string())
                .unwrap_or_else(|_| "generic".into())
                .as_str(),
            title.as_deref(),
            thumbnail.as_deref(),
            format_id.as_deref(),
            now,
        ))?
    };
    spawn_download(
        app,
        Arc::clone(&state),
        &yt_dlp,
        id,
        &url,
        format_id.as_deref(),
        &kind,
    )?;
    Ok(id)
}

#[tauri::command]
pub fn dl_cancel(state: State<'_, Arc<RunnerState>>, id: i64) -> Result<(), String> {
    cancel_download(&state, id)
}

#[tauri::command]
pub fn dl_list(state: State<'_, Arc<RunnerState>>) -> Result<Vec<DownloadJob>, String> {
    to_string_err(state.jobs.lock().unwrap().list(500))
}

#[tauri::command]
pub fn dl_delete(state: State<'_, Arc<RunnerState>>, id: i64) -> Result<(), String> {
    to_string_err(state.jobs.lock().unwrap().delete(id))
}

#[tauri::command]
pub fn dl_clear_completed(state: State<'_, Arc<RunnerState>>) -> Result<usize, String> {
    to_string_err(state.jobs.lock().unwrap().clear_completed())
}
