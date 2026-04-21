use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::keyring::{ACCOUNT_BOT_TOKEN, ACCOUNT_CHAT_ID};
use super::pairing::{self, PairingState};
use super::repo::InboxItem;
use super::settings::NotificationSettings;
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
pub(super) fn compute_status(
    has_token: bool,
    pairing_state: &PairingState,
) -> ConnectionStatus {
    match pairing_state {
        PairingState::Paired { chat_id } => ConnectionStatus::Paired { chat_id: *chat_id },
        PairingState::Pairing { code, expires_at, .. } => ConnectionStatus::Pairing {
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
pub(super) async fn validate_token(
    client: &reqwest::Client,
    token: &str,
) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    tracing::info!("validating bot token");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
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
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
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
pub async fn telegram_clear_token(
    state: State<'_, Arc<TelegramState>>,
) -> Result<(), String> {
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
pub fn telegram_status(
    state: State<'_, Arc<TelegramState>>,
) -> Result<ConnectionStatus, String> {
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
    let code = pairing::generate_code(&mut rand::thread_rng());
    let new_state = pairing::start_pairing(code, now_secs());
    *state.pairing.lock().unwrap() = new_state.clone();

    // Spin up long-polling so the bot can receive /pair, plus the outbound
    // queue that carries replies.
    let arc = state.inner().clone();
    arc.transport.start(token.clone(), app.clone(), arc.clone()).await?;
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
    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .delete_inbox_item(id)
        .map_err(|e| e.to_string())?;
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
