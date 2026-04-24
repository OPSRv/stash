use crate::modules::downloader::{
    detector::{
        fetch_info, fetch_oembed, pick_quality_options, QualityOption, QuickPreview, VideoInfo,
    },
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

fn ensure_http_scheme(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "scheme '{}' not allowed (only http/https)",
            parsed.scheme()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn dl_detect_quick(url: String) -> Result<Option<QuickDetect>, String> {
    // Runs a short oEmbed fetch (~500ms for YouTube/Vimeo) so the UI can
    // render a preview card immediately while full yt-dlp extraction
    // continues in the background. Returns None for unsupported providers.
    ensure_http_scheme(&url)?;
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
    ensure_http_scheme(&url)?;
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
    ensure_http_scheme(&url)?;
    let yt_dlp = resolve_yt_dlp(&state)?;
    let platform = Platform::from_url(&url);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let id = {
        let mut repo = state.jobs.lock().unwrap();
        to_string_err(
            repo.create(
                &url,
                serde_json::to_string(&platform)
                    .map(|s| s.trim_matches('"').to_string())
                    .unwrap_or_else(|_| "generic".into())
                    .as_str(),
                title.as_deref(),
                thumbnail.as_deref(),
                format_id.as_deref(),
                now,
            ),
        )?
    };
    spawn_download(app, Arc::clone(&state), &yt_dlp, id, &url, height, &kind)?;
    Ok(id)
}

#[tauri::command]
pub fn dl_cancel(state: State<'_, Arc<RunnerState>>, id: i64) -> Result<(), String> {
    cancel_download(&state, id)
}

/// Split a job list into "rows to keep" and "ids whose file vanished". Pure
/// helper so the hot path and tests can share the same predicate without a
/// live runner state.
pub(crate) fn partition_missing_files<F: Fn(&str) -> bool>(
    jobs: Vec<DownloadJob>,
    exists: F,
) -> (Vec<DownloadJob>, Vec<i64>) {
    let mut kept = Vec::with_capacity(jobs.len());
    let mut pruned = Vec::new();
    for job in jobs {
        let missing = job.status == "completed"
            && matches!(job.target_path.as_deref(), Some(p) if !exists(p));
        if missing {
            pruned.push(job.id);
        } else {
            kept.push(job);
        }
    }
    (kept, pruned)
}

#[tauri::command]
pub fn dl_list(state: State<'_, Arc<RunnerState>>) -> Result<Vec<DownloadJob>, String> {
    let jobs = to_string_err(state.jobs.lock().unwrap().list(500))?;
    // Drop completed rows whose target file was removed behind our back
    // (Finder, external cleanup, moved drive). The UI should never show a
    // row that can't be played or revealed anyway, so we purge the stale
    // record here and return the survivors.
    let (kept, pruned) = partition_missing_files(jobs, |p| std::path::Path::new(p).exists());
    if !pruned.is_empty() {
        if let Ok(mut repo) = state.jobs.lock() {
            for id in &pruned {
                let _ = repo.delete(*id);
            }
        }
    }
    Ok(kept)
}

#[tauri::command]
pub fn dl_delete(
    state: State<'_, Arc<RunnerState>>,
    id: i64,
    purge_file: Option<bool>,
) -> Result<(), String> {
    if purge_file.unwrap_or(false) {
        // Fetch first so we can reach for target_path before dropping the row.
        // Failure to remove the file is non-fatal — the DB row is still the
        // source of truth for the UI, and the user asked to forget this job.
        let target = to_string_err(state.jobs.lock().unwrap().get(id))?
            .and_then(|job| job.target_path.clone());
        if let Some(path) = target {
            let p = std::path::Path::new(&path);
            if p.is_file() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    to_string_err(state.jobs.lock().unwrap().delete(id))
}

/// Extract subtitles for a completed job. Re-queries yt-dlp for subtitle files
/// only (skips the video download), converts the first usable track to plain
/// text, and returns it so the frontend can feed it into Notes.
#[tauri::command]
pub async fn dl_extract_subtitles(
    state: State<'_, Arc<RunnerState>>,
    id: i64,
    langs: Option<Vec<String>>,
) -> Result<String, String> {
    use crate::modules::downloader::subtitles;

    let yt_dlp = resolve_yt_dlp(&state)?;
    let job = to_string_err(state.jobs.lock().unwrap().get(id))?
        .ok_or_else(|| "download not found".to_string())?;
    let url = job.url.clone();
    let cookies = state.cookies_browser.lock().unwrap().clone();
    let scratch_root = state.default_downloads_dir.join("bin").join("subs");
    let scratch = subtitles::new_scratch(&scratch_root);

    let langs = langs.unwrap_or_default();
    let cookies_for_worker = cookies.clone();
    let scratch_for_worker = scratch.clone();
    let yt_dlp_for_worker = yt_dlp.clone();
    let files = tauri::async_runtime::spawn_blocking(move || {
        subtitles::fetch_vtt_files(
            &yt_dlp_for_worker,
            &url,
            &scratch_for_worker,
            &langs,
            cookies_for_worker.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("subtitle task join: {e}"))??;

    let cleanup = scratch.clone();
    let result: Result<String, String> = (|| {
        if files.is_empty() {
            return Err("No subtitles available for this video".into());
        }
        // Prefer manual subs (no `.auto`) over auto-generated when both exist.
        let mut manual: Option<&std::path::PathBuf> = None;
        let mut auto: Option<&std::path::PathBuf> = None;
        for f in &files {
            let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem.contains(".auto") || stem.contains("-auto") {
                auto.get_or_insert(f);
            } else {
                manual.get_or_insert(f);
            }
        }
        let chosen = manual.or(auto).unwrap();
        let raw =
            std::fs::read_to_string(chosen).map_err(|e| format!("read subtitle file: {e}"))?;
        let text = subtitles::vtt_to_plain_text(&raw);
        if text.trim().is_empty() {
            Err("Subtitle file was empty after parsing".into())
        } else {
            Ok(text)
        }
    })();
    let _ = std::fs::remove_dir_all(&cleanup);
    result
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
pub fn dl_retry(app: AppHandle, state: State<'_, Arc<RunnerState>>, id: i64) -> Result<(), String> {
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
pub fn dl_set_max_parallel(state: State<'_, Arc<RunnerState>>, value: usize) -> Result<(), String> {
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
    to_string_err(
        state
            .jobs
            .lock()
            .unwrap()
            .prune_completed_older_than(cutoff),
    )
}

#[tauri::command]
pub fn dl_purge_cookies(state: State<'_, Arc<RunnerState>>) -> Result<(), String> {
    let cookies = state
        .default_downloads_dir
        .join("bin")
        .join("arc-cookies.txt");
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
                    tracing::debug!("[downloader] arc cookies export failed: {e}");
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
        clamp_max_parallel, ensure_http_scheme, normalize_cookies_browser, normalize_rate_limit,
        partition_missing_files, resolve_downloads_dir, DownloadJob,
    };
    use std::path::PathBuf;

    fn stub_job(id: i64, status: &str, path: Option<&str>) -> DownloadJob {
        DownloadJob {
            id,
            url: "https://example.com/v".into(),
            platform: "generic".into(),
            title: None,
            thumbnail_url: None,
            format_id: None,
            target_path: path.map(|p| p.to_string()),
            status: status.into(),
            progress: 1.0,
            bytes_total: None,
            bytes_done: None,
            error: None,
            created_at: 0,
            completed_at: Some(0),
        }
    }

    #[test]
    fn partition_missing_drops_completed_rows_with_vanished_files() {
        let jobs = vec![
            stub_job(1, "completed", Some("/tmp/present.mp4")),
            stub_job(2, "completed", Some("/tmp/missing.mp4")),
            stub_job(3, "active", Some("/tmp/active.mp4")),
            stub_job(4, "completed", None),
        ];
        let (kept, pruned) =
            partition_missing_files(jobs, |p| p == "/tmp/present.mp4" || p == "/tmp/active.mp4");
        assert_eq!(pruned, vec![2]);
        assert_eq!(kept.iter().map(|j| j.id).collect::<Vec<_>>(), vec![1, 3, 4]);
    }

    #[test]
    fn partition_missing_preserves_non_completed_statuses_even_if_file_absent() {
        // Active / pending / failed rows may legitimately have no file yet.
        let jobs = vec![
            stub_job(1, "active", Some("/tmp/none")),
            stub_job(2, "failed", Some("/tmp/none")),
            stub_job(3, "pending", None),
        ];
        let (kept, pruned) = partition_missing_files(jobs, |_| false);
        assert!(pruned.is_empty());
        assert_eq!(kept.len(), 3);
    }

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

    #[test]
    fn ensure_http_scheme_accepts_http_and_https() {
        assert!(ensure_http_scheme("http://example.com/video").is_ok());
        assert!(ensure_http_scheme("https://youtu.be/abc123").is_ok());
        assert!(ensure_http_scheme("HTTPS://youtu.be/abc123").is_ok());
    }

    #[test]
    fn ensure_http_scheme_rejects_non_http_and_garbage() {
        assert!(ensure_http_scheme("file:///etc/passwd").is_err());
        assert!(ensure_http_scheme("data:video/mp4;base64,AAA").is_err());
        assert!(ensure_http_scheme("javascript:alert(1)").is_err());
        assert!(ensure_http_scheme("ftp://example.com/").is_err());
        assert!(ensure_http_scheme("").is_err());
        assert!(ensure_http_scheme("not a url at all").is_err());
    }
}
