use crate::modules::recorder::helper::{resolve_helper, Helper, HelperEvent};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindowBuilder,
};

/// Shared Tauri state for the recorder module.
pub struct RecorderState {
    pub helper: Mutex<Option<Helper>>,
    pub output_dir: Mutex<PathBuf>,
    pub last_saved: Mutex<Option<PathBuf>>,
    pub history: Mutex<Vec<Recording>>,
}

#[derive(Serialize, Clone)]
pub struct Recording {
    pub path: String,
    pub created_at: i64,
    pub bytes: u64,
    pub thumbnail: Option<String>,
}

/// Resolve (or generate) a JPEG thumbnail for a recording file. Returns the
/// thumbnail path, or None when ffmpeg is unavailable or extraction fails.
/// Thumbnails live under `<output_dir>/.thumbs/<stem>.jpg`.
fn ensure_thumbnail(recording: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = recording.parent()?;
    let stem = recording.file_stem()?.to_string_lossy().to_string();
    let thumbs_dir = parent.join(".thumbs");
    let thumb = thumbs_dir.join(format!("{stem}.jpg"));
    if thumb.exists() {
        return Some(thumb);
    }
    std::fs::create_dir_all(&thumbs_dir).ok()?;
    // Probe duration then extract a frame at 10% (fallback 1s for tiny clips).
    let duration = ffprobe_duration(recording).unwrap_or(10.0);
    let at = (duration * 0.1).max(0.5);
    let status = std::process::Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-ss", &format!("{at:.2}")])
        .arg("-i")
        .arg(recording)
        .args(["-frames:v", "1", "-q:v", "4", "-vf", "scale=320:-2"])
        .arg(&thumb)
        .status()
        .ok()?;
    if status.success() && thumb.exists() {
        Some(thumb)
    } else {
        None
    }
}

/// Query the duration (seconds) of a media file via `ffprobe`.
/// Returns None if the binary is missing or parsing fails.
fn ffprobe_duration(path: &std::path::Path) -> Option<f64> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.parse::<f64>().ok()
}

impl RecorderState {
    pub fn new(output_dir: PathBuf) -> Self {
        let mut history = list_recordings(&output_dir);
        // Newest first.
        history.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Self {
            helper: Mutex::new(None),
            output_dir: Mutex::new(output_dir),
            last_saved: Mutex::new(None),
            history: Mutex::new(history),
        }
    }
}

/// Scan `dir` for `.mov`/`.mp4` files and map them to Recording entries.
fn list_recordings(dir: &std::path::Path) -> Vec<Recording> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(|entry| {
        let entry = entry.ok()?;
        let path = entry.path();
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !matches!(ext, "mov" | "mp4" | "m4a") {
            return None;
        }
        let meta = entry.metadata().ok()?;
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let thumbnail = ensure_thumbnail(&path).map(|p| p.display().to_string());
        Some(Recording {
            path: path.display().to_string(),
            created_at,
            bytes: meta.len(),
            thumbnail,
        })
    })
    .collect()
}

#[derive(Serialize)]
pub struct RecorderStatus {
    pub available: bool,
    pub recording: bool,
    pub last_saved: Option<String>,
}

fn ensure_helper(
    app: &AppHandle,
    state: &Arc<RecorderState>,
    bin_dir: &std::path::Path,
) -> Result<(), String> {
    {
        let mut guard = state.helper.lock().unwrap();
        if let Some(h) = guard.as_mut() {
            if h.is_alive() {
                return Ok(());
            }
            // Dead helper — drop and respawn.
            *guard = None;
        }
    }

    let path = resolve_helper(bin_dir)
        .ok_or_else(|| "stash-recorder helper binary not found".to_string())?;

    let app_for_cb = app.clone();
    let state_for_cb = Arc::clone(state);
    let helper = Helper::spawn(&path, move |ev: &HelperEvent| {
        let _ = app_for_cb.emit("recorder:event", ev);
        if ev.event == "stopped" {
            if let Some(p) = ev.path.clone() {
                if !p.is_empty() {
                    let pb = PathBuf::from(&p);
                    *state_for_cb.last_saved.lock().unwrap() = Some(pb.clone());
                    if let Ok(meta) = std::fs::metadata(&pb) {
                        let thumbnail =
                            ensure_thumbnail(&pb).map(|t| t.display().to_string());
                        let entry = Recording {
                            path: p,
                            created_at: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0),
                            bytes: meta.len(),
                            thumbnail,
                        };
                        state_for_cb.history.lock().unwrap().insert(0, entry);
                    }
                }
            }
        }
    })?;

    *state.helper.lock().unwrap() = Some(helper);
    Ok(())
}

fn recorder_bin_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|p| p.join("bin"))
        .unwrap_or_else(|_| PathBuf::from("bin"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn rec_start(
    app: AppHandle,
    state: State<'_, Arc<RecorderState>>,
    mode: Option<String>,
    mic: Option<bool>,
    fps: Option<u32>,
    filename: Option<String>,
    display_id: Option<String>,
    mic_ids: Option<Vec<String>>,
    system_audio: Option<bool>,
    camera_id: Option<String>,
    cam_overlay: Option<serde_json::Value>,
    excluded_window_titles: Option<Vec<String>>,
    source_gains: Option<serde_json::Value>,
    muted_sources: Option<Vec<String>>,
) -> Result<String, String> {
    let bin_dir = recorder_bin_dir(&app);
    ensure_helper(&app, &state, &bin_dir)?;

    let output_dir = state.output_dir.lock().unwrap().clone();
    std::fs::create_dir_all(&output_dir).ok();
    let name = filename.unwrap_or_else(|| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("stash-recording-{ts}.mov")
    });
    let output = output_dir.join(name);

    let guard = state.helper.lock().unwrap();
    let helper = guard
        .as_ref()
        .ok_or_else(|| "helper not running".to_string())?;
    let mic_ids_vec = mic_ids.unwrap_or_default();
    let excluded = excluded_window_titles.unwrap_or_default();
    let muted = muted_sources.unwrap_or_default();
    helper.start(
        &output,
        mode.as_deref().unwrap_or("screen"),
        mic.unwrap_or(false),
        fps.unwrap_or(60),
        display_id.as_deref(),
        &mic_ids_vec,
        system_audio.unwrap_or(false),
        camera_id.as_deref(),
        cam_overlay.as_ref(),
        &excluded,
        source_gains.as_ref(),
        &muted,
    )?;
    Ok(output.display().to_string())
}

#[tauri::command]
pub fn rec_stop(state: State<'_, Arc<RecorderState>>) -> Result<(), String> {
    let guard = state.helper.lock().unwrap();
    let helper = guard
        .as_ref()
        .ok_or_else(|| "helper not running".to_string())?;
    helper.stop()
}

#[tauri::command]
pub fn rec_status(
    app: AppHandle,
    state: State<'_, Arc<RecorderState>>,
) -> Result<RecorderStatus, String> {
    let bin_dir = recorder_bin_dir(&app);
    let available = resolve_helper(&bin_dir).is_some();
    let guard = state.helper.lock().unwrap();
    let recording = guard
        .as_ref()
        .and_then(|h| h.current_recording_path())
        .is_some();
    let last_saved = state
        .last_saved
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.display().to_string());
    Ok(RecorderStatus {
        available,
        recording,
        last_saved,
    })
}

#[derive(Serialize)]
pub struct DevicesList {
    pub displays: serde_json::Value,
    pub cameras: serde_json::Value,
    pub microphones: serde_json::Value,
}

#[tauri::command]
pub fn rec_list_devices(
    app: AppHandle,
    state: State<'_, Arc<RecorderState>>,
) -> Result<DevicesList, String> {
    let bin_dir = recorder_bin_dir(&app);
    ensure_helper(&app, &state, &bin_dir)?;
    let guard = state.helper.lock().unwrap();
    let helper = guard
        .as_ref()
        .ok_or_else(|| "helper not running".to_string())?;
    let ev = helper.list_devices()?;
    Ok(DevicesList {
        displays: ev.displays.unwrap_or(serde_json::Value::Array(vec![])),
        cameras: ev.cameras.unwrap_or(serde_json::Value::Array(vec![])),
        microphones: ev.microphones.unwrap_or(serde_json::Value::Array(vec![])),
    })
}

#[tauri::command]
pub fn rec_probe_permissions(
    app: AppHandle,
    state: State<'_, Arc<RecorderState>>,
) -> Result<(), String> {
    let bin_dir = recorder_bin_dir(&app);
    ensure_helper(&app, &state, &bin_dir)?;
    let guard = state.helper.lock().unwrap();
    let helper = guard
        .as_ref()
        .ok_or_else(|| "helper not running".to_string())?;
    helper.probe_permissions()
}

#[tauri::command]
pub fn rec_list(state: State<'_, Arc<RecorderState>>) -> Result<Vec<Recording>, String> {
    Ok(state.history.lock().unwrap().clone())
}

#[tauri::command]
pub fn rec_delete(
    state: State<'_, Arc<RecorderState>>,
    path: String,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("remove: {e}"))?;
    }
    state.history.lock().unwrap().retain(|r| r.path != path);
    if state
        .last_saved
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.display().to_string() == path)
        .unwrap_or(false)
    {
        *state.last_saved.lock().unwrap() = None;
    }
    Ok(())
}

/// Trim `source` between two timestamps (seconds) using stream-copy ffmpeg.
/// Writes `<stem>-trimmed<n>.<ext>` next to the source and inserts it at the
/// top of the history list.
#[tauri::command]
pub async fn rec_trim(
    state: State<'_, Arc<RecorderState>>,
    source: String,
    start: f64,
    end: f64,
) -> Result<String, String> {
    if end <= start {
        return Err("end must be after start".into());
    }
    let src = PathBuf::from(&source);
    if !src.exists() {
        return Err(format!("source not found: {source}"));
    }
    let parent = src
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?
        .to_path_buf();
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("trimmed")
        .to_string();
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mov")
        .to_string();

    // Pick a non-colliding filename.
    let mut out = parent.join(format!("{stem}-trimmed.{ext}"));
    let mut n = 2;
    while out.exists() {
        out = parent.join(format!("{stem}-trimmed{n}.{ext}"));
        n += 1;
    }

    let out_clone = out.clone();
    let src_clone = src.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-loglevel",
                "error",
                "-ss",
                &format!("{start:.3}"),
                "-to",
                &format!("{end:.3}"),
            ])
            .arg("-i")
            .arg(&src_clone)
            .args(["-c", "copy"])
            .arg(&out_clone)
            .status()
            .map_err(|e| format!("spawn ffmpeg: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;

    if !status.success() {
        let _ = std::fs::remove_file(&out);
        return Err(format!("ffmpeg exited with {status}"));
    }

    let meta = std::fs::metadata(&out).map_err(|e| format!("stat: {e}"))?;
    let thumbnail = ensure_thumbnail(&out).map(|p| p.display().to_string());
    let entry = Recording {
        path: out.display().to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        bytes: meta.len(),
        thumbnail,
    };
    state.history.lock().unwrap().insert(0, entry);
    Ok(out.display().to_string())
}

/// Label and title used for the live camera PIP window. Swift needs the
/// exact `Title` to exclude the window from SCStream capture.
pub const CAM_PIP_LABEL: &str = "camera-pip";
pub const CAM_PIP_TITLE: &str = "Stash Camera";

#[tauri::command]
pub fn cam_pip_show(
    app: AppHandle,
    camera_label: Option<String>,
    shape: Option<String>,
) -> Result<(), String> {
    // Square when the preview is a circle — otherwise `border-radius: 50%`
    // on a 4:3 frame gives an ellipse (the exact bug the user flagged).
    let is_circle = shape.as_deref() == Some("circle");
    let (w, h) = if is_circle { (280.0, 280.0) } else { (320.0, 240.0) };

    if let Some(win) = app.get_webview_window(CAM_PIP_LABEL) {
        // Already open — just re-show and resize so a shape switch is
        // reflected immediately.
        win.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().ok();
        return Ok(());
    }
    // Encode the camera preview hint into the URL hash + query so the
    // webview picks it up without an IPC round-trip. `url::form_urlencoded`
    // matches how the `URLSearchParams` API on the frontend decodes it.
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    if let Some(l) = camera_label.as_deref().filter(|s| !s.is_empty()) {
        serializer.append_pair("label", l);
    }
    if let Some(s) = shape.as_deref().filter(|s| !s.is_empty()) {
        serializer.append_pair("shape", s);
    }
    let query = serializer.finish();
    let url_str = if query.is_empty() {
        "index.html#camera-pip".to_string()
    } else {
        format!("index.html?{query}#camera-pip")
    };
    let parsed = WebviewUrl::App(std::path::PathBuf::from(url_str));
    let window = WebviewWindowBuilder::new(&app, CAM_PIP_LABEL, parsed)
        .title(CAM_PIP_TITLE)
        .inner_size(w, h)
        .min_inner_size(160.0, 160.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("pip build: {e}"))?;
    window
        .set_position(LogicalPosition::new(40.0, 40.0))
        .map_err(|e| e.to_string())?;
    window
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cam_pip_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(CAM_PIP_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn rec_set_output_dir(
    state: State<'_, Arc<RecorderState>>,
    path: Option<String>,
) -> Result<(), String> {
    if let Some(p) = path.filter(|s| !s.is_empty()) {
        let next = PathBuf::from(p);
        std::fs::create_dir_all(&next).ok();
        *state.output_dir.lock().unwrap() = next;
    }
    Ok(())
}
