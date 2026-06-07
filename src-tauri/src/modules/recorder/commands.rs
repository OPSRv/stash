//! Tauri commands backing the embedded Recorder widget (hosted inside the
//! Valeton editor, but a standalone module — own SQLite store, own audio dir,
//! own agent surface — exactly like the Metronome).
//!
//! Capture happens browser-side via `MediaRecorder` (same approach as the
//! voice popup); `recorder_save` receives the encoded bytes, writes them under
//! the recorder audio dir, and records metadata in `recorder.sqlite`. Playback
//! reuses the shared media server — the audio dir is registered as an Audio
//! root in `lib.rs`, so the frontend streams takes through the generic
//! `media_stream_url` command. Deletes remove both the row and the file.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::modules::recorder::repo::{RecorderRepo, RecordingRow};

/// Hard cap on a single inbound take. 200 MB is ~3 h of 128 kbps Opus — far
/// past any realistic quick take, and safely below the Tauri IPC payload
/// limit so a runaway recording fails cleanly instead of wedging the bridge.
const MAX_AUDIO_BYTES: usize = 200 * 1024 * 1024;

pub struct RecorderState {
    pub repo: Mutex<RecorderRepo>,
    pub audio_dir: PathBuf,
}

impl RecorderState {
    pub fn new(repo: RecorderRepo, audio_dir: PathBuf) -> Self {
        Self {
            repo: Mutex::new(repo),
            audio_dir,
        }
    }
}

/// What the frontend sees. `file_path` is absolute (joined from the live audio
/// dir) so it can be handed straight to `media_stream_url` / `revealItemInDir`.
#[derive(Debug, Clone, Serialize)]
pub struct Recording {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub ext: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub device: Option<String>,
    pub favorite: bool,
    pub created_at: i64,
}

fn to_recording(row: RecordingRow, audio_dir: &PathBuf) -> Recording {
    Recording {
        file_path: audio_dir.join(&row.file_name).display().to_string(),
        id: row.id,
        name: row.name,
        ext: row.ext,
        duration_ms: row.duration_ms,
        size_bytes: row.size_bytes,
        device: row.device,
        favorite: row.favorite,
        created_at: row.created_at,
    }
}

/// Lowercase, ASCII-alnum, ≤8 chars — anything else collapses to `webm`, the
/// browser default. Keeps the on-disk suffix meaningful without ever trusting
/// a free-form string into a filesystem path.
fn sanitize_ext(ext: &str) -> String {
    let cleaned = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !cleaned.is_empty() && cleaned.len() <= 8 && cleaned.chars().all(|c| c.is_ascii_alphanumeric())
    {
        cleaned
    } else {
        "webm".into()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn recorder_list(state: State<'_, RecorderState>) -> Result<Vec<Recording>, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    let rows = repo.list().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| to_recording(r, &state.audio_dir))
        .collect())
}

#[tauri::command]
pub fn recorder_save(
    state: State<'_, RecorderState>,
    bytes: Vec<u8>,
    ext: String,
    duration_ms: i64,
    name: Option<String>,
    device: Option<String>,
) -> Result<Recording, String> {
    if bytes.is_empty() {
        return Err("empty recording".into());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "recording too large ({} bytes, max {})",
            bytes.len(),
            MAX_AUDIO_BYTES
        ));
    }
    std::fs::create_dir_all(&state.audio_dir)
        .map_err(|e| format!("create recorder dir: {e}"))?;

    let ext = sanitize_ext(&ext);
    let created_at = now_ms();
    // Monotonic-ish, collision-free id keyed off the wall clock plus a nanos
    // tail — two takes in the same millisecond still land on distinct files.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!("rec-{nonce}");
    let file_name = format!("{id}.{ext}");
    let abs = state.audio_dir.join(&file_name);
    std::fs::write(&abs, &bytes).map_err(|e| format!("write recording: {e}"))?;

    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Take".to_string());

    let row = RecordingRow {
        id,
        name,
        file_name,
        ext,
        duration_ms: duration_ms.max(0),
        size_bytes: bytes.len() as i64,
        device: device.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()),
        favorite: false,
        created_at,
    };
    {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        if let Err(e) = repo.insert(&row) {
            // Don't leave an orphan file if the metadata write fails.
            let _ = std::fs::remove_file(&abs);
            return Err(e.to_string());
        }
    }
    Ok(to_recording(row, &state.audio_dir))
}

#[tauri::command]
pub fn recorder_rename(
    state: State<'_, RecorderState>,
    id: String,
    name: String,
) -> Result<Recording, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name cannot be empty".into());
    }
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.rename(&id, trimmed).map_err(|e| e.to_string())?;
    let row = repo
        .get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording {id} not found"))?;
    Ok(to_recording(row, &state.audio_dir))
}

#[tauri::command]
pub fn recorder_set_favorite(
    state: State<'_, RecorderState>,
    id: String,
    favorite: bool,
) -> Result<Recording, String> {
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.set_favorite(&id, favorite).map_err(|e| e.to_string())?;
    let row = repo
        .get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording {id} not found"))?;
    Ok(to_recording(row, &state.audio_dir))
}

/// Deletes the row *and* the underlying file. A missing file is not an error —
/// the user's intent is "make this take gone", and a half-deleted record left
/// in the list would be more surprising than a silently-already-gone file.
#[tauri::command]
pub fn recorder_delete(state: State<'_, RecorderState>, id: String) -> Result<(), String> {
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    if let Some(row) = repo.get(&id).map_err(|e| e.to_string())? {
        let abs = state.audio_dir.join(&row.file_name);
        let _ = std::fs::remove_file(&abs);
    }
    repo.delete(&id).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_ext_keeps_known_and_falls_back() {
        assert_eq!(sanitize_ext("webm"), "webm");
        assert_eq!(sanitize_ext(".OGG"), "ogg");
        assert_eq!(sanitize_ext("m4a"), "m4a");
        assert_eq!(sanitize_ext("../evil"), "webm");
        assert_eq!(sanitize_ext(""), "webm");
        assert_eq!(sanitize_ext("waytoolongext"), "webm");
    }
}
