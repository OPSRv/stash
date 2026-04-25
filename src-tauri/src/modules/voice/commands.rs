//! Tauri commands backing the voice popup.
//!
//! Settings live in the same telegram `kv` table as everything else
//! — there's already a single SQLite handle wired in, no point in
//! spinning a second one for two booleans.
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

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct VoiceSettings {
    /// When true, recording auto-stops once `autostop_silence_ms` of
    /// silence accumulates. Default false — explicit tap-to-stop is
    /// the primary UX.
    pub autostop_enabled: bool,
    /// How much continuous silence triggers auto-stop. Clamped to a
    /// usable range (0.5 s … 5 s) on save so a typo can't make the
    /// recorder fire on the first audible breath.
    pub autostop_silence_ms: u32,
}

const KEY_AUTOSTOP_ENABLED: &str = "voice.autostop_enabled";
const KEY_AUTOSTOP_SILENCE_MS: &str = "voice.autostop_silence_ms";
const DEFAULT_AUTOSTOP_SILENCE_MS: u32 = 1500;
const MIN_AUTOSTOP_SILENCE_MS: u32 = 500;
const MAX_AUTOSTOP_SILENCE_MS: u32 = 5000;

#[tauri::command]
pub fn voice_get_settings(state: State<'_, Arc<TelegramState>>) -> Result<VoiceSettings, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    let enabled = repo
        .kv_get(KEY_AUTOSTOP_ENABLED)
        .ok()
        .flatten()
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let silence_ms = repo
        .kv_get(KEY_AUTOSTOP_SILENCE_MS)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u32>().ok())
        .map(|v| v.clamp(MIN_AUTOSTOP_SILENCE_MS, MAX_AUTOSTOP_SILENCE_MS))
        .unwrap_or(DEFAULT_AUTOSTOP_SILENCE_MS);
    Ok(VoiceSettings {
        autostop_enabled: enabled,
        autostop_silence_ms: silence_ms,
    })
}

#[tauri::command]
pub fn voice_set_settings(
    state: State<'_, Arc<TelegramState>>,
    settings: VoiceSettings,
) -> Result<(), String> {
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.kv_set(
        KEY_AUTOSTOP_ENABLED,
        if settings.autostop_enabled { "1" } else { "0" },
    )
    .map_err(|e| e.to_string())?;
    let silence_ms = settings
        .autostop_silence_ms
        .clamp(MIN_AUTOSTOP_SILENCE_MS, MAX_AUTOSTOP_SILENCE_MS);
    repo.kv_set(KEY_AUTOSTOP_SILENCE_MS, &silence_ms.to_string())
        .map_err(|e| e.to_string())?;
    Ok(())
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
