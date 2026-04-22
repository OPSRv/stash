//! Outbound message queue. A single tokio task drains an mpsc channel and
//! calls `bot.send_message` serially — giving us one place to enforce rate
//! limits (Telegram's Bot API documents 30 msg/s globally, 1 msg/s per chat)
//! and to retry on transient errors with exponential backoff.
//!
//! `enqueue` is synchronous and non-blocking: callers (inbound dispatcher,
//! reminder ticker, notifier) fire-and-forget. The queue is unbounded because
//! single-user traffic is tiny and dropping messages silently is worse than
//! holding a handful of strings.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

/// Minimum gap between `send_message` calls. 1 msg/s per chat is the Telegram
/// ceiling; with a single-user bot we only ever target one chat at a time.
const MIN_SEND_GAP: Duration = Duration::from_millis(1_100);

/// Initial backoff; doubled each attempt up to `MAX_RETRIES`.
const BACKOFF_START: Duration = Duration::from_millis(200);
const MAX_RETRIES: u32 = 6;

#[derive(Debug, Clone)]
pub struct Outbound {
    pub chat_id: i64,
    pub text: String,
    /// Optional inline keyboard sent alongside the message.
    pub keyboard: Option<super::commands_registry::InlineKeyboard>,
    /// Document attachments. When non-empty, the first document carries
    /// `text` as its caption and the remaining are sent as follow-ups
    /// without captions. Sent via `send_document` (not `send_photo`) so
    /// PNGs aren't re-encoded. Empty = plain text-only message.
    pub documents: Vec<PathBuf>,
}

pub struct TelegramSender {
    slot: Mutex<Option<SenderInner>>,
}

struct SenderInner {
    tx: mpsc::UnboundedSender<Outbound>,
    shutdown: oneshot::Sender<()>,
}

impl TelegramSender {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }

    /// Start the drain task. Safe to call while already running — subsequent
    /// calls are a no-op until `stop` is called.
    pub fn start(&self, token: String) -> Result<(), String> {
        let mut slot = self.slot.lock().unwrap();
        if slot.is_some() {
            return Ok(());
        }
        let (tx, rx) = mpsc::unbounded_channel::<Outbound>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            run_drain(token, rx, shutdown_rx).await;
        });
        *slot = Some(SenderInner {
            tx,
            shutdown: shutdown_tx,
        });
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(inner) = self.slot.lock().unwrap().take() {
            let _ = inner.shutdown.send(());
        }
    }

    /// Queue a plain text message. Silently dropped on failure — this only
    /// happens if the drain task is gone, in which case there's nothing
    /// useful we can do other than log it.
    pub fn enqueue(&self, chat_id: i64, text: impl Into<String>) {
        self.enqueue_with_keyboard(chat_id, text, None);
    }

    pub fn enqueue_with_keyboard(
        &self,
        chat_id: i64,
        text: impl Into<String>,
        keyboard: Option<super::commands_registry::InlineKeyboard>,
    ) {
        self.enqueue_full(chat_id, text, keyboard, Vec::new());
    }

    /// Full form: text + optional keyboard + optional document
    /// attachments. When `documents` is non-empty the send path switches
    /// from `send_message` to `send_document` (first doc captioned with
    /// `text`, rest sent plain) — keeps PNGs byte-identical on the
    /// recipient side, unlike `send_photo` which re-encodes.
    pub fn enqueue_full(
        &self,
        chat_id: i64,
        text: impl Into<String>,
        keyboard: Option<super::commands_registry::InlineKeyboard>,
        documents: Vec<PathBuf>,
    ) {
        let text = text.into();
        match self.slot.lock().unwrap().as_ref() {
            Some(inner) => {
                if let Err(e) = inner.tx.send(Outbound {
                    chat_id,
                    text,
                    keyboard,
                    documents,
                }) {
                    tracing::warn!(error = %e, "telegram sender: enqueue failed");
                }
            }
            None => tracing::debug!(
                "telegram sender: enqueue dropped (sender not running); chat_id={chat_id}"
            ),
        }
    }
}

impl Default for TelegramSender {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_drain(
    token: String,
    mut rx: mpsc::UnboundedReceiver<Outbound>,
    mut shutdown: oneshot::Receiver<()>,
) {
    use teloxide::prelude::*;

    let bot = Bot::new(token);
    tracing::info!("telegram sender started");
    let mut last_send = tokio::time::Instant::now()
        .checked_sub(MIN_SEND_GAP)
        .unwrap_or_else(tokio::time::Instant::now);

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                tracing::info!("telegram sender stopping");
                break;
            }
            next = rx.recv() => {
                let Some(msg) = next else { break };

                // Rate limit: sleep until MIN_SEND_GAP has elapsed since the
                // last successful send, so a burst of enqueues still paces out.
                let elapsed = last_send.elapsed();
                if elapsed < MIN_SEND_GAP {
                    tokio::time::sleep(MIN_SEND_GAP - elapsed).await;
                }

                send_with_retry(&bot, &msg).await;
                last_send = tokio::time::Instant::now();
            }
        }
    }
}

async fn send_with_retry(bot: &teloxide::Bot, msg: &Outbound) {
    use teloxide::prelude::*;
    use teloxide::types::{ChatId, InlineKeyboardButton, InlineKeyboardMarkup, InputFile};

    let keyboard = msg.keyboard.as_ref().map(|k| {
        let rows: Vec<Vec<InlineKeyboardButton>> = k
            .rows
            .iter()
            .map(|r| {
                r.iter()
                    .map(|b| {
                        InlineKeyboardButton::callback(b.text.clone(), b.callback_data.clone())
                    })
                    .collect()
            })
            .collect();
        InlineKeyboardMarkup::new(rows)
    });

    let chat = ChatId(msg.chat_id);
    let mut backoff = BACKOFF_START;
    for attempt in 0..=MAX_RETRIES {
        let result = if msg.documents.is_empty() {
            let mut req = bot.send_message(chat, &msg.text);
            if let Some(k) = keyboard.clone() {
                req = req.reply_markup(k);
            }
            req.await.map(|_| ())
        } else {
            // First document carries the caption + keyboard; trailing
            // documents go out plain. Unrolled instead of using `?` so
            // retry accounting stays uniform across both branches.
            let mut last = Ok(());
            for (i, path) in msg.documents.iter().enumerate() {
                let mut req = bot.send_document(chat, InputFile::file(path));
                if i == 0 {
                    req = req.caption(&msg.text);
                    if let Some(k) = keyboard.clone() {
                        req = req.reply_markup(k);
                    }
                }
                match req.await {
                    Ok(_) => {}
                    Err(e) => {
                        last = Err(e);
                        break;
                    }
                }
            }
            last.map(|_| ())
        };
        match result {
            Ok(_) => return,
            Err(e) => {
                if attempt == MAX_RETRIES {
                    tracing::warn!(
                        error = %e,
                        attempts = attempt + 1,
                        "telegram sender: giving up after max retries"
                    );
                    return;
                }
                tracing::debug!(
                    error = %e,
                    attempt,
                    backoff_ms = backoff.as_millis() as u64,
                    "telegram send failed, retrying"
                );
                tokio::time::sleep(backoff).await;
                backoff = backoff.saturating_mul(2).min(Duration::from_secs(30));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_before_start_is_silent() {
        let s = TelegramSender::new();
        // Should not panic or send anywhere.
        s.enqueue(1, "hello");
        s.enqueue(1, "world");
    }

    #[test]
    fn double_start_is_noop() {
        let s = TelegramSender::new();
        // Can't actually start without a tokio runtime, but with a fake
        // token both calls should succeed and the second be a no-op. We
        // exercise this under a tokio runtime in an async test below.
        assert!(s.slot.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_then_stop_is_clean() {
        let s = TelegramSender::new();
        // Use a clearly-invalid token — the drain task will spin up with a
        // Bot that will fail on any send attempt, but we never call enqueue
        // so no network traffic is attempted.
        s.start("0:fake".into()).unwrap();
        assert!(s.slot.lock().unwrap().is_some());
        // Second start = no-op.
        s.start("0:fake".into()).unwrap();
        s.stop();
        assert!(s.slot.lock().unwrap().is_none());
    }
}
