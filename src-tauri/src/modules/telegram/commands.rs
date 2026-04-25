use rand::rngs::OsRng;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::keyring::{ACCOUNT_BOT_TOKEN, ACCOUNT_CHAT_ID};
use super::pairing::{self, PairingState};
use super::repo::InboxItem;
use super::settings::{AiSettings, NotificationSettings};
use super::state::TelegramState;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Connection status projected for the UI. Carries no credential — just the
/// pairing code (shown for the user to send to the bot) and the paired
/// chat id (public, not a secret).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionStatus {
    NoToken,
    TokenOnly,
    Pairing { code: String, expires_at: i64 },
    Paired { chat_id: i64 },
}

/// Pure helper — unit-testable without Tauri `State`.
pub(super) fn compute_status(has_token: bool, pairing_state: &PairingState) -> ConnectionStatus {
    match pairing_state {
        PairingState::Paired { chat_id } => ConnectionStatus::Paired { chat_id: *chat_id },
        PairingState::Pairing {
            code, expires_at, ..
        } => ConnectionStatus::Pairing {
            code: code.clone(),
            expires_at: *expires_at,
        },
        PairingState::Unconfigured if has_token => ConnectionStatus::TokenOnly,
        PairingState::Unconfigured => ConnectionStatus::NoToken,
    }
}

/// Validate a token by calling `getMe` on the Telegram Bot API. A failing
/// validation returns `Err` so the command layer can refuse to persist a
/// bad token — per design §5.1 (token validation policy).
pub(super) async fn validate_token(client: &reqwest::Client, token: &str) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    tracing::info!("validating bot token");
    let resp = client.get(&url).send().await.map_err(|e| {
        tracing::warn!(error = %e, "getMe network error");
        format!("network: {e}")
    })?;
    if !resp.status().is_success() {
        return Err(format!(
            "Telegram rejected the token (HTTP {})",
            resp.status()
        ));
    }
    let text = resp.text().await.map_err(|e| format!("read: {e}"))?;
    let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err(body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("Telegram rejected the token")
            .to_string())
    }
}

#[tauri::command]
pub async fn telegram_set_token(
    state: State<'_, Arc<TelegramState>>,
    token: String,
) -> Result<(), String> {
    tracing::info!("telegram_set_token invoked (token len={})", token.len());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    validate_token(&client, &token).await?;
    state.secrets.set(ACCOUNT_BOT_TOKEN, &token)?;
    tracing::info!("bot token saved to keychain");
    Ok(())
}

#[tauri::command]
pub async fn telegram_clear_token(state: State<'_, Arc<TelegramState>>) -> Result<(), String> {
    state.transport.stop().await;
    state.sender.stop();
    state.secrets.delete(ACCOUNT_BOT_TOKEN)?;
    state.secrets.delete(ACCOUNT_CHAT_ID)?;
    *state.pairing.lock().unwrap() = PairingState::Unconfigured;
    Ok(())
}

#[tauri::command]
pub fn telegram_has_token(state: State<'_, Arc<TelegramState>>) -> Result<bool, String> {
    Ok(state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some())
}

#[tauri::command]
pub fn telegram_status(state: State<'_, Arc<TelegramState>>) -> Result<ConnectionStatus, String> {
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    let status = compute_status(has_token, &state.pairing.lock().unwrap());
    tracing::info!(has_token, status = ?status, "telegram_status");
    Ok(status)
}

#[tauri::command]
pub async fn telegram_start_pairing(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
) -> Result<ConnectionStatus, String> {
    let Some(token) = state.secrets.get(ACCOUNT_BOT_TOKEN)? else {
        return Err("Paste a bot token first".into());
    };
    let code = pairing::generate_code(&mut OsRng);
    let new_state = pairing::start_pairing(code, now_secs());
    *state.pairing.lock().unwrap() = new_state.clone();

    // Spin up long-polling so the bot can receive /pair, plus the outbound
    // queue that carries replies.
    let arc = state.inner().clone();
    arc.transport
        .start(token.clone(), app.clone(), arc.clone())
        .await?;
    arc.sender.start(token)?;

    let _ = app.emit("telegram:status_changed", ());
    Ok(compute_status(true, &new_state))
}

#[tauri::command]
pub async fn telegram_cancel_pairing(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
) -> Result<ConnectionStatus, String> {
    {
        let mut p = state.pairing.lock().unwrap();
        if matches!(*p, PairingState::Pairing { .. }) {
            *p = PairingState::Unconfigured;
        }
    }
    state.transport.stop().await;
    state.sender.stop();
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    let status = compute_status(has_token, &state.pairing.lock().unwrap());
    let _ = app.emit("telegram:status_changed", ());
    Ok(status)
}

#[tauri::command]
pub fn telegram_list_inbox(
    state: State<'_, Arc<TelegramState>>,
    limit: Option<usize>,
) -> Result<Vec<InboxItem>, String> {
    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .list_inbox(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn telegram_delete_inbox_item(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    id: i64,
) -> Result<(), String> {
    // Snapshot the file path *before* we drop the row so we can unlink
    // the blob. We tolerate a missing row here — the frontend may race a
    // duplicate delete, which should be a no-op instead of a hard error.
    let file_path = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.inbox_item_file_path(id).map_err(|e| e.to_string())?
    };

    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .delete_inbox_item(id)
        .map_err(|e| e.to_string())?;

    if let Some(p) = file_path {
        let path = std::path::PathBuf::from(&p);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            // Missing file is fine — the row may have been orphaned by
            // an earlier manual cleanup, or the file was never saved
            // successfully in the first place.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(path = %p, error = %e, "telegram: failed to unlink inbox blob")
            }
        }
    }

    let _ = app.emit("telegram:inbox_updated", id);
    Ok(())
}

#[tauri::command]
pub fn telegram_mark_inbox_routed(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    id: i64,
    target: String,
) -> Result<(), String> {
    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .mark_inbox_routed(id, &target)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("telegram:inbox_updated", id);
    Ok(())
}

/// Reveal a media inbox file in Finder. Resolves the relative
/// `file_path` against the Tauri app data dir and runs `open -R`.
#[tauri::command]
pub fn telegram_get_notification_settings(
    state: State<'_, Arc<TelegramState>>,
) -> Result<NotificationSettings, String> {
    Ok(NotificationSettings::load(state.as_ref()))
}

#[tauri::command]
pub fn telegram_set_notification_settings(
    state: State<'_, Arc<TelegramState>>,
    settings: NotificationSettings,
) -> Result<(), String> {
    settings.save(state.as_ref())
}

#[tauri::command]
pub fn telegram_get_ai_settings(
    state: State<'_, Arc<TelegramState>>,
) -> Result<AiSettings, String> {
    Ok(AiSettings::load(state.as_ref()))
}

#[tauri::command]
pub fn telegram_set_ai_settings(
    state: State<'_, Arc<TelegramState>>,
    settings: AiSettings,
) -> Result<(), String> {
    settings.save(state.as_ref())
}

#[tauri::command]
pub fn telegram_get_inbox_limits(
    state: State<'_, Arc<TelegramState>>,
) -> Result<super::settings::InboxLimits, String> {
    Ok(super::settings::InboxLimits::load(state.as_ref()))
}

#[tauri::command]
pub fn telegram_set_inbox_limits(
    state: State<'_, Arc<TelegramState>>,
    limits: super::settings::InboxLimits,
) -> Result<(), String> {
    limits.save(state.as_ref())
}

/// Wipe every inbox row + the file each one points at. Returns
/// `(rows_removed, files_removed)` so the toast can surface concrete
/// numbers; the user's per-day byte counter for today/yesterday is
/// also reset so a freshly cleared inbox can absorb a new burst.
#[tauri::command]
pub fn telegram_clear_inbox(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
) -> Result<(usize, usize), String> {
    super::inbox::clear_all(&app, state.as_ref())
}

/// Run the retention sweep on demand. Normally fired by the
/// background timer in `lib.rs`, but exposed so the user can force a
/// pass after they bump the slider down.
#[tauri::command]
pub fn telegram_sweep_inbox(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
) -> Result<(), String> {
    let days = super::settings::InboxLimits::load(state.as_ref()).retention_days;
    super::inbox::sweep_old(&app, state.as_ref(), days);
    Ok(())
}

#[tauri::command]
pub fn telegram_list_memory(
    state: State<'_, Arc<TelegramState>>,
) -> Result<Vec<super::repo::MemoryRow>, String> {
    let repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.memory_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn telegram_delete_memory(
    state: State<'_, Arc<TelegramState>>,
    id: i64,
) -> Result<bool, String> {
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    repo.memory_delete(id).map_err(|e| e.to_string())
}

/// Create a Notes entry from a single inbox item. For text messages the
/// body carries the text verbatim; for voice the transcript (if any) is
/// used as the body. Any attached file is copied into the new note's
/// attachments dir so deleting the inbox row later doesn't orphan it.
/// The inbox row is marked `routed_to = "notes"` on success.
#[tauri::command]
pub fn telegram_send_inbox_to_notes(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    notes_state: State<'_, crate::modules::notes::commands::NotesState>,
    id: i64,
) -> Result<i64, String> {
    use tauri::Manager;
    let item = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.list_inbox(500)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| format!("inbox item {id} not found"))?
    };

    let body = pick_note_body(&item);
    let title = pick_note_title(&item, &body);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let note_id = notes_state
        .repo
        .lock()
        .unwrap()
        .create(&title, &body, now)
        .map_err(|e| e.to_string())?;

    if let Some(rel) = item.file_path.as_deref() {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        let src = data_dir.join(rel);
        if src.is_file() {
            let dir = data_dir
                .join("notes")
                .join("attachments")
                .join(note_id.to_string());
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let original_name = src
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("file")
                .to_string();
            let safe: String = original_name
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let suffix = format!(
                "{:08x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0)
                    & 0xFFFF_FFFF
            );
            let dest = dir.join(format!("{suffix}_{safe}"));
            std::fs::copy(&src, &dest).map_err(|e| format!("copy: {e}"))?;
            let size = std::fs::metadata(&dest).ok().map(|m| m.len() as i64);
            let abs = dest
                .to_str()
                .ok_or_else(|| "attachment path is not valid UTF-8".to_string())?;
            notes_state
                .repo
                .lock()
                .unwrap()
                .add_attachment(
                    note_id,
                    abs,
                    &original_name,
                    item.mime_type.as_deref(),
                    size,
                    now,
                )
                .map_err(|e| e.to_string())?;
        }
    }

    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .mark_inbox_routed(id, "notes")
        .map_err(|e| e.to_string())?;
    let _ = app.emit("telegram:inbox_updated", id);
    let _ = app.emit("notes:changed", note_id);
    Ok(note_id)
}

fn pick_note_body(item: &crate::modules::telegram::repo::InboxItem) -> String {
    if let Some(t) = item.text_content.as_deref() {
        if !t.trim().is_empty() {
            return t.to_string();
        }
    }
    if let Some(t) = item.transcript.as_deref() {
        if !t.trim().is_empty() {
            return t.to_string();
        }
    }
    if let Some(c) = item.caption.as_deref() {
        if !c.trim().is_empty() {
            return c.to_string();
        }
    }
    String::new()
}

fn pick_note_title(item: &crate::modules::telegram::repo::InboxItem, body: &str) -> String {
    let first_line = body.lines().next().unwrap_or("").trim();
    if !first_line.is_empty() {
        return first_line.chars().take(80).collect();
    }
    if let Some(p) = item.file_path.as_deref() {
        if let Some(name) = p.rsplit(['/', '\\']).next() {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    format!("[{}]", item.kind)
}

/// Push an arbitrary text message into the paired Telegram chat.
/// Used by the Notes module's "Send to Telegram" button — lets a
/// hand-written or polished note round-trip to the user's phone.
/// Silently no-op when the bot isn't paired; that's friendlier than
/// an error dialog when the user just hasn't set up Telegram yet.
#[tauri::command]
pub fn telegram_send_text(
    state: State<'_, Arc<TelegramState>>,
    text: String,
) -> Result<bool, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let pairing = state.pairing.lock().map_err(|e| e.to_string())?;
    let chat_id = match &*pairing {
        PairingState::Paired { chat_id } => *chat_id,
        _ => return Ok(false),
    };
    drop(pairing);
    state.sender.enqueue(chat_id, trimmed.to_string());
    Ok(true)
}

/// Overwrite the stored transcript for a voice inbox row. Used by the
/// UI "edit transcript" affordance so typos can be fixed before the
/// text ends up in a note or AI context.
#[tauri::command]
pub fn telegram_set_inbox_transcript(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    id: i64,
    transcript: String,
) -> Result<(), String> {
    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .set_inbox_transcript(id, transcript.trim())
        .map_err(|e| e.to_string())?;
    let _ = app.emit("telegram:inbox_updated", id);
    Ok(())
}

/// Re-run Whisper on an existing voice inbox row. Fires the same
/// `telegram:transcribing` / `telegram:inbox_updated` /
/// `telegram:transcribe_failed` events as the first-pass flow so the
/// Inbox UI shows the same spinner / states without a second code path.
/// Does NOT re-run the assistant afterwards — retry is a "fix the
/// transcription" action, the user can trigger a new AI turn manually.
#[tauri::command]
pub async fn telegram_retry_transcribe(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    id: i64,
) -> Result<(), String> {
    use tauri::Manager;
    let (rel, kind, mime) = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        let item = repo
            .list_inbox(500)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| format!("inbox item {id} not found"))?;
        let path = item
            .file_path
            .ok_or_else(|| "item has no file on disk".to_string())?;
        (path, item.kind, item.mime_type)
    };
    let runs_whisper = super::inbox::is_transcribable(&kind);
    let runs_ocr = !runs_whisper && crate::modules::ocr::is_ocr_able(&kind, mime.as_deref());
    if !runs_whisper && !runs_ocr {
        return Err(format!("inbox item {id} is not transcribable"));
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let abs = data_dir.join(&rel);
    if !abs.is_file() {
        return Err(format!("file missing: {}", abs.display()));
    }

    let _ = app.emit("telegram:transcribing", id);
    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    // Detach — same pattern as first-pass transcription so the IPC call
    // returns immediately and the UI stays responsive.
    tauri::async_runtime::spawn(async move {
        let result: Result<String, String> = if runs_whisper {
            // Pull the live diarization toggle so a retry honours the
            // user's current preference even if it's been flipped
            // since the original recording landed.
            let diarize = super::settings::AiSettings::load(&state_clone).diarization_enabled;
            crate::modules::diarization::pipeline::transcribe_with_optional_diarization(
                &app_clone, abs, None, diarize,
            )
            .await
        } else {
            // OCR — Vision/PDFKit are sync. spawn_blocking keeps the
            // tokio worker free.
            let mime_owned = mime.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::modules::ocr::extract_text(&abs, mime_owned.as_deref())
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
        };
        match result {
            Ok(text) => {
                let trimmed = text.trim().to_string();
                if trimmed.is_empty() {
                    let _ = app_clone.emit("telegram:transcribe_failed", id);
                    return;
                }
                if let Ok(mut repo) = state_clone.repo.lock() {
                    let _ = repo.set_inbox_transcript(id, &trimmed);
                }
                let _ = app_clone.emit("telegram:inbox_updated", id);
            }
            Err(e) => {
                tracing::warn!(error = %e, "retry transcription failed");
                let _ = app_clone.emit("telegram:transcribe_failed", id);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn telegram_reveal_inbox_file(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
    id: i64,
) -> Result<(), String> {
    use tauri::Manager;
    let items = state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .list_inbox(500)
        .map_err(|e| e.to_string())?;
    let item = items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("inbox item {id} not found"))?;
    let rel = item
        .file_path
        .ok_or_else(|| "inbox item has no file".to_string())?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let abs = data_dir.join(&rel);
    std::process::Command::new("open")
        .args(["-R"])
        .arg(&abs)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn telegram_unpair(
    app: AppHandle,
    state: State<'_, Arc<TelegramState>>,
) -> Result<ConnectionStatus, String> {
    state.transport.stop().await;
    state.sender.stop();
    state.secrets.delete(ACCOUNT_CHAT_ID)?;
    *state.pairing.lock().unwrap() = PairingState::Unconfigured;
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    let _ = app.emit("telegram:status_changed", ());
    Ok(compute_status(has_token, &state.pairing.lock().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_no_token() {
        assert_eq!(
            compute_status(false, &PairingState::Unconfigured),
            ConnectionStatus::NoToken
        );
    }

    #[test]
    fn status_token_only() {
        assert_eq!(
            compute_status(true, &PairingState::Unconfigured),
            ConnectionStatus::TokenOnly
        );
    }

    #[test]
    fn status_pairing_exposes_code_and_expiry() {
        let s = compute_status(
            true,
            &PairingState::Pairing {
                code: "654321".into(),
                expires_at: 999,
                bad_attempts: 0,
            },
        );
        assert_eq!(
            s,
            ConnectionStatus::Pairing {
                code: "654321".into(),
                expires_at: 999,
            }
        );
    }

    #[test]
    fn status_paired_exposes_chat_id() {
        let s = compute_status(true, &PairingState::Paired { chat_id: 42 });
        assert_eq!(s, ConnectionStatus::Paired { chat_id: 42 });
    }

    #[test]
    fn serialized_status_never_leaks_token_value() {
        for s in [
            compute_status(false, &PairingState::Unconfigured),
            compute_status(true, &PairingState::Unconfigured),
            compute_status(
                true,
                &PairingState::Pairing {
                    code: "000000".into(),
                    expires_at: 0,
                    bad_attempts: 0,
                },
            ),
            compute_status(true, &PairingState::Paired { chat_id: 1 }),
        ] {
            let j = serde_json::to_string(&s).unwrap();
            assert!(!j.contains("bot_token"), "{j}");
            assert!(!j.to_lowercase().contains("secret"), "{j}");
            assert!(!j.to_lowercase().contains("123:abc"), "{j}");
        }
    }
}
