//! teloxide long-polling driver. Phase 0 only understands `/pair <code>` —
//! anything else is silently dropped. Later phases extend the dispatcher but
//! do not change this transport shape.

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use super::keyring::{SecretStore, ACCOUNT_CHAT_ID};
use super::pairing::{self, PairOutcome, PairingState};
use super::state::TelegramState;

/// Outcome of running one update through the Phase-0 dispatcher. Kept
/// separate from teloxide types so the dispatcher stays pure and tests do
/// not need network or a mocked bot.
#[derive(Debug, PartialEq, Eq)]
pub enum DispatchAction {
    /// Silently drop — no reply, no log.
    Drop,
    ReplyPaired { chat_id: i64 },
    ReplyReject { chat_id: i64 },
    ReplyExpired { chat_id: i64 },
    ReplyAlreadyPaired { chat_id: i64 },
    ReplyAborted { chat_id: i64 },
}

/// Parse an inbound text message + chat_id into a dispatcher action while
/// mutating `pairing` in place and persisting the chat id on successful
/// pair. Pure apart from the two borrow arguments — callable in unit tests.
pub fn dispatch_text(
    pairing_state: &mut PairingState,
    secrets: &dyn SecretStore,
    text: &str,
    chat_id: i64,
    now: i64,
) -> DispatchAction {
    let Some(code) = text.strip_prefix("/pair").map(str::trim) else {
        return DispatchAction::Drop;
    };
    if code.is_empty() {
        return DispatchAction::Drop;
    }

    // verify_pair consumes the state — clone and replace after.
    let snapshot = pairing_state.clone();
    let (next, outcome) = pairing::verify_pair(snapshot, code, chat_id, now);
    *pairing_state = next;

    match outcome {
        PairOutcome::Paired { chat_id } => {
            if let Err(e) = secrets.set(ACCOUNT_CHAT_ID, &chat_id.to_string()) {
                tracing::warn!(error = %e, "failed to persist chat_id after pair");
            }
            tracing::info!("paired with a new chat");
            DispatchAction::ReplyPaired { chat_id }
        }
        PairOutcome::Reject { .. } => DispatchAction::ReplyReject { chat_id },
        PairOutcome::Abort => DispatchAction::ReplyAborted { chat_id },
        PairOutcome::Expired => DispatchAction::ReplyExpired { chat_id },
        PairOutcome::AlreadyPaired => DispatchAction::ReplyAlreadyPaired { chat_id },
        PairOutcome::Ignore => DispatchAction::Drop,
    }
}

// -------------------- Live transport (teloxide) --------------------

/// Spawned tokio task that long-polls Telegram until cancelled. Phase 0
/// starts it inside `telegram_start_pairing` and stops it on unpair/cancel.
pub struct TransportHandle {
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl TransportHandle {
    pub fn new() -> Self {
        Self {
            shutdown: Mutex::new(None),
        }
    }

    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        self.shutdown.lock().await.is_some()
    }

    /// Spin up long-polling. Safe to call multiple times — a second call
    /// while already running is a no-op.
    pub async fn start(
        &self,
        token: String,
        app: AppHandle,
        state: Arc<TelegramState>,
    ) -> Result<(), String> {
        let mut slot = self.shutdown.lock().await;
        if slot.is_some() {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel::<()>();
        *slot = Some(tx);
        drop(slot);

        tokio::spawn(async move {
            run_polling(token, app, state, rx).await;
        });
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(tx) = self.shutdown.lock().await.take() {
            let _ = tx.send(());
        }
    }
}

impl Default for TransportHandle {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_polling(
    token: String,
    app: AppHandle,
    state: Arc<TelegramState>,
    mut shutdown: oneshot::Receiver<()>,
) {
    use teloxide::prelude::*;

    let bot = Bot::new(token);
    tracing::info!("telegram transport started");

    // Resume from last seen update_id so we don't re-process messages after
    // restart. Stored in the kv table (written below on every successful batch).
    let mut offset: i32 = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.kv_get("last_update_id").ok().flatten())
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(0);

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                tracing::info!("telegram transport stopping");
                break;
            }
            result = bot.get_updates().offset(offset).timeout(25) => {
                match result {
                    Ok(list) => {
                        for u in list {
                            offset = (u.id.0 as i32).saturating_add(1);
                            handle_update(&bot, &app, &state, u).await;
                        }
                        if let Ok(mut repo) = state.repo.lock() {
                            let _ = repo.kv_set("last_update_id", &offset.to_string());
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "getUpdates failed");
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
            }
        }
    }
}

async fn handle_update(
    bot: &teloxide::Bot,
    app: &AppHandle,
    state: &Arc<TelegramState>,
    update: teloxide::types::Update,
) {
    use teloxide::prelude::*;
    use teloxide::types::UpdateKind;

    let UpdateKind::Message(msg) = update.kind else {
        return;
    };
    let Some(text) = msg.text() else { return };
    let chat_id = msg.chat.id.0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let action = {
        let mut p = state.pairing.lock().unwrap();
        dispatch_text(&mut p, state.secrets.as_ref(), text, chat_id, now)
    };

    let reply = match &action {
        DispatchAction::Drop => return,
        DispatchAction::ReplyPaired { .. } => {
            let _ = app.emit("telegram:paired", chat_id);
            "✅ Paired with Stash. Commands coming in the next build."
        }
        DispatchAction::ReplyReject { .. } => "❌ Invalid code.",
        DispatchAction::ReplyExpired { .. } => {
            "⚠️ Pairing code expired — start again in Stash."
        }
        DispatchAction::ReplyAlreadyPaired { .. } => "✅ Already paired with Stash.",
        DispatchAction::ReplyAborted { .. } => {
            "⚠️ Too many wrong codes. Pairing cancelled — restart from Stash."
        }
    };
    if let Err(e) = bot
        .send_message(teloxide::types::ChatId(chat_id), reply)
        .await
    {
        tracing::warn!(error = %e, "send_message failed");
    }
    let _ = app.emit("telegram:status_changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;

    fn store() -> MemStore {
        MemStore::new()
    }

    fn active_pairing() -> PairingState {
        PairingState::Pairing {
            code: "123456".into(),
            expires_at: 999_999_999,
            bad_attempts: 0,
        }
    }

    #[test]
    fn non_pair_text_is_dropped() {
        let mut p = active_pairing();
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "hello bot", 1, 0),
            DispatchAction::Drop
        );
    }

    #[test]
    fn bare_slash_pair_is_dropped() {
        let mut p = active_pairing();
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair", 1, 0),
            DispatchAction::Drop
        );
    }

    #[test]
    fn correct_code_pairs_and_persists_chat_id() {
        let mut p = active_pairing();
        let s = store();
        let action = dispatch_text(&mut p, &s, "/pair 123456", 777, 0);
        assert_eq!(action, DispatchAction::ReplyPaired { chat_id: 777 });
        assert_eq!(p, PairingState::Paired { chat_id: 777 });
        assert_eq!(s.get(ACCOUNT_CHAT_ID).unwrap().as_deref(), Some("777"));
    }

    #[test]
    fn wrong_code_rejects_without_persisting() {
        let mut p = active_pairing();
        let s = store();
        let action = dispatch_text(&mut p, &s, "/pair 000000", 1, 0);
        assert_eq!(action, DispatchAction::ReplyReject { chat_id: 1 });
        assert_eq!(s.get(ACCOUNT_CHAT_ID).unwrap(), None);
    }

    #[test]
    fn unpaired_state_drops_silently() {
        let mut p = PairingState::Unconfigured;
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair 123456", 1, 0),
            DispatchAction::Drop,
            "unconfigured → Ignore → Drop (no leakage)"
        );
    }

    #[test]
    fn already_paired_replies_accordingly() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair 123456", 42, 0),
            DispatchAction::ReplyAlreadyPaired { chat_id: 42 }
        );
    }
}
