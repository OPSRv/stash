//! Tauri commands backing the voice popup.
//!
//! `voice_transcribe` takes an in-memory recording (usually WebM/Opus
//! from the browser's MediaRecorder), spills it to an app-cache temp
//! file, and runs it through the active Whisper model. The temp file
//! is removed in every branch so the cache directory can't grow
//! unbounded if the assistant hop later errors.
//!
//! `voice_ask` is the single-turn handle into the shared assistant
//! pipeline — same `handle_user_text` the Telegram dispatcher and the
//! `/ai` slash-command call.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::modules::telegram::assistant;
use crate::modules::telegram::state::TelegramState;
use crate::modules::whisper::commands::transcribe_with_active_model;

/// Hard cap on the inbound audio blob. 50 MB is ~45 min of 128 kbps
/// Opus — well past anything push-to-talk should produce, and safely
/// below the default Tauri IPC payload limit.
const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;

fn voice_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?;
    let dir = base.join("voice-temp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    Ok(dir)
}

fn sanitize_extension(ext: Option<&str>) -> &'static str {
    // Whisper's pipeline probes the container by content, but Symphonia's
    // file-extension hint nudges it toward the right demuxer first — so
    // we still keep the suffix meaningful. Anything weird falls back to
    // webm, the browser default.
    match ext.map(str::trim).map(|s| s.trim_start_matches('.')) {
        Some("webm") => "webm",
        Some("ogg") | Some("opus") => "ogg",
        Some("wav") => "wav",
        Some("mp4") | Some("m4a") => "m4a",
        _ => "webm",
    }
}

#[tauri::command]
pub async fn voice_transcribe(
    app: AppHandle,
    audio_bytes: Vec<u8>,
    extension: Option<String>,
    language: Option<String>,
) -> Result<String, String> {
    if audio_bytes.is_empty() {
        return Err("empty audio".into());
    }
    if audio_bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "audio too large ({} bytes, max {})",
            audio_bytes.len(),
            MAX_AUDIO_BYTES
        ));
    }
    let ext = sanitize_extension(extension.as_deref());
    let dir = voice_temp_dir(&app)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("rec-{nonce}.{ext}"));
    std::fs::write(&path, &audio_bytes).map_err(|e| format!("write temp audio: {e}"))?;
    // Run whisper, cleanup temp in every branch — errors still want the
    // disk freed.
    let result = transcribe_with_active_model(&app, path.clone(), language).await;
    let _ = std::fs::remove_file(&path);
    result
}

#[tauri::command]
pub async fn voice_ask(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    prompt: String,
) -> Result<String, String> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err("empty prompt".into());
    }
    let reply = assistant::handle_user_text(&app, state.inner(), trimmed)
        .await
        .map_err(|e| e.to_string())?;
    Ok(reply.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_extension_passes_through_known_formats() {
        assert_eq!(sanitize_extension(Some("webm")), "webm");
        assert_eq!(sanitize_extension(Some(".ogg")), "ogg");
        assert_eq!(sanitize_extension(Some("opus")), "ogg");
        assert_eq!(sanitize_extension(Some("m4a")), "m4a");
        assert_eq!(sanitize_extension(Some("wav")), "wav");
    }

    #[test]
    fn sanitize_extension_falls_back_to_webm_on_unknown() {
        assert_eq!(sanitize_extension(None), "webm");
        assert_eq!(sanitize_extension(Some("")), "webm");
        assert_eq!(sanitize_extension(Some("../evil")), "webm");
        assert_eq!(sanitize_extension(Some("mp3")), "webm");
    }
}
