//! Slash-command handlers that bridge Telegram to other Stash modules.
//! Each handler captures an `Arc` of the module state it targets and is
//! registered into the `CommandRegistry` from `lib.rs` after all module
//! states exist.

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tauri::{Emitter, Manager};

use super::commands_registry::{CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply};
use super::reminders;
use super::repo::TelegramRepo;
use super::state::TelegramState;
use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::notes::repo::NotesRepo;
use crate::tray::TrayState;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// -------------------- /battery --------------------

pub struct BatteryCmd;

#[async_trait]
impl CommandHandler for BatteryCmd {
    fn name(&self) -> &'static str {
        "battery"
    }
    fn description(&self) -> &'static str {
        "Показати заряд батареї та стан живлення"
    }
    fn usage(&self) -> &'static str {
        "/battery"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        match read_battery() {
            BatterySnapshot::Present { percent, charging } => {
                let icon = if charging { "🔌" } else { "🔋" };
                let status = if charging { "заряджається" } else { "від батареї" };
                // Below 20% + not plugged in → offer a quick sleep action.
                let low = percent < 20 && !charging;
                Reply {
                    text: format!("{icon} {percent}% — {status}"),
                    keyboard: if low {
                        Some(InlineKeyboard {
                            rows: vec![vec![InlineButton::new("💤 Sleep Mac", "sleep")]],
                        })
                    } else {
                        None
                    },
                    ..Default::default()
                }
            }
            BatterySnapshot::NoBattery => {
                Reply::text("🔌 У цього Mac немає батареї (desktop / під'єднано до мережі).")
            }
            BatterySnapshot::Unknown => {
                Reply::text("🪫 Не вдалося отримати дані про батарею.")
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BatterySnapshot {
    Present { percent: u32, charging: bool },
    /// pmset succeeded but produced no battery line — desktop Mac / server.
    NoBattery,
    /// pmset absent, failed, or returned garbage.
    Unknown,
}

/// Parse `pmset -g batt` output — shape on laptops:
///   `  -InternalBattery-0 (id=...) 87%; charging; 2:31 remaining present: true`
/// On desktop Macs (Mac Mini / Studio / Pro) the output is only
/// `Now drawing from 'AC Power'` with no battery line — we report that
/// distinctly so the user gets a useful reply instead of "unavailable".
pub(crate) fn read_battery() -> BatterySnapshot {
    let Ok(out) = Command::new("pmset").args(["-g", "batt"]).output() else {
        return BatterySnapshot::Unknown;
    };
    if !out.status.success() {
        return BatterySnapshot::Unknown;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_pmset(&text)
}

fn parse_pmset(s: &str) -> BatterySnapshot {
    // Look for "NN%" on any line.
    let Some(pct_idx) = s.find('%') else {
        // No percent sign at all — desktop Mac has no battery line.
        return BatterySnapshot::NoBattery;
    };
    let prefix = &s[..pct_idx];
    let pct_start = prefix
        .rfind(|c: char| !c.is_ascii_digit())
        .map(|i| i + 1)
        .unwrap_or(0);
    let Ok(percent) = prefix[pct_start..].parse::<u32>() else {
        return BatterySnapshot::Unknown;
    };
    let rest = &s[pct_idx + 1..];
    let charging = rest
        .split(';')
        .nth(1)
        .map(|s| {
            let w = s.trim().to_lowercase();
            w == "charging" || w.starts_with("ac")
        })
        .unwrap_or(false);
    BatterySnapshot::Present { percent, charging }
}

// -------------------- /clip --------------------

pub struct ClipCmd {
    state: Arc<ClipboardState>,
}

impl ClipCmd {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ClipCmd {
    fn name(&self) -> &'static str {
        "clip"
    }
    fn description(&self) -> &'static str {
        "Показати запис буфера обміну №N (1 = найновіший)"
    }
    fn usage(&self) -> &'static str {
        "/clip [N]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let trimmed = args.trim();
        // Subcommand: `restore N` — push item N back onto the system
        // clipboard. Only text items for now (image restoration needs
        // the full paste pipeline).
        if let Some(rest) = trimmed.strip_prefix("restore") {
            let n: usize = rest.trim().parse().unwrap_or(1).max(1);
            return match clip_restore_text(&self.state, n) {
                Ok(preview) => Reply::text(format!("📋 Скопійовано №{n}: {preview}")),
                Err(e) => Reply::text(format!("⚠️ {e}")),
            };
        }
        let n: usize = trimmed.parse().unwrap_or(1).max(1);
        let items = match self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())
            .and_then(|repo| repo.list(n).map_err(|e| e.to_string()))
        {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ помилка буфера: {e}")),
        };
        let total = items.len();
        match items.get(n - 1) {
            Some(item) if item.kind == "text" => {
                let content = truncate_preview(&item.content, 3_500);
                let mut row: Vec<InlineButton> = vec![
                    InlineButton::new("📋 Re-copy", format!("clip:restore {n}")),
                ];
                if total > n {
                    row.push(InlineButton::new("⏭ Next", format!("clip:{}", n + 1)));
                }
                if n > 1 {
                    row.insert(0, InlineButton::new("⏮ Prev", format!("clip:{}", n - 1)));
                }
                Reply {
                    text: content,
                    keyboard: Some(InlineKeyboard { rows: vec![row] }),
                    ..Default::default()
                }
            }
            Some(item) => Reply::text(format!("📎 [{}] {}", item.kind, item.content)),
            None => Reply::text(format!("📭 Немає запису буфера на позиції {n}.")),
        }
    }
}

/// Re-push the Nth clipboard history item back onto the system
/// clipboard. Returns a short preview on success. Image items are
/// rejected — the full paste pipeline handles those, and wiring it
/// in from the bot isn't worth the extra surface.
fn clip_restore_text(state: &Arc<ClipboardState>, n: usize) -> Result<String, String> {
    let items = state
        .repo
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|repo| repo.list(n).map_err(|e| e.to_string()))?;
    let item = items
        .get(n - 1)
        .ok_or_else(|| format!("немає запису буфера на позиції {n}"))?;
    if item.kind != "text" {
        return Err(format!(
            "{} — небінарні записи бот поки не копіює; відкрий Stash",
            item.kind
        ));
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_text(item.content.clone())
        .map_err(|e| e.to_string())?;
    let preview: String = item.content.chars().take(60).collect();
    let suffix = if item.content.chars().count() > 60 { "…" } else { "" };
    Ok(format!("\"{preview}{suffix}\""))
}

fn truncate_preview(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

// -------------------- /note --------------------

pub struct NoteCmd {
    repo: Arc<Mutex<NotesRepo>>,
}

impl NoteCmd {
    pub fn new(repo: Arc<Mutex<NotesRepo>>) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl CommandHandler for NoteCmd {
    fn name(&self) -> &'static str {
        "note"
    }
    fn description(&self) -> &'static str {
        "Зберегти нотатку з тексту після команди"
    }
    fn usage(&self) -> &'static str {
        "/note <текст>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let body = args.trim();
        if body.is_empty() {
            return Reply::text("✍️ Використання: /note <текст>");
        }
        let title: String = body.lines().next().unwrap_or("").chars().take(80).collect();
        let title = if title.is_empty() {
            "Без заголовка".to_string()
        } else {
            title
        };
        let result = match self.repo.lock() {
            Ok(mut repo) => repo.create(&title, body, now_ms()),
            Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
        };
        match result {
            Ok(id) => {
                let _ = ctx.app.emit("notes:changed", id);
                Reply {
                    text: format!("📝 Збережено нотатку №{id}: {title}"),
                    keyboard: Some(InlineKeyboard {
                        rows: vec![vec![InlineButton::new("📝 Recent", "notes")]],
                    }),
                    ..Default::default()
                }
            }
            Err(e) => Reply::text(format!("⚠️ помилка нотаток: {e}")),
        }
    }
}

// -------------------- /notes --------------------

pub struct NotesListCmd {
    repo: Arc<Mutex<NotesRepo>>,
}

impl NotesListCmd {
    pub fn new(repo: Arc<Mutex<NotesRepo>>) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl CommandHandler for NotesListCmd {
    fn name(&self) -> &'static str {
        "notes"
    }
    fn description(&self) -> &'static str {
        "Останні нотатки (newest first)"
    }
    fn usage(&self) -> &'static str {
        "/notes"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let summaries = match self.repo.lock() {
            Ok(r) => match r.list_summaries() {
                Ok(v) => v,
                Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
            },
            Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
        };
        if summaries.is_empty() {
            return Reply::text("📭 Нотаток ще немає. Додай `/note <текст>`.");
        }
        let mut out = String::from("📝 Останні нотатки:\n");
        for s in summaries.iter().take(10) {
            let preview = s.preview.trim().replace('\n', " ");
            let preview_short: String = preview.chars().take(60).collect();
            out.push_str(&format!("• №{} — {}\n", s.id, if preview_short.is_empty() {
                s.title.clone()
            } else {
                format!("{} · {}", s.title, preview_short)
            }));
        }
        if summaries.len() > 10 {
            out.push_str(&format!("…ще {}\n", summaries.len() - 10));
        }
        Reply::text(out.trim_end().to_string())
    }
}

// -------------------- /remind --------------------

pub struct RemindCmd {
    state: Arc<TelegramState>,
}

impl RemindCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for RemindCmd {
    fn name(&self) -> &'static str {
        "remind"
    }
    fn description(&self) -> &'static str {
        "Запланувати нагадування. Формати: `10m текст`, `14:30 текст`, `tomorrow 9:00 текст`, `2026-04-25 14:30 текст`"
    }
    fn usage(&self) -> &'static str {
        "/remind <коли> <текст>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let now = now_secs();
        let Some((due, text)) = reminders::parse_when(args, now) else {
            return Reply::text(
                "✍️ Використання: /remind <коли> <текст>\n\
                 Приклади:\n\
                 • /remind 10m випити води\n\
                 • /remind 1h30m зателефонувати мамі\n\
                 • /remind 14:30 нарада команди\n\
                 • /remind tomorrow 9:00 спортзал\n\
                 • /remind 2026-04-25 14:30 лікар",
            );
        };
        let created = now * 1000;
        // Scope the mutex guard so it's dropped before we .await the
        // Reminders.app mirror below — MutexGuard isn't Send and would
        // otherwise block the handler future from being Send.
        let insert_result = {
            let mut repo = match self.state.repo.lock() {
                Ok(r) => r,
                Err(e) => return Reply::text(format!("⚠️ помилка нагадувань: {e}")),
            };
            repo.insert_reminder(&text, due, created)
        };
        match insert_result {
            Ok(id) => {
                let mins = ((due - now) as f64 / 60.0).round() as i64;
                let when = if mins < 60 {
                    format!("через ~{mins} хв")
                } else if mins < 24 * 60 {
                    format!("через ~{} год {} хв", mins / 60, mins % 60)
                } else {
                    format!("через ~{} дн", mins / (24 * 60))
                };
                // Mirror into macOS Reminders.app so the alert also
                // rings on iPhone/iPad via iCloud. Best-effort: if the
                // user hasn't granted Automation access, we keep the
                // Stash-side reminder working and just annotate the
                // reply rather than failing outright. The mirror tag
                // in brackets survives into the returned text so the
                // user learns whether the handshake went through.
                let title = text.clone();
                let mirror = tokio::task::spawn_blocking(move || {
                    crate::modules::system::reminders_bridge::create_reminder(&title, due)
                })
                .await;
                let tag = match mirror {
                    Ok(Ok(())) => "📱 дзеркалю в Reminders",
                    Ok(Err(e)) => {
                        tracing::warn!(error = %e, "reminders mirror failed");
                        "⚠️ Reminders.app не дозволено — перевір Automation"
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "reminders mirror task join failed");
                        "⚠️ Reminders.app: внутрішня помилка"
                    }
                };
                Reply {
                    text: format!("⏰ №{id} заплановано {when}: {text}\n{tag}"),
                    keyboard: Some(InlineKeyboard {
                        rows: vec![vec![InlineButton::new(
                            "✖ Cancel",
                            format!("forget:{id}"),
                        )]],
                    }),
                    ..Default::default()
                }
            }
            Err(e) => Reply::text(format!("⚠️ помилка БД: {e}")),
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// -------------------- /reminders --------------------

pub struct RemindersCmd {
    state: Arc<TelegramState>,
}

impl RemindersCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for RemindersCmd {
    fn name(&self) -> &'static str {
        "reminders"
    }
    fn description(&self) -> &'static str {
        "Список активних нагадувань"
    }
    fn usage(&self) -> &'static str {
        "/reminders"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let repo = match self.state.repo.lock() {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ помилка нагадувань: {e}")),
        };
        let items = match repo.list_active_reminders() {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ помилка БД: {e}")),
        };
        if items.is_empty() {
            return Reply::text("📭 Немає активних нагадувань.");
        }
        let now = now_secs();
        let mut out = String::from("⏰ Активні:\n");
        for r in items.iter().take(20) {
            let delta = r.due_at - now;
            let when = if delta < 0 {
                "(прострочено)".to_string()
            } else if delta < 60 {
                "< 1 хв".to_string()
            } else if delta < 3600 {
                format!("{} хв", delta / 60)
            } else if delta < 86_400 {
                format!("{} год", delta / 3600)
            } else {
                format!("{} дн", delta / 86_400)
            };
            out.push_str(&format!("• №{} ({when}) — {}\n", r.id, r.text));
        }
        if items.len() > 20 {
            out.push_str(&format!("…ще {}\n", items.len() - 20));
        }
        Reply::text(out.trim_end().to_string())
    }
}

// -------------------- /forget --------------------

pub struct ForgetCmd {
    state: Arc<TelegramState>,
}

impl ForgetCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ForgetCmd {
    fn name(&self) -> &'static str {
        "forget"
    }
    fn description(&self) -> &'static str {
        "Скасувати активне нагадування за id"
    }
    fn usage(&self) -> &'static str {
        "/forget <id>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let Ok(id): Result<i64, _> = args.trim().parse() else {
            return Reply::text("✍️ Використання: /forget <id> (дивись /reminders)");
        };
        let mut repo = match self.state.repo.lock() {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ помилка нагадувань: {e}")),
        };
        match repo.cancel_reminder(id) {
            Ok(true) => Reply::text(format!("🗑️ Скасовано нагадування №{id}.")),
            Ok(false) => Reply::text(format!("❓ Немає активного нагадування №{id}.")),
            Err(e) => Reply::text(format!("⚠️ помилка БД: {e}")),
        }
    }
}

// unused import silencer while the helper is only used in reminders.rs
#[allow(dead_code)]
fn _keep_import(_: &TelegramRepo) {}

// -------------------- /volume --------------------

pub struct VolumeCmd;

#[async_trait]
impl CommandHandler for VolumeCmd {
    fn name(&self) -> &'static str {
        "volume"
    }
    fn description(&self) -> &'static str {
        "Показати або змінити гучність macOS (0–100)"
    }
    fn usage(&self) -> &'static str {
        "/volume [N | up | down | mute | unmute]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let raw = args.trim().to_lowercase();
        let action = match raw.as_str() {
            "" | "status" => VolumeAction::Status,
            "up" | "+" => VolumeAction::Step(10),
            "down" | "-" => VolumeAction::Step(-10),
            "mute" => VolumeAction::Mute(true),
            "unmute" => VolumeAction::Mute(false),
            other => match other.parse::<i32>() {
                Ok(n) => VolumeAction::Set(n.clamp(0, 100) as u32),
                Err(_) => {
                    return Reply::text(format!(
                        "✍️ Usage: /volume [N | up | down | mute | unmute]. Got: {other}"
                    ));
                }
            },
        };
        let snap = apply_volume(action);
        Reply {
            text: format_volume(&snap),
            keyboard: Some(volume_keyboard()),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum VolumeAction {
    Status,
    Set(u32),
    Step(i32),
    Mute(bool),
}

#[derive(Debug, Clone, Default)]
struct VolumeSnapshot {
    percent: Option<u32>,
    muted: bool,
    error: Option<String>,
}

fn apply_volume(action: VolumeAction) -> VolumeSnapshot {
    // Compute the target percent first so Set/Step flow through the same
    // AppleScript invocation.
    let current = read_volume();
    let target = match action {
        VolumeAction::Status => None,
        VolumeAction::Set(n) => Some(n),
        VolumeAction::Step(delta) => current
            .percent
            .map(|p| (p as i32 + delta).clamp(0, 100) as u32),
        VolumeAction::Mute(_) => None,
    };
    if let Some(t) = target {
        if let Err(e) = set_volume_percent(t) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    if let VolumeAction::Mute(on) = action {
        if let Err(e) = set_mute(on) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    read_volume()
}

fn read_volume() -> VolumeSnapshot {
    let pct = osascript_output("output volume of (get volume settings)")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let mute_str = osascript_output("output muted of (get volume settings)")
        .unwrap_or_default();
    let muted = mute_str.trim() == "true";
    VolumeSnapshot {
        percent: pct,
        muted,
        error: None,
    }
}

fn set_volume_percent(n: u32) -> Result<(), String> {
    osascript_run(&format!("set volume output volume {n}"))
}

fn set_mute(on: bool) -> Result<(), String> {
    osascript_run(&format!(
        "set volume output muted {}",
        if on { "true" } else { "false" }
    ))
}

fn osascript_output(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn osascript_run(script: &str) -> Result<(), String> {
    osascript_output(script).map(|_| ())
}

fn format_volume(s: &VolumeSnapshot) -> String {
    if let Some(e) = &s.error {
        return format!("⚠️ {e}");
    }
    let Some(p) = s.percent else {
        return "🔇 Could not read system volume.".to_string();
    };
    if s.muted {
        return format!("🔇 Muted (was {p}%)");
    }
    let bar = volume_bar(p);
    format!("🔊 {p}% {bar}")
}

fn volume_bar(percent: u32) -> String {
    let slots = 10usize;
    let filled = ((percent as f32 / 100.0) * slots as f32).round() as usize;
    let filled = filled.min(slots);
    let mut out = String::with_capacity(slots);
    for i in 0..slots {
        out.push(if i < filled { '█' } else { '░' });
    }
    out
}

fn volume_keyboard() -> InlineKeyboard {
    // Second row mirrors `music_keyboard()` — callback namespaces route
    // by first segment, so `music:*` from here hits MusicCmd just like
    // it would from `/music`. Reply carries its own volume keyboard
    // back, so the user stays in one message.
    InlineKeyboard {
        rows: vec![
            vec![
                InlineButton {
                    text: "➖10".into(),
                    callback_data: "volume:down".into(),
                },
                InlineButton {
                    text: "🔇".into(),
                    callback_data: "volume:mute".into(),
                },
                InlineButton {
                    text: "🔊".into(),
                    callback_data: "volume:unmute".into(),
                },
                InlineButton {
                    text: "➕10".into(),
                    callback_data: "volume:up".into(),
                },
            ],
            vec![
                InlineButton {
                    text: "⏮️".into(),
                    callback_data: "music:prev".into(),
                },
                InlineButton {
                    text: "⏯️".into(),
                    callback_data: "music:toggle".into(),
                },
                InlineButton {
                    text: "⏭️".into(),
                    callback_data: "music:next".into(),
                },
            ],
        ],
    }
}

// -------------------- /music --------------------

pub struct MusicCmd;

#[async_trait]
impl CommandHandler for MusicCmd {
    fn name(&self) -> &'static str {
        "music"
    }
    fn description(&self) -> &'static str {
        "Показати або керувати плеєром YouTube Music"
    }
    fn usage(&self) -> &'static str {
        "/music [play|pause|next|prev]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_lowercase();
        match sub.as_str() {
            "" | "status" => {
                let snapshot = read_now_playing(&ctx.app);
                let text = format_now_playing(&snapshot);
                Reply {
                    text,
                    keyboard: Some(music_keyboard()),
                    ..Default::default()
                }
            }
            "open" => {
                reveal_music_tab(&ctx.app);
                Reply {
                    text: "📻 Відкриваю YouTube Music у Stash. Коли плеєр завантажиться, керуй кнопками нижче."
                        .to_string(),
                    keyboard: Some(music_keyboard()),
                    ..Default::default()
                }
            }
            "play" | "pause" | "toggle" => run_music_action(
                &ctx,
                crate::modules::music::commands::music_play_pause,
                "⏯️",
                "перемкнуто",
            )
            .await,
            "next" => run_music_action(
                &ctx,
                crate::modules::music::commands::music_next,
                "⏭️",
                "далі",
            )
            .await,
            "prev" => run_music_action(
                &ctx,
                crate::modules::music::commands::music_prev,
                "⏮️",
                "назад",
            )
            .await,
            _ => Reply::text(format!(
                "✍️ Використання: /music [play|pause|next|prev]. Отримано: {sub}"
            )),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct NowPlaying {
    playing: bool,
    title: String,
    artist: String,
    attached: bool,
}

fn read_now_playing(app: &tauri::AppHandle) -> NowPlaying {
    let attached = app.webviews().contains_key("music");
    let Some(tray) = app.try_state::<Arc<TrayState>>() else {
        return NowPlaying {
            attached,
            ..NowPlaying::default()
        };
    };
    // Read music snapshot through the Mutex. `tray::music` is private —
    // use the public read helper.
    let snap = crate::tray::read_music_snapshot(&tray);
    NowPlaying {
        playing: snap.playing,
        title: snap.title,
        artist: snap.artist,
        attached,
    }
}

/// Wait a blink for the webview to update its now-playing state after a
/// control click, then format whatever we see — so `/music pause` reports
/// the post-action state rather than the pre-action one.
fn read_after_action(app: &tauri::AppHandle, verb: &str) -> String {
    std::thread::sleep(std::time::Duration::from_millis(400));
    let snap = read_now_playing(app);
    if !snap.attached {
        return format!("{verb} (плеєр не підключено)");
    }
    format_now_playing(&snap)
}

fn format_now_playing(snap: &NowPlaying) -> String {
    if !snap.attached {
        return "🎵 Плеєр не підключено. Спочатку відкрий Stash → Music.".to_string();
    }
    let title = if snap.title.is_empty() {
        "(нічого)".to_string()
    } else {
        snap.title.clone()
    };
    let who = if snap.artist.is_empty() {
        String::new()
    } else {
        format!(" — {}", snap.artist)
    };
    let icon = if snap.playing { "▶️" } else { "⏸️" };
    format!("{icon} {title}{who}")
}

/// Dispatch a music-player click and shape the Reply uniformly. On
/// first call per session the YouTube-Music webview isn't attached
/// yet — instead of bouncing the request back to the user with a
/// manual "open Music" button, we auto-reveal the tab and poll for the
/// webview to mount (takes ~5 s cold). The keyboard stays in play on
/// every outcome so the user isn't stranded after a transient failure.
async fn run_music_action(
    ctx: &Ctx,
    action: fn(tauri::AppHandle) -> Result<(), String>,
    emoji: &str,
    verb: &str,
) -> Reply {
    // Fast path — if the webview is already attached the action just
    // works without any UI jump.
    match action(ctx.app.clone()) {
        Ok(()) => {
            return Reply {
                text: format!("{emoji} {}", read_after_action(&ctx.app, verb)),
                keyboard: Some(music_keyboard()),
                ..Default::default()
            };
        }
        Err(e) if !e.contains("not attached") => {
            return Reply {
                text: format!("⚠️ {e}"),
                keyboard: Some(music_keyboard()),
                ..Default::default()
            };
        }
        Err(_) => {}
    }

    // Cold path — open the tab and wait for the child webview. 8 s
    // covers first-launch YTM loads (~5 s empirically) with headroom;
    // bail back to the manual prompt if we still don't see it so the
    // user isn't silently left hanging.
    reveal_music_tab(&ctx.app);
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut attached = false;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if ctx.app.webviews().contains_key("music") {
            attached = true;
            break;
        }
    }
    if !attached {
        return Reply {
            text: "📻 Плеєр не встиг відкритись. Спробуй ще раз за пару секунд."
                .into(),
            keyboard: Some(music_open_keyboard()),
            ..Default::default()
        };
    }
    // Webview exists, but YTM's player-bar buttons render a beat later —
    // give the DOM 600 ms to paint #play-pause-button before the first
    // click. Empirical; without this the click lands on an empty doc
    // and nothing happens.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;

    match action(ctx.app.clone()) {
        Ok(()) => Reply {
            text: format!("{emoji} {}", read_after_action(&ctx.app, verb)),
            keyboard: Some(music_keyboard()),
            ..Default::default()
        },
        Err(e) if e.contains("not attached") => Reply {
            text: "📻 Плеєр ще відкривається — повтори через секунду.".into(),
            keyboard: Some(music_keyboard()),
            ..Default::default()
        },
        Err(e) => Reply {
            text: format!("⚠️ {e}"),
            keyboard: Some(music_keyboard()),
            ..Default::default()
        },
    }
}

/// Mirror of the `⌘⇧N` shortcut for Notes: show the popup, focus it,
/// and tell the frontend to jump to the Music tab so `MusicShell`
/// mounts and attaches the YouTube-Music child webview.
fn reveal_music_tab(app: &tauri::AppHandle) {
    let _ = app.emit("nav:activate", "music");
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Single-button keyboard shown when the Music webview isn't attached
/// yet. Tapping it routes to `MusicCmd` with arg `"open"`, which calls
/// `reveal_music_tab` and swaps back to the full playback keyboard.
fn music_open_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![InlineButton {
            text: "📻 Відкрити Music".into(),
            callback_data: "music:open".into(),
        }]],
    }
}

fn music_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton {
                text: "⏮️".into(),
                callback_data: "music:prev".into(),
            },
            InlineButton {
                text: "⏯️".into(),
                callback_data: "music:toggle".into(),
            },
            InlineButton {
                text: "⏭️".into(),
                callback_data: "music:next".into(),
            },
        ]],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_page_parser_clamps_and_defaults() {
        assert_eq!(parse_dashboard_page(""), 1);
        assert_eq!(parse_dashboard_page("page=1"), 1);
        assert_eq!(parse_dashboard_page("page=2"), 2);
        assert_eq!(parse_dashboard_page("page=3"), 3);
        // Out-of-range clamps to the max page instead of crashing.
        assert_eq!(parse_dashboard_page("page=99"), DASHBOARD_PAGES);
        // Garbage falls back to page 1 so a mis-typed callback still renders.
        assert_eq!(parse_dashboard_page("page=xx"), 1);
        assert_eq!(parse_dashboard_page("random"), 1);
    }

    #[test]
    fn dashboard_keyboard_has_footer_with_wraparound() {
        let kb = dashboard_keyboard(1);
        // Footer is the last row. Expect prev = wrap to last page, self =
        // current page, next = 2.
        let footer = kb.rows.last().expect("footer present");
        assert_eq!(footer.len(), 3);
        assert_eq!(footer[0].callback_data, format!("refresh:dashboard:page={DASHBOARD_PAGES}"));
        assert!(footer[1].text.starts_with("1/"));
        assert_eq!(footer[1].callback_data, "refresh:dashboard:page=1");
        assert_eq!(footer[2].callback_data, "refresh:dashboard:page=2");
    }

    #[test]
    fn dashboard_page_three_covers_all_known_tabs() {
        // Page 3 exists to offer a one-tap jump to every app tab. If
        // someone adds a tab to KNOWN_TABS we want to notice before
        // shipping a dashboard that hides it from the AI-less user.
        let kb = dashboard_keyboard(3);
        let navigate_targets: std::collections::HashSet<&str> = kb
            .rows
            .iter()
            .flat_map(|row| row.iter())
            .filter_map(|b| b.callback_data.strip_prefix("navigate:"))
            .collect();
        for tab in KNOWN_TABS {
            assert!(
                navigate_targets.contains(*tab),
                "dashboard page 3 missing jump button for tab {tab}"
            );
        }
    }

    #[test]
    fn pmset_parses_typical_output() {
        let s = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123) 87%; discharging; 2:31 remaining present: true\n";
        assert_eq!(
            parse_pmset(s),
            BatterySnapshot::Present {
                percent: 87,
                charging: false,
            }
        );
    }

    #[test]
    fn pmset_parses_charging() {
        let s = " -InternalBattery-0 (id=1) 42%; charging; 1:10 present: true\n";
        assert_eq!(
            parse_pmset(s),
            BatterySnapshot::Present {
                percent: 42,
                charging: true,
            }
        );
    }

    #[test]
    fn pmset_parses_ac_attached() {
        let s = " -InternalBattery-0 (id=1) 100%; AC attached; not charging present: true\n";
        assert_eq!(
            parse_pmset(s),
            BatterySnapshot::Present {
                percent: 100,
                charging: true,
            }
        );
    }

    #[test]
    fn pmset_desktop_mac_without_battery() {
        assert_eq!(parse_pmset("Now drawing from 'AC Power'\n"), BatterySnapshot::NoBattery);
    }

    #[test]
    fn pmset_garbled_returns_unknown() {
        // A percent sign but no parsable number nearby → Unknown, not
        // NoBattery, because we did see a %.
        assert_eq!(parse_pmset("abc%def"), BatterySnapshot::Unknown);
    }

    #[test]
    fn truncate_preview_keeps_short() {
        assert_eq!(truncate_preview("hello", 10), "hello");
    }

    #[test]
    fn truncate_preview_adds_ellipsis() {
        let long = "a".repeat(20);
        let out = truncate_preview(&long, 10);
        assert_eq!(out.chars().count(), 11);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn volume_bar_reflects_percent() {
        assert_eq!(volume_bar(0), "░░░░░░░░░░");
        assert_eq!(volume_bar(50), "█████░░░░░");
        assert_eq!(volume_bar(100), "██████████");
    }

    #[test]
    fn format_volume_renders_percent() {
        let s = VolumeSnapshot {
            percent: Some(42),
            muted: false,
            error: None,
        };
        let out = format_volume(&s);
        assert!(out.contains("42%"));
        assert!(out.starts_with("🔊"));
    }

    #[test]
    fn parse_metronome_start_with_full_params() {
        let r = parse_metronome_args("start bpm=140 sig=6/8 sub=2 sound=wood").unwrap();
        assert_eq!(r.action.as_deref(), Some("start"));
        assert_eq!(r.bpm, Some(140));
        assert_eq!(r.numerator, Some(6));
        assert_eq!(r.denominator, Some(8));
        assert_eq!(r.subdivision, Some(2));
        assert_eq!(r.sound.as_deref(), Some("wood"));
    }

    #[test]
    fn parse_metronome_bare_bpm_change_has_no_action() {
        let r = parse_metronome_args("bpm=100").unwrap();
        assert!(r.action.is_none());
        assert_eq!(r.bpm, Some(100));
    }

    #[test]
    fn parse_metronome_rejects_out_of_range_bpm() {
        let err = parse_metronome_args("bpm=999").unwrap_err();
        assert!(err.to_lowercase().contains("bpm"));
    }

    #[test]
    fn parse_metronome_rejects_bad_denominator() {
        let err = parse_metronome_args("sig=4/3").unwrap_err();
        assert!(err.contains("denominator"));
    }

    #[test]
    fn parse_metronome_rejects_unknown_key() {
        let err = parse_metronome_args("foo=1").unwrap_err();
        assert!(err.contains("foo"));
    }

    #[test]
    fn parse_metronome_accepts_play_alias_as_start() {
        let r = parse_metronome_args("play").unwrap();
        assert_eq!(r.action.as_deref(), Some("start"));
    }

    #[test]
    fn parse_metronome_rejects_bad_sound() {
        let err = parse_metronome_args("sound=gong").unwrap_err();
        assert!(err.contains("sound"));
    }

    #[test]
    fn format_metronome_reply_summarises_action_and_params() {
        let r = MetronomeRemote {
            action: Some("start".into()),
            bpm: Some(140),
            numerator: Some(6),
            denominator: Some(8),
            subdivision: None,
            sound: None,
        };
        let out = format_metronome_reply(&r);
        assert!(out.contains("140"));
        assert!(out.contains("6/8"));
        assert!(out.contains("старт"));
    }

    #[test]
    fn parse_pomodoro_blocks_accepts_bare_minutes() {
        let blocks = parse_pomodoro_blocks("25/sit 5/walk", 1000).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].duration_sec, 25 * 60);
        assert_eq!(blocks[0].posture, Posture::Sit);
        assert_eq!(blocks[1].duration_sec, 5 * 60);
        assert_eq!(blocks[1].posture, Posture::Walk);
    }

    #[test]
    fn parse_pomodoro_blocks_honours_unit_suffixes() {
        let blocks = parse_pomodoro_blocks("90s/sit 1h/walk", 0).unwrap();
        assert_eq!(blocks[0].duration_sec, 90);
        assert_eq!(blocks[1].duration_sec, 3600);
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_missing_slash() {
        let err = parse_pomodoro_blocks("25sit", 0).unwrap_err();
        assert!(err.contains("посture") || err.contains("posture") || err.contains("/"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_unknown_posture() {
        let err = parse_pomodoro_blocks("25/fly", 0).unwrap_err();
        assert!(err.to_lowercase().contains("posture"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_zero_duration() {
        let err = parse_pomodoro_blocks("0/sit", 0).unwrap_err();
        assert!(err.contains("> 0"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_too_many() {
        let tokens = (0..21).map(|_| "1/sit").collect::<Vec<_>>().join(" ");
        let err = parse_pomodoro_blocks(&tokens, 0).unwrap_err();
        assert!(err.contains("максимум"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_empty_input() {
        let err = parse_pomodoro_blocks("", 0).unwrap_err();
        assert!(err.contains("хоча б"));
    }

    #[test]
    fn known_tabs_include_metronome_and_pomodoro() {
        assert!(KNOWN_TABS.contains(&"metronome"));
        assert!(KNOWN_TABS.contains(&"pomodoro"));
    }

    #[test]
    fn format_volume_mute_shows_previous_level() {
        let s = VolumeSnapshot {
            percent: Some(60),
            muted: true,
            error: None,
        };
        let out = format_volume(&s);
        assert!(out.contains("60%"));
        assert!(out.starts_with("🔇"));
    }
}

// -------------------- Memory slash commands --------------------
// (Assistant chat is the free-text default — no `/ai` slash needed.)

/// `/remember <fact>` — persist a single fact.
pub struct RememberCmd {
    state: Arc<TelegramState>,
}

impl RememberCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for RememberCmd {
    fn name(&self) -> &'static str {
        "remember"
    }
    fn description(&self) -> &'static str {
        "Запам'ятати факт про тебе"
    }
    fn usage(&self) -> &'static str {
        "/remember <факт>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let text = args.trim();
        if text.is_empty() {
            return Reply::text("Використання: /remember <факт>");
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let result = {
            let mut repo = match self.state.repo.lock() {
                Ok(r) => r,
                Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
            };
            repo.memory_insert(text, now)
        };
        match result {
            Ok(id) => Reply::text(format!("🧠 Записав. (id {id})")),
            Err(e) => Reply::text(format!("⚠️ {e}")),
        }
    }
}

/// `/memory` — list stored facts.
pub struct MemoryCmd {
    state: Arc<TelegramState>,
}

impl MemoryCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for MemoryCmd {
    fn name(&self) -> &'static str {
        "memory"
    }
    fn description(&self) -> &'static str {
        "Показати все, що я пам'ятаю про тебе"
    }
    fn usage(&self) -> &'static str {
        "/memory"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let rows = {
            let repo = match self.state.repo.lock() {
                Ok(r) => r,
                Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
            };
            repo.memory_list()
        };
        match rows {
            Ok(rows) if rows.is_empty() => Reply::text("🗒 Поки що нічого. Почни з `/remember <факт>`."),
            Ok(rows) => {
                let body = rows
                    .iter()
                    .map(|r| format!("• {} (id {})", r.fact, r.id))
                    .collect::<Vec<_>>()
                    .join("\n");
                Reply::text(format!("🗒 Факти:\n{body}"))
            }
            Err(e) => Reply::text(format!("⚠️ {e}")),
        }
    }
}

/// `/forget_fact <id>` — delete a fact. Named distinctly from
/// `/forget` (which cancels a reminder in Phase 4) so there's no id-
/// collision ambiguity between the two tables.
pub struct ForgetFactCmd {
    state: Arc<TelegramState>,
}

impl ForgetFactCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ForgetFactCmd {
    fn name(&self) -> &'static str {
        "forget_fact"
    }
    fn description(&self) -> &'static str {
        "Видалити збережений факт за id"
    }
    fn usage(&self) -> &'static str {
        "/forget_fact <id>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let Ok(id) = args.trim().parse::<i64>() else {
            return Reply::text("Використання: /forget_fact <id>");
        };
        let result = {
            let mut repo = match self.state.repo.lock() {
                Ok(r) => r,
                Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
            };
            repo.memory_delete(id)
        };
        match result {
            Ok(true) => Reply::text(format!("🧠 Забув факт {id}.")),
            Ok(false) => Reply::text(format!("🤷 Немає факту з id {id}.")),
            Err(e) => Reply::text(format!("⚠️ {e}")),
        }
    }
}

// -------------------- /summarize --------------------

/// `/summarize [N]` — collect the last N inbox items (text body,
/// voice transcript, photo/video caption) and ask the assistant for a
/// single-paragraph recap with emojis. N defaults to 10 and is capped
/// at 50 so one command can't consume a whole context window.
pub struct SummarizeCmd {
    state: Arc<TelegramState>,
}

impl SummarizeCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for SummarizeCmd {
    fn name(&self) -> &'static str {
        "summarize"
    }
    fn description(&self) -> &'static str {
        "Підсумок останніх N повідомлень в інбоксі (N=10 за замовчуванням)"
    }
    fn usage(&self) -> &'static str {
        "/summarize [N]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let n = args.trim().parse::<usize>().unwrap_or(10).clamp(1, 50);
        let items = match self.state.repo.lock() {
            Ok(repo) => match repo.list_inbox(n) {
                Ok(list) => list,
                Err(e) => return Reply::text(format!("⚠️ {e}")),
            },
            Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
        };
        if items.is_empty() {
            return Reply::text("📭 В інбоксі нічого немає.");
        }
        let mut prompt = String::from(
            "Summarise the following recent Telegram-inbox items into one short \
             paragraph, in the same language as the majority of entries. \
             Use one or two emojis to group themes (📝 notes, 🎤 voice, 📷 photo, \
             📎 file). Skip meta-statements, just deliver the content.\n\n",
        );
        for (i, it) in items.iter().enumerate() {
            let content = it
                .text_content
                .as_deref()
                .or(it.transcript.as_deref())
                .or(it.caption.as_deref())
                .unwrap_or("[no text]");
            prompt.push_str(&format!("{}. [{}] {}\n", i + 1, it.kind, content));
        }
        match super::assistant::handle_user_text(&ctx.app, &self.state, &prompt).await {
            Ok(reply) => {
                let body = reply.text.trim();
                if body.is_empty() {
                    Reply::text("🤷 Нема на що відповісти — AI нічого не повернув.")
                } else {
                    Reply::text(format!("🗒 {body}"))
                }
            }
            Err(e) => Reply::text(format!("⚠️ AI: {e}")),
        }
    }
}

// -------------------- /screenshot --------------------

pub struct ScreenshotCmd;

#[async_trait]
impl CommandHandler for ScreenshotCmd {
    fn name(&self) -> &'static str {
        "screenshot"
    }
    fn description(&self) -> &'static str {
        "Скрін усіх екранів у PNG (без перекодування). `main` — лише головний."
    }
    fn usage(&self) -> &'static str {
        "/screenshot [main]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_ascii_lowercase();
        let result = tokio::task::spawn_blocking(move || {
            if matches!(sub.as_str(), "main" | "primary" | "1") {
                crate::modules::system::screenshot::capture_main_display().map(|p| vec![p])
            } else {
                crate::modules::system::screenshot::capture_all_displays()
            }
        })
        .await;

        let files = match result {
            Ok(Ok(ps)) => ps,
            Ok(Err(e)) => return Reply::text(format!("⚠️ screenshot: {e}")),
            Err(e) => return Reply::text(format!("⚠️ screenshot: task join: {e}")),
        };

        let paths_block = files
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let caption = format!(
            "📸 Захоплено екранів: {}\n{}",
            files.len(),
            paths_block
        );
        Reply {
            text: caption,
            documents: files,
            keyboard: Some(InlineKeyboard {
                rows: vec![vec![InlineButton::new("📸 Again", "screenshot")]],
            }),
        }
    }
}

// -------------------- /display /sleep /shutdown --------------------

use crate::modules::system::power::{self, PowerKind, PowerTimers};

pub struct DisplayCmd;

#[async_trait]
impl CommandHandler for DisplayCmd {
    fn name(&self) -> &'static str {
        "display"
    }
    fn description(&self) -> &'static str {
        "Погасити екрани. Mac і фонові задачі (Claude, білди, завантаження) працюють далі."
    }
    fn usage(&self) -> &'static str {
        "/display"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        match tokio::task::spawn_blocking(power::display_off).await {
            Ok(Ok(())) => Reply::text("💤 Екрани погашено (Mac працює далі)."),
            Ok(Err(e)) => Reply::text(format!("⚠️ display: {e}")),
            Err(e) => Reply::text(format!("⚠️ display: task join: {e}")),
        }
    }
}

pub struct SleepCmd {
    timers: Arc<PowerTimers>,
}

impl SleepCmd {
    pub fn new(timers: Arc<PowerTimers>) -> Self {
        Self { timers }
    }
}

#[async_trait]
impl CommandHandler for SleepCmd {
    fn name(&self) -> &'static str {
        "sleep"
    }
    fn description(&self) -> &'static str {
        "Приспати Mac. Без аргументу — зараз; `15m` / `30s` / `1h` — за таймером. `cancel` / `status`."
    }
    fn usage(&self) -> &'static str {
        "/sleep [<duration>|cancel|status]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        handle_power_cmd(&self.timers, PowerKind::Sleep, args).await
    }
}

pub struct ShutdownCmd {
    timers: Arc<PowerTimers>,
}

impl ShutdownCmd {
    pub fn new(timers: Arc<PowerTimers>) -> Self {
        Self { timers }
    }
}

#[async_trait]
impl CommandHandler for ShutdownCmd {
    fn name(&self) -> &'static str {
        "shutdown"
    }
    fn description(&self) -> &'static str {
        "Вимкнути Mac. Без аргументу — зараз; `30m` — за таймером. `cancel` / `status`. Незбережені документи можуть блокувати."
    }
    fn usage(&self) -> &'static str {
        "/shutdown [<duration>|cancel|status]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        handle_power_cmd(&self.timers, PowerKind::Shutdown, args).await
    }
}

// -------------------- /focus --------------------

use crate::modules::system::focus;

pub struct FocusCmd;

#[async_trait]
impl CommandHandler for FocusCmd {
    fn name(&self) -> &'static str {
        "focus"
    }
    fn description(&self) -> &'static str {
        "Керувати macOS Focus: on / off / status. Одноразове налаштування через Shortcuts.app."
    }
    fn usage(&self) -> &'static str {
        "/focus <on|off|status>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_ascii_lowercase();
        let verb = sub.as_str();
        let status =
            tokio::task::spawn_blocking(focus::check).await.unwrap_or(
                focus::FocusCheck::ListFailed("internal: task join".into()),
            );
        if verb.is_empty() || verb == "status" {
            return Reply::text(format_focus_status(&status));
        }
        match &status {
            focus::FocusCheck::Ready => {}
            focus::FocusCheck::CliMissing => {
                return Reply::text(
                    "⚠️ `shortcuts` CLI не знайдено. Потрібен macOS 12+.",
                );
            }
            focus::FocusCheck::ShortcutsMissing { .. } => {
                return Reply::text(format!(
                    "⚠️ Не знайдено потрібних ярликів.\n{}",
                    focus::setup_instructions()
                ));
            }
            focus::FocusCheck::ListFailed(e) => {
                return Reply::text(format!("⚠️ shortcuts list: {e}"));
            }
        }
        match verb {
            "on" | "enable" => match tokio::task::spawn_blocking(focus::enable).await {
                Ok(Ok(())) => Reply::text("🔕 Focus увімкнено."),
                Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                Err(e) => Reply::text(format!("⚠️ task join: {e}")),
            },
            "off" | "disable" => match tokio::task::spawn_blocking(focus::disable).await {
                Ok(Ok(())) => Reply::text("🔔 Focus вимкнено."),
                Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                Err(e) => Reply::text(format!("⚠️ task join: {e}")),
            },
            other => Reply::text(format!(
                "❓ Невідомий підкоманда `{other}`.\nВикористання: {}",
                self.usage()
            )),
        }
    }
}

fn format_focus_status(s: &focus::FocusCheck) -> String {
    match s {
        focus::FocusCheck::Ready => {
            "🔔 Focus готовий: `/focus on` або `/focus off`.".into()
        }
        focus::FocusCheck::CliMissing => {
            "⚠️ `shortcuts` CLI не знайдено. Потрібен macOS 12+.".into()
        }
        focus::FocusCheck::ShortcutsMissing { on, off } => {
            let missing = match (on, off) {
                (false, false) => "обидва ярлики",
                (true, false) => "«Stash Focus Off»",
                (false, true) => "«Stash Focus On»",
                (true, true) => unreachable!("Ready should hit other branch"),
            };
            format!(
                "⚠️ Відсутнє: {missing}.\n{}",
                focus::setup_instructions()
            )
        }
        focus::FocusCheck::ListFailed(e) => format!("⚠️ shortcuts list: {e}"),
    }
}

// -------------------- /weather --------------------

use crate::modules::system::weather;

pub struct WeatherCmd {
    state: Arc<TelegramState>,
}

impl WeatherCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for WeatherCmd {
    fn name(&self) -> &'static str {
        "weather"
    }
    fn description(&self) -> &'static str {
        "Погода з wttr.in. Без аргумента — з пам'яті (факт `location: <місто>`)."
    }
    fn usage(&self) -> &'static str {
        "/weather [<місто>]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let arg = args.trim().to_string();
        let city = if arg.is_empty() {
            // Pull the `location:` fact out of memory. Falling back to IP
            // geolocation would be surprising and wrong when the user
            // asks for "their" weather after saving a city.
            let facts: Vec<String> = match self.state.repo.lock() {
                Ok(r) => match r.memory_list() {
                    Ok(rows) => rows.into_iter().map(|r| r.fact).collect(),
                    Err(e) => return Reply::text(format!("⚠️ пам'ять: {e}")),
                },
                Err(e) => return Reply::text(format!("⚠️ пам'ять: {e}")),
            };
            match weather::location_from_facts(&facts) {
                Some(c) => c,
                None => {
                    return Reply::text(
                        "❓ Місто не збережене. Скажи, наприклад: \
                         `/remember location: Київ` — або `/weather Київ`.",
                    );
                }
            }
        } else {
            arg
        };
        let for_label = city.clone();
        match weather::fetch_weather(&city).await {
            Ok(body) => Reply::text(format!("🌦 {for_label}\n{body}")),
            Err(e) => Reply::text(format!("⚠️ погода: {e}")),
        }
    }
}

// -------------------- /app --------------------

use crate::modules::system::apps_control;

pub struct AppCmd;

#[async_trait]
impl CommandHandler for AppCmd {
    fn name(&self) -> &'static str {
        "app"
    }
    fn description(&self) -> &'static str {
        "Керувати програмами macOS: відкрити, згорнути, закрити, список запущених."
    }
    fn usage(&self) -> &'static str {
        "/app <open|hide|quit> <name> | /app running"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim();
        if sub.is_empty() {
            return Reply::text(format!("✍️ Використання: {}", self.usage()));
        }
        // Running-list is the only sub without a name argument, so peel it
        // off first before the verb/name split.
        if sub.eq_ignore_ascii_case("running")
            || sub.eq_ignore_ascii_case("list")
            || sub.eq_ignore_ascii_case("ls")
        {
            return match tokio::task::spawn_blocking(apps_control::list_running_apps).await {
                Ok(Ok(names)) if names.is_empty() => {
                    Reply::text("🪟 Нічого переднього плану не запущено.")
                }
                Ok(Ok(names)) => {
                    Reply::text(format!("🪟 Запущено: {}", names.join(", ")))
                }
                Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                Err(e) => Reply::text(format!("⚠️ task join: {e}")),
            };
        }

        let mut parts = sub.splitn(2, char::is_whitespace);
        let verb = parts.next().unwrap_or("").to_ascii_lowercase();
        let name = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            return Reply::text(format!(
                "✍️ Треба ім'я програми. Використання: {}",
                self.usage()
            ));
        }
        match verb.as_str() {
            "open" | "launch" | "focus" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::open_app(&n)).await;
                match result {
                    Ok(Ok(())) => Reply::text(format!("🚀 Відкрив: {name}")),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            "hide" | "minimize" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::hide_app(&n)).await;
                match result {
                    Ok(Ok(())) => Reply::text(format!("👻 Згорнув: {name}")),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            "quit" | "close" | "exit" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::quit_app(&n)).await;
                match result {
                    Ok(Ok(apps_control::QuitOutcome::Quit { resolved_name })) => {
                        Reply::text(format!("🛑 Закрив: {resolved_name}"))
                    }
                    Ok(Ok(apps_control::QuitOutcome::NotRunning)) => Reply::text(format!(
                        "ℹ️ `{name}` не запущений — нема чого закривати."
                    )),
                    Ok(Ok(apps_control::QuitOutcome::StillRunning { resolved_name })) => {
                        // Most common cause is an unsaved-document dialog
                        // blocking the Quit event. Report honestly so the
                        // assistant doesn't falsely claim success.
                        Reply::text(format!(
                            "⚠️ `{resolved_name}` не закрився (можливо, діалог «зберегти»?). \
                             Натисни `/app quit {resolved_name}` ще раз після відповіді на діалог."
                        ))
                    }
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            other => Reply::text(format!(
                "❓ Невідомий підкоманда `{other}`.\nВикористання: {}",
                self.usage()
            )),
        }
    }
}

/// Tab IDs the frontend's module registry currently recognises. Kept in
/// sync manually with `src/modules/*/index.tsx` — changes there must land
/// here the same commit (see CLAUDE.md "Agent surface").
pub const KNOWN_TABS: &[&str] = &[
    "clipboard",
    "translator",
    "notes",
    "ai",
    "telegram",
    "metronome",
    "music",
    "downloads",
    "pomodoro",
    "terminal",
    "web",
    "system",
];

pub struct NavigateCmd;

#[async_trait]
impl CommandHandler for NavigateCmd {
    fn name(&self) -> &'static str {
        "navigate"
    }
    fn description(&self) -> &'static str {
        "Відкрити певну вкладку Stash. Без аргументу — список доступних."
    }
    fn usage(&self) -> &'static str {
        "/navigate <tab>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let wanted = args.trim().to_ascii_lowercase();
        if wanted.is_empty() {
            return Reply::text(format!(
                "🗂 Доступні вкладки: {}\nВикористання: /navigate <tab>",
                KNOWN_TABS.join(", ")
            ));
        }
        if !KNOWN_TABS.contains(&wanted.as_str()) {
            return Reply::text(format!(
                "❓ Невідома вкладка `{wanted}`. Доступні: {}",
                KNOWN_TABS.join(", ")
            ));
        }
        reveal_tab(&ctx.app, &wanted);
        Reply::text(format!("🗂 Відкрито вкладку: {wanted}"))
    }
}

/// Emit `nav:activate` + show/focus the popup. The frontend shell listens
/// and mounts the requested lazy tab inside `<Suspense>`; this is the
/// same path used by `reveal_music_tab` and the `⌘⇧N` Notes shortcut.
fn reveal_tab(app: &tauri::AppHandle, tab_id: &str) {
    let _ = app.emit("nav:activate", tab_id);
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

// -------------------- /metronome --------------------

/// Payload for the `metronome:remote` event. Frontend applies the patch
/// (any `Some` field), then reacts to `action`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MetronomeRemote {
    pub action: Option<String>,
    pub bpm: Option<u32>,
    pub numerator: Option<u8>,
    pub denominator: Option<u8>,
    pub subdivision: Option<u8>,
    pub sound: Option<String>,
}

pub struct MetronomeCmd;

#[async_trait]
impl CommandHandler for MetronomeCmd {
    fn name(&self) -> &'static str {
        "metronome"
    }
    fn description(&self) -> &'static str {
        "Керувати метрономом. Приклади: `start bpm=140 sig=6/8`, `stop`, `bpm=100`."
    }
    fn usage(&self) -> &'static str {
        "/metronome [start|stop|toggle] [bpm=N] [sig=N/D] [sub=1..4] [sound=click|wood|beep]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let parsed = match parse_metronome_args(args) {
            Ok(p) => p,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        // Reveal + mount the metronome tab so the shell's listener is
        // attached by the time we emit the remote payload. Two pieces of
        // async work but both are best-effort — `nav:activate` handled by
        // shell; sleep gives Suspense a moment to resolve the lazy chunk.
        reveal_tab(&ctx.app, "metronome");
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        let _ = ctx.app.emit("metronome:remote", &parsed);
        Reply::text(format_metronome_reply(&parsed))
    }
}

fn parse_metronome_args(args: &str) -> Result<MetronomeRemote, String> {
    let mut out = MetronomeRemote::default();
    for tok in args.split_whitespace() {
        match tok.to_ascii_lowercase().as_str() {
            "start" | "play" => out.action = Some("start".into()),
            "stop" | "pause" => out.action = Some("stop".into()),
            "toggle" => out.action = Some("toggle".into()),
            "status" => out.action = Some("status".into()),
            other => {
                let (key, val) = other
                    .split_once('=')
                    .ok_or_else(|| format!("незрозумілий токен: `{other}`"))?;
                match key {
                    "bpm" => {
                        let n: u32 = val
                            .parse()
                            .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                        if !(40..=240).contains(&n) {
                            return Err(format!("bpm поза межами 40–240: {n}"));
                        }
                        out.bpm = Some(n);
                    }
                    "sig" | "time" => {
                        let (num, den) = val
                            .split_once('/')
                            .ok_or_else(|| format!("sig очікує N/D, отримано `{val}`"))?;
                        let n: u8 = num
                            .parse()
                            .map_err(|_| format!("numerator не число: `{num}`"))?;
                        let d: u8 = den
                            .parse()
                            .map_err(|_| format!("denominator не число: `{den}`"))?;
                        if !(1..=16).contains(&n) {
                            return Err(format!("numerator поза 1–16: {n}"));
                        }
                        if !matches!(d, 2 | 4 | 8) {
                            return Err(format!("denominator має бути 2/4/8, отримано {d}"));
                        }
                        out.numerator = Some(n);
                        out.denominator = Some(d);
                    }
                    "sub" | "subdivision" => {
                        let n: u8 = val
                            .parse()
                            .map_err(|_| format!("sub не число: `{val}`"))?;
                        if !(1..=4).contains(&n) {
                            return Err(format!("sub поза 1–4: {n}"));
                        }
                        out.subdivision = Some(n);
                    }
                    "sound" => {
                        let v = val.to_ascii_lowercase();
                        if !matches!(v.as_str(), "click" | "wood" | "beep") {
                            return Err(format!("sound має бути click|wood|beep, отримано `{val}`"));
                        }
                        out.sound = Some(v);
                    }
                    _ => return Err(format!("невідомий параметр: `{key}`")),
                }
            }
        }
    }
    Ok(out)
}

fn format_metronome_reply(r: &MetronomeRemote) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = &r.action {
        parts.push(match a.as_str() {
            "start" => "▶️ старт".into(),
            "stop" => "⏸ стоп".into(),
            "toggle" => "⏯ перемкнуто".into(),
            "status" => "ℹ️ статус".into(),
            other => other.into(),
        });
    }
    if let Some(bpm) = r.bpm {
        parts.push(format!("{bpm} BPM"));
    }
    if let (Some(n), Some(d)) = (r.numerator, r.denominator) {
        parts.push(format!("{n}/{d}"));
    }
    if let Some(sub) = r.subdivision {
        parts.push(format!("sub={sub}"));
    }
    if let Some(sound) = &r.sound {
        parts.push(format!("звук={sound}"));
    }
    if parts.is_empty() {
        "🥁 Метроном без змін.".to_string()
    } else {
        format!("🥁 Метроном: {}", parts.join(", "))
    }
}

// -------------------- /pomodoro --------------------

use crate::modules::pomodoro::commands::{start_session, stop_session};
use crate::modules::pomodoro::engine::SessionStatus;
use crate::modules::pomodoro::model::{Block, Posture};
use crate::modules::pomodoro::state::PomodoroState;

pub struct PomodoroCmd {
    state: Arc<PomodoroState>,
}

impl PomodoroCmd {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for PomodoroCmd {
    fn name(&self) -> &'static str {
        "pomodoro"
    }
    fn description(&self) -> &'static str {
        "Керувати таймером Pomodoro. Приклади: `start 25/sit 5/walk`, `stop`, `status`."
    }
    fn usage(&self) -> &'static str {
        "/pomodoro [start <min>/<posture> …|stop|status]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim();
        // No args OR "status" → read-only snapshot. Safe without AppHandle.
        if sub.is_empty() || sub.eq_ignore_ascii_case("status") {
            return Reply::text(format_pomodoro_status(&self.state));
        }
        let mut parts = sub.splitn(2, char::is_whitespace);
        let verb = parts.next().unwrap_or("").to_ascii_lowercase();
        let rest = parts.next().unwrap_or("").trim();
        match verb.as_str() {
            "stop" | "cancel" | "end" => {
                let was_running = {
                    let core = match self.state.core.lock() {
                        Ok(c) => c,
                        Err(e) => return Reply::text(format!("⚠️ pomodoro: {e}")),
                    };
                    !core.is_idle()
                };
                if !was_running {
                    return Reply::text("ℹ️ Pomodoro не запущено.");
                }
                let _ = stop_session(&ctx.app, &self.state);
                Reply::text("⏹ Pomodoro зупинено.")
            }
            "start" | "begin" | "go" => {
                let blocks = match parse_pomodoro_blocks(rest, now_ms()) {
                    Ok(b) => b,
                    Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
                };
                reveal_tab(&ctx.app, "pomodoro");
                match start_session(&ctx.app, &self.state, blocks.clone(), None) {
                    Ok(snap) => {
                        let total_min: u32 = snap
                            .blocks
                            .iter()
                            .map(|b| b.duration_sec / 60)
                            .sum();
                        let summary = snap
                            .blocks
                            .iter()
                            .map(|b| {
                                format!(
                                    "{}/{}",
                                    b.duration_sec / 60,
                                    posture_word(&b.posture)
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                            ;
                        Reply::text(format!(
                            "🍅 Стартував Pomodoro ({total_min} хв): {summary}"
                        ))
                    }
                    Err(e) => Reply::text(format!("⚠️ pomodoro: {e}")),
                }
            }
            other => Reply::text(format!(
                "❓ Невідомий підкоманда `{other}`.\nВикористання: {}",
                self.usage()
            )),
        }
    }
}

fn format_pomodoro_status(state: &Arc<PomodoroState>) -> String {
    let core = match state.core.lock() {
        Ok(c) => c,
        Err(e) => return format!("⚠️ pomodoro: {e}"),
    };
    let snap = core.snapshot();
    match snap.status {
        SessionStatus::Idle => "🍅 Pomodoro не активний.".to_string(),
        status => {
            let remaining_sec = (snap.remaining_ms / 1000).max(0);
            let mins = remaining_sec / 60;
            let secs = remaining_sec % 60;
            let phase = snap
                .blocks
                .get(snap.current_idx)
                .map(|b| {
                    format!(
                        "{} ({}/{})",
                        b.name,
                        snap.current_idx + 1,
                        snap.blocks.len()
                    )
                })
                .unwrap_or_else(|| "-".into());
            let verb = match status {
                SessionStatus::Running => "▶️",
                SessionStatus::Paused => "⏸",
                SessionStatus::Idle => "🍅",
            };
            format!("{verb} {phase} — лишилось {mins:02}:{secs:02}")
        }
    }
}

/// Parse `25/sit 5/walk 25/sit 10/walk` (minutes by default). Accepts
/// explicit unit suffixes (`s`, `m`, `h`) so `90s/sit 25m/stand` works.
pub(crate) fn parse_pomodoro_blocks(s: &str, now_ms: i64) -> Result<Vec<Block>, String> {
    let tokens: Vec<&str> = s.split_whitespace().collect();
    if tokens.is_empty() {
        return Err("вкажи хоча б один блок у форматі `<тривалість>/<postura>`".into());
    }
    if tokens.len() > 20 {
        return Err(format!("забагато блоків ({}), максимум 20", tokens.len()));
    }
    let mut blocks = Vec::with_capacity(tokens.len());
    for (i, tok) in tokens.iter().enumerate() {
        let (dur_str, posture_str) = tok
            .split_once('/')
            .ok_or_else(|| format!("блок {i} має бути `<тривалість>/<posture>`, отримано `{tok}`"))?;
        let duration_sec = parse_duration_to_sec(dur_str)
            .map_err(|e| format!("блок {i}: {e}"))?;
        if duration_sec == 0 {
            return Err(format!("блок {i}: тривалість має бути > 0"));
        }
        if duration_sec > 4 * 60 * 60 {
            return Err(format!("блок {i}: тривалість перевищує 4 год"));
        }
        let posture = match posture_str.to_ascii_lowercase().as_str() {
            "sit" => Posture::Sit,
            "stand" => Posture::Stand,
            "walk" => Posture::Walk,
            other => return Err(format!("блок {i}: невідома posture `{other}` (sit|stand|walk)")),
        };
        let name = match posture {
            Posture::Sit => "Focus".to_string(),
            Posture::Stand => "Stand".to_string(),
            Posture::Walk => "Walk".to_string(),
        };
        blocks.push(Block {
            id: format!("cli-{now_ms}-{i}"),
            name,
            duration_sec,
            posture,
            mid_nudge_sec: None,
        });
    }
    Ok(blocks)
}

fn parse_duration_to_sec(s: &str) -> Result<u32, String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err("порожня тривалість".into());
    }
    let (num_str, mul) = if let Some(stripped) = trimmed.strip_suffix('s') {
        (stripped, 1u32)
    } else if let Some(stripped) = trimmed.strip_suffix('m') {
        (stripped, 60u32)
    } else if let Some(stripped) = trimmed.strip_suffix('h') {
        (stripped, 3600u32)
    } else {
        // bare number → minutes (the common pomodoro mental model)
        (trimmed, 60u32)
    };
    let n: u32 = num_str
        .parse()
        .map_err(|_| format!("тривалість `{s}` не число"))?;
    n.checked_mul(mul)
        .ok_or_else(|| format!("тривалість `{s}` перевищує припустимий діапазон"))
}

fn posture_word(p: &Posture) -> &'static str {
    match p {
        Posture::Sit => "sit",
        Posture::Stand => "stand",
        Posture::Walk => "walk",
    }
}

// -------------------- /ai --------------------

/// `/ai <prompt>` — free-text turn against the assistant. Primary entry
/// point for the CLI (`stash ai "…"`) and any non-Telegram transport that
/// needs the LLM + tool-loop. Telegram's dispatcher already routes bare
/// text through `handle_user_text`, but exposing it as a slash command
/// means the CLI's thin slash-dispatcher can reach the assistant without
/// a parallel code path.
pub struct AiCmd {
    state: Arc<TelegramState>,
}

impl AiCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for AiCmd {
    fn name(&self) -> &'static str {
        "ai"
    }
    fn description(&self) -> &'static str {
        "Запит до AI-асистента (з повним доступом до tools і slash-команд)."
    }
    fn usage(&self) -> &'static str {
        "/ai <запит>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let prompt = args.trim();
        if prompt.is_empty() {
            return Reply::text("✍️ Використання: /ai <запит>");
        }
        match super::assistant::handle_user_text(&ctx.app, &self.state, prompt).await {
            Ok(reply) => {
                let body = reply.text.trim();
                if body.is_empty() {
                    Reply::text("🤷 AI нічого не повернув.")
                } else if reply.truncated {
                    Reply::text(format!("{body}\n\n(обрізано через ліміт глибини)"))
                } else {
                    Reply::text(body.to_string())
                }
            }
            Err(e) => Reply::text(format!("⚠️ AI: {e}")),
        }
    }
}

async fn handle_power_cmd(
    timers: &Arc<PowerTimers>,
    kind: PowerKind,
    args: &str,
) -> Reply {
    let sub = args.trim().to_ascii_lowercase();
    match sub.as_str() {
        "cancel" | "off" | "stop" | "abort" => {
            if timers.cancel(kind) {
                Reply::text(format!("✖️ {} cancelled.", label(kind, true)))
            } else {
                Reply::text(format!("ℹ️ Немає запланованого {}.", label(kind, false)))
            }
        }
        "status" => match timers.pending_fire_at(kind) {
            Some(fire_at_ms) => {
                let now = now_ms();
                let remaining = (fire_at_ms - now).max(0) as u64;
                Reply::text(format!(
                    "⏱ {} через {}",
                    label(kind, true),
                    power::format_duration(std::time::Duration::from_millis(remaining))
                ))
            }
            None => Reply::text(format!("ℹ️ Немає запланованого {}.", label(kind, false))),
        },
        "" => immediate(kind).await,
        other => match power::parse_duration(other) {
            Ok(delay) => {
                timers.schedule(kind, delay);
                Reply::text(format!(
                    "⏳ {} заплановано через {}.",
                    label(kind, true),
                    power::format_duration(delay)
                ))
            }
            Err(e) => Reply::text(format!("⚠️ {}: {e}", kind_word(kind))),
        },
    }
}

async fn immediate(kind: PowerKind) -> Reply {
    let verb = match kind {
        PowerKind::Sleep => power::sleep_now,
        PowerKind::Shutdown => power::shutdown_now,
    };
    match tokio::task::spawn_blocking(verb).await {
        Ok(Ok(())) => Reply::text(match kind {
            PowerKind::Sleep => "😴 Засинаю…",
            PowerKind::Shutdown => "⏻ Вимикаюсь…",
        }),
        Ok(Err(e)) => Reply::text(format!("⚠️ {}: {e}", kind_word(kind))),
        Err(e) => Reply::text(format!("⚠️ {}: task join: {e}", kind_word(kind))),
    }
}

fn label(kind: PowerKind, caps: bool) -> &'static str {
    match (kind, caps) {
        (PowerKind::Sleep, true) => "Sleep",
        (PowerKind::Sleep, false) => "sleep",
        (PowerKind::Shutdown, true) => "Shutdown",
        (PowerKind::Shutdown, false) => "shutdown",
    }
}

fn kind_word(kind: PowerKind) -> &'static str {
    match kind {
        PowerKind::Sleep => "sleep",
        PowerKind::Shutdown => "shutdown",
    }
}

// -------------------- /dashboard --------------------

/// Cockpit view over the key live signals in Stash. Read-only snapshot
/// so re-tapping the Refresh button is always safe.
pub struct DashboardCmd {
    telegram: Arc<TelegramState>,
}

impl DashboardCmd {
    pub fn new(telegram: Arc<TelegramState>) -> Self {
        Self { telegram }
    }
}

#[async_trait]
impl CommandHandler for DashboardCmd {
    fn name(&self) -> &'static str {
        "dashboard"
    }
    fn description(&self) -> &'static str {
        "Cockpit: battery + pomodoro + clip + reminders одним екраном"
    }
    fn usage(&self) -> &'static str {
        "/dashboard"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        // Dashboard is paginated: args="page=2" / "page=3" flip between
        // layouts without rebuilding the snapshot text. Anything else
        // (or empty) falls through to page 1.
        let page = parse_dashboard_page(args);
        let text = build_dashboard_text(&ctx, &self.telegram);
        Reply {
            text,
            keyboard: Some(dashboard_keyboard(page)),
            ..Default::default()
        }
    }
}

fn parse_dashboard_page(args: &str) -> u8 {
    args.trim()
        .strip_prefix("page=")
        .and_then(|s| s.parse::<u8>().ok())
        .map(|n| n.clamp(1, DASHBOARD_PAGES))
        .unwrap_or(1)
}

fn build_dashboard_text(ctx: &Ctx, telegram: &Arc<TelegramState>) -> String {
    let battery = match read_battery() {
        BatterySnapshot::Present { percent, charging } => {
            let icon = if charging { "🔌" } else { "🔋" };
            let suffix = if charging { "⚡" } else { "" };
            format!("{icon} {percent}%{suffix}")
        }
        BatterySnapshot::NoBattery => "🔌 AC".to_string(),
        BatterySnapshot::Unknown => "🔋 —".to_string(),
    };
    let pomodoro = ctx
        .app
        .try_state::<Arc<PomodoroState>>()
        .map(|s| format_pomodoro_status(s.inner()))
        .unwrap_or_else(|| "🍅 —".to_string());
    let clip = ctx
        .app
        .try_state::<Arc<ClipboardState>>()
        .and_then(|s| s.repo.lock().ok().and_then(|r| r.list(1).ok()))
        .map(|v| match v.first() {
            None => "📋 порожньо".to_string(),
            Some(it) if it.kind == "text" => {
                let preview: String = it.content.chars().take(40).collect();
                let preview = preview.replace('\n', " ");
                let suffix = if it.content.chars().count() > 40 { "…" } else { "" };
                format!("📋 \"{preview}{suffix}\"")
            }
            Some(it) => format!("📋 [{}]", it.kind),
        })
        .unwrap_or_else(|| "📋 —".to_string());
    let reminders = {
        let now = now_secs();
        match telegram.repo.lock() {
            Ok(r) => match r.list_active_reminders() {
                Ok(items) if items.is_empty() => "⏰ немає".to_string(),
                Ok(items) => items
                    .iter()
                    .min_by_key(|r| r.due_at)
                    .map(|r| {
                        let delta = (r.due_at - now).max(0);
                        let when = if delta < 60 {
                            "<1хв".to_string()
                        } else if delta < 3600 {
                            format!("{}хв", delta / 60)
                        } else if delta < 86_400 {
                            format!("{}г", delta / 3600)
                        } else {
                            format!("{}дн", delta / 86_400)
                        };
                        let label: String = r.text.chars().take(30).collect();
                        format!("⏰ {} активних · next {} — {}", items.len(), when, label)
                    })
                    .unwrap_or_else(|| format!("⏰ {} активних", items.len())),
                Err(e) => format!("⏰ ⚠️ {e}"),
            },
            Err(e) => format!("⏰ ⚠️ {e}"),
        }
    };
    format!("🧭 *Stash cockpit*\n\n{battery}\n{pomodoro}\n{clip}\n{reminders}")
}

const DASHBOARD_PAGES: u8 = 3;

fn dashboard_keyboard(page: u8) -> InlineKeyboard {
    let mut rows: Vec<Vec<InlineButton>> = match page {
        // Page 1 — primary actions that run a command inline.
        1 => vec![
            vec![
                InlineButton::new("🍅 Pomodoro", "pomodoro"),
                InlineButton::new("🥁 Metronome", "metronome"),
                InlineButton::new("🎵 Music", "music"),
            ],
            vec![
                InlineButton::new("🔋 Battery", "battery"),
                InlineButton::new("📋 Clip", "clip"),
                InlineButton::new("⏰ Reminders", "reminders"),
            ],
        ],
        // Page 2 — more commands + quick power/capture actions.
        2 => vec![
            vec![
                InlineButton::new("📝 Notes", "notes"),
                InlineButton::new("🧠 Memory", "memory"),
                InlineButton::new("📸 Shot", "screenshot"),
            ],
            vec![
                InlineButton::new("💤 Sleep", "sleep"),
                InlineButton::new("🌙 Display off", "display"),
                InlineButton::new("❓ Help", "help"),
            ],
        ],
        // Page 3 — jump to any of the 13 app tabs.
        _ => vec![
            vec![
                InlineButton::new("📋 Clipboard", "navigate:clipboard"),
                InlineButton::new("🌍 Translator", "navigate:translator"),
                InlineButton::new("📝 Notes", "navigate:notes"),
            ],
            vec![
                InlineButton::new("🤖 AI", "navigate:ai"),
                InlineButton::new("✉️ Telegram", "navigate:telegram"),
                InlineButton::new("🥁 Metronome", "navigate:metronome"),
            ],
            vec![
                InlineButton::new("🎵 Music", "navigate:music"),
                InlineButton::new("⬇️ Downloads", "navigate:downloads"),
                InlineButton::new("🍅 Pomodoro", "navigate:pomodoro"),
            ],
            vec![
                InlineButton::new("💻 Terminal", "navigate:terminal"),
                InlineButton::new("🌐 Web", "navigate:web"),
                InlineButton::new("⚙️ System", "navigate:system"),
            ],
            vec![InlineButton::new("🎙 Voice", "navigate:voice")],
        ],
    };
    // Footer row is shared: Refresh self + paginate. Arrows wrap around
    // so you can tap Next on the last page and land on page 1.
    let prev_page = if page == 1 { DASHBOARD_PAGES } else { page - 1 };
    let next_page = if page == DASHBOARD_PAGES { 1 } else { page + 1 };
    rows.push(vec![
        InlineButton::new("◀", format!("refresh:dashboard:page={prev_page}")),
        InlineButton::new(
            format!("{page}/{DASHBOARD_PAGES} 🔄"),
            format!("refresh:dashboard:page={page}"),
        ),
        InlineButton::new("▶", format!("refresh:dashboard:page={next_page}")),
    ]);
    InlineKeyboard { rows }
}
