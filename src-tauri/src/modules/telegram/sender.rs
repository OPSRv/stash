//! Outbound message queue. A single tokio task drains an mpsc channel and
//! calls `bot.send_message` serially — giving us one place to enforce rate
//! limits (Telegram's Bot API documents 30 msg/s globally, 1 msg/s per chat)
//! and to retry on transient errors with exponential backoff.
//!
//! `enqueue` is synchronous and non-blocking: callers (inbound dispatcher,
//! reminder ticker, notifier) fire-and-forget. The queue is unbounded because
//! single-user traffic is tiny and dropping messages silently is worse than
//! holding a handful of strings.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use teloxide::prelude::*;
use teloxide::requests::Request;
use teloxide::types::{
    ChatId, InlineKeyboardButton, InlineKeyboardMarkup, InputFile, MessageId, ParseMode,
};
use teloxide::{ApiError, RequestError};
use tokio::sync::{mpsc, oneshot};

use super::format::{
    balance_fences, markdown_to_telegram_html, split_message, CAPTION_LIMIT, MESSAGE_LIMIT,
};

/// Chunk size for long replies — a little under Telegram's 4096 cap so the
/// fence-balancing markers added by `balance_fences` always fit.
const CHUNK_LIMIT: usize = MESSAGE_LIMIT - 16;
/// Replies needing more messages than this are sent as a `.md` file.
const MAX_TEXT_CHUNKS: usize = 4;
/// Carrier text for a keyboard-only reply (Telegram rejects empty text).
const EMPTY_PLACEHOLDER: &str = "👇";
const LONG_REPLY_CAPTION: &str = "📄 Відповідь задовга для повідомлення — надсилаю файлом.";

/// Minimum gap between `send_message` calls. 1 msg/s per chat is the Telegram
/// ceiling; with a single-user bot we only ever target one chat at a time.
const MIN_SEND_GAP: Duration = Duration::from_millis(1_100);

/// Initial backoff; doubled each attempt up to `MAX_RETRIES`.
const BACKOFF_START: Duration = Duration::from_millis(200);
const MAX_RETRIES: u32 = 6;
/// Cap on a single flood-control wait: Telegram can ask for minutes, but
/// one message must not stall the whole outbound queue that long.
const MAX_RETRY_AFTER_WAIT: Duration = Duration::from_secs(30);
/// Total sleep budget across all retries of one Bot API call.
const MAX_RETRY_BUDGET: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct Outbound {
    pub chat_id: i64,
    pub text: String,
    /// Optional inline keyboard sent alongside the message.
    pub keyboard: Option<super::commands_registry::InlineKeyboard>,
    /// File attachments. When non-empty, the first file carries `text` as
    /// its caption (or, past 1024 chars, `text` follows as its own message)
    /// and the rest are sent without captions. `.jpg/.jpeg/.webp` go via
    /// `send_photo` with a `send_document` fallback; everything else
    /// (including lossless `.png`) via `send_document`. Empty = plain text-only message.
    pub documents: Vec<PathBuf>,
}

pub struct TelegramSender {
    slot: Mutex<Option<SenderInner>>,
    /// Per-chat count of jobs queued so far. Lets a caller holding a
    /// tracked message (progress placeholder) tell whether anything else
    /// was queued after it — e.g. a tool that sent a file mid-turn.
    seq: Mutex<HashMap<i64, u64>>,
}

/// A message sent through [`TelegramSender::send_tracked`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackedMessage {
    pub id: MessageId,
    /// The chat's queue sequence right after this message was queued.
    pub seq: u64,
}

/// One item of the outbound queue.
enum Job {
    /// Fire-and-forget message (see `Outbound`).
    Send(Outbound),
    /// Single short text message whose id the caller needs (e.g. a
    /// progress placeholder that is later edited in place). Rides the same
    /// queue so it keeps its place relative to earlier enqueued messages.
    Tracked {
        chat_id: i64,
        text: String,
        reply: oneshot::Sender<Option<MessageId>>,
    },
}

struct SenderInner {
    tx: mpsc::UnboundedSender<Job>,
    shutdown: oneshot::Sender<()>,
}

impl TelegramSender {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            seq: Mutex::new(HashMap::new()),
        }
    }

    /// Number of jobs queued for `chat_id` so far (see [`TrackedMessage`]).
    pub fn chat_seq(&self, chat_id: i64) -> u64 {
        self.seq
            .lock()
            .map(|m| m.get(&chat_id).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    /// `true` when something was queued for the chat after `tracked`.
    pub fn sent_after(&self, chat_id: i64, tracked: &TrackedMessage) -> bool {
        self.chat_seq(chat_id) != tracked.seq
    }

    /// Start the drain task. Safe to call while already running — subsequent
    /// calls are a no-op until `stop` is called.
    pub fn start(&self, token: String) -> Result<(), String> {
        let mut slot = self.slot.lock().unwrap();
        if slot.is_some() {
            return Ok(());
        }
        let (tx, rx) = mpsc::unbounded_channel::<Job>();
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

    /// Full form: text + optional keyboard + optional file attachments.
    /// `text` is Markdown; the drain converts it to Telegram HTML (falling
    /// back to plain text) and splits it as needed. See `Outbound`.
    pub fn enqueue_full(
        &self,
        chat_id: i64,
        text: impl Into<String>,
        keyboard: Option<super::commands_registry::InlineKeyboard>,
        documents: Vec<PathBuf>,
    ) {
        let text = text.into();
        self.push(Job::Send(Outbound {
            chat_id,
            text,
            keyboard,
            documents,
        }));
    }

    /// Queue a single short plain-text message and wait until it is actually
    /// sent, returning its id and queue position (`None` when the sender is
    /// stopped or the send failed). Paced and ordered like every other
    /// queued message.
    pub async fn send_tracked(
        &self,
        chat_id: i64,
        text: impl Into<String>,
    ) -> Option<TrackedMessage> {
        let (reply, rx) = oneshot::channel();
        let seq = self.push_seq(Job::Tracked {
            chat_id,
            text: text.into(),
            reply,
        })?;
        let id = rx.await.ok().flatten()?;
        Some(TrackedMessage { id, seq })
    }

    fn push(&self, job: Job) -> bool {
        self.push_seq(job).is_some()
    }

    /// Queue `job`; returns the chat's sequence number after it. The seq
    /// bump happens under the slot lock so it matches queue order.
    fn push_seq(&self, job: Job) -> Option<u64> {
        let chat_id = match &job {
            Job::Send(o) => o.chat_id,
            Job::Tracked { chat_id, .. } => *chat_id,
        };
        let slot = self.slot.lock().unwrap();
        match slot.as_ref() {
            Some(inner) => match inner.tx.send(job) {
                Ok(()) => {
                    let mut seq = self.seq.lock().unwrap_or_else(|e| e.into_inner());
                    let n = seq.entry(chat_id).or_insert(0);
                    *n += 1;
                    Some(*n)
                }
                Err(_) => {
                    tracing::warn!("telegram sender: enqueue failed (drain task gone)");
                    None
                }
            },
            None => {
                tracing::debug!("telegram sender: enqueue dropped (sender not running)");
                None
            }
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
    mut rx: mpsc::UnboundedReceiver<Job>,
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
                let Some(job) = next else { break };

                // Rate limit: sleep until MIN_SEND_GAP has elapsed since the
                // last successful send, so a burst of enqueues still paces out.
                let elapsed = last_send.elapsed();
                if elapsed < MIN_SEND_GAP {
                    tokio::time::sleep(MIN_SEND_GAP - elapsed).await;
                }

                match job {
                    Job::Send(msg) => deliver(&bot, &msg).await,
                    Job::Tracked { chat_id, text, reply } => {
                        let id = send_single(&bot, ChatId(chat_id), &text).await;
                        let _ = reply.send(id);
                    }
                }
                last_send = tokio::time::Instant::now();
            }
        }
    }
}

/// How a failed Bot API request should be handled.
#[derive(Debug, PartialEq, Eq)]
enum Failure {
    /// Transient (network / 5xx / garbled response) — back off and retry.
    Retry,
    /// Flood control — wait exactly what Telegram asked for.
    RetryAfter(Duration),
    /// 4xx and friends — retrying won't help.
    Permanent,
}

fn classify(e: &RequestError) -> Failure {
    match e {
        RequestError::RetryAfter(s) => Failure::RetryAfter(s.duration()),
        RequestError::Network(_) | RequestError::InvalidJson { .. } => Failure::Retry,
        RequestError::Api(ApiError::Unknown(m)) if is_server_error(m) => Failure::Retry,
        _ => Failure::Permanent,
    }
}

/// Telegram reports 5xx through the generic `description` field, which
/// teloxide surfaces as `ApiError::Unknown`.
fn is_server_error(description: &str) -> bool {
    let l = description.to_ascii_lowercase();
    [
        "internal server error",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "timed out",
    ]
    .iter()
    .any(|needle| l.contains(needle))
}

/// Run one Bot API call, retrying transient failures with exponential
/// backoff and honouring `RetryAfter`. Permanent errors return at once so
/// a bad request never blocks the queue for half a minute.
async fn retrying<T, F, Fut>(what: &'static str, mut op: F) -> Result<T, RequestError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, RequestError>>,
{
    let mut backoff = BACKOFF_START;
    let mut attempt = 0u32;
    let mut spent = Duration::ZERO;
    loop {
        let e = match op().await {
            Ok(v) => return Ok(v),
            Err(e) => e,
        };
        let failure = classify(&e);
        if failure == Failure::Permanent {
            return Err(e);
        }
        let Some(wait) = next_wait(&failure, attempt, &mut backoff, spent) else {
            tracing::warn!(error = %e, what, attempts = attempt + 1, "telegram sender: giving up (retry limit / budget)");
            return Err(e);
        };
        attempt += 1;
        spent += wait;
        tracing::debug!(error = %e, what, attempt, wait_ms = wait.as_millis() as u64, "telegram send failed, retrying");
        tokio::time::sleep(wait).await;
    }
}

/// Wait before the next retry of a transient failure, or `None` to give
/// up: attempt limit hit, or the wait would push the total sleep for
/// this call past `MAX_RETRY_BUDGET`. Flood-control waits are capped at
/// `MAX_RETRY_AFTER_WAIT`.
fn next_wait(
    failure: &Failure,
    attempt: u32,
    backoff: &mut Duration,
    spent: Duration,
) -> Option<Duration> {
    if attempt >= MAX_RETRIES {
        return None;
    }
    let wait = match failure {
        Failure::Permanent => return None,
        Failure::RetryAfter(d) => (*d).min(MAX_RETRY_AFTER_WAIT),
        Failure::Retry => {
            let d = *backoff;
            *backoff = backoff.saturating_mul(2).min(Duration::from_secs(30));
            d
        }
    };
    (spent.saturating_add(wait) <= MAX_RETRY_BUDGET).then_some(wait)
}

/// Only a permanent rejection (bad entities, too-long caption, …) is
/// worth resending in a different shape. After flood-control or network
/// exhaustion the same request would just repeat the whole retry cycle.
fn worth_fallback(e: &RequestError) -> bool {
    classify(e) == Failure::Permanent
}

/// What to do with an outbound text body.
#[derive(Debug, PartialEq, Eq)]
enum TextPlan {
    /// Nothing worth sending.
    Skip,
    /// Send these Markdown chunks as consecutive messages.
    Chunks(Vec<String>),
    /// Too long for a handful of messages — ship it as a `.md` file.
    File,
}

fn plan_text(text: &str, has_keyboard: bool) -> TextPlan {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        // Telegram rejects empty text; a keyboard still needs a carrier.
        return if has_keyboard {
            TextPlan::Chunks(vec![EMPTY_PLACEHOLDER.to_string()])
        } else {
            TextPlan::Skip
        };
    }
    let chunks = balance_fences(split_message(trimmed, CHUNK_LIMIT));
    if chunks.len() > MAX_TEXT_CHUNKS {
        TextPlan::File
    } else {
        TextPlan::Chunks(chunks)
    }
}

pub(super) fn to_markup(k: &super::commands_registry::InlineKeyboard) -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::new(k.rows.iter().map(|r| {
        r.iter()
            .map(|b| InlineKeyboardButton::callback(b.text.clone(), b.callback_data.clone()))
            .collect::<Vec<_>>()
    }))
}

/// PNGs are deliberately excluded: they're screenshots / annotations where
/// the photo path's re-encode + ≤1280px downscale would defeat the point.
fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "webp"))
        .unwrap_or(false)
}

async fn deliver(bot: &Bot, msg: &Outbound) {
    let chat = ChatId(msg.chat_id);
    let markup = msg.keyboard.as_ref().map(to_markup);
    if msg.documents.is_empty() {
        send_text(bot, chat, &msg.text, markup).await;
        return;
    }
    // Captions are capped at 1024 chars; longer text goes out as its own
    // message (carrying the keyboard) after the files.
    let text = msg.text.trim();
    let caption_fits = text.chars().count() <= CAPTION_LIMIT;
    for (i, path) in msg.documents.iter().enumerate() {
        let first = i == 0;
        let caption = (first && caption_fits && !text.is_empty()).then_some(text);
        let kb = if first && caption_fits { markup.clone() } else { None };
        if let Err(e) = send_file(bot, chat, path, caption, kb).await {
            tracing::warn!(error = %e, path = %path.display(), "telegram sender: attachment not delivered");
        }
    }
    if !caption_fits {
        send_text(bot, chat, text, markup).await;
    }
}

/// Send Markdown `text` as HTML, split into ≤4096-char messages; the
/// keyboard rides on the last one. A chunk Telegram refuses permanently
/// (bad entity parse, etc.) is resent once as plain text.
async fn send_text(bot: &Bot, chat: ChatId, text: &str, markup: Option<InlineKeyboardMarkup>) {
    let chunks = match plan_text(text, markup.is_some()) {
        TextPlan::Skip => {
            tracing::debug!("telegram sender: skipping empty message");
            return;
        }
        TextPlan::Chunks(c) => c,
        TextPlan::File => {
            if send_text_as_file(bot, chat, text, markup.clone()).await {
                return;
            }
            // File upload failed — still deliver the text, chunked.
            balance_fences(split_message(text.trim(), CHUNK_LIMIT))
        }
    };
    let last = chunks.len().saturating_sub(1);
    for (i, chunk) in chunks.iter().enumerate() {
        let kb = if i == last { markup.clone() } else { None };
        let html = markdown_to_telegram_html(chunk);
        let res = retrying("sendMessage", || {
            let mut r = bot.send_message(chat, html.clone()).parse_mode(ParseMode::Html);
            if let Some(k) = kb.clone() {
                r = r.reply_markup(k);
            }
            r.send()
        })
        .await;
        match res {
            Ok(_) => {}
            // Flood control / network exhausted: a plain resend would
            // just repeat the whole retry cycle.
            Err(e) if !worth_fallback(&e) => {
                tracing::warn!(error = %e, "telegram sender: giving up on message chunk");
            }
            Err(e) => {
                tracing::warn!(error = %e, "telegram sender: HTML send rejected, retrying as plain text");
                let plain = retrying("sendMessage(plain)", || {
                    let mut r = bot.send_message(chat, chunk.clone());
                    if let Some(k) = kb.clone() {
                        r = r.reply_markup(k);
                    }
                    r.send()
                })
                .await;
                if let Err(e) = plain {
                    tracing::warn!(error = %e, "telegram sender: giving up on message chunk");
                }
            }
        }
        if i != last {
            tokio::time::sleep(MIN_SEND_GAP).await;
        }
    }
}

/// Send one short plain-text message and return its id. Text past one
/// message is cut to the first chunk.
async fn send_single(bot: &Bot, chat: ChatId, text: &str) -> Option<MessageId> {
    let chunk = split_message(text.trim(), CHUNK_LIMIT)
        .into_iter()
        .next()
        .unwrap_or_else(|| EMPTY_PLACEHOLDER.to_string());
    match retrying("sendMessage(tracked)", || {
        bot.send_message(chat, chunk.clone()).send()
    })
    .await
    {
        Ok(m) => Some(m.id),
        Err(e) => {
            tracing::warn!(error = %e, "telegram sender: tracked message not delivered");
            None
        }
    }
}

/// Split a reply into the Markdown chunks the queue would send, or `None`
/// when it is blank or long enough to ship as a `.md` file. Lets callers
/// that edit a message in place decide whether the reply fits that shape.
pub(crate) fn reply_chunks(text: &str) -> Option<Vec<String>> {
    match plan_text(text, false) {
        TextPlan::Chunks(c) => Some(c),
        TextPlan::Skip | TextPlan::File => None,
    }
}

/// Upload a very long reply as `reply-<ts>.md`. Returns `false` when the
/// upload failed so the caller can fall back to chunked messages.
async fn send_text_as_file(
    bot: &Bot,
    chat: ChatId,
    text: &str,
    markup: Option<InlineKeyboardMarkup>,
) -> bool {
    let dir = std::env::temp_dir().join("stash-telegram");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("reply-{ts}.md"));
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, text)) {
        tracing::warn!(error = %e, "telegram sender: could not stage long reply file");
        return false;
    }
    let res = retrying("sendDocument(md)", || {
        let mut r = bot
            .send_document(chat, InputFile::file(path.clone()))
            .caption(LONG_REPLY_CAPTION);
        if let Some(k) = markup.clone() {
            r = r.reply_markup(k);
        }
        r.send()
    })
    .await;
    let _ = std::fs::remove_file(&path);
    match res {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(error = %e, "telegram sender: long reply upload failed");
            false
        }
    }
}

/// Images go as photos (inline preview); anything else — or a photo
/// Telegram refuses (too large / odd dimensions) — goes as a document.
async fn send_file(
    bot: &Bot,
    chat: ChatId,
    path: &Path,
    caption: Option<&str>,
    kb: Option<InlineKeyboardMarkup>,
) -> Result<(), RequestError> {
    let caption_html = caption.map(markdown_to_telegram_html);
    if is_image_path(path) {
        let res = retrying("sendPhoto", || {
            let mut r = bot.send_photo(chat, InputFile::file(path.to_path_buf()));
            if let Some(c) = caption_html.clone() {
                r = r.caption(c).parse_mode(ParseMode::Html);
            }
            if let Some(k) = kb.clone() {
                r = r.reply_markup(k);
            }
            r.send()
        })
        .await;
        match res {
            Ok(_) => return Ok(()),
            Err(e) if !worth_fallback(&e) => return Err(e),
            Err(e) => tracing::info!(error = %e, "sendPhoto failed, falling back to sendDocument"),
        }
    }
    let send_doc = |caption: Option<String>, html: bool| {
        let kb = kb.clone();
        retrying("sendDocument", move || {
            let mut r = bot.send_document(chat, InputFile::file(path.to_path_buf()));
            if let Some(c) = caption.clone() {
                r = r.caption(c);
                if html {
                    r = r.parse_mode(ParseMode::Html);
                }
            }
            if let Some(k) = kb.clone() {
                r = r.reply_markup(k);
            }
            r.send()
        })
    };
    match send_doc(caption_html.clone(), true).await {
        Ok(_) => Ok(()),
        // Caption markup rejected — resend with the raw caption.
        Err(e) if caption.is_some() && worth_fallback(&e) => {
            tracing::warn!(error = %e, "sendDocument with HTML caption failed, retrying plain");
            send_doc(caption.map(str::to_string), false).await.map(|_| ())
        }
        Err(e) => Err(e),
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

    #[test]
    fn classify_retries_only_transient_errors() {
        assert_eq!(
            classify(&RequestError::RetryAfter(teloxide::types::Seconds::from_seconds(7))),
            Failure::RetryAfter(Duration::from_secs(7))
        );
        assert_eq!(
            classify(&RequestError::Api(ApiError::Unknown("Internal Server Error".into()))),
            Failure::Retry
        );
        assert_eq!(
            classify(&RequestError::Api(ApiError::Unknown("Bad Gateway".into()))),
            Failure::Retry
        );
        assert_eq!(
            classify(&RequestError::Api(ApiError::CantParseEntities(
                "Bad Request: can't parse entities".into()
            ))),
            Failure::Permanent
        );
        assert_eq!(
            classify(&RequestError::Api(ApiError::MessageTextIsEmpty)),
            Failure::Permanent
        );
        assert_eq!(
            classify(&RequestError::Api(ApiError::ChatNotFound)),
            Failure::Permanent
        );
    }

    #[test]
    fn retry_after_is_capped_per_wait() {
        let mut b = BACKOFF_START;
        let w = next_wait(
            &Failure::RetryAfter(Duration::from_secs(600)),
            0,
            &mut b,
            Duration::ZERO,
        );
        assert_eq!(w, Some(MAX_RETRY_AFTER_WAIT));
        let w = next_wait(
            &Failure::RetryAfter(Duration::from_secs(3)),
            0,
            &mut b,
            Duration::ZERO,
        );
        assert_eq!(w, Some(Duration::from_secs(3)));
    }

    #[test]
    fn retries_stop_at_total_budget() {
        // Simulate repeated flood-control answers asking for 25 s.
        let mut b = BACKOFF_START;
        let mut spent = Duration::ZERO;
        let mut attempt = 0;
        while let Some(w) = next_wait(
            &Failure::RetryAfter(Duration::from_secs(25)),
            attempt,
            &mut b,
            spent,
        ) {
            spent += w;
            attempt += 1;
        }
        assert!(spent <= MAX_RETRY_BUDGET, "{spent:?}");
        assert_eq!(attempt, 2);
        // Attempt cap still applies to cheap backoffs.
        let mut b = BACKOFF_START;
        assert_eq!(
            next_wait(&Failure::Retry, MAX_RETRIES, &mut b, Duration::ZERO),
            None
        );
        assert_eq!(
            next_wait(&Failure::Permanent, 0, &mut b, Duration::ZERO),
            None
        );
    }

    #[test]
    fn plain_fallback_only_after_permanent_errors() {
        assert!(worth_fallback(&RequestError::Api(
            ApiError::CantParseEntities("bad".into())
        )));
        assert!(!worth_fallback(&RequestError::RetryAfter(
            teloxide::types::Seconds::from_seconds(7)
        )));
        assert!(!worth_fallback(&RequestError::Api(ApiError::Unknown(
            "Bad Gateway".into()
        ))));
    }

    #[test]
    fn plan_text_skips_blank_and_files_huge() {
        assert_eq!(plan_text("   \n", false), TextPlan::Skip);
        assert_eq!(
            plan_text("", true),
            TextPlan::Chunks(vec![EMPTY_PLACEHOLDER.to_string()])
        );
        assert_eq!(plan_text(" hi ", false), TextPlan::Chunks(vec!["hi".into()]));
        let para = format!("{}\n\n", "щось ".repeat(150));
        let medium = para.repeat(8); // ~6k chars → 2 chunks
        assert!(matches!(plan_text(&medium, false), TextPlan::Chunks(c) if c.len() == 2));
        let huge = para.repeat(40); // ~30k chars → > 4 chunks
        assert_eq!(plan_text(&huge, false), TextPlan::File);
    }

    #[test]
    fn reply_chunks_mirror_queue_plan() {
        assert_eq!(reply_chunks("  "), None);
        assert_eq!(reply_chunks(" hi "), Some(vec!["hi".to_string()]));
        let para = format!("{}\n\n", "щось ".repeat(150));
        assert_eq!(reply_chunks(&para.repeat(8)).map(|c| c.len()), Some(2));
        assert_eq!(reply_chunks(&para.repeat(40)), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_tracked_without_sender_returns_none() {
        let s = TelegramSender::new();
        assert_eq!(s.send_tracked(1, "⏳").await, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_seq_counts_queued_jobs_per_chat() {
        let s = TelegramSender::new();
        s.enqueue(1, "dropped: not running");
        assert_eq!(s.chat_seq(1), 0);
        s.start("0:fake".into()).unwrap();
        let marker = TrackedMessage {
            id: MessageId(5),
            seq: s.chat_seq(1),
        };
        assert!(!s.sent_after(1, &marker));
        s.enqueue(2, "other chat");
        assert!(!s.sent_after(1, &marker), "other chats don't count");
        s.enqueue(1, "tool output");
        assert!(s.sent_after(1, &marker));
        assert_eq!(s.chat_seq(1), 1);
        s.stop();
    }

    #[test]
    fn image_paths_detected_by_extension() {
        assert!(!is_image_path(Path::new("/tmp/a.PNG")));
        assert!(is_image_path(Path::new("/tmp/a.jpeg")));
        assert!(is_image_path(Path::new("x.webp")));
        assert!(!is_image_path(Path::new("x.pdf")));
        assert!(!is_image_path(Path::new("noext")));
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
