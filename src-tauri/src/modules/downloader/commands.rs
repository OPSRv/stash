use crate::modules::downloader::{
    detector::{fetch_info, fetch_oembed, pick_quality_options, QualityOption, QuickPreview, VideoInfo},
    installer,
    jobs::DownloadJob,
    platform::Platform,
    runner::{
        cancel_download, pause_download, resume_download, retry_download, spawn_download,
        CachedDetection, RunnerState,
    },
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

#[derive(Serialize)]
pub struct QuickDetect {
    pub platform: Platform,
    pub preview: QuickPreview,
}

#[tauri::command]
pub async fn dl_detect_quick(url: String) -> Result<Option<QuickDetect>, String> {
    // Runs a short oEmbed fetch (~500ms for YouTube/Vimeo) so the UI can
    // render a preview card immediately while full yt-dlp extraction
    // continues in the background. Returns None for unsupported providers.
    let url_clone = url.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || fetch_oembed(&url_clone))
        .await
        .map_err(|e| e.to_string())?;
    Ok(preview.map(|p| QuickDetect {
        platform: Platform::from_url(&url),
        preview: p,
    }))
}

fn to_string_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn resolve_yt_dlp(state: &RunnerState) -> Result<std::path::PathBuf, String> {
    let bin_dir = state.default_downloads_dir.join("bin");
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

const DETECT_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

#[tauri::command]
pub async fn dl_detect(
    state: State<'_, Arc<RunnerState>>,
    url: String,
) -> Result<DetectedVideo, String> {
    // Fast path: cached result within TTL.
    if let Some(hit) = state.detect_cache.lock().unwrap().get(&url) {
        if hit.fetched_at.elapsed() < DETECT_CACHE_TTL {
            let qualities = pick_quality_options(&hit.info);
            return Ok(DetectedVideo {
                platform: Platform::from_url(&url),
                info: hit.info.clone(),
                qualities,
            });
        }
    }

    let yt_dlp = resolve_yt_dlp(&state)?;
    let url_clone = url.clone();
    let cookies = state.cookies_browser.lock().unwrap().clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        fetch_info(&yt_dlp, &url_clone, cookies.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    let qualities = pick_quality_options(&info);

    state.detect_cache.lock().unwrap().insert(
        url.clone(),
        CachedDetection {
            info: info.clone(),
            fetched_at: std::time::Instant::now(),
        },
    );

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
    height: Option<u32>,
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
        height,
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

/// Resolve the user-supplied downloads path down to the absolute dir the
/// runner should use. Empty/None falls back to the app default.
pub(crate) fn resolve_downloads_dir(
    default_dir: &std::path::Path,
    path: Option<String>,
) -> std::path::PathBuf {
    match path {
        Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => default_dir.to_path_buf(),
    }
}

#[tauri::command]
pub fn dl_set_downloads_dir(
    state: State<'_, Arc<RunnerState>>,
    path: Option<String>,
) -> Result<(), String> {
    let next = resolve_downloads_dir(&state.default_downloads_dir, path);
    std::fs::create_dir_all(&next).ok();
    *state.downloads_dir.lock().unwrap() = next;
    Ok(())
}

#[tauri::command]
pub fn dl_pause(state: State<'_, Arc<RunnerState>>, id: i64) -> Result<(), String> {
    pause_download(&state, id)
}

#[tauri::command]
pub fn dl_resume(state: State<'_, Arc<RunnerState>>, id: i64) -> Result<(), String> {
    resume_download(&state, id)
}

#[tauri::command]
pub fn dl_retry(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    id: i64,
) -> Result<(), String> {
    let yt_dlp = resolve_yt_dlp(&state)?;
    retry_download(app, Arc::clone(&state), &yt_dlp, id)
}

#[derive(Serialize)]
pub struct YtDlpVersionInfo {
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn dl_ytdlp_version(
    state: State<'_, Arc<RunnerState>>,
) -> Result<YtDlpVersionInfo, String> {
    let path = resolve_yt_dlp(&state).ok();
    let installed = path
        .as_ref()
        .and_then(|p| installer::installed_version(p).ok());
    let latest = tauri::async_runtime::spawn_blocking(|| installer::latest_version().ok())
        .await
        .map_err(|e| e.to_string())?;
    Ok(YtDlpVersionInfo {
        installed,
        latest,
        path: path.map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub async fn dl_update_binary(state: State<'_, Arc<RunnerState>>) -> Result<String, String> {
    let bin_dir = state.default_downloads_dir.join("bin");
    let path = tauri::async_runtime::spawn_blocking(move || installer::force_reinstall(&bin_dir))
        .await
        .map_err(|e| e.to_string())??;
    *state.yt_dlp_path.lock().unwrap() = Some(path.clone());
    installer::installed_version(&path)
}

/// Coerce an arbitrary parallelism value into a safe minimum of 1.
pub(crate) fn clamp_max_parallel(value: usize) -> usize {
    value.max(1)
}

#[tauri::command]
pub fn dl_set_max_parallel(
    state: State<'_, Arc<RunnerState>>,
    value: usize,
) -> Result<(), String> {
    *state.max_parallel.lock().unwrap() = clamp_max_parallel(value);
    Ok(())
}

/// Normalise a user-supplied rate-limit string. Empty/whitespace → None so
/// the downloader stays uncapped. Returned value is trimmed.
pub(crate) fn normalize_rate_limit(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Set a global download speed cap. `value` accepts yt-dlp rate syntax
/// ("2M", "500K", "1.5M"). Pass null/empty to clear.
#[tauri::command]
pub fn dl_set_rate_limit(
    state: State<'_, Arc<RunnerState>>,
    value: Option<String>,
) -> Result<(), String> {
    *state.rate_limit.lock().unwrap() = normalize_rate_limit(value);
    Ok(())
}

#[tauri::command]
pub fn dl_prune_history(
    state: State<'_, Arc<RunnerState>>,
    older_than_days: i64,
) -> Result<usize, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = now - older_than_days.max(1) * 86_400;
    to_string_err(state.jobs.lock().unwrap().prune_completed_older_than(cutoff))
}

#[tauri::command]
pub fn dl_purge_cookies(state: State<'_, Arc<RunnerState>>) -> Result<(), String> {
    let cookies = state.default_downloads_dir.join("bin").join("arc-cookies.txt");
    if cookies.exists() {
        std::fs::remove_file(&cookies).map_err(|e| format!("remove {cookies:?}: {e}"))?;
    }
    *state.cookies_browser.lock().unwrap() = None;
    state.detect_cache.lock().unwrap().clear();
    Ok(())
}

/// Trim/lowercase a browser name input. Empty/whitespace becomes None so we
/// can clearly distinguish "unset" from a real browser selection downstream.
pub(crate) fn normalize_cookies_browser(browser: Option<String>) -> Option<String> {
    browser.and_then(|b| {
        let b = b.trim().to_lowercase();
        if b.is_empty() {
            None
        } else {
            Some(b)
        }
    })
}

#[tauri::command]
pub fn dl_set_cookies_browser(
    state: State<'_, Arc<RunnerState>>,
    browser: Option<String>,
) -> Result<(), String> {
    let trimmed = normalize_cookies_browser(browser);

    let resolved = match trimmed.as_deref() {
        None => None,
        Some("arc") => {
            // yt-dlp can't decrypt Arc cookies (wrong Keychain entry name).
            // Export them ourselves and pass via --cookies <file>.
            let cookies_dir = state.default_downloads_dir.join("bin");
            match super::arc_cookies::export_default(&cookies_dir) {
                Ok(path) => Some(format!("file:{}", path.display())),
                Err(e) => {
                    eprintln!("[downloader] arc cookies export failed: {e}");
                    return Err(format!("Arc cookies export failed: {e}"));
                }
            }
        }
        Some(other) => Some(other.to_string()),
    };

    *state.cookies_browser.lock().unwrap() = resolved;
    state.detect_cache.lock().unwrap().clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_max_parallel, normalize_cookies_browser, normalize_rate_limit,
        resolve_downloads_dir,
    };
    use std::path::PathBuf;

    #[test]
    fn resolve_downloads_dir_falls_back_to_default_for_none() {
        let default = PathBuf::from("/home/u/Movies/Stash");
        assert_eq!(resolve_downloads_dir(&default, None), default);
    }

    #[test]
    fn resolve_downloads_dir_falls_back_for_empty_string() {
        let default = PathBuf::from("/home/u/Movies/Stash");
        assert_eq!(resolve_downloads_dir(&default, Some("".into())), default);
    }

    #[test]
    fn resolve_downloads_dir_uses_supplied_path() {
        let default = PathBuf::from("/home/u/Movies/Stash");
        assert_eq!(
            resolve_downloads_dir(&default, Some("/custom".into())),
            PathBuf::from("/custom")
        );
    }

    #[test]
    fn clamp_max_parallel_enforces_min_of_one() {
        assert_eq!(clamp_max_parallel(0), 1);
        assert_eq!(clamp_max_parallel(1), 1);
        assert_eq!(clamp_max_parallel(5), 5);
    }

    #[test]
    fn normalize_rate_limit_clears_empty_values() {
        assert_eq!(normalize_rate_limit(None), None);
        assert_eq!(normalize_rate_limit(Some("".into())), None);
        assert_eq!(normalize_rate_limit(Some("   ".into())), None);
    }

    #[test]
    fn normalize_rate_limit_trims_and_preserves() {
        assert_eq!(
            normalize_rate_limit(Some("  2M  ".into())),
            Some("2M".into())
        );
        assert_eq!(
            normalize_rate_limit(Some("500K".into())),
            Some("500K".into())
        );
    }

    #[test]
    fn normalize_cookies_browser_clears_empty() {
        assert_eq!(normalize_cookies_browser(None), None);
        assert_eq!(normalize_cookies_browser(Some("".into())), None);
        assert_eq!(normalize_cookies_browser(Some("   ".into())), None);
    }

    #[test]
    fn normalize_cookies_browser_trims_and_lowercases() {
        assert_eq!(
            normalize_cookies_browser(Some("  Chrome  ".into())),
            Some("chrome".into())
        );
        assert_eq!(
            normalize_cookies_browser(Some("ARC".into())),
            Some("arc".into())
        );
    }
}
