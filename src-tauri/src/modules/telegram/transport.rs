//! teloxide long-polling driver. Before pairing it only understands
//! `/pair <code>` (and answers `/start` with a pairing hint); once paired it
//! routes commands, free text, media and button presses. Polling runs under
//! a supervisor; updates are handled off the polling loop (messages in
//! order on one worker, callbacks concurrently), each on its own task.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::keyring::{SecretStore, ACCOUNT_CHAT_ID};
use super::pairing::{self, PairOutcome, PairingState};
use super::state::TelegramState;

/// Outcome of running one update through the dispatcher. Kept separate
/// from teloxide types so the dispatcher stays pure and tests do not need
/// network or a mocked bot.
#[derive(Debug, PartialEq, Eq)]
pub enum DispatchAction {
    /// Silently drop — no reply, no log.
    Drop,
    ReplyPaired {
        chat_id: i64,
    },
    ReplyReject {
        chat_id: i64,
    },
    ReplyExpired {
        chat_id: i64,
    },
    ReplyAlreadyPaired {
        chat_id: i64,
    },
    ReplyAborted {
        chat_id: i64,
    },
    /// `/start` before pairing — answer with a one-line pairing hint.
    ReplyStartUnpaired {
        chat_id: i64,
    },
    /// Paired user sent a slash-command. Dispatcher couldn't call the
    /// async handler itself (it is sync + pure), so it surfaces the name
    /// and args for `handle_update` to resolve against the registry.
    RunCommand {
        chat_id: i64,
        name: String,
        args: String,
    },
    /// Paired user sent plain text. Phase 1.5 pipes this into the inbox;
    /// for now the caller drops it.
    IngestText {
        chat_id: i64,
        text: String,
    },
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
    // /pair always takes precedence while not Paired, regardless of other
    // input shapes.
    if let Some(code) = text.strip_prefix("/pair").map(str::trim) {
        if !code.is_empty() {
            return dispatch_pair(pairing_state, secrets, code, chat_id, now);
        }
        // Bare `/pair` — fall through to command dispatch (which will drop
        // it if unpaired, or reject it as unknown-command when paired).
    }

    match pairing_state {
        PairingState::Unconfigured | PairingState::Pairing { .. } => {
            // Telegram clients send `/start` when the user first opens the
            // bot; tell them where to pair instead of staying silent.
            let is_start = text
                .strip_prefix('/')
                .map(|rest| command_name(split_command(rest).0) == "start")
                .unwrap_or(false);
            if is_start {
                DispatchAction::ReplyStartUnpaired { chat_id }
            } else {
                DispatchAction::Drop
            }
        }
        PairingState::Paired { chat_id: allowed } => {
            if *allowed != chat_id {
                // Allowlist: messages from any other chat are silently
                // dropped so a leaked token can't learn about us.
                return DispatchAction::Drop;
            }
            if let Some(rest) = text.strip_prefix('/') {
                let (name, args) = split_command(rest);
                let name = command_name(name);
                if name.is_empty() {
                    return DispatchAction::Drop;
                }
                DispatchAction::RunCommand {
                    chat_id,
                    name,
                    args: args.to_string(),
                }
            } else {
                DispatchAction::IngestText {
                    chat_id,
                    text: text.to_string(),
                }
            }
        }
    }
}

fn dispatch_pair(
    pairing_state: &mut PairingState,
    secrets: &dyn SecretStore,
    code: &str,
    chat_id: i64,
    now: i64,
) -> DispatchAction {
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

/// Split "cmd rest of args" into ("cmd", "rest of args"). Trims leading/
/// trailing whitespace from the name but leaves args verbatim so commands
/// that care about exact payload (e.g. `/note  foo`) receive what the user
/// typed.
fn split_command(s: &str) -> (&str, &str) {
    match s.find(char::is_whitespace) {
        Some(i) => (s[..i].trim(), s[i + 1..].trim_start()),
        None => (s.trim(), ""),
    }
}

/// Normalise a command token: lowercase and drop the `@BotName` suffix
/// Telegram appends when a command is picked from the menu in groups.
fn command_name(token: &str) -> String {
    token
        .split('@')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// Heuristic: does `s` contain at least one URL worth storing in the
/// inbox? Matches `http(s)://…` and bare `www.…` hosts — same rules
/// the frontend LinkifiedText uses, kept simple (regex-free) on
/// purpose. False positives (e.g. a string with "http://" as literal
/// text about protocols) are OK — the user can still delete the row.
pub(crate) fn contains_url(s: &str) -> bool {
    let lower = s.to_lowercase();
    // Looks for a scheme + at least one non-whitespace/punctuation
    // char immediately after. A bare "http://" in prose doesn't fire.
    for needle in ["http://", "https://"] {
        if let Some(pos) = lower.find(needle) {
            let after = &lower[pos + needle.len()..];
            if after
                .chars()
                .next()
                .map(|c| !c.is_whitespace() && c.is_alphanumeric())
                .unwrap_or(false)
            {
                return true;
            }
        }
    }
    if let Some(pos) = lower.find("www.") {
        // Require a dot after www. (e.g. "www.site.com") so a sentence
        // like "at www." doesn't fire.
        let after = &lower[pos + 4..];
        if let Some(first) = after.chars().next() {
            if first.is_alphanumeric() && after[first.len_utf8()..].contains('.') {
                return true;
            }
        }
    }
    false
}

// -------------------- Live transport (teloxide) --------------------

/// Upper bound for one queued message handler before the ordered worker
/// moves on to the next update. The slow handler keeps running detached —
/// this only stops one hung LLM call from freezing the whole bot.
const MESSAGE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Same guard for button presses (they run concurrently, so it only
/// bounds how long we keep the JoinHandle around).
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// getUpdates retry backoff: doubles from START up to MAX.
const POLL_BACKOFF_START: Duration = Duration::from_secs(1);
const POLL_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// Pause before the supervisor restarts a polling task that died.
const RESTART_DELAY: Duration = Duration::from_secs(5);
/// Telegram drops "typing…" after ~5s; refresh a bit sooner.
const TYPING_REFRESH: Duration = Duration::from_secs(4);
/// Hard stop for a forgotten typing guard (~10 minutes).
const TYPING_MAX_TICKS: u32 = 150;

/// Commands that work but stay out of Telegram's `/` menu: `/pair` only
/// matters during pairing, `/start` is sent by the client itself, and
/// `voice` / `confirm` / `retry` / `ask` are driven by inline buttons.
const HIDDEN_COMMANDS: &[&str] = &["pair", "start", "voice", "confirm", "retry", "ask"];

const UNSUPPORTED_MESSAGE: &str = "🤷 Цей тип повідомлень поки не підтримується.";

type ShutdownSlot = Arc<Mutex<Option<(u64, oneshot::Sender<()>)>>>;

/// Supervised long-polling task. Started on pairing / app launch and
/// stopped on unpair/cancel. If the polling task panics it is restarted;
/// if it exits for good (revoked token) the slot is cleared so a later
/// `start` can bring it back.
pub struct TransportHandle {
    shutdown: ShutdownSlot,
    generation: AtomicU64,
}

impl TransportHandle {
    pub fn new() -> Self {
        Self {
            shutdown: Arc::new(Mutex::new(None)),
            generation: AtomicU64::new(0),
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
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel::<()>();
        *slot = Some((generation, tx));
        drop(slot);

        let slot = Arc::clone(&self.shutdown);
        tokio::spawn(async move {
            supervise(token, app, state, rx, slot, generation).await;
        });
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some((_, tx)) = self.shutdown.lock().await.take() {
            let _ = tx.send(());
        }
    }
}

impl Default for TransportHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// Keep `run_polling` alive until shutdown: restart it after a panic,
/// give up (and free the slot) when it returns on a fatal error.
async fn supervise(
    token: String,
    app: AppHandle,
    state: Arc<TelegramState>,
    mut shutdown: oneshot::Receiver<()>,
    slot: ShutdownSlot,
    generation: u64,
) {
    loop {
        let mut task = tokio::spawn(run_polling(token.clone(), app.clone(), Arc::clone(&state)));
        tokio::select! {
            _ = &mut shutdown => {
                task.abort();
                tracing::info!("telegram transport stopping");
                return;
            }
            res = &mut task => {
                match res {
                    Ok(()) => {
                        // Fatal exit (e.g. revoked token): free the slot
                        // unless a newer transport already took it.
                        let mut s = slot.lock().await;
                        if matches!(&*s, Some((g, _)) if *g == generation) {
                            *s = None;
                        }
                        tracing::warn!("telegram transport stopped after a fatal error");
                        return;
                    }
                    Err(e) if e.is_panic() => {
                        tracing::error!("telegram polling task panicked — restarting");
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "telegram polling task ended unexpectedly — restarting");
                    }
                }
            }
        }
        tokio::select! {
            _ = &mut shutdown => return,
            _ = tokio::time::sleep(RESTART_DELAY) => {}
        }
    }
}

/// How the poll loop reacts to a getUpdates failure.
#[derive(Debug, PartialEq, Eq)]
enum PollError {
    /// 401 — token revoked/invalid. Retrying is pointless.
    InvalidToken,
    /// 409 — another process is polling with the same token.
    Conflict,
    /// Flood control with an explicit wait.
    RetryAfter(Duration),
    /// Network blips, 5xx — exponential backoff.
    Transient,
}

fn classify_poll_error(e: &teloxide::RequestError) -> PollError {
    use teloxide::{ApiError, RequestError};
    match e {
        RequestError::Api(ApiError::InvalidToken) => PollError::InvalidToken,
        RequestError::Api(ApiError::TerminatedByOtherGetUpdates) => PollError::Conflict,
        RequestError::RetryAfter(s) => PollError::RetryAfter(s.duration()),
        _ => PollError::Transient,
    }
}

fn next_backoff(current: Duration) -> Duration {
    current.saturating_mul(2).min(POLL_BACKOFF_MAX)
}

/// Tell the UI about transport health. `None` = healthy again.
fn emit_status(app: &AppHandle, error: Option<&str>) {
    let _ = app.emit("telegram:status", serde_json::json!({ "error": error }));
    let _ = app.emit("telegram:status_changed", ());
}

fn command_count(state: &TelegramState) -> usize {
    state
        .commands
        .read()
        .map(|r| r.enumerate().len())
        .unwrap_or(0)
}

/// Long-poll loop. Returns only on a fatal error; the supervisor aborts it
/// on shutdown.
async fn run_polling(token: String, app: AppHandle, state: Arc<TelegramState>) {
    use teloxide::prelude::*;
    use teloxide::types::UpdateKind;

    let bot = Bot::new(token);
    tracing::info!("telegram transport started");

    // Publish slash commands so they show up in Telegram's / autocomplete.
    publish_bot_commands(&bot, &state).await;
    let mut published_count = command_count(&state);

    // Resume from last seen update_id so we don't re-process messages after
    // restart. Stored in the kv table (written below before each update runs).
    let mut offset: i32 = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.kv_get("last_update_id").ok().flatten())
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(0);

    // Messages go through one ordered worker so replies keep the order the
    // user typed them in; button presses run concurrently. Every handler is
    // spawned on its own task, so a panic is logged instead of killing the
    // poller. The worker exits when this function's sender is dropped.
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<teloxide::types::Update>();
    {
        let bot = bot.clone();
        let app = app.clone();
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            while let Some(u) = msg_rx.recv().await {
                let fut = handle_update(bot.clone(), app.clone(), Arc::clone(&state), u);
                run_guarded("message", MESSAGE_TIMEOUT, fut).await;
            }
        });
    }

    let mut backoff = POLL_BACKOFF_START;
    let mut reported_error = false;
    loop {
        // 10s long-poll: short enough that flaky NATs / captive portals
        // don't reap the idle connection, still long enough to avoid
        // hot-looping.
        match bot.get_updates().offset(offset).timeout(10).await {
            Ok(list) => {
                backoff = POLL_BACKOFF_START;
                if std::mem::take(&mut reported_error) {
                    emit_status(&app, None);
                }
                for u in list {
                    offset = (u.id.0 as i32).saturating_add(1);
                    // Persist before handling: a crash mid-handler must not
                    // replay the update (and its side effects) on restart.
                    if let Ok(mut repo) = state.repo.lock() {
                        let _ = repo.kv_set("last_update_id", &offset.to_string());
                    }
                    if matches!(u.kind, UpdateKind::CallbackQuery(_)) {
                        let fut = handle_update(bot.clone(), app.clone(), Arc::clone(&state), u);
                        tokio::spawn(run_guarded("callback", CALLBACK_TIMEOUT, fut));
                    } else if msg_tx.send(u).is_err() {
                        tracing::error!("telegram message worker is gone");
                    }
                }
                // Commands registered after start (late module wiring) get
                // pushed to the `/` menu on the next poll cycle.
                let count = command_count(&state);
                if count != published_count {
                    published_count = count;
                    publish_bot_commands(&bot, &state).await;
                }
            }
            Err(e) => match classify_poll_error(&e) {
                PollError::InvalidToken => {
                    tracing::error!(error = %e, "getUpdates: bot token rejected (401) — stopping transport");
                    emit_status(
                        &app,
                        Some("Telegram rejected the bot token (401). Re-pair the bot in Stash → Telegram."),
                    );
                    return;
                }
                PollError::Conflict => {
                    tracing::error!(
                        error = %e,
                        "getUpdates: another instance is polling this bot (409) — retrying in {}s",
                        POLL_BACKOFF_MAX.as_secs()
                    );
                    if !reported_error {
                        reported_error = true;
                        emit_status(
                            &app,
                            Some("Another app instance is polling this bot (409 Conflict)."),
                        );
                    }
                    tokio::time::sleep(POLL_BACKOFF_MAX).await;
                }
                PollError::RetryAfter(wait) => {
                    tracing::warn!(wait_s = wait.as_secs(), "getUpdates: flood control");
                    tokio::time::sleep(wait).await;
                }
                PollError::Transient => {
                    tracing::warn!(error = %e, backoff_s = backoff.as_secs(), "getUpdates failed");
                    tokio::time::sleep(backoff).await;
                    backoff = next_backoff(backoff);
                }
            },
        }
    }
}

/// Run one update handler on its own task: panics are logged, and a
/// handler that outlives `limit` is left running detached while the
/// caller moves on.
async fn run_guarded<F>(what: &'static str, limit: Duration, fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let handle = tokio::spawn(fut);
    match tokio::time::timeout(limit, handle).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) if e.is_panic() => tracing::error!(what, "telegram update handler panicked"),
        Ok(Err(e)) => tracing::warn!(what, error = %e, "telegram update handler cancelled"),
        Err(_) => tracing::warn!(
            what,
            "telegram update handler still running after timeout — moving on"
        ),
    }
}

/// Poison-tolerant check that `chat_id` is the paired chat.
fn is_paired_chat(state: &TelegramState, chat_id: i64) -> bool {
    matches!(
        &*state.pairing.lock().unwrap_or_else(|e| e.into_inner()),
        PairingState::Paired { chat_id: allowed } if *allowed == chat_id
    )
}

async fn handle_update(
    bot: teloxide::Bot,
    app: AppHandle,
    state: Arc<TelegramState>,
    update: teloxide::types::Update,
) {
    use teloxide::types::UpdateKind;

    // Button presses on inline keyboards arrive as CallbackQuery. Treated
    // exactly like a typed slash command after allowlist verification.
    // Edited text messages are handled like fresh ones (the user fixed a
    // typo and expects an answer to the corrected text).
    let (msg, edited) = match update.kind {
        UpdateKind::CallbackQuery(q) => {
            handle_callback(&bot, &app, &state, q).await;
            return;
        }
        UpdateKind::Message(m) => (m, false),
        UpdateKind::EditedMessage(m) => (m, true),
        _ => return,
    };
    let (bot, app, state) = (&bot, &app, &state);
    let chat_id = msg.chat.id.0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Media path — voice / audio / photo / document / video. Only persisted
    // when the sender is on the allowlist (Paired.chat_id == msg.chat_id).
    // Edits of media messages (caption tweaks) are ignored so the file
    // isn't downloaded twice.
    if !edited {
        if let Some(intent) = super::inbox::extract_media(&msg) {
            if !is_paired_chat(state, chat_id) {
                return; // allowlist drop
            }
            handle_media(bot, app, state, &msg, intent, now).await;
            return;
        }
    }

    let Some(text) = msg.text() else {
        if !edited && super::inbox::is_unsupported_media(&msg) && is_paired_chat(state, chat_id) {
            state.sender.enqueue(chat_id, UNSUPPORTED_MESSAGE);
        }
        return;
    };

    let action = {
        let mut p = state.pairing.lock().unwrap_or_else(|e| e.into_inner());
        dispatch_text(&mut p, state.secrets.as_ref(), text, chat_id, now)
    };

    match action {
        DispatchAction::Drop => return,
        DispatchAction::ReplyStartUnpaired { .. } => {
            state.sender.enqueue(chat_id, super::bot_cmds::UNPAIRED_START_HINT);
        }
        DispatchAction::ReplyPaired { .. } => {
            let _ = app.emit("telegram:paired", chat_id);
            let welcome = build_welcome_message(app);
            state.sender.enqueue_with_keyboard(
                chat_id,
                welcome,
                Some(super::commands_registry::quick_actions_keyboard()),
            );
        }
        DispatchAction::ReplyReject { .. } => {
            state.sender.enqueue(chat_id, "❌ Невірний код.");
        }
        DispatchAction::ReplyExpired { .. } => {
            state.sender.enqueue(
                chat_id,
                "⚠️ Код парування прострочений — почни знову у Stash.",
            );
        }
        DispatchAction::ReplyAlreadyPaired { .. } => {
            state.sender.enqueue(chat_id, "✅ Уже сполучено зі Stash.");
        }
        DispatchAction::ReplyAborted { .. } => {
            state.sender.enqueue(
                chat_id,
                "⚠️ Забагато невірних кодів. Парування скасовано — почни знову у Stash.",
            );
        }
        DispatchAction::RunCommand { name, args, .. } => {
            if let Some(handler) = state.find_command(&name) {
                // "typing…" stays visible until the reply is queued, so
                // slow commands (/screenshot, /summarize) show progress.
                let _typing = TypingGuard::start(bot, chat_id);
                let reply = handler
                    .handle(
                        crate::modules::telegram::commands_registry::Ctx { app: app.clone() },
                        &args,
                    )
                    .await;
                state
                    .sender
                    .enqueue_full(chat_id, reply.text, reply.keyboard, reply.documents);
            } else {
                let (text, keyboard) = build_unknown_command_reply(state, &name);
                state.sender.enqueue_with_keyboard(chat_id, text, keyboard);
            }
        }
        DispatchAction::IngestText { text, .. } => {
            use super::bot_cmds::{
                assistant_text, friendly_llm_error, remember_prompt, retry_keyboard,
                with_reply_context,
            };
            // URLs always land in the inbox, even when the AI path
            // succeeds — that's the surface where the user expects to
            // see shareable links ("download this mp3", "save this
            // article"). Pure chat without URLs still flows only to
            // the assistant; otherwise the inbox would fill up with
            // every "привіт" and become useless.
            let mut inbox_already = false;
            if contains_url(&text) {
                let msg_id = msg.id.0 as i64;
                if let Ok(mut repo) = state.repo.lock() {
                    if let Ok(id) = repo.insert_text_inbox(msg_id, &text, now) {
                        tracing::debug!(id, "inbox text with url saved");
                        let _ = app.emit("telegram:inbox_added", id);
                        inbox_already = true;
                    }
                }
            }

            // Replying to a message quotes it for the assistant so "this"
            // / "translate it" have a referent.
            let quote = reply_quote(state, &msg);
            let prompt = with_reply_context(quote.as_deref(), &text);
            remember_prompt(&prompt);

            // Phase 3: free text goes to the AI assistant when one is
            // configured. Any missing-piece error (no key, no model,
            // provider not supported) falls back to the inbox so the
            // message isn't silently swallowed.
            let typing = TypingGuard::start(bot, chat_id);
            let result = super::assistant::handle_user_text_at(
                app,
                state,
                &prompt,
                Some(msg.date.timestamp()),
            )
            .await;
            drop(typing);
            match result {
                Ok(reply) => {
                    state.sender.enqueue(chat_id, assistant_text(&reply));
                }
                Err(e) => {
                    tracing::info!(error = %e, "assistant unavailable, falling back to inbox");
                    let friendly = friendly_llm_error(&e);
                    if inbox_already {
                        // The URL-detect path already persisted this
                        // message — avoid a duplicate row. Surface the
                        // assistant failure so the user knows why
                        // there's no AI reply, but don't pretend we're
                        // "saving" something twice.
                        state.sender.enqueue_with_keyboard(
                            chat_id,
                            friendly,
                            Some(retry_keyboard()),
                        );
                    } else {
                        let msg_id = msg.id.0 as i64;
                        let received_at = now;
                        let inbox_id = match state.repo.lock() {
                            Ok(mut repo) => repo
                                .insert_text_inbox(msg_id, &text, received_at)
                                .map_err(|e| e.to_string()),
                            Err(e) => Err(e.to_string()),
                        };
                        match inbox_id {
                            Ok(id) => {
                                tracing::debug!(id, text_len = text.len(), "inbox text ingested");
                                let _ = app.emit("telegram:inbox_added", id);
                                state.sender.enqueue_with_keyboard(
                                    chat_id,
                                    format!("📥 Збережено в інбокс.\n{friendly}"),
                                    Some(retry_keyboard()),
                                );
                            }
                            Err(e2) => {
                                tracing::warn!(error = %e2, "inbox insert failed");
                                state.sender.enqueue(
                                    chat_id,
                                    "⚠️ Не вдалося зберегти в інбокс — переглянь лог Stash.",
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let _ = app.emit("telegram:status_changed", ());
}

/// Text of the message the user replied to: its text/caption, plus the
/// inbox transcript (Whisper / OCR) when the quoted message was media.
fn reply_quote(state: &TelegramState, msg: &teloxide::types::Message) -> Option<String> {
    let q = msg.reply_to_message()?;
    if let Some(t) = q.text().filter(|t| !t.trim().is_empty()) {
        return Some(t.to_string());
    }
    let transcript = state.repo.lock().ok().and_then(|repo| {
        let qid = q.id.0 as i64;
        repo.list_inbox(200)
            .ok()?
            .into_iter()
            .find(|i| i.telegram_message_id == qid)
            .and_then(|i| i.transcript)
    });
    let parts: Vec<String> = [q.caption().map(str::to_string), transcript]
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

async fn handle_media(
    bot: &teloxide::Bot,
    app: &AppHandle,
    state: &Arc<TelegramState>,
    msg: &teloxide::types::Message,
    intent: super::inbox::MediaIntent,
    now: i64,
) {
    use super::inbox::{
        bump_used_bytes, check_caps, current_caps, download_to, record_media, target_paths,
        today_str, today_used_bytes, CapVerdict,
    };
    use tauri::Manager;

    let chat_id = msg.chat.id.0;
    let day = today_str(now);
    let used = today_used_bytes(state, &day);
    let (per_file, per_day) = current_caps(state);

    match check_caps(intent.declared_size, used, per_file, per_day) {
        CapVerdict::OverPerFile { limit, size } => {
            state.sender.enqueue(
                chat_id,
                format!(
                    "⚠️ File too big: {} MB (per-file cap {} MB). Skipped.",
                    size / 1_048_576,
                    limit / 1_048_576
                ),
            );
            return;
        }
        CapVerdict::OverPerDay {
            limit,
            used,
            attempted,
        } => {
            state.sender.enqueue(
                chat_id,
                format!(
                    "⚠️ Daily inbox quota hit: {} MB used + {} MB pending > {} MB cap. Try tomorrow.",
                    used / 1_048_576,
                    attempted / 1_048_576,
                    limit / 1_048_576,
                ),
            );
            return;
        }
        CapVerdict::Unknown => {
            state
                .sender
                .enqueue(chat_id, "⚠️ Telegram не вказав розмір — пропускаю.");
            return;
        }
        CapVerdict::Ok => {}
    }

    // Resolve the app data dir every call — cheap lookup through Manager.
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "inbox: app_data_dir lookup failed");
            return;
        }
    };

    let (abs, rel) = match target_paths(&data_dir, &day, intent.extension) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "inbox: could not create day dir");
            state.sender.enqueue(
                chat_id,
                "⚠️ Не вдалося створити папку інбокса — переглянь лог Stash.",
            );
            return;
        }
    };

    let bytes = match download_to(bot, &intent.file_id, &abs).await {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(error = %e, "inbox: download failed");
            let _ = std::fs::remove_file(&abs); // partial file, best-effort cleanup
            // The Bot API caps file downloads at 20 MB regardless of how
            // big the file actually is on Telegram's servers — that's a
            // server-side limit, not something we can lift here. Most
            // failures on forwarded videos are exactly this, so detect
            // the signature and explain instead of just dumping the
            // raw error.
            let lower = e.to_lowercase();
            let is_too_big = lower.contains("file is too big")
                || lower.contains("400")
                    && (lower.contains("too big") || lower.contains("too large"));
            let detail = if is_too_big {
                "файл >20 MB — Bot API не дозволяє завантажувати такі. \
                 Використай повний клієнт у Stash → Downloader (yt-dlp) \
                 або перешли як «video file» (не «video»), щоб обійти ліміт"
                    .to_string()
            } else {
                e
            };
            state
                .sender
                .enqueue(chat_id, format!("⚠️ Завантаження з Telegram не вдалося: {detail}"));
            return;
        }
    };

    let msg_id = msg.id.0 as i64;
    let inbox_id = match record_media(app, state, msg_id, &intent, &rel, now) {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(error = %e, "inbox: repo insert failed");
            state.sender.enqueue(
                chat_id,
                "⚠️ Could not persist inbox record — file kept on disk.",
            );
            return;
        }
    };
    bump_used_bytes(state, &day, bytes);

    let human_size = if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    };
    let duration_tag = intent
        .duration_sec
        .filter(|s| *s > 0)
        .map(|s| format!(" · {s}s"))
        .unwrap_or_default();
    // Audio-bearing (voice / video / video_note) and OCR-able (photo /
    // image-document / pdf) kinds go silent on ingest — the user gets
    // a transcript message once Whisper / Vision finishes, which is
    // already informative on its own. Adding an inbox-save ack on top
    // is noise.
    let will_transcribe = super::inbox::is_transcribable(intent.kind);
    let will_ocr = crate::modules::ocr::is_ocr_able(intent.kind, intent.mime.as_deref());
    if !will_transcribe && !will_ocr {
        let reply = format!(
            "📥 Saved {} ({}{}). See it in Stash → Telegram → Inbox.",
            intent.kind, human_size, duration_tag
        );
        state.sender.enqueue(chat_id, reply);
    }

    // OCR runs in the background; the recognised text comes back with an
    // "🤖 Спитати AI" button, or — when the caption already reads like a
    // question/instruction — goes straight to the assistant together with
    // the caption.
    if will_ocr {
        let file_abs = abs.clone();
        let mime_owned = intent.mime.clone();
        let caption = intent.caption.clone();
        let app_for_task = app.clone();
        let state_for_task = Arc::clone(state);
        let bot_for_task = bot.clone();
        let chat_for_task = chat_id;
        use tauri::Emitter;
        let _ = app.emit("telegram:transcribing", inbox_id);
        tauri::async_runtime::spawn(async move {
            // Vision / PDFKit are sync APIs and can take a few hundred
            // ms on big PDFs; offload to spawn_blocking so we don't pin
            // a tokio worker.
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::modules::ocr::extract_text(&file_abs, mime_owned.as_deref())
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);

            match result {
                Ok(text) if !text.is_empty() => {
                    if let Ok(mut repo) = state_for_task.repo.lock() {
                        let _ = repo.set_inbox_transcript(inbox_id, &text);
                    }
                    let _ = app_for_task.emit("telegram:inbox_updated", inbox_id);
                    let wants_ai = caption
                        .as_deref()
                        .map(super::bot_cmds::looks_like_prompt)
                        .unwrap_or(false);
                    if wants_ai {
                        let _typing = TypingGuard::start(&bot_for_task, chat_for_task);
                        let prompt = super::bot_cmds::ocr_prompt(caption.as_deref(), &text);
                        let reply =
                            super::bot_cmds::ask_assistant(&app_for_task, &state_for_task, &prompt)
                                .await;
                        state_for_task.sender.enqueue_full(
                            chat_for_task,
                            reply.text,
                            reply.keyboard,
                            reply.documents,
                        );
                    } else {
                        state_for_task.sender.enqueue_with_keyboard(
                            chat_for_task,
                            format!("📝 {text}"),
                            Some(super::bot_cmds::ask_keyboard(inbox_id)),
                        );
                    }
                }
                Ok(_) => {
                    // Vision found no text — surface that as a failure
                    // so the row clears the spinner and shows a retry
                    // hint, same UX as a flubbed Whisper run.
                    let _ = app_for_task.emit("telegram:transcribe_failed", inbox_id);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "ocr failed");
                    let _ = app_for_task.emit("telegram:transcribe_failed", inbox_id);
                    state_for_task.sender.enqueue(
                        chat_for_task,
                        "⚠️ Не вдалося розпізнати текст на зображенні — деталі в лозі Stash.",
                    );
                }
            }
        });
    }

    // Voice / audio / video / video_note all trigger Whisper transcription
    // in the background. Symphonia demuxes the mp4 container so the same
    // pipeline handles all of them. Keeping this off the request path
    // means a bad model config never blocks the inbox write — the row
    // is already persisted above.
    if will_transcribe {
        let audio_abs = abs.clone();
        let app_for_task = app.clone();
        let state_for_task = Arc::clone(state);
        let chat_for_task = chat_id;
        // Tell the UI transcription started so the Inbox panel can
        // surface a per-row spinner while Whisper chews on the file.
        use tauri::Emitter;
        let _ = app.emit("telegram:transcribing", inbox_id);
        // Diarization toggle is read once per recording — flipping
        // it later won't retro-label this transcript, but the next
        // one will pick up the change.
        let diarize = super::settings::AiSettings::load(state).diarization_enabled;
        tauri::async_runtime::spawn(async move {
            match crate::modules::diarization::pipeline::transcribe_with_optional_diarization(
                &app_for_task,
                audio_abs,
                None,
                diarize,
                None,
            )
            .await
            {
                Ok(text) => {
                    let trimmed = text.trim().to_string();
                    if trimmed.is_empty() {
                        // Nothing usable came back — clear the UI spinner.
                        let _ = app_for_task.emit("telegram:transcribe_failed", inbox_id);
                        return;
                    }
                    if let Ok(mut repo) = state_for_task.repo.lock() {
                        let _ = repo.set_inbox_transcript(inbox_id, &trimmed);
                    }
                    let _ = app_for_task.emit("telegram:inbox_updated", inbox_id);

                    // Send the transcript with an action-picker
                    // keyboard. The previous behaviour (auto-pipe
                    // through the assistant on every recording) is
                    // gone — every AI follow-up is now opt-in per
                    // message via the buttons. Same dispatch the
                    // text-mode chat already uses, so we don't have
                    // a parallel code path for "what does AI do
                    // with this text".
                    let kb = super::module_cmds::voice_action_keyboard(inbox_id);
                    state_for_task.sender.enqueue_with_keyboard(
                        chat_for_task,
                        format!("📝 {trimmed}"),
                        Some(kb),
                    );
                }
                Err(e) => {
                    tracing::warn!(error = %e, "whisper transcription failed");
                    let _ = app_for_task.emit("telegram:transcribe_failed", inbox_id);
                    state_for_task.sender.enqueue(
                        chat_for_task,
                        "⚠️ Не вдалося розшифрувати аудіо — перевір модель Whisper у налаштуваннях Stash.",
                    );
                }
            }
        });
    }
}

async fn handle_callback(
    bot: &teloxide::Bot,
    app: &AppHandle,
    state: &Arc<TelegramState>,
    q: teloxide::types::CallbackQuery,
) {
    use teloxide::prelude::*;

    let Some(data) = q.data.clone() else {
        let _ = bot.answer_callback_query(q.id.clone()).await;
        return;
    };
    // Allowlist: only the paired chat's user can drive buttons.
    let user_id = q.from.id.0 as i64;
    // Answer right away so the button's spinner stops even when the
    // handler is slow (LLM turns, screenshots). Foreign users get the
    // same silent ack and nothing else.
    let _ = bot.answer_callback_query(q.id.clone()).await;
    if !is_paired_chat(state, user_id) {
        return;
    }

    // "refresh:<cmd>[ rest]" — run the command and *edit* the source
    // message in place instead of sending a fresh one. Lets the Dashboard
    // (and other live cards) behave like a cockpit that updates rather
    // than a stack of stale snapshots.
    let (is_refresh, dispatch_data) = match data.strip_prefix("refresh:") {
        Some(rest) => (true, rest.to_string()),
        None => (false, data.clone()),
    };

    // "ns:action[:arg]" — dispatch to a registered command named `ns`.
    let (ns, action) = match dispatch_data.split_once(':') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (dispatch_data.clone(), String::new()),
    };

    let Some(handler) = state.find_command(&ns) else {
        return;
    };
    let typing = TypingGuard::start(bot, user_id);
    let reply = handler
        .handle(
            crate::modules::telegram::commands_registry::Ctx { app: app.clone() },
            &action,
        )
        .await;
    drop(typing);

    // Edit-in-place path: reuse the originating message instead of
    // sending a new one. Only applies when the callback asked for it
    // AND we actually know which message to edit (q.message is present).
    if is_refresh && reply.documents.is_empty() {
        if let Some(src) = q.message.as_ref() {
            let msg_id = src.id();
            edit_message(bot, user_id, msg_id, &reply.text, &reply.keyboard).await;
            return;
        }
    }
    // Forward any attachments a handler emits (e.g. /screenshot)
    // so the "Again" button actually delivers the PNG, not just the
    // text caption.
    state
        .sender
        .enqueue_full(user_id, reply.text, reply.keyboard, reply.documents);
}

/// Publish the command list to Telegram's Bot API so the native client
/// offers autocomplete when the user types `/`. Best-effort — a failure
/// here doesn't break the transport, just skips the nice-to-have.
pub async fn publish_bot_commands(bot: &teloxide::Bot, state: &TelegramState) {
    use teloxide::prelude::*;
    use teloxide::types::BotCommand;
    let cmds: Vec<BotCommand> = {
        let reg = state.commands.read().unwrap_or_else(|e| e.into_inner());
        reg.enumerate()
            .into_iter()
            .filter(|h| !HIDDEN_COMMANDS.contains(&h.name()))
            .map(|h| BotCommand::new(h.name(), h.description()))
            .collect()
    };
    if let Err(e) = bot.set_my_commands(cmds).await {
        tracing::warn!(error = %e, "setMyCommands failed");
    } else {
        tracing::info!("published bot commands to Telegram");
    }
}

/// Edit an existing bot message in place — used by `refresh:*` callbacks so
/// a Dashboard card updates itself rather than stacking stale snapshots.
/// Renders Markdown as HTML like the sender does (plain-text retry when
/// Telegram rejects the markup). Best-effort: a message Telegram refuses
/// to edit (too old / from a different bot) falls through to a log line;
/// we'd rather leave the old card visible than spam a fresh one.
async fn edit_message(
    bot: &teloxide::Bot,
    chat_id: i64,
    message_id: teloxide::types::MessageId,
    text: &str,
    keyboard: &Option<super::commands_registry::InlineKeyboard>,
) {
    use super::format::{markdown_to_telegram_html, split_message, MESSAGE_LIMIT};
    use teloxide::prelude::*;
    use teloxide::types::{ChatId, ParseMode};
    use teloxide::{ApiError, RequestError};

    // An edit is a single message: keep the first chunk only.
    let chunk = split_message(text, MESSAGE_LIMIT - 16)
        .into_iter()
        .next()
        .unwrap_or_else(|| "👇".to_string());
    let markup = keyboard.as_ref().map(super::sender::to_markup);

    let mut req = bot
        .edit_message_text(ChatId(chat_id), message_id, markdown_to_telegram_html(&chunk))
        .parse_mode(ParseMode::Html);
    if let Some(m) = markup.clone() {
        req = req.reply_markup(m);
    }
    match req.await {
        Ok(_) | Err(RequestError::Api(ApiError::MessageNotModified)) => {}
        Err(e) => {
            tracing::debug!(error = %e, "editMessageText (HTML) failed, retrying plain");
            let mut plain = bot.edit_message_text(ChatId(chat_id), message_id, chunk);
            if let Some(m) = markup {
                plain = plain.reply_markup(m);
            }
            if let Err(e) = plain.await {
                tracing::debug!(error = %e, "editMessageText failed");
            }
        }
    }
}

/// Keeps Telegram's "typing…" indicator alive (it expires after ~5s)
/// until dropped — i.e. until the reply has been queued.
struct TypingGuard(tokio::task::JoinHandle<()>);

impl TypingGuard {
    fn start(bot: &teloxide::Bot, chat_id: i64) -> Self {
        let bot = bot.clone();
        Self(tokio::spawn(async move {
            for _ in 0..TYPING_MAX_TICKS {
                send_typing(&bot, chat_id).await;
                tokio::time::sleep(TYPING_REFRESH).await;
            }
        }))
    }
}

impl Drop for TypingGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Fire Telegram's "typing…" indicator for the current chat. Best-effort
/// — a network hiccup here must never block the actual reply. Telegram
/// auto-dismisses the indicator after 5s or when any message arrives.
async fn send_typing(bot: &teloxide::Bot, chat_id: i64) {
    use teloxide::prelude::*;
    use teloxide::types::{ChatAction, ChatId};
    if let Err(e) = bot
        .send_chat_action(ChatId(chat_id), ChatAction::Typing)
        .await
    {
        tracing::debug!(error = %e, "sendChatAction(typing) failed");
    }
}

/// Build the suggestion-aware reply for a slash-command the registry
/// didn't recognise. Returns plain text + optional button row, so the
/// user can tap the most likely intended command instead of re-typing.
fn build_unknown_command_reply(
    state: &Arc<TelegramState>,
    typed: &str,
) -> (String, Option<super::commands_registry::InlineKeyboard>) {
    use super::commands_registry::{suggest_commands, InlineButton, InlineKeyboard};
    let names: Vec<&'static str> = {
        let reg = match state.commands.read() {
            Ok(r) => r,
            Err(_) => return (format!("❓ Невідома команда: /{typed}"), None),
        };
        reg.enumerate().into_iter().map(|h| h.name()).collect()
    };
    let suggestions = suggest_commands(typed, &names, 3);
    if suggestions.is_empty() {
        return (
            format!("❓ Невідома команда: /{typed}\n_Натисни `/` — побачиш повний список._"),
            None,
        );
    }
    let list = suggestions
        .iter()
        .map(|s| format!("/{s}"))
        .collect::<Vec<_>>()
        .join(", ");
    let text = format!("❓ /{typed} не знайшов. Може: {list}?");
    let row: Vec<InlineButton> = suggestions
        .iter()
        .map(|s| InlineButton::new(format!("/{s}"), s.clone()))
        .collect();
    (text, Some(InlineKeyboard { rows: vec![row] }))
}

/// Compose the post-pairing welcome: a snapshot line for "look, Stash is
/// alive and here's what I already know" + a nudge toward /help. The
/// quick-actions keyboard is attached separately at the call site.
pub(crate) fn build_welcome_message(app: &AppHandle) -> String {
    use super::module_cmds::{read_battery, BatterySnapshot};
    let battery = match read_battery() {
        BatterySnapshot::Present { percent, charging } => {
            let icon = if charging { "🔌" } else { "🔋" };
            format!("{icon} {percent}%")
        }
        BatterySnapshot::NoBattery => "🔌 AC".to_string(),
        BatterySnapshot::Unknown => "🔋 —".to_string(),
    };
    let clips = app
        .try_state::<Arc<crate::modules::clipboard::commands::ClipboardState>>()
        .and_then(|s| s.repo.lock().ok().and_then(|r| r.list(1).ok()))
        .map(|v| {
            if v.is_empty() {
                "📋 порожньо".to_string()
            } else {
                "📋 ready".to_string()
            }
        })
        .unwrap_or_else(|| "📋 —".to_string());
    let pomodoro = app
        .try_state::<Arc<crate::modules::pomodoro::state::PomodoroState>>()
        .and_then(|s| s.core.lock().ok().map(|c| c.snapshot()))
        .map(|snap| match snap.status {
            crate::modules::pomodoro::engine::SessionStatus::Idle => "🍅 idle".to_string(),
            crate::modules::pomodoro::engine::SessionStatus::Running => {
                let mins = (snap.remaining_ms / 60_000).max(0);
                format!("🍅 {mins}m left")
            }
            crate::modules::pomodoro::engine::SessionStatus::Paused => "🍅 paused".to_string(),
        })
        .unwrap_or_else(|| "🍅 —".to_string());
    format!(
        "✅ *Stash online*\n{battery} · {clips} · {pomodoro}\n\nНатисни `/` щоб побачити всі команди, або скористайся кнопками нижче."
    )
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
    fn non_pair_text_while_pairing_is_dropped() {
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
    fn paired_slash_routes_to_registry() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/help", 42, 0),
            DispatchAction::RunCommand {
                chat_id: 42,
                name: "help".into(),
                args: "".into(),
            }
        );
    }

    #[test]
    fn paired_slash_with_args_preserves_payload() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/note hello world", 42, 0),
            DispatchAction::RunCommand {
                chat_id: 42,
                name: "note".into(),
                args: "hello world".into(),
            }
        );
    }

    #[test]
    fn paired_command_name_is_lowercased() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/Help", 42, 0),
            DispatchAction::RunCommand {
                chat_id: 42,
                name: "help".into(),
                args: "".into(),
            }
        );
    }

    #[test]
    fn paired_plain_text_goes_to_inbox() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "hello bot", 42, 0),
            DispatchAction::IngestText {
                chat_id: 42,
                text: "hello bot".into(),
            }
        );
    }

    #[test]
    fn paired_allowlist_drops_foreign_chat() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/help", 999, 0),
            DispatchAction::Drop
        );
        assert_eq!(
            dispatch_text(&mut p, &s, "hello", 999, 0),
            DispatchAction::Drop
        );
    }

    #[test]
    fn paired_pair_gets_already_paired_reply() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair 123456", 42, 0),
            DispatchAction::ReplyAlreadyPaired { chat_id: 42 }
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

    #[test]
    fn start_before_pairing_gets_hint() {
        let s = store();
        let mut p = active_pairing();
        assert_eq!(
            dispatch_text(&mut p, &s, "/start", 5, 0),
            DispatchAction::ReplyStartUnpaired { chat_id: 5 }
        );
        assert_eq!(
            dispatch_text(&mut p, &s, "/START@StashBot", 5, 0),
            DispatchAction::ReplyStartUnpaired { chat_id: 5 }
        );
        let mut u = PairingState::Unconfigured;
        assert_eq!(
            dispatch_text(&mut u, &s, "/start deeplink", 5, 0),
            DispatchAction::ReplyStartUnpaired { chat_id: 5 }
        );
        // Anything else is still dropped, and pairing state is untouched.
        assert_eq!(dispatch_text(&mut p, &s, "/help", 5, 0), DispatchAction::Drop);
        assert_eq!(dispatch_text(&mut p, &s, "start", 5, 0), DispatchAction::Drop);
        assert_eq!(p, active_pairing());
    }

    #[test]
    fn start_from_foreign_chat_after_pairing_is_dropped() {
        let mut p = PairingState::Paired { chat_id: 42 };
        assert_eq!(
            dispatch_text(&mut p, &store(), "/start", 7, 0),
            DispatchAction::Drop
        );
    }

    #[test]
    fn bot_mention_suffix_is_stripped_from_commands() {
        let mut p = PairingState::Paired { chat_id: 42 };
        assert_eq!(
            dispatch_text(&mut p, &store(), "/Battery@StashBot now", 42, 0),
            DispatchAction::RunCommand {
                chat_id: 42,
                name: "battery".into(),
                args: "now".into(),
            }
        );
    }

    #[test]
    fn poll_backoff_doubles_and_caps() {
        let mut d = POLL_BACKOFF_START;
        let mut seen = vec![d.as_secs()];
        for _ in 0..8 {
            d = next_backoff(d);
            seen.push(d.as_secs());
        }
        assert_eq!(seen, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }

    #[test]
    fn poll_errors_are_classified() {
        use teloxide::{ApiError, RequestError};
        assert_eq!(
            classify_poll_error(&RequestError::Api(ApiError::InvalidToken)),
            PollError::InvalidToken
        );
        assert_eq!(
            classify_poll_error(&RequestError::Api(ApiError::TerminatedByOtherGetUpdates)),
            PollError::Conflict
        );
        assert_eq!(
            classify_poll_error(&RequestError::RetryAfter(
                teloxide::types::Seconds::from_seconds(3)
            )),
            PollError::RetryAfter(Duration::from_secs(3))
        );
        assert_eq!(
            classify_poll_error(&RequestError::Api(ApiError::Unknown("Bad Gateway".into()))),
            PollError::Transient
        );
    }

    #[test]
    fn hidden_commands_cover_callback_only_and_start() {
        for name in ["pair", "start", "voice", "confirm", "retry", "ask"] {
            assert!(HIDDEN_COMMANDS.contains(&name));
        }
        assert!(!HIDDEN_COMMANDS.contains(&"help"));
    }

    #[test]
    fn contains_url_matches_http_https_and_www() {
        assert!(contains_url("grab https://example.com/song.mp3 please"));
        assert!(contains_url("http://stash.dev"));
        assert!(contains_url("see www.tauri.app today"));
    }

    #[test]
    fn contains_url_ignores_bare_words_and_stubs() {
        assert!(!contains_url("привіт"));
        assert!(!contains_url("a note about http:// and https://"));
        assert!(!contains_url("mention www. alone"));
    }
}
