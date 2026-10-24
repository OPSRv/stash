//! Agent surface for the Downloads tab: `/dl` slash command, LLM tools and
//! the Telegram completion card. Everything the Telegram bot / assistant can
//! do with downloads lives here, next to the module it drives, instead of in
//! the shared `telegram/module_cmds.rs`.
//!
//! Layout: typed core fns (`start_download`, `list_downloads`, …) hold the
//! logic; `DlCmd` parses slash args → core → `Reply`; the `*Tool` structs
//! map JSON → core → JSON. `lib.rs` / `assistant.rs` call
//! `register_commands` / `register_tools`.

use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use lru::LruCache;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::jobs::DownloadJob;
use super::runner::{self, RunnerState};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::pairing::PairingState;
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Telegram Bot API cap for bot uploads.
pub const TELEGRAM_UPLOAD_LIMIT: u64 = 50 * 1024 * 1024;
/// Telegram's hard cap on `callback_data`.
#[cfg(test)]
const CALLBACK_DATA_MAX: usize = 64;
/// Quality tiers the Downloads tab offers (see `detector::pick_quality_options`).
pub const HEIGHT_TIERS: [u32; 6] = [2160, 1440, 1080, 720, 480, 360];

// ───────────────────────── core types ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Video,
    Audio,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartReq {
    pub url: String,
    pub kind: MediaKind,
    /// Max video height; `None` = best available. Ignored for audio.
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Cancel,
    Pause,
    Resume,
    Retry,
    Delete,
}

impl Control {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cancel" => Control::Cancel,
            "pause" => Control::Pause,
            "resume" => Control::Resume,
            "retry" => Control::Retry,
            "delete" => Control::Delete,
            _ => return None,
        })
    }
}

// ───────────────────────── core fns ─────────────────────────

fn runner_state(app: &AppHandle) -> Result<Arc<RunnerState>, String> {
    app.try_state::<Arc<RunnerState>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "downloader is not initialised".to_string())
}

fn notify_ui(app: &AppHandle, id: i64) {
    let _ = app.emit("downloader:job_updated", id);
}

/// Start a download with the tab's runner settings (folder, parallelism,
/// rate limit, cookies). Returns immediately; the title is filled in the
/// background from oEmbed when available. The job is flagged as
/// agent-originated so completion pushes a rich Telegram card.
pub async fn start_download(app: &AppHandle, req: StartReq) -> Result<DownloadJob, String> {
    let state = runner_state(app)?;
    super::commands::ensure_http_scheme(&req.url)?;
    let height = match req.kind {
        MediaKind::Audio => None,
        MediaKind::Video => req.height,
    };
    let (app2, state2, url2) = (app.clone(), Arc::clone(&state), req.url.clone());
    // `start_job` may install yt-dlp on first use — keep it off the async worker.
    let id = tauri::async_runtime::spawn_blocking(move || {
        super::commands::start_job(
            app2,
            &state2,
            &url2,
            None,
            None,
            None,
            height,
            req.kind.as_str(),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    agent_jobs().lock().unwrap().insert(id);
    notify_ui(app, id);

    let (app3, state3, url3) = (app.clone(), Arc::clone(&state), req.url);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = super::detector::fetch_oembed(&url3) {
            if let Ok(mut repo) = state3.jobs.lock() {
                let _ = repo.set_title_if_missing(id, &p.title);
            }
            notify_ui(&app3, id);
        }
    });

    get_download(app, id)
}

pub fn get_download(app: &AppHandle, id: i64) -> Result<DownloadJob, String> {
    let state = runner_state(app)?;
    let job = state
        .jobs
        .lock()
        .unwrap()
        .get(id)
        .map_err(|e| e.to_string())?;
    job.ok_or_else(|| format!("download #{id} not found"))
}

/// Newest-first job list, optionally filtered by status.
pub fn list_downloads(
    app: &AppHandle,
    limit: usize,
    status: Option<&str>,
) -> Result<Vec<DownloadJob>, String> {
    let state = runner_state(app)?;
    let jobs = state
        .jobs
        .lock()
        .unwrap()
        .list(500)
        .map_err(|e| e.to_string())?;
    Ok(jobs
        .into_iter()
        .filter(|j| status.map_or(true, |s| j.status == s))
        .take(limit.max(1))
        .collect())
}

/// Cancel / pause / resume / retry / delete a job. Returns the updated job
/// (`None` after delete).
pub fn control_download(
    app: &AppHandle,
    id: i64,
    action: Control,
) -> Result<Option<DownloadJob>, String> {
    let state = runner_state(app)?;
    get_download(app, id)?;
    match action {
        Control::Cancel => runner::cancel_download(&state, id)?,
        Control::Pause => runner::pause_download(&state, id)?,
        Control::Resume => runner::resume_download(&state, id)?,
        Control::Retry => {
            let yt_dlp = super::commands::resolve_yt_dlp(&state)?;
            runner::retry_download(app.clone(), Arc::clone(&state), &yt_dlp, id)?;
            agent_jobs().lock().unwrap().insert(id);
        }
        Control::Delete => {
            if let Some(mut child) = state.active.lock().unwrap().remove(&id) {
                let _ = child.kill();
            }
            state
                .jobs
                .lock()
                .unwrap()
                .delete(id)
                .map_err(|e| e.to_string())?;
            notify_ui(app, id);
            return Ok(None);
        }
    }
    notify_ui(app, id);
    get_download(app, id).map(Some)
}

pub fn job_to_json(job: &DownloadJob) -> Value {
    let size = job
        .target_path
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    json!({
        "id": job.id,
        "url": job.url,
        "platform": job.platform,
        "title": job.title,
        "status": job.status,
        "kind": job.kind,
        "height": job.target_height,
        "progress": job.progress,
        "bytes_done": job.bytes_done,
        "bytes_total": job.bytes_total,
        "path": job.target_path,
        "file_size": size,
        "error": job.error.as_deref().map(error_summary),
        "created_at": job.created_at,
        "completed_at": job.completed_at,
    })
}

// ───────────────────────── completion push ─────────────────────────

/// Job ids started from the agent surface (Telegram / assistant). Only these
/// get the rich completion card; UI-started downloads keep the plain notice.
fn agent_jobs() -> &'static Mutex<HashSet<i64>> {
    static SET: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Called by the runner when a job reaches a terminal state (completed or
/// finally failed). Pushes the job card with follow-up buttons to the
/// paired chat. Returns `true` when this job was agent-originated (so the
/// caller can skip its generic notification).
pub fn notify_finished(app: &AppHandle, id: i64) -> bool {
    if !agent_jobs().lock().unwrap().remove(&id) {
        return false;
    }
    let Some(tg) = app.try_state::<Arc<TelegramState>>() else {
        return true;
    };
    let chat_id = match &*tg.pairing.lock().unwrap() {
        PairingState::Paired { chat_id } => *chat_id,
        _ => return true,
    };
    if let Ok(job) = get_download(app, id) {
        let reply = job_card(&job);
        tg.sender
            .enqueue_with_keyboard(chat_id, reply.text, reply.keyboard);
    }
    true
}

// ───────────────────────── formatting ─────────────────────────

fn error_summary(s: &str) -> String {
    let line = s
        .lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .or_else(|| s.lines().last())
        .unwrap_or(s);
    line.chars().take(200).collect()
}

fn human_bytes(n: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let n = n as f64;
    if n >= 1024.0 * MB {
        format!("{:.1} GB", n / (1024.0 * MB))
    } else if n >= MB {
        format!("{:.1} MB", n / MB)
    } else {
        format!("{:.0} KB", n / 1024.0)
    }
}

fn display_name(job: &DownloadJob) -> String {
    if let Some(t) = job.title.as_deref().filter(|t| !t.trim().is_empty()) {
        return t.to_string();
    }
    if let Some(stem) = job
        .target_path
        .as_deref()
        .and_then(|p| Path::new(p).file_stem())
    {
        return stem.to_string_lossy().to_string();
    }
    job.url.clone()
}

fn status_line(job: &DownloadJob) -> String {
    match job.status.as_str() {
        "pending" => "⏳ У черзі".into(),
        "active" => {
            let pct = (job.progress * 100.0).clamp(0.0, 100.0);
            match (job.bytes_done, job.bytes_total) {
                (Some(d), Some(t)) if t > 0 => format!(
                    "⬇️ {pct:.0}% · {} / {}",
                    human_bytes(d as u64),
                    human_bytes(t as u64)
                ),
                _ => format!("⬇️ {pct:.0}%"),
            }
        }
        "paused" => format!("⏸ Пауза · {:.0}%", job.progress * 100.0),
        "completed" => "✅ Завантажено".into(),
        "failed" => format!(
            "⚠️ Помилка: {}",
            job.error.as_deref().map(error_summary).unwrap_or_default()
        ),
        "cancelled" => "✖ Скасовано".into(),
        other => other.to_string(),
    }
}

fn kind_label(job: &DownloadJob) -> String {
    if job.kind == "audio" {
        "🎵 Аудіо".into()
    } else {
        match job.target_height {
            Some(h) => format!("🎬 Відео · {h}p"),
            None => "🎬 Відео · best".into(),
        }
    }
}

fn file_size(job: &DownloadJob) -> Option<u64> {
    job.target_path
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
}

/// Buttons for one job, by status. All callbacks are `dl:<action> <id>`.
pub fn job_keyboard(job: &DownloadJob) -> InlineKeyboard {
    let id = job.id;
    let rows = match job.status.as_str() {
        "completed" => {
            let mut second = vec![InlineButton::new(
                "📂 Показати у Finder",
                format!("dl:reveal {id}"),
            )];
            if file_size(job).is_some_and(|s| s < TELEGRAM_UPLOAD_LIMIT) {
                second.push(InlineButton::new("📤 Надіслати сюди", format!("dl:send {id}")));
            }
            vec![
                vec![
                    InlineButton::new("🎛 Stems", format!("dl:stems {id}")),
                    InlineButton::new("🥁 BPM", format!("dl:bpm {id}")),
                ],
                second,
            ]
        }
        "failed" | "cancelled" => vec![vec![InlineButton::new(
            "🔁 Повторити",
            format!("refresh:dl:retry {id}"),
        )]],
        "paused" => vec![vec![
            InlineButton::new("🔄", format!("refresh:dl:status {id}")),
            InlineButton::new("▶️ Продовжити", format!("refresh:dl:resume {id}")),
            InlineButton::new("✖ Скасувати", format!("refresh:dl:cancel {id}")),
        ]],
        _ => vec![vec![
            InlineButton::new("🔄", format!("refresh:dl:status {id}")),
            InlineButton::new("⏸", format!("refresh:dl:pause {id}")),
            InlineButton::new("✖ Скасувати", format!("refresh:dl:cancel {id}")),
        ]],
    };
    InlineKeyboard { rows }
}

pub fn job_card(job: &DownloadJob) -> Reply {
    let mut text = format!(
        "⬇️ {}\n{}\n{}",
        display_name(job),
        kind_label(job),
        status_line(job)
    );
    if job.status == "completed" {
        if let Some(size) = file_size(job) {
            text.push_str(&format!(" · {}", human_bytes(size)));
            if size >= TELEGRAM_UPLOAD_LIMIT {
                text.push_str(" (завелике для Telegram)");
            }
        }
    }
    text.push_str(&format!("\n#{}", job.id));
    Reply {
        text,
        keyboard: Some(job_keyboard(job)),
        ..Default::default()
    }
}

fn list_reply(jobs: &[DownloadJob]) -> Reply {
    if jobs.is_empty() {
        return Reply::text("📭 Завантажень немає.\nНадішли /dl <url>");
    }
    let mut text = String::from("⬇️ Завантаження:\n");
    let mut rows = Vec::new();
    for job in jobs {
        let name: String = display_name(job).chars().take(48).collect();
        text.push_str(&format!("\n#{} {} — {}", job.id, name, status_line(job)));
        let mut row = vec![InlineButton::new(format!("#{}", job.id), format!("dl:status {}", job.id))];
        match job.status.as_str() {
            "completed" => {
                row.push(InlineButton::new("🎛", format!("dl:stems {}", job.id)));
                row.push(InlineButton::new("📂", format!("dl:reveal {}", job.id)));
                if file_size(job).is_some_and(|s| s < TELEGRAM_UPLOAD_LIMIT) {
                    row.push(InlineButton::new("📤", format!("dl:send {}", job.id)));
                }
            }
            "failed" | "cancelled" => {
                row.push(InlineButton::new("🔁", format!("dl:retry {}", job.id)))
            }
            _ => row.push(InlineButton::new("✖", format!("dl:cancel {}", job.id))),
        }
        rows.push(row);
    }
    rows.push(vec![InlineButton::new("🔄 Оновити", "refresh:dl")]);
    Reply {
        text,
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

// ───────────────────────── URL stash (bare links) ─────────────────────────

/// Small LRU of `short id → payload` for inline buttons whose payload can't
/// fit Telegram's 64-byte `callback_data` (long URLs).
pub struct ShortIdStore {
    next: AtomicU32,
    map: Mutex<LruCache<u32, String>>,
}

impl ShortIdStore {
    pub fn new(cap: usize) -> Self {
        Self {
            next: AtomicU32::new(1),
            map: Mutex::new(LruCache::new(
                NonZeroUsize::new(cap.max(1)).expect("cap is non-zero"),
            )),
        }
    }

    pub fn put(&self, value: impl Into<String>) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.map.lock().unwrap().put(id, value.into());
        id
    }

    pub fn get(&self, id: u32) -> Option<String> {
        self.map.lock().unwrap().get(&id).cloned()
    }
}

fn url_store() -> &'static ShortIdStore {
    static STORE: OnceLock<ShortIdStore> = OnceLock::new();
    STORE.get_or_init(|| ShortIdStore::new(64))
}

/// Keyboard to attach under a bare URL the user sent to the bot:
/// ⬇️ video / 🎵 audio-only. The URL is parked in an LRU so the callback
/// stays within 64 bytes regardless of URL length.
// Attached by the Telegram transport under bare-URL messages.
#[allow(dead_code)]
pub fn url_actions_keyboard(url: &str) -> InlineKeyboard {
    let key = url_store().put(url.trim());
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("⬇️ Завантажити відео", format!("dl:u {key} video")),
            InlineButton::new("🎵 Тільки аудіо", format!("dl:u {key} audio")),
        ]],
    }
}

// ───────────────────────── slash parsing ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DlArgs {
    List,
    Start(StartReq),
    /// Start from a stashed URL (`url_actions_keyboard` buttons).
    Stashed { key: u32, kind: MediaKind },
    Status(i64),
    Control(i64, Control),
    Reveal(i64),
    Send(i64),
    Stems(i64),
    Bpm(i64),
}

fn parse_height(tok: &str) -> Option<Option<u32>> {
    let t = tok.to_ascii_lowercase();
    match t.as_str() {
        "best" | "max" => return Some(None),
        "4k" | "uhd" => return Some(Some(2160)),
        "2k" => return Some(Some(1440)),
        "fullhd" | "fhd" => return Some(Some(1080)),
        "hd" => return Some(Some(720)),
        _ => {}
    }
    let digits = t.strip_suffix('p').unwrap_or(&t);
    digits
        .parse::<u32>()
        .ok()
        .filter(|h| (144..=4320).contains(h))
        .map(Some)
}

fn parse_kind(tok: &str) -> Option<MediaKind> {
    match tok.to_ascii_lowercase().as_str() {
        "audio" | "mp3" | "m4a" | "music" | "a" | "аудіо" => Some(MediaKind::Audio),
        "video" | "mp4" | "v" | "відео" => Some(MediaKind::Video),
        _ => None,
    }
}

pub fn parse_dl_args(args: &str) -> Result<DlArgs, String> {
    let toks: Vec<&str> = args.split_whitespace().collect();
    let Some(&first) = toks.first() else {
        return Ok(DlArgs::List);
    };
    let id_arg = |i: usize| -> Result<i64, String> {
        toks.get(i)
            .map(|s| s.trim_start_matches('#'))
            .and_then(|s| s.parse::<i64>().ok())
            .ok_or_else(|| format!("потрібен id завантаження: /dl {first} <id>"))
    };
    let lower = first.to_ascii_lowercase();
    match lower.as_str() {
        "list" | "ls" => return Ok(DlArgs::List),
        "status" | "get" => return Ok(DlArgs::Status(id_arg(1)?)),
        "reveal" | "finder" => return Ok(DlArgs::Reveal(id_arg(1)?)),
        "send" => return Ok(DlArgs::Send(id_arg(1)?)),
        "stems" => return Ok(DlArgs::Stems(id_arg(1)?)),
        "bpm" => return Ok(DlArgs::Bpm(id_arg(1)?)),
        "u" => {
            let key = toks
                .get(1)
                .and_then(|s| s.parse::<u32>().ok())
                .ok_or("bad url key")?;
            let kind = toks
                .get(2)
                .and_then(|s| parse_kind(s))
                .unwrap_or(MediaKind::Video);
            return Ok(DlArgs::Stashed { key, kind });
        }
        _ => {}
    }
    if let Some(c) = Control::parse(&lower) {
        return Ok(DlArgs::Control(id_arg(1)?, c));
    }
    if let Some(id) = first.strip_prefix('#').and_then(|s| s.parse().ok()) {
        return Ok(DlArgs::Status(id));
    }
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("невідома дія або не URL: {first}"));
    }
    let mut req = StartReq {
        url: first.to_string(),
        kind: MediaKind::Video,
        height: None,
    };
    for tok in &toks[1..] {
        if let Some(k) = parse_kind(tok) {
            req.kind = k;
        } else if let Some(h) = parse_height(tok) {
            req.height = h;
        } else {
            return Err(format!("невідома опція: {tok}"));
        }
    }
    if req.kind == MediaKind::Audio {
        req.height = None;
    }
    Ok(DlArgs::Start(req))
}

// ───────────────────────── slash command ─────────────────────────

pub struct DlCmd;

const DL_USAGE: &str = "/dl [<url> [audio|video] [best|2160|1440|1080|720|480|360]] | /dl status|cancel|pause|resume|retry|delete|send|reveal|stems|bpm <id>";

#[async_trait]
impl CommandHandler for DlCmd {
    fn name(&self) -> &'static str {
        "dl"
    }
    fn description(&self) -> &'static str {
        "Завантажити відео/аудіо за посиланням (yt-dlp) або показати завантаження"
    }
    fn usage(&self) -> &'static str {
        DL_USAGE
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let parsed = match parse_dl_args(args) {
            Ok(p) => p,
            Err(e) => return Reply::text(format!("⚠️ {e}\n{DL_USAGE}")),
        };
        match run_dl(&ctx.app, parsed).await {
            Ok(r) => r,
            Err(e) => Reply::text(format!("⚠️ {e}")),
        }
    }
}

async fn run_dl(app: &AppHandle, args: DlArgs) -> Result<Reply, String> {
    match args {
        DlArgs::List => Ok(list_reply(&list_downloads(app, 8, None)?)),
        DlArgs::Start(req) => Ok(job_card(&start_download(app, req).await?)),
        DlArgs::Stashed { key, kind } => {
            let url = url_store()
                .get(key)
                .ok_or("посилання вже забуте — надішли його ще раз")?;
            let req = StartReq {
                url,
                kind,
                height: None,
            };
            Ok(job_card(&start_download(app, req).await?))
        }
        DlArgs::Status(id) => Ok(job_card(&get_download(app, id)?)),
        DlArgs::Control(id, action) => match control_download(app, id, action)? {
            Some(job) => Ok(job_card(&job)),
            None => Ok(Reply::text(format!("🗑 Завантаження #{id} видалено"))),
        },
        DlArgs::Reveal(id) => {
            let path = completed_path(app, id)?;
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("open: {e}"))?;
            Ok(Reply::text(format!("📂 Показано у Finder: {}", path.display())))
        }
        DlArgs::Send(id) => {
            let path = completed_path(app, id)?;
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if size >= TELEGRAM_UPLOAD_LIMIT {
                return Err(format!(
                    "файл {} — більше ліміту Telegram 50 MB",
                    human_bytes(size)
                ));
            }
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            Ok(Reply {
                text: format!("📤 {name}"),
                documents: vec![path],
                ..Default::default()
            })
        }
        DlArgs::Stems(id) => spawn_separator(app, id, "analyze"),
        DlArgs::Bpm(id) => spawn_separator(app, id, "bpm"),
    }
}

fn completed_path(app: &AppHandle, id: i64) -> Result<PathBuf, String> {
    let job = get_download(app, id)?;
    let path = job
        .target_path
        .filter(|_| job.status == "completed")
        .map(PathBuf::from)
        .ok_or_else(|| format!("#{id} ще не завантажено"))?;
    if !path.is_file() {
        return Err(format!("файл зник з диска: {}", path.display()));
    }
    Ok(path)
}

/// Queue a Demucs/BeatNet job on a downloaded file and push the result to
/// the paired chat when it settles. Returns an immediate ack so the
/// callback doesn't spin for minutes.
fn spawn_separator(app: &AppHandle, id: i64, mode: &str) -> Result<Reply, String> {
    use crate::modules::separator;
    let path = completed_path(app, id)?;
    let sep = app
        .try_state::<Arc<separator::SeparatorState>>()
        .map(|s| s.inner().clone())
        .ok_or("модуль Stems не ініціалізовано")?;
    let job_id = separator::enqueue_job(
        app,
        &sep,
        separator::SeparatorRunArgs {
            input_path: path.display().to_string(),
            mode: Some(mode.into()),
            ..Default::default()
        },
    )?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let reply = await_separator(&sep, &job_id).await;
        if let Some(tg) = app2.try_state::<Arc<TelegramState>>() {
            if let PairingState::Paired { chat_id } = &*tg.pairing.lock().unwrap() {
                tg.sender
                    .enqueue_full(*chat_id, reply.text, reply.keyboard, reply.documents);
            }
        }
    });
    Ok(Reply::text(if mode == "bpm" {
        "🥁 Визначаю BPM… результат прийде окремим повідомленням"
    } else {
        "🎛 Розділяю на стеми… результат прийде окремим повідомленням"
    }))
}

async fn await_separator(
    sep: &Arc<crate::modules::separator::SeparatorState>,
    job_id: &str,
) -> Reply {
    use crate::modules::separator::JobStatus;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30 * 60);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if std::time::Instant::now() > deadline {
            return Reply::text("⚠️ Stems: таймаут (30 хв)");
        }
        let job = sep
            .jobs
            .lock()
            .unwrap()
            .iter()
            .find(|j| j.id == job_id)
            .cloned();
        let Some(job) = job else {
            return Reply::text("⚠️ Stems: задачу втрачено");
        };
        match job.status {
            JobStatus::Completed => {
                let bpm = job.result.as_ref().and_then(|r| r.bpm);
                let stems = job.result.and_then(|r| r.stems);
                let mut text = String::new();
                if let Some(bpm) = bpm {
                    text.push_str(&format!("🥁 BPM: {bpm:.1}\n"));
                }
                let mut documents = Vec::new();
                if let Some(stems) = stems {
                    text.push_str(&format!("🎛 Стеми готові ({})", stems.len()));
                    let mut entries: Vec<_> = stems.into_iter().collect();
                    entries.sort();
                    let mut big = 0;
                    for (_, p) in entries {
                        let p = PathBuf::from(p);
                        match std::fs::metadata(&p) {
                            Ok(m) if m.len() < TELEGRAM_UPLOAD_LIMIT => documents.push(p),
                            _ => big += 1,
                        }
                    }
                    if big > 0 {
                        text.push_str(&format!("\n{big} файл(и) завеликі для Telegram — див. вкладку Stems"));
                    }
                }
                if text.is_empty() {
                    text = "🎛 Готово".into();
                }
                return Reply {
                    text: text.trim_end().to_string(),
                    documents,
                    ..Default::default()
                };
            }
            JobStatus::Failed => {
                let err = job.error.unwrap_or_else(|| "unknown".into());
                return Reply::text(format!("⚠️ Stems: {}", err.lines().next().unwrap_or("")));
            }
            JobStatus::Cancelled => return Reply::text("✖ Stems: скасовано"),
            _ => continue,
        }
    }
}

// ───────────────────────── LLM tools ─────────────────────────

fn tool_app(ctx: &ToolCtx) -> Result<&AppHandle, String> {
    ctx.app
        .as_ref()
        .ok_or_else(|| "AppHandle not available in this context".to_string())
}

fn arg_id(args: &Value) -> Result<i64, String> {
    args.get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing integer `id`".to_string())
}

/// Map the tool's JSON args to a `StartReq`. Pure — unit-tested.
pub fn start_req_from_json(args: &Value) -> Result<StartReq, String> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("missing `url`")?
        .to_string();
    let kind = match args.get("kind").and_then(|v| v.as_str()) {
        None => MediaKind::Video,
        Some(k) => parse_kind(k).ok_or_else(|| format!("unknown kind: {k}"))?,
    };
    let height = match args.get("height") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(
            n.as_u64()
                .map(|h| h as u32)
                .filter(|h| (144..=4320).contains(h))
                .ok_or("height must be 144..4320")?,
        ),
        Some(Value::String(s)) => parse_height(s).ok_or_else(|| format!("bad height: {s}"))?,
        Some(_) => return Err("bad height".into()),
    };
    Ok(StartReq {
        url,
        height: if kind == MediaKind::Audio { None } else { height },
        kind,
    })
}

pub struct DownloadMedia;

#[async_trait]
impl Tool for DownloadMedia {
    fn name(&self) -> &'static str {
        "download_media"
    }
    fn description(&self) -> &'static str {
        "Download a video or audio track from a URL (YouTube, Vimeo, TikTok, Instagram, \
         SoundCloud, X and anything else yt-dlp supports) into the Stash Downloads folder, \
         using the Downloads tab settings (folder, speed cap, cookies). Returns the job \
         immediately (status pending/active); poll `get_download(id)` for progress and the \
         final file path. The user gets a Telegram card when it finishes."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "http(s) URL of the media page." },
                "kind": {
                    "type": "string",
                    "enum": ["video", "audio"],
                    "description": "`audio` extracts audio only (m4a). Default `video` (mp4)."
                },
                "height": {
                    "type": "integer",
                    "enum": HEIGHT_TIERS,
                    "description": "Max video height in pixels. Omit for best available. Ignored for audio."
                }
            },
            "required": ["url"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = tool_app(ctx)?;
        let req = start_req_from_json(&args)?;
        let job = start_download(app, req).await?;
        Ok(job_to_json(&job))
    }
}

pub struct ListDownloads;

#[async_trait]
impl Tool for ListDownloads {
    fn name(&self) -> &'static str {
        "list_downloads"
    }
    fn description(&self) -> &'static str {
        "List recent downloads from the Downloads tab, newest first, with status, progress \
         and file path."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Default 20." },
                "status": {
                    "type": "string",
                    "enum": ["pending", "active", "paused", "completed", "failed", "cancelled"],
                    "description": "Only return jobs in this state."
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = tool_app(ctx)?;
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
        let status = args.get("status").and_then(|v| v.as_str());
        let jobs = list_downloads(app, limit.min(100), status)?;
        Ok(json!({ "downloads": jobs.iter().map(job_to_json).collect::<Vec<_>>() }))
    }
}

pub struct GetDownload;

#[async_trait]
impl Tool for GetDownload {
    fn name(&self) -> &'static str {
        "get_download"
    }
    fn description(&self) -> &'static str {
        "Get one download job by id: status, progress, bytes, file path and error. Use the \
         `path` of a completed job with separate_stems / detect_bpm / convert_media."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer" } },
            "required": ["id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = tool_app(ctx)?;
        Ok(job_to_json(&get_download(app, arg_id(&args)?)?))
    }
}

pub struct CancelDownload;

#[async_trait]
impl Tool for CancelDownload {
    fn name(&self) -> &'static str {
        "cancel_download"
    }
    fn description(&self) -> &'static str {
        "Cancel a pending or active download by id."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer" } },
            "required": ["id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = tool_app(ctx)?;
        let job = control_download(app, arg_id(&args)?, Control::Cancel)?;
        Ok(job.map(|j| job_to_json(&j)).unwrap_or(Value::Null))
    }
}

pub struct ControlDownload;

#[async_trait]
impl Tool for ControlDownload {
    fn name(&self) -> &'static str {
        "control_download"
    }
    fn description(&self) -> &'static str {
        "Pause, resume, retry (failed/cancelled) or delete a download job by id. Delete \
         removes the history row only, the file stays on disk unless `purge_file` is true."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "action": { "type": "string", "enum": ["pause", "resume", "retry", "delete", "cancel"] },
                "purge_file": { "type": "boolean", "description": "With action=delete: also delete the file." }
            },
            "required": ["id", "action"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = tool_app(ctx)?;
        let id = arg_id(&args)?;
        let action_s = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let action = Control::parse(action_s).ok_or_else(|| format!("unknown action: {action_s}"))?;
        if action == Control::Delete
            && args.get("purge_file").and_then(|v| v.as_bool()) == Some(true)
        {
            if let Some(p) = get_download(app, id)?.target_path {
                let p = Path::new(&p);
                if p.is_file() {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        let job = control_download(app, id, action)?;
        Ok(json!({ "ok": true, "job": job.map(|j| job_to_json(&j)) }))
    }
}

// ───────────────────────── wiring ─────────────────────────

pub fn register_commands(tg: &TelegramState) {
    tg.register_command(DlCmd);
}

pub fn register_tools(tools: &mut ToolRegistry) {
    tools.register(DownloadMedia);
    tools.register(ListDownloads);
    tools.register(GetDownload);
    tools.register(CancelDownload);
    tools.register(ControlDownload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: i64, status: &str, path: Option<&str>) -> DownloadJob {
        DownloadJob {
            id,
            url: "https://youtu.be/abc".into(),
            platform: "youtube".into(),
            title: Some("Song".into()),
            thumbnail_url: None,
            format_id: None,
            target_path: path.map(String::from),
            status: status.into(),
            progress: 0.5,
            bytes_total: None,
            bytes_done: None,
            error: None,
            created_at: 0,
            completed_at: None,
            transcription: None,
            kind: "video".into(),
            target_height: Some(1080),
        }
    }

    fn all_callbacks(kb: &InlineKeyboard) -> Vec<String> {
        kb.rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.clone())
            .collect()
    }

    #[test]
    fn empty_args_list() {
        assert_eq!(parse_dl_args("  "), Ok(DlArgs::List));
        assert_eq!(parse_dl_args("list"), Ok(DlArgs::List));
    }

    #[test]
    fn parses_url_with_options() {
        assert_eq!(
            parse_dl_args("https://youtu.be/x 720p"),
            Ok(DlArgs::Start(StartReq {
                url: "https://youtu.be/x".into(),
                kind: MediaKind::Video,
                height: Some(720),
            }))
        );
        assert_eq!(
            parse_dl_args("https://youtu.be/x audio 1080"),
            Ok(DlArgs::Start(StartReq {
                url: "https://youtu.be/x".into(),
                kind: MediaKind::Audio,
                height: None,
            }))
        );
        assert_eq!(
            parse_dl_args("https://x.com/a 4k"),
            Ok(DlArgs::Start(StartReq {
                url: "https://x.com/a".into(),
                kind: MediaKind::Video,
                height: Some(2160),
            }))
        );
        assert!(parse_dl_args("https://youtu.be/x banana").is_err());
        assert!(parse_dl_args("youtube.com/x").is_err());
    }

    #[test]
    fn parses_actions() {
        assert_eq!(parse_dl_args("status 12"), Ok(DlArgs::Status(12)));
        assert_eq!(parse_dl_args("#7"), Ok(DlArgs::Status(7)));
        assert_eq!(
            parse_dl_args("cancel #3"),
            Ok(DlArgs::Control(3, Control::Cancel))
        );
        assert_eq!(parse_dl_args("retry 4"), Ok(DlArgs::Control(4, Control::Retry)));
        assert_eq!(parse_dl_args("stems 9"), Ok(DlArgs::Stems(9)));
        assert_eq!(parse_dl_args("send 9"), Ok(DlArgs::Send(9)));
        assert_eq!(
            parse_dl_args("u 5 audio"),
            Ok(DlArgs::Stashed {
                key: 5,
                kind: MediaKind::Audio
            })
        );
        assert!(parse_dl_args("cancel").is_err());
    }

    #[test]
    fn tool_json_maps_to_request() {
        let r = start_req_from_json(&json!({"url": "https://a.b/c", "height": 480})).unwrap();
        assert_eq!(r.height, Some(480));
        assert_eq!(r.kind, MediaKind::Video);
        let r = start_req_from_json(&json!({"url": "https://a.b/c", "kind": "audio", "height": 480}))
            .unwrap();
        assert_eq!((r.kind, r.height), (MediaKind::Audio, None));
        assert!(start_req_from_json(&json!({})).is_err());
        assert!(start_req_from_json(&json!({"url": "https://a", "kind": "gif"})).is_err());
    }

    #[test]
    fn callback_data_fits_telegram_limit() {
        let huge = i64::MAX;
        for status in ["pending", "active", "paused", "completed", "failed", "cancelled"] {
            let j = job(huge, status, None);
            for cb in all_callbacks(&job_keyboard(&j)) {
                assert!(cb.len() <= CALLBACK_DATA_MAX, "{cb}");
            }
            for cb in all_callbacks(list_reply(&[j]).keyboard.as_ref().unwrap()) {
                assert!(cb.len() <= CALLBACK_DATA_MAX, "{cb}");
            }
        }
        let long_url = format!("https://www.youtube.com/watch?v={}", "x".repeat(300));
        for cb in all_callbacks(&url_actions_keyboard(&long_url)) {
            assert!(cb.len() <= CALLBACK_DATA_MAX, "{cb}");
            // Round-trip through the parser.
            assert!(matches!(parse_dl_args(cb.strip_prefix("dl:").unwrap()), Ok(DlArgs::Stashed { .. })));
        }
    }

    #[test]
    fn short_id_store_round_trips_and_evicts() {
        let s = ShortIdStore::new(2);
        let a = s.put("a");
        let b = s.put("b");
        assert_ne!(a, b);
        assert_eq!(s.get(a).as_deref(), Some("a"));
        let c = s.put("c"); // evicts `b` (a was touched more recently)
        assert_eq!(s.get(b), None);
        assert_eq!(s.get(a).as_deref(), Some("a"));
        assert_eq!(s.get(c).as_deref(), Some("c"));
    }

    #[test]
    fn keyboard_by_status() {
        let active = all_callbacks(&job_keyboard(&job(3, "active", None)));
        assert!(active.contains(&"refresh:dl:status 3".to_string()));
        assert!(active.contains(&"refresh:dl:cancel 3".to_string()));
        let failed = all_callbacks(&job_keyboard(&job(3, "failed", None)));
        assert_eq!(failed, vec!["refresh:dl:retry 3".to_string()]);
        // Completed but file missing on disk → no send button.
        let done = all_callbacks(&job_keyboard(&job(3, "completed", Some("/nonexistent/x.m4a"))));
        assert!(done.contains(&"dl:stems 3".to_string()));
        assert!(done.contains(&"dl:bpm 3".to_string()));
        assert!(done.contains(&"dl:reveal 3".to_string()));
        assert!(!done.contains(&"dl:send 3".to_string()));
    }

    #[test]
    fn height_tokens() {
        assert_eq!(parse_height("best"), Some(None));
        assert_eq!(parse_height("1080p"), Some(Some(1080)));
        assert_eq!(parse_height("FHD"), Some(Some(1080)));
        assert_eq!(parse_height("12"), None);
    }
}
