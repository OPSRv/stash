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
use crate::modules::telegram::commands_registry::Ctx as CommandCtx;
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

#[derive(serde::Serialize, Debug, Clone, Default)]
pub struct VoiceReply {
    pub text: String,
    /// Absolute filesystem paths attached to the reply. Telegram surfaces
    /// these as send_document; the voice popup renders them as image
    /// thumbnails or file chips with a right-click action menu.
    pub documents: Vec<String>,
}

#[tauri::command]
pub async fn voice_ask(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    prompt: String,
    attachments: Option<Vec<String>>,
) -> Result<VoiceReply, String> {
    let trimmed = prompt.trim();
    let atts = attachments.unwrap_or_default();
    if trimmed.is_empty() && atts.is_empty() {
        return Err("empty prompt".into());
    }

    // Slash prefix → run the same deterministic handler the Telegram
    // dispatcher uses, so /timer, /note, /help etc. behave identically
    // across both surfaces. Unknown commands fall through to the LLM so
    // the user gets a useful answer instead of a bare "unknown command".
    if let Some(rest) = trimmed.strip_prefix('/') {
        let (name, args_text) = match rest.find(char::is_whitespace) {
            Some(i) => (
                rest[..i].trim().to_lowercase(),
                rest[i + 1..].trim_start().to_string(),
            ),
            None => (rest.trim().to_lowercase(), String::new()),
        };
        if !name.is_empty() {
            if let Some(handler) = state.find_command(&name) {
                // Append attachment paths as whitespace-separated args
                // so handlers that accept file paths (/note,
                // /summarize, …) see them; the rest ignore the tail.
                let mut args = args_text;
                for a in &atts {
                    if !args.is_empty() {
                        args.push(' ');
                    }
                    args.push_str(a);
                }
                let reply = handler
                    .handle(CommandCtx { app: app.clone() }, &args)
                    .await;
                return Ok(VoiceReply {
                    text: reply.text,
                    documents: reply
                        .documents
                        .into_iter()
                        .map(|p| p.display().to_string())
                        .collect(),
                });
            }
        }
    }

    // Free text → assistant. Attachments surface as a structured prefix
    // the LLM can parse. Full multimodal (image content blocks) is a
    // deeper change; for now the model sees the paths and can reference
    // them by name in its reply.
    let mut prompt_for_llm = String::new();
    if !atts.is_empty() {
        prompt_for_llm.push_str("[Attached file(s):\n");
        for a in &atts {
            prompt_for_llm.push_str("- ");
            prompt_for_llm.push_str(a);
            prompt_for_llm.push('\n');
        }
        prompt_for_llm.push_str("]\n");
    }
    prompt_for_llm.push_str(trimmed);

    let reply = assistant::handle_user_text(&app, state.inner(), &prompt_for_llm)
        .await
        .map_err(|e| e.to_string())?;
    Ok(VoiceReply {
        text: reply.text,
        documents: Vec::new(),
    })
}

/// Persist arbitrary bytes (e.g. a clipboard image grabbed via
/// `navigator.clipboard.read()`) to a per-popup temp file and return
/// the absolute path. Reused by both clipboard-paste and drag-drop
/// flows when the source isn't already on disk.
#[tauri::command]
pub fn voice_save_attachment(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("empty attachment".into());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "attachment too large ({} bytes, max {})",
            bytes.len(),
            MAX_AUDIO_BYTES
        ));
    }
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?;
    let dir = base.join("voice-attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    let ext = extension
        .as_deref()
        .map(str::trim)
        .map(|s| s.trim_start_matches('.'))
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 8
                && s.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("bin");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("att-{nonce}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| format!("write attachment: {e}"))?;
    Ok(path.display().to_string())
}

/// Lightweight catalog of registered slash-commands. Returned to the
/// voice popup so it can render an autocomplete dropdown when the user
/// types `/`. Mirrors the registry's insertion order so `/help` and the
/// popup agree on what's available.
#[derive(serde::Serialize, Debug, Clone)]
pub struct VoiceCommand {
    pub name: String,
    pub usage: String,
    pub description: String,
}

#[tauri::command]
pub fn voice_list_commands(
    state: State<'_, Arc<TelegramState>>,
) -> Result<Vec<VoiceCommand>, String> {
    let reg = state.commands.read().map_err(|e| e.to_string())?;
    Ok(reg
        .enumerate()
        .into_iter()
        .map(|h| VoiceCommand {
            name: h.name().to_string(),
            usage: h.usage().to_string(),
            description: h.description().to_string(),
        })
        .collect())
}

/// User-defined quick-action shortcut. Rendered as a pill above the
/// composer; clicking the pill submits `prompt` through the same
/// `voice_ask` pipeline. Stored as a JSON array in the telegram KV
/// table so it travels with the rest of the app's settings backup.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct QuickCommand {
    pub id: String,
    pub label: String,
    /// Single grapheme / emoji rendered before the label. Free-form
    /// because the user picks it; we never parse it on the Rust side.
    pub icon: String,
    /// Text submitted on click — `/slash`, plain prose, anything the
    /// assistant pipeline accepts.
    pub prompt: String,
}

const KEY_QUICK_COMMANDS: &str = "voice.quick_commands";

fn default_quick_commands() -> Vec<QuickCommand> {
    vec![
        QuickCommand {
            id: "dashboard".into(),
            label: "Dashboard".into(),
            icon: "📊".into(),
            prompt: "/dashboard".into(),
        },
        QuickCommand {
            id: "screenshot".into(),
            label: "Screenshot".into(),
            icon: "📸".into(),
            prompt: "/screenshot".into(),
        },
        QuickCommand {
            id: "note".into(),
            label: "New note".into(),
            icon: "📝".into(),
            prompt: "/note ".into(),
        },
        QuickCommand {
            id: "translate".into(),
            label: "Translate".into(),
            icon: "🌐".into(),
            prompt: "Translate this to English: ".into(),
        },
        QuickCommand {
            id: "claude".into(),
            label: "Claude Code".into(),
            icon: "🤖".into(),
            prompt: "/claude".into(),
        },
        QuickCommand {
            id: "memory".into(),
            label: "Memory".into(),
            icon: "🧠".into(),
            prompt: "/memory".into(),
        },
    ]
}

#[tauri::command]
pub fn voice_get_quick_commands(
    state: State<'_, Arc<TelegramState>>,
) -> Result<Vec<QuickCommand>, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    match repo.kv_get(KEY_QUICK_COMMANDS).map_err(|e| e.to_string())? {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str::<Vec<QuickCommand>>(&raw)
            .map_err(|e| format!("decode quick_commands: {e}")),
        // First run — seed with a sensible starter set so the popup
        // isn't empty. The user can edit / delete any of these from
        // the popup's quick-commands tray.
        _ => Ok(default_quick_commands()),
    }
}

#[tauri::command]
pub fn voice_set_quick_commands(
    state: State<'_, Arc<TelegramState>>,
    commands: Vec<QuickCommand>,
) -> Result<(), String> {
    let payload = serde_json::to_string(&commands)
        .map_err(|e| format!("encode quick_commands: {e}"))?;
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.kv_set(KEY_QUICK_COMMANDS, &payload)
        .map_err(|e| e.to_string())
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
