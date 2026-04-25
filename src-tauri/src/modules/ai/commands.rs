use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;
use uuid::Uuid;

use super::repo::{Message, Session};
use super::state::AiState;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn ai_list_sessions(state: State<'_, AiState>) -> Result<Vec<Session>, String> {
    state.repo.lock().unwrap().list_sessions().map_err(map_err)
}

#[tauri::command]
pub fn ai_create_session(
    state: State<'_, AiState>,
    title: Option<String>,
    kind: Option<String>,
    context_ref: Option<String>,
) -> Result<Session, String> {
    let id = Uuid::new_v4().to_string();
    let title = title.unwrap_or_else(|| "New chat".to_string());
    state
        .repo
        .lock()
        .unwrap()
        .create_session(
            &id,
            &title,
            now_ms(),
            kind.as_deref(),
            context_ref.as_deref(),
        )
        .map_err(map_err)
}

/// Look up the existing session bound to a `(kind, context_ref)` pair, or
/// `None` if none has been created yet. The notes module uses this to
/// resolve the per-note chat lazily on first open.
#[tauri::command]
pub fn ai_find_session_by_context(
    state: State<'_, AiState>,
    kind: String,
    context_ref: String,
) -> Result<Option<Session>, String> {
    state
        .repo
        .lock()
        .unwrap()
        .find_session_by_context(&kind, &context_ref)
        .map_err(map_err)
}

#[tauri::command]
pub fn ai_rename_session(
    state: State<'_, AiState>,
    id: String,
    title: String,
) -> Result<(), String> {
    state
        .repo
        .lock()
        .unwrap()
        .rename_session(&id, &title, now_ms())
        .map_err(map_err)
}

#[tauri::command]
pub fn ai_delete_session(state: State<'_, AiState>, id: String) -> Result<(), String> {
    state
        .repo
        .lock()
        .unwrap()
        .delete_session(&id)
        .map_err(map_err)
}

#[tauri::command]
pub fn ai_list_messages(
    state: State<'_, AiState>,
    session_id: String,
) -> Result<Vec<Message>, String> {
    state
        .repo
        .lock()
        .unwrap()
        .list_messages(&session_id)
        .map_err(map_err)
}

#[tauri::command]
pub fn ai_append_message(
    state: State<'_, AiState>,
    session_id: String,
    role: String,
    content: String,
    stopped: Option<bool>,
) -> Result<Message, String> {
    let id = Uuid::new_v4().to_string();
    state
        .repo
        .lock()
        .unwrap()
        .append_message(
            &id,
            &session_id,
            &role,
            &content,
            now_ms(),
            stopped.unwrap_or(false),
        )
        .map_err(map_err)
}

#[tauri::command]
pub fn ai_get_api_key(
    state: State<'_, AiState>,
    provider: String,
) -> Result<Option<String>, String> {
    state.secrets.get(&provider)
}

#[tauri::command]
pub fn ai_set_api_key(
    state: State<'_, AiState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    state.secrets.set(&provider, &key)
}

#[tauri::command]
pub fn ai_delete_api_key(state: State<'_, AiState>, provider: String) -> Result<(), String> {
    state.secrets.delete(&provider)
}

/// Does a keychain entry exist for this provider? Returns true without leaking
/// the secret itself — used by Settings UI to render the "••••••••" placeholder.
#[tauri::command]
pub fn ai_has_api_key(state: State<'_, AiState>, provider: String) -> Result<bool, String> {
    Ok(state.secrets.get(&provider)?.is_some())
}

/// Send a chat message through the full tool-enabled assistant (same loop used
/// by Telegram and the CLI). The user message has already been persisted by the
/// caller; this command runs the LLM + tool round-trips, persists the assistant
/// reply to the AI session, and returns it so the caller can append it to the UI.
#[tauri::command]
pub async fn ai_chat_send(
    app: tauri::AppHandle,
    state: State<'_, AiState>,
    session_id: String,
    prompt: String,
) -> Result<Message, String> {
    use tauri::Manager;

    let tg_state = app
        .try_state::<Arc<crate::modules::telegram::state::TelegramState>>()
        .ok_or_else(|| "assistant state not initialised".to_string())?;

    let reply = crate::modules::telegram::assistant::handle_user_text(&app, &*tg_state, &prompt)
        .await
        .map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    state
        .repo
        .lock()
        .map_err(|e| e.to_string())?
        .append_message(
            &id,
            &session_id,
            "assistant",
            &reply.text,
            ts,
            reply.truncated,
        )
        .map_err(|e| e.to_string())
}
