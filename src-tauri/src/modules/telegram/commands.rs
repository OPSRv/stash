use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::keyring::{ACCOUNT_BOT_TOKEN, ACCOUNT_CHAT_ID};
use super::pairing::{self, PairingState};
use super::state::TelegramState;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Connection status projected for the UI. Intentionally carries no secret —
/// just the pairing code (shown in UI for the user to type into Telegram) and
/// the paired chat id (public, not a credential).
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
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
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
    state: State<'_, TelegramState>,
    token: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    validate_token(&client, &token).await?;
    state.secrets.set(ACCOUNT_BOT_TOKEN, &token)
}

#[tauri::command]
pub fn telegram_clear_token(state: State<'_, TelegramState>) -> Result<(), String> {
    // Clearing the token must also unpair — chat_id is meaningless without a
    // bot to reach it.
    state.secrets.delete(ACCOUNT_BOT_TOKEN)?;
    state.secrets.delete(ACCOUNT_CHAT_ID)?;
    *state.pairing.lock().unwrap() = PairingState::Unconfigured;
    Ok(())
}

#[tauri::command]
pub fn telegram_has_token(state: State<'_, TelegramState>) -> Result<bool, String> {
    Ok(state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some())
}

#[tauri::command]
pub fn telegram_status(state: State<'_, TelegramState>) -> Result<ConnectionStatus, String> {
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    Ok(compute_status(has_token, &state.pairing.lock().unwrap()))
}

#[tauri::command]
pub fn telegram_start_pairing(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
    if state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_none() {
        return Err("Paste a bot token first".into());
    }
    let code = pairing::generate_code(&mut rand::thread_rng());
    let new_state = pairing::start_pairing(code, now_secs());
    *state.pairing.lock().unwrap() = new_state.clone();
    let _ = app.emit("telegram:status_changed", ());
    Ok(compute_status(true, &new_state))
}

#[tauri::command]
pub fn telegram_cancel_pairing(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
    {
        let mut p = state.pairing.lock().unwrap();
        if matches!(*p, PairingState::Pairing { .. }) {
            *p = PairingState::Unconfigured;
        }
    }
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    let status = compute_status(has_token, &state.pairing.lock().unwrap());
    let _ = app.emit("telegram:status_changed", ());
    Ok(status)
}

#[tauri::command]
pub fn telegram_unpair(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
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
        // Sanity: ConnectionStatus has no field that would carry the actual
        // bot token. The variant name `token_only` is fine — it's a state
        // label, not a credential.
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
