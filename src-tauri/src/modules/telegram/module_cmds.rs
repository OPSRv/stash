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
                let status = if charging {
                    "заряджається"
                } else {
                    "від батареї"
                };
                // Below 20% + not plugged in → offer a quick sleep action.
                let low = percent < 20 && !charging;
                let mut rows = Vec::new();
                if low {
                    rows.push(vec![
                        InlineButton::new("💤 Sleep Mac", "sleep:ask"),
                        InlineButton::new("☕ Keep awake off", "keepawake:off"),
                    ]);
                }
                rows.push(super::menu::nav_row("refresh:battery"));
                Reply {
                    text: format!("{icon} {percent}% — {status}"),
                    keyboard: Some(InlineKeyboard { rows }),
                    ..Default::default()
                }
            }
            BatterySnapshot::NoBattery => Reply {
                text: "🔌 У цього Mac немає батареї (desktop / під'єднано до мережі).".into(),
                keyboard: Some(super::menu::nav_keyboard("refresh:battery")),
                ..Default::default()
            },
            BatterySnapshot::Unknown => Reply {
                text: "🪫 Не вдалося отримати дані про батарею.".into(),
                keyboard: Some(super::menu::nav_keyboard("refresh:battery")),
                ..Default::default()
            },
        }
    }
}

// -------------------- /ocr --------------------

pub struct OcrCmd;

#[async_trait]
impl CommandHandler for OcrCmd {
    fn name(&self) -> &'static str {
        "ocr"
    }
    fn description(&self) -> &'static str {
        "Розпізнати текст із зображення (Apple Vision). Без аргументу — захопити область екрана"
    }
    fn usage(&self) -> &'static str {
        "/ocr [шлях до зображення]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let arg = args.trim();
        let result = if arg.is_empty() {
            // No path → interactive region capture on the Mac, then OCR.
            let app = ctx.app.clone();
            tokio::task::spawn_blocking(move || {
                crate::modules::canvas::capture::capture_and_ocr(&app)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .map(|opt| opt.unwrap_or_default())
        } else {
            crate::modules::canvas::capture::ocr_file(std::path::Path::new(arg))
        };
        match result {
            Ok(text) if !text.trim().is_empty() => Reply::text(text),
            Ok(_) => Reply::text("🔍 Текст не знайдено."),
            Err(e) => Reply::text(format!("⚠️ OCR не вдалося: {e}")),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BatterySnapshot {
    Present {
        percent: u32,
        charging: bool,
    },
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
        "Історія буфера обміну з кнопками; /clip N — повний запис №N (1 = найновіший)"
    }
    fn usage(&self) -> &'static str {
        "/clip [N | page N]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let trimmed = args.trim();
        let n = match parse_clip_args(trimmed) {
            ClipAction::Page(page) => return render_clip_page(&self.state, page, None),
            ClipAction::Copy(id, page) => {
                let status = clip_copy_to_mac(&ctx.app, id)
                    .map(|()| "✅ Скопійовано на Mac.".to_string())
                    .unwrap_or_else(|e| format!("⚠️ {e}"));
                return render_clip_page(&self.state, page, Some(status));
            }
            ClipAction::Pin(id, page) => {
                let status = self
                    .state
                    .repo
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|mut r| {
                        r.toggle_pin(id).map_err(|e| e.to_string())?;
                        r.get(id).map_err(|e| e.to_string())
                    });
                let status = match status {
                    Ok(Some(it)) if it.pinned => "📌 Закріплено.".to_string(),
                    Ok(Some(_)) => "📍 Відкріплено.".to_string(),
                    Ok(None) => "❓ Запис не знайдено.".to_string(),
                    Err(e) => format!("⚠️ {e}"),
                };
                return render_clip_page(&self.state, page, Some(status));
            }
            // Subcommand: `restore N` — push item N back onto the system
            // clipboard. Only text items for now (image restoration needs
            // the full paste pipeline).
            ClipAction::Restore(n) => {
                return match clip_restore_text(&self.state, n) {
                    Ok(preview) => Reply::text(format!("📋 Скопійовано №{n}: {preview}")),
                    Err(e) => Reply::text(format!("⚠️ {e}")),
                };
            }
            ClipAction::Item(n) => n,
        };
        let items = match self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())
            // One extra row so we know whether a "Next" exists.
            .and_then(|repo| repo.list(n + 1).map_err(|e| e.to_string()))
        {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ помилка буфера: {e}")),
        };
        let total = items.len();
        match items.get(n - 1) {
            Some(item) if item.kind == "text" => {
                let content = truncate_preview(&item.content, 3_500);
                let mut row: Vec<InlineButton> =
                    vec![InlineButton::new("📋 Re-copy", format!("clip:restore {n}"))];
                if total > n {
                    row.push(InlineButton::new("⏭ Next", format!("refresh:clip:{}", n + 1)));
                }
                if n > 1 {
                    row.insert(
                        0,
                        InlineButton::new("⏮ Prev", format!("refresh:clip:{}", n - 1)),
                    );
                }
                let page = (n - 1) / CLIP_PAGE_SIZE + 1;
                Reply {
                    text: content,
                    keyboard: Some(InlineKeyboard {
                        rows: vec![
                            row,
                            vec![InlineButton::new(
                                "📋 Список",
                                format!("refresh:clip:page:{page}"),
                            )],
                        ],
                    }),
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
    let suffix = if item.content.chars().count() > 60 {
        "…"
    } else {
        ""
    };
    Ok(format!("\"{preview}{suffix}\""))
}

fn truncate_preview(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

/// Items per page in the `/clip` history card.
const CLIP_PAGE_SIZE: usize = 5;

#[derive(Debug, PartialEq, Eq)]
enum ClipAction {
    /// History card, 1-based page.
    Page(usize),
    /// Full view of the Nth newest item (legacy `/clip N`).
    Item(usize),
    /// Re-copy the Nth newest text item (legacy `/clip restore N`).
    Restore(usize),
    /// Copy item `id` back onto the Mac clipboard, then re-render `page`.
    Copy(i64, usize),
    /// Toggle the pin on item `id`, then re-render `page`.
    Pin(i64, usize),
}

/// `/clip` args — typed (`page 2`, `copy 41 1`) and button
/// (`page:2`, `copy:41:1`) forms share one tokenizer.
fn parse_clip_args(args: &str) -> ClipAction {
    let toks: Vec<&str> = args
        .split([':', ' '])
        .filter(|t| !t.is_empty())
        .collect();
    let num = |i: usize| toks.get(i).and_then(|t| t.parse::<usize>().ok());
    let id = |i: usize| toks.get(i).and_then(|t| t.parse::<i64>().ok());
    match toks.first().map(|t| t.to_ascii_lowercase()).as_deref() {
        None => ClipAction::Page(1),
        Some("page" | "p") => ClipAction::Page(num(1).unwrap_or(1).max(1)),
        Some("restore") => ClipAction::Restore(num(1).unwrap_or(1).max(1)),
        Some("copy") => match id(1) {
            Some(i) => ClipAction::Copy(i, num(2).unwrap_or(1).max(1)),
            None => ClipAction::Page(1),
        },
        Some("pin") => match id(1) {
            Some(i) => ClipAction::Pin(i, num(2).unwrap_or(1).max(1)),
            None => ClipAction::Page(1),
        },
        Some(other) => match other.parse::<usize>() {
            Ok(n) => ClipAction::Item(n.max(1)),
            Err(_) => ClipAction::Page(1),
        },
    }
}

/// Copy a history row (text / image / files) back onto the Mac clipboard
/// through the same path the Clipboard tab uses.
pub(crate) fn clip_copy_to_mac(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = app
        .try_state::<Arc<ClipboardState>>()
        .ok_or_else(|| "clipboard state not initialised".to_string())?;
    crate::modules::clipboard::commands::clipboard_copy_only(state, id)
}

fn clip_line(item: &crate::modules::clipboard::repo::ClipboardItem) -> String {
    let pin = if item.pinned { "📌 " } else { "" };
    let body = match item.kind.as_str() {
        "text" => truncate_preview(&item.content.trim().replace('\n', " "), 80),
        "image" => "🖼 зображення".to_string(),
        "file" => format!("📎 {}", truncate_preview(&item.content, 60)),
        other => format!("[{other}]"),
    };
    format!("{pin}{body}")
}

/// Paged history card: numbered items, per-item "copy to Mac" + pin
/// buttons, and ⬅️/➡️ paging that edits the card in place.
fn render_clip_page(state: &Arc<ClipboardState>, page: usize, status: Option<String>) -> Reply {
    let page = page.max(1);
    let skip = (page - 1) * CLIP_PAGE_SIZE;
    let items = match state
        .repo
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|r| r.list(skip + CLIP_PAGE_SIZE + 1).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => return Reply::text(format!("⚠️ помилка буфера: {e}")),
    };
    let has_next = items.len() > skip + CLIP_PAGE_SIZE;
    let slice: Vec<_> = items.iter().skip(skip).take(CLIP_PAGE_SIZE).collect();
    let mut text = status.map(|s| format!("{s}\n\n")).unwrap_or_default();
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    if slice.is_empty() {
        text.push_str("📭 Буфер обміну порожній.");
    } else {
        text.push_str(&format!("📋 Буфер обміну · сторінка {page}\n"));
        for (i, item) in slice.iter().enumerate() {
            let n = skip + i + 1;
            text.push_str(&format!("{n}. {}\n", clip_line(item)));
            rows.push(vec![
                InlineButton::new(format!("📋 {n} на Mac"), clip_cb("copy", item.id, page)),
                InlineButton::new(
                    if item.pinned {
                        format!("📍 {n} відкріпити")
                    } else {
                        format!("📌 {n}")
                    },
                    clip_cb("pin", item.id, page),
                ),
            ]);
        }
        text.push_str("\n/clip N — повний текст запису №N");
    }
    let mut nav = Vec::new();
    if page > 1 {
        nav.push(InlineButton::new("⬅️", format!("refresh:clip:page:{}", page - 1)));
    }
    nav.push(InlineButton::new("🔄", format!("refresh:clip:page:{page}")));
    if has_next {
        nav.push(InlineButton::new("➡️", format!("refresh:clip:page:{}", page + 1)));
    }
    nav.push(super::menu::menu_button());
    rows.push(nav);
    Reply {
        text: text.trim_end().to_string(),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

fn clip_cb(verb: &str, id: i64, page: usize) -> String {
    format!("refresh:clip:{verb}:{id}:{page}")
}

#[cfg(test)]
mod clip_notes_tests {
    use super::*;

    #[test]
    fn clip_args_cover_typed_and_button_forms() {
        assert_eq!(parse_clip_args(""), ClipAction::Page(1));
        assert_eq!(parse_clip_args("page:3"), ClipAction::Page(3));
        assert_eq!(parse_clip_args("page 0"), ClipAction::Page(1));
        assert_eq!(parse_clip_args("2"), ClipAction::Item(2));
        assert_eq!(parse_clip_args("restore 4"), ClipAction::Restore(4));
        assert_eq!(parse_clip_args("copy:41:2"), ClipAction::Copy(41, 2));
        assert_eq!(parse_clip_args("pin 41"), ClipAction::Pin(41, 1));
        assert_eq!(parse_clip_args("copy:abc"), ClipAction::Page(1));
        assert_eq!(parse_clip_args("whatever"), ClipAction::Page(1));
    }

    #[test]
    fn memory_args_split_ask_from_delete() {
        assert_eq!(parse_memory_args(""), MemoryAction::List);
        assert_eq!(parse_memory_args("ask:5"), MemoryAction::Ask(5));
        assert_eq!(parse_memory_args("del:5"), MemoryAction::Delete(5));
        assert_eq!(parse_memory_args("del 5"), MemoryAction::Delete(5));
        assert_eq!(parse_memory_args("del"), MemoryAction::List);
        let card = memory_confirm_card(i64::MAX, "x");
        let kb = card.keyboard.unwrap();
        assert_eq!(kb.rows[0][0].callback_data, format!("refresh:memory:del:{}", i64::MAX));
        assert!(memory_ask_cb(i64::MAX).len() <= 64);
    }

    #[test]
    fn power_buttons_need_a_second_tap() {
        for kind in [PowerKind::Sleep, PowerKind::Shutdown] {
            let kb = power_confirm_card(kind).keyboard.unwrap();
            let cbs: Vec<_> = kb.rows.iter().flatten().map(|b| b.callback_data.as_str()).collect();
            let w = kind_word(kind);
            assert_eq!(cbs, vec![format!("refresh:{w}:now"), format!("refresh:{w}:no")]);
        }
    }

    #[test]
    fn app_open_card_quit_goes_through_confirm() {
        let r = app_reply("x".into(), &[("🛑 Закрити", "quitask", "Safari")]);
        assert_eq!(r.keyboard.unwrap().rows[0][0].callback_data, "refresh:app:quitask Safari");
    }

    #[test]
    fn notes_args_cover_typed_and_button_forms() {
        assert_eq!(parse_notes_args(""), NotesAction::Page(1));
        assert_eq!(parse_notes_args("page:2"), NotesAction::Page(2));
        assert_eq!(parse_notes_args("open:7"), NotesAction::Open(7));
        assert_eq!(parse_notes_args("open 7"), NotesAction::Open(7));
        assert_eq!(parse_notes_args("7"), NotesAction::Open(7));
        assert_eq!(parse_notes_args("del:7"), NotesAction::AskDelete(7));
        assert_eq!(parse_notes_args("delok:7"), NotesAction::Delete(7));
        assert_eq!(parse_notes_args("undo:7"), NotesAction::AskDelete(7));
        assert_eq!(parse_notes_args("pin:7"), NotesAction::Pin(7));
        // A destructive verb without an id never deletes anything.
        assert_eq!(parse_notes_args("delok"), NotesAction::Page(1));
    }

    #[test]
    fn clip_notes_app_callbacks_fit_telegram_limit() {
        let big = i64::MAX;
        for cb in [
            clip_cb("copy", big, 9_999),
            clip_cb("pin", big, 9_999),
            notes_cb("delok", big),
            notes_cb("undo", big),
            format!("refresh:memory:del:{big}"),
            format!("refresh:clip:page:{}", usize::MAX),
        ] {
            assert!(cb.len() <= 64, "{cb} is {} bytes", cb.len());
        }
        assert!(app_cb("quit", &"x".repeat(80)).is_none());
        let r = app_reply("t".into(), &[("🛑", "quit", &"Ж".repeat(26))]);
        assert!(r.keyboard.is_none(), "over-long refresh payload must be dropped");
    }
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
                        rows: vec![
                            vec![
                                InlineButton::new("📝 Відкрити", notes_cb("open", id)),
                                InlineButton::new("🗑 Undo", notes_cb("undo", id)),
                            ],
                            vec![InlineButton::new("📚 Усі нотатки", "notes")],
                        ],
                    }),
                    ..Default::default()
                }
            }
            Err(e) => Reply::text(format!("⚠️ помилка нотаток: {e}")),
        }
    }
}

// -------------------- /send --------------------

/// `/send <text>` — push the text verbatim into the paired chat.
/// From the CLI (`stash send "…"`) this is how scripts / Claude Code
/// deliver a notification to the user's phone.
pub struct SendCmd {
    state: Arc<TelegramState>,
}

impl SendCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for SendCmd {
    fn name(&self) -> &'static str {
        "send"
    }
    fn description(&self) -> &'static str {
        "Надіслати текст у спарений Telegram-чат"
    }
    fn usage(&self) -> &'static str {
        "/send <текст>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        if args.trim().is_empty() {
            return Reply::text("✍️ Використання: /send <текст>");
        }
        if self.state.send_to_paired(args) {
            Reply::text("📨 Надіслано в Telegram.")
        } else {
            Reply::text("⚠️ Telegram не спарено — відкрий Settings → Telegram.")
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
        "Останні нотатки з кнопками (newest first); /notes open <id> — відкрити"
    }
    fn usage(&self) -> &'static str {
        "/notes [page N | open <id>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        match parse_notes_args(args) {
            NotesAction::Page(page) => render_notes_page(&self.repo, page, None),
            NotesAction::Open(id) => render_note_card(&self.repo, id, false),
            NotesAction::AskDelete(id) => render_note_card(&self.repo, id, true),
            NotesAction::Delete(id) => {
                let status = match delete_note(Some(&ctx.app), &self.repo, id) {
                    Ok(true) => format!("🗑 Нотатку №{id} видалено."),
                    Ok(false) => format!("❓ Нотатки №{id} немає."),
                    Err(e) => format!("⚠️ помилка нотаток: {e}"),
                };
                render_notes_page(&self.repo, 1, Some(status))
            }
            NotesAction::Pin(id) => {
                let result = self.repo.lock().map_err(|e| e.to_string()).and_then(|mut r| {
                    let note = r.get(id).map_err(|e| e.to_string())?;
                    match note {
                        Some(n) => r.set_pinned(id, !n.pinned).map_err(|e| e.to_string()),
                        None => Err(format!("нотатки №{id} немає")),
                    }
                });
                match result {
                    Ok(()) => {
                        let _ = ctx.app.emit("notes:changed", id);
                        render_note_card(&self.repo, id, false)
                    }
                    Err(e) => Reply::text(format!("⚠️ {e}")),
                }
            }
        }
    }
}

/// Notes per page in the `/notes` list card.
const NOTES_PAGE_SIZE: usize = 8;
/// Telegram caps a message at 4096 chars; leave room for the header.
const NOTE_BODY_MAX_CHARS: usize = 3_500;

#[derive(Debug, PartialEq, Eq)]
enum NotesAction {
    Page(usize),
    Open(i64),
    /// First tap on 🗑 — the card asks for confirmation in place.
    AskDelete(i64),
    /// Second tap — actually delete.
    Delete(i64),
    Pin(i64),
}

fn parse_notes_args(args: &str) -> NotesAction {
    let toks: Vec<&str> = args
        .split([':', ' '])
        .filter(|t| !t.is_empty())
        .collect();
    let id = toks.get(1).and_then(|t| t.parse::<i64>().ok());
    let verb = toks.first().map(|t| t.to_ascii_lowercase());
    match (verb.as_deref(), id) {
        (Some("open"), Some(i)) => NotesAction::Open(i),
        (Some("del"), Some(i)) => NotesAction::AskDelete(i),
        (Some("delok"), Some(i)) => NotesAction::Delete(i),
        // "🗑 Undo" under a saved `/note` never expires, so it goes
        // through the same two-tap confirm as 🗑.
        (Some("undo"), Some(i)) => NotesAction::AskDelete(i),
        (Some("pin"), Some(i)) => NotesAction::Pin(i),
        (Some("page" | "p"), _) => NotesAction::Page(
            toks.get(1)
                .and_then(|t| t.parse::<usize>().ok())
                .unwrap_or(1)
                .max(1),
        ),
        // Bare number → open that note, mirroring `/clip N`.
        (Some(v), None) if v.parse::<i64>().is_ok() => NotesAction::Open(v.parse().unwrap()),
        _ => NotesAction::Page(1),
    }
}

fn notes_cb(verb: &str, id: i64) -> String {
    format!("refresh:notes:{verb}:{id}")
}

/// Delete a note with the same file cleanup the Notes tab does (audio +
/// attachments) when the app handle is available; falls back to a bare
/// row delete otherwise. Returns `Ok(false)` when the note doesn't exist.
pub(crate) fn delete_note(
    app: Option<&tauri::AppHandle>,
    repo: &Arc<Mutex<NotesRepo>>,
    id: i64,
) -> Result<bool, String> {
    let exists = repo
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .map_err(|e| e.to_string())?
        .is_some();
    if !exists {
        return Ok(false);
    }
    let notes_state =
        app.and_then(|a| a.try_state::<crate::modules::notes::commands::NotesState>());
    match (app, notes_state) {
        (Some(a), Some(st)) => crate::modules::notes::commands::notes_delete(a.clone(), st, id)?,
        _ => repo
            .lock()
            .map_err(|e| e.to_string())?
            .delete(id)
            .map_err(|e| e.to_string())?,
    }
    if let Some(a) = app {
        let _ = a.emit("notes:changed", id);
    }
    Ok(true)
}

fn render_notes_page(repo: &Arc<Mutex<NotesRepo>>, page: usize, status: Option<String>) -> Reply {
    let summaries = match repo.lock() {
        Ok(r) => match r.list_summaries(crate::modules::notes::repo::FolderFilter::All) {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
        },
        Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
    };
    let mut out = status.map(|s| format!("{s}\n\n")).unwrap_or_default();
    if summaries.is_empty() {
        out.push_str("📭 Нотаток ще немає. Додай `/note <текст>`.");
        return Reply {
            text: out,
            keyboard: Some(InlineKeyboard {
                rows: vec![vec![super::menu::menu_button()]],
            }),
            ..Default::default()
        };
    }
    let pages = summaries.len().div_ceil(NOTES_PAGE_SIZE);
    let page = page.clamp(1, pages);
    let skip = (page - 1) * NOTES_PAGE_SIZE;
    out.push_str(&format!("📝 Нотатки · {page}/{pages}:\n"));
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    for s in summaries.iter().skip(skip).take(NOTES_PAGE_SIZE) {
        let preview = s.preview.trim().replace('\n', " ");
        let preview_short: String = preview.chars().take(60).collect();
        let pin = if s.pinned { "📌 " } else { "" };
        out.push_str(&format!(
            "• {pin}№{} — {}\n",
            s.id,
            if preview_short.is_empty() {
                s.title.clone()
            } else {
                format!("{} · {}", s.title, preview_short)
            }
        ));
        rows.push(vec![InlineButton::new(
            format!("{pin}№{} {}", s.id, truncate_preview(s.title.trim(), 28)),
            notes_cb("open", s.id),
        )]);
    }
    let mut nav = Vec::new();
    if page > 1 {
        nav.push(InlineButton::new("⬅️", format!("refresh:notes:page:{}", page - 1)));
    }
    if page < pages {
        nav.push(InlineButton::new("➡️", format!("refresh:notes:page:{}", page + 1)));
    }
    nav.push(super::menu::menu_button());
    rows.push(nav);
    Reply {
        text: out.trim_end().to_string(),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

/// Full note view. `confirm_delete` swaps the action row for a
/// second-tap confirmation so a stray tap never deletes anything.
fn render_note_card(repo: &Arc<Mutex<NotesRepo>>, id: i64, confirm_delete: bool) -> Reply {
    let note = match repo.lock().map_err(|e| e.to_string()).and_then(|r| r.get(id).map_err(|e| e.to_string())) {
        Ok(Some(n)) => n,
        Ok(None) => return render_notes_page(repo, 1, Some(format!("❓ Нотатки №{id} немає."))),
        Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
    };
    let pin = if note.pinned { "📌 " } else { "" };
    let body = note.body.trim();
    let mut text = format!("{pin}📝 №{} · {}\n\n", note.id, note.title.trim());
    if body.is_empty() {
        text.push_str("(порожня нотатка)");
    } else {
        text.push_str(&truncate_preview(body, NOTE_BODY_MAX_CHARS));
        if body.chars().count() > NOTE_BODY_MAX_CHARS {
            text.push_str("\n\n✂️ Обрізано — повний текст у Stash → Notes.");
        }
    }
    let rows = if confirm_delete {
        text.push_str("\n\n⚠️ Видалити цю нотатку? Натисни ще раз, щоб підтвердити.");
        vec![vec![
            InlineButton::new("🗑 Так, видалити", notes_cb("delok", id)),
            InlineButton::new("↩️ Ні", notes_cb("open", id)),
        ]]
    } else {
        vec![
            vec![
                InlineButton::new(
                    if note.pinned { "📍 Відкріпити" } else { "📌 Закріпити" },
                    notes_cb("pin", id),
                ),
                InlineButton::new("🗑 Видалити", notes_cb("del", id)),
            ],
            vec![InlineButton::new("⬅️ Назад", "refresh:notes:page:1")],
        ]
    };
    Reply {
        text,
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
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
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
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
                // Live-refresh the Reminders tab so a row created from
                // Telegram appears without remounting the popup.
                {
                    use tauri::Emitter;
                    let _ = ctx.app.emit("reminders:changed", ());
                }
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
                let state = Arc::clone(&self.state);
                let mirror = tokio::task::spawn_blocking(move || {
                    reminders::ext_mirror_create_blocking(&state, id, &title, due)
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
                        rows: vec![vec![
                            InlineButton::new("✖ Скасувати", reminders::cancel_cb(id)),
                            InlineButton::new("⏰ Усі", "reminders"),
                        ]],
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
        "Список активних нагадувань з кнопками скасування / відкладення"
    }
    fn usage(&self) -> &'static str {
        "/reminders [cancel <id> | snooze <id> <10m|1h|tomorrow> | done <id>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        // Card rendering + button actions live in `reminders.rs`.
        reminders::handle_command(&ctx.app, &self.state, args)
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
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let Ok(id): Result<i64, _> = args.trim().parse() else {
            return Reply::text("✍️ Використання: /forget <id> (дивись /reminders)");
        };
        let result = {
            let mut repo = match self.state.repo.lock() {
                Ok(r) => r,
                Err(e) => return Reply::text(format!("⚠️ помилка нагадувань: {e}")),
            };
            repo.cancel_reminder(id)
        };
        match result {
            Ok(true) => {
                use tauri::Emitter;
                reminders::ext_sync_cancel(&self.state, id);
                let _ = ctx.app.emit("reminders:changed", ());
                Reply {
                    text: format!("🗑️ Скасовано нагадування №{id}."),
                    keyboard: Some(InlineKeyboard {
                        rows: vec![vec![InlineButton::new("⏰ Список", "reminders")]],
                    }),
                    ..Default::default()
                }
            }
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
        let action = match parse_volume_action(args) {
            Ok(a) => a,
            Err(other) => {
                return Reply::text(format!(
                    "✍️ Usage: /volume [N | +N | -N | up | down | mute | unmute | toggle]. Got: {other}"
                ));
            }
        };
        let snap = apply_volume(action);
        Reply {
            text: format_volume(&snap),
            keyboard: Some(volume_keyboard(snap.muted)),
            ..Default::default()
        }
    }
}

/// `N` sets the level; signed `+N` / `-N` nudge relative to the current
/// level (so the card's −1/+1 buttons and typed args share one grammar).
fn parse_volume_action(args: &str) -> Result<VolumeAction, String> {
    let raw = args.trim().to_lowercase();
    Ok(match raw.as_str() {
        "" | "status" => VolumeAction::Status,
        "up" | "+" => VolumeAction::Step(10),
        "down" | "-" => VolumeAction::Step(-10),
        "mute" => VolumeAction::Mute(true),
        "unmute" => VolumeAction::Mute(false),
        "toggle" | "togglemute" => VolumeAction::ToggleMute,
        other if other.starts_with('+') || other.starts_with('-') => match other.parse::<i32>() {
            Ok(n) => VolumeAction::Step(n.clamp(-100, 100)),
            Err(_) => return Err(other.to_string()),
        },
        other => match other.parse::<i32>() {
            Ok(n) => VolumeAction::Set(n.clamp(0, 100) as u32),
            Err(_) => return Err(other.to_string()),
        },
    })
}

#[derive(Debug, Clone, Copy)]
enum VolumeAction {
    Status,
    Set(u32),
    Step(i32),
    Mute(bool),
    ToggleMute,
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
        VolumeAction::Mute(_) | VolumeAction::ToggleMute => None,
    };
    if let Some(t) = target {
        if let Err(e) = set_volume_percent(t) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    let mute_target = match action {
        VolumeAction::Mute(on) => Some(on),
        VolumeAction::ToggleMute => Some(!current.muted),
        _ => None,
    };
    if let Some(on) = mute_target {
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
    let mute_str = osascript_output("output muted of (get volume settings)").unwrap_or_default();
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

/// Live volume card — every button is `refresh:` so the level line updates
/// in place. The 🎵 button swaps this card for the player card.
fn volume_keyboard(muted: bool) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:volume:{args}"));
    InlineKeyboard {
        rows: vec![
            vec![
                b("−10", "-10"),
                b("−1", "-1"),
                if muted { b("🔊", "unmute") } else { b("🔇", "mute") },
                b("+1", "+1"),
                b("+10", "+10"),
            ],
            vec![
                InlineButton::new("🎵 Плеєр", "refresh:music"),
                b("🔄", "status"),
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
        "/music [play|pause|toggle|next|prev|volup|voldown|open]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_lowercase();
        match sub.as_str() {
            "" | "status" => music_card(&ctx.app, None),
            "volup" | "vol+" | "volumeup" => {
                let snap = apply_volume(VolumeAction::Step(10));
                music_card(&ctx.app, snap.error.as_deref().map(|e| format!("⚠️ {e}")))
            }
            "voldown" | "vol-" | "volumedown" => {
                let snap = apply_volume(VolumeAction::Step(-10));
                music_card(&ctx.app, snap.error.as_deref().map(|e| format!("⚠️ {e}")))
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
            "play" | "pause" | "toggle" => {
                run_music_action(
                    &ctx,
                    crate::modules::music::commands::music_play_pause,
                    "⏯️",
                    "перемкнуто",
                )
                .await
            }
            "next" => {
                run_music_action(
                    &ctx,
                    crate::modules::music::commands::music_next,
                    "⏭️",
                    "далі",
                )
                .await
            }
            "prev" => {
                run_music_action(
                    &ctx,
                    crate::modules::music::commands::music_prev,
                    "⏮️",
                    "назад",
                )
                .await
            }
            _ => Reply::text(format!(
                "✍️ Використання: {}. Отримано: {sub}",
                self.usage()
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
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
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
            text: "📻 Плеєр не встиг відкритись. Спробуй ще раз за пару секунд.".into(),
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

/// Mirror of the `⌘⇧J` shortcut for Notes: show the popup, focus it,
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
        rows: vec![vec![InlineButton::new("📻 Відкрити Music", "refresh:music:open")]],
    }
}

/// Player card: now-playing + system volume, with the live keyboard.
fn music_card(app: &tauri::AppHandle, note: Option<String>) -> Reply {
    let mut text = format_now_playing(&read_now_playing(app));
    let vol = read_volume();
    if let Some(p) = vol.percent {
        let icon = if vol.muted { "🔇" } else { "🔊" };
        text.push_str(&format!("\n{icon} {p}% {}", volume_bar(p)));
    }
    if let Some(n) = note {
        text = format!("{n}\n\n{text}");
    }
    Reply {
        text,
        keyboard: Some(music_keyboard()),
        ..Default::default()
    }
}

/// Live player keyboard — `refresh:` so taps edit the card in place.
fn music_keyboard() -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:music:{args}"));
    InlineKeyboard {
        rows: vec![
            vec![b("⏮️", "prev"), b("⏯️", "toggle"), b("⏭️", "next")],
            vec![b("🔉", "voldown"), b("🔊", "volup")],
            vec![b("🔄", "status")],
        ],
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
        assert_eq!(
            footer[0].callback_data,
            format!("refresh:dashboard:page={DASHBOARD_PAGES}")
        );
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
        assert_eq!(
            parse_pmset("Now drawing from 'AC Power'\n"),
            BatterySnapshot::NoBattery
        );
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
            ..Default::default()
        };
        let out = format_metronome_reply(&r);
        assert!(out.contains("140"));
        assert!(out.contains("6/8"));
        assert!(out.contains("старт"));
    }

    #[test]
    fn parse_valeton_collects_patch_bpm_division() {
        let r = parse_valeton_args("patch=12 bpm=120 div=eighth").unwrap();
        assert_eq!(r.patch, Some(12));
        assert_eq!(r.bpm, Some(120));
        assert_eq!(r.division.as_deref(), Some("eighth"));
    }

    #[test]
    fn parse_valeton_block_on_off() {
        let on = parse_valeton_args("amp=on").unwrap();
        assert_eq!(on.block.as_deref(), Some("amp"));
        assert_eq!(on.block_on, Some(true));
        let off = parse_valeton_args("dly=off").unwrap();
        assert_eq!(off.block.as_deref(), Some("dly"));
        assert_eq!(off.block_on, Some(false));
    }

    #[test]
    fn parse_valeton_bare_save() {
        let r = parse_valeton_args("save").unwrap();
        assert_eq!(r.save, Some(true));
    }

    #[test]
    fn parse_valeton_rejects_out_of_range_and_unknown() {
        assert!(parse_valeton_args("patch=200").unwrap_err().contains("0–99"));
        assert!(parse_valeton_args("bpm=999").unwrap_err().contains("40–240"));
        assert!(parse_valeton_args("div=triplet").unwrap_err().contains("div"));
        assert!(parse_valeton_args("amp=maybe").unwrap_err().contains("on|off"));
        assert!(parse_valeton_args("foo=1").unwrap_err().contains("невідомий"));
        // no recognised action at all
        assert!(parse_valeton_args("").unwrap_err().contains("жодної"));
    }

    #[test]
    fn format_valeton_reply_summarises_fields() {
        let r = ValetonRemote {
            patch: Some(7),
            bpm: Some(90),
            block: Some("amp".into()),
            block_on: Some(true),
            save: Some(true),
            ..Default::default()
        };
        let out = format_valeton_reply(&r);
        assert!(out.contains("патч 7"));
        assert!(out.contains("90 BPM"));
        assert!(out.contains("AMP on"));
        assert!(out.contains("збереження"));
    }

    #[test]
    fn resolve_tuning_accepts_canonical_ids() {
        assert_eq!(resolve_tuning("standard-e").as_deref(), Some("standard-e"));
        assert_eq!(resolve_tuning("drop-a").as_deref(), Some("drop-a"));
        // spaces/underscores stand in for dashes
        assert_eq!(resolve_tuning("drop a").as_deref(), Some("drop-a"));
    }

    #[test]
    fn resolve_tuning_parses_free_text() {
        assert_eq!(resolve_tuning("drop d").as_deref(), Some("drop-d"));
        assert_eq!(resolve_tuning("Drop D").as_deref(), Some("drop-d"));
        assert_eq!(resolve_tuning("e standard").as_deref(), Some("standard-e"));
        assert_eq!(resolve_tuning("standard e").as_deref(), Some("standard-e"));
        // flats map onto the sharp-based slugs
        assert_eq!(resolve_tuning("eb standard").as_deref(), Some("standard-dsharp"));
        assert_eq!(resolve_tuning("drop c#").as_deref(), Some("drop-csharp"));
        // tuning= prefix is stripped
        assert_eq!(resolve_tuning("tuning=drop b").as_deref(), Some("drop-b"));
    }

    #[test]
    fn resolve_tuning_defaults_and_rejects() {
        // bare category words fall back to the canonical default of that shape
        assert_eq!(resolve_tuning("drop").as_deref(), Some("drop-d"));
        assert_eq!(resolve_tuning("standard").as_deref(), Some("standard-e"));
        // nothing recognisable
        assert_eq!(resolve_tuning("half step down"), None);
        assert_eq!(resolve_tuning(""), None);
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
    fn known_tabs_cover_every_frontend_module() {
        // Every `id: '…'` declared by a frontend module wired into
        // `registry.ts` (plus Settings, which lives outside src/modules)
        // must be navigable from Telegram / the assistant.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let registry = std::fs::read_to_string(root.join("src/modules/registry.ts"))
            .expect("read registry.ts");
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(root.join("src/modules"))
            .expect("read src/modules")
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("index.tsx"))
            .filter(|p| p.exists())
            .collect();
        files.push(root.join("src/settings/index.tsx"));
        let mut checked = 0;
        for file in files {
            let src = std::fs::read_to_string(&file).unwrap();
            let Some(export) = src
                .split("export const ")
                .nth(1)
                .and_then(|r| r.split(':').next())
                .map(str::trim)
            else {
                continue;
            };
            if !registry.contains(export) {
                continue;
            }
            let Some(id) = src
                .lines()
                .find_map(|l| l.trim().strip_prefix("id: '"))
                .and_then(|r| r.split('\'').next())
            else {
                continue;
            };
            assert!(
                KNOWN_TABS.contains(&id),
                "KNOWN_TABS is missing frontend tab `{id}` ({})",
                file.display()
            );
            checked += 1;
        }
        assert!(checked >= 15, "parsed only {checked} frontend tab ids");
    }

    #[test]
    fn known_tabs_include_valeton_and_pomodoro() {
        // The metronome no longer has its own tab — it lives inside the
        // Valeton editor — so `/metronome` reveals `valeton-editor`.
        assert!(KNOWN_TABS.contains(&"valeton-editor"));
        assert!(KNOWN_TABS.contains(&"pomodoro"));
        assert!(!KNOWN_TABS.contains(&"metronome"));
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
            Ok(id) => Reply {
                text: format!("🧠 Записав. (id {id})"),
                keyboard: Some(InlineKeyboard {
                    rows: vec![vec![
                        InlineButton::new("↩️ Undo", memory_ask_cb(id)),
                        InlineButton::new("🧠 Усі факти", "memory"),
                    ]],
                }),
                ..Default::default()
            },
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
        "/memory [del <id>]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        // Per-fact 🗑 buttons (and the Undo under `/remember`) send
        // `ask:<id>` → confirm card; its ✅ sends `del:<id>`. A typed
        // `/memory del <id>` deletes directly. The card re-renders in
        // place afterwards.
        let mut status = String::new();
        let action = parse_memory_args(args);
        if let MemoryAction::Ask(id) = action {
            let fact = match self.state.repo.lock() {
                Ok(r) => r.memory_list().ok().and_then(|rows| {
                    rows.into_iter().find(|r| r.id == id).map(|r| r.fact)
                }),
                Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
            };
            if let Some(fact) = fact {
                return memory_confirm_card(id, &fact);
            }
            status = format!("🤷 Немає факту з id {id}.\n\n");
        }
        if let MemoryAction::Delete(id) = action {
            let result = match self.state.repo.lock() {
                Ok(mut r) => r.memory_delete(id),
                Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
            };
            status = match result {
                Ok(true) => format!("🧠 Забув факт {id}.\n\n"),
                Ok(false) => format!("🤷 Немає факту з id {id}.\n\n"),
                Err(e) => format!("⚠️ {e}\n\n"),
            };
        }
        let rows = {
            let repo = match self.state.repo.lock() {
                Ok(r) => r,
                Err(e) => return Reply::text(format!("⚠️ репозиторій зайнятий: {e}")),
            };
            repo.memory_list()
        };
        match rows {
            Ok(rows) if rows.is_empty() => Reply {
                text: format!("{status}🗒 Поки що нічого. Почни з `/remember <факт>`."),
                keyboard: Some(InlineKeyboard {
                    rows: vec![vec![super::menu::menu_button()]],
                }),
                ..Default::default()
            },
            Ok(rows) => {
                let body = rows
                    .iter()
                    .map(|r| format!("• {} (id {})", r.fact, r.id))
                    .collect::<Vec<_>>()
                    .join("\n");
                // Two delete buttons per row, capped so a long memory
                // doesn't turn into a wall of buttons.
                let mut kb_rows: Vec<Vec<InlineButton>> = rows
                    .iter()
                    .take(12)
                    .map(|r| {
                        InlineButton::new(
                            format!("🗑 {}", truncate_preview(&r.fact, 18)),
                            memory_ask_cb(r.id),
                        )
                    })
                    .collect::<Vec<_>>()
                    .chunks(2)
                    .map(|c| c.to_vec())
                    .collect();
                kb_rows.push(super::menu::nav_row("refresh:memory"));
                Reply {
                    text: format!("{status}🗒 Факти:\n{body}"),
                    keyboard: Some(InlineKeyboard { rows: kb_rows }),
                    ..Default::default()
                }
            }
            Err(e) => Reply::text(format!("⚠️ {e}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryAction {
    List,
    /// First tap on 🗑 — confirm card.
    Ask(i64),
    /// Confirmed (or typed) delete.
    Delete(i64),
}

fn parse_memory_args(args: &str) -> MemoryAction {
    let toks: Vec<&str> = args.split([':', ' ']).filter(|t| !t.is_empty()).collect();
    let id = toks.get(1).and_then(|t| t.parse::<i64>().ok());
    match (toks.first().copied(), id) {
        (Some("ask"), Some(i)) => MemoryAction::Ask(i),
        (Some("del"), Some(i)) => MemoryAction::Delete(i),
        _ => MemoryAction::List,
    }
}

fn memory_ask_cb(id: i64) -> String {
    format!("refresh:memory:ask:{id}")
}

fn memory_confirm_card(id: i64, fact: &str) -> Reply {
    Reply {
        text: format!(
            "⚠️ Забути факт (id {id})?\n\n«{}»",
            truncate_preview(fact, 300)
        ),
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![
                InlineButton::new("🗑 Так, забути", format!("refresh:memory:del:{id}")),
                InlineButton::new("↩️ Ні", "refresh:memory"),
            ]],
        }),
        ..Default::default()
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
        let caption = format!("📸 Захоплено екранів: {}\n{}", files.len(), paths_block);
        Reply {
            text: caption,
            documents: files,
            keyboard: Some(InlineKeyboard {
                // Plain `menu` (not `refresh:`) — a document message
                // can't be edited into a text card.
                rows: vec![vec![
                    InlineButton::new("📸 Again", "screenshot"),
                    InlineButton::new("📸 Лише головний", "screenshot:main"),
                    InlineButton::new("☰ Меню", "menu"),
                ]],
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
        "Погасити екрани (Mac і фонові задачі працюють далі) або змінити яскравість: `up` / `down`."
    }
    fn usage(&self) -> &'static str {
        "/display [off|up|down]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let text = match args.trim().to_ascii_lowercase().as_str() {
            "" | "off" | "sleep" => match tokio::task::spawn_blocking(power::display_off).await {
                Ok(Ok(())) => "💤 Екрани погашено (Mac працює далі).".to_string(),
                Ok(Err(e)) => format!("⚠️ display: {e}"),
                Err(e) => format!("⚠️ display: task join: {e}"),
            },
            verb @ ("up" | "+" | "brighter" | "down" | "-" | "dimmer") => {
                let up = matches!(verb, "up" | "+" | "brighter");
                let res = tokio::task::spawn_blocking(move || {
                    crate::modules::system::displays::adjust_brightness(up)
                })
                .await;
                match res {
                    Ok(Ok(())) if up => "🔆 Яскравість + (вбудований дисплей).".to_string(),
                    Ok(Ok(())) => "🔅 Яскравість − (вбудований дисплей).".to_string(),
                    Ok(Err(e)) => format!("⚠️ brightness: {e}"),
                    Err(e) => format!("⚠️ brightness: task join: {e}"),
                }
            }
            other => format!("❓ Невідомо: `{other}`. Використання: {}", self.usage()),
        };
        Reply {
            text,
            keyboard: Some(display_keyboard()),
            ..Default::default()
        }
    }
}

fn display_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("🔅", "refresh:display:down"),
            InlineButton::new("🔆", "refresh:display:up"),
            InlineButton::new("💤 Погасити", "refresh:display:off"),
        ]],
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
        let text = self.run(args).await;
        Reply {
            text,
            keyboard: Some(focus_keyboard()),
            ..Default::default()
        }
    }
}

impl FocusCmd {
    async fn run(&self, args: &str) -> String {
        let sub = args.trim().to_ascii_lowercase();
        let verb = sub.as_str();
        let status = tokio::task::spawn_blocking(focus::check)
            .await
            .unwrap_or(focus::FocusCheck::ListFailed("internal: task join".into()));
        if verb.is_empty() || verb == "status" {
            return format_focus_status(&status);
        }
        match &status {
            focus::FocusCheck::Ready => {}
            focus::FocusCheck::CliMissing => {
                return "⚠️ `shortcuts` CLI не знайдено. Потрібен macOS 12+.".into();
            }
            focus::FocusCheck::ShortcutsMissing { .. } => {
                return format!(
                    "⚠️ Не знайдено потрібних ярликів.\n{}",
                    focus::setup_instructions()
                );
            }
            focus::FocusCheck::ListFailed(e) => {
                return format!("⚠️ shortcuts list: {e}");
            }
        }
        match verb {
            "on" | "enable" => match tokio::task::spawn_blocking(focus::enable).await {
                Ok(Ok(())) => "🔕 Focus увімкнено.".into(),
                Ok(Err(e)) => format!("⚠️ {e}"),
                Err(e) => format!("⚠️ task join: {e}"),
            },
            "off" | "disable" => match tokio::task::spawn_blocking(focus::disable).await {
                Ok(Ok(())) => "🔔 Focus вимкнено.".into(),
                Ok(Err(e)) => format!("⚠️ {e}"),
                Err(e) => format!("⚠️ task join: {e}"),
            },
            other => format!(
                "❓ Невідомий підкоманда `{other}`.\nВикористання: {}",
                self.usage()
            ),
        }
    }
}

fn focus_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("🔕 Увімкнути", "refresh:focus:on"),
            InlineButton::new("🔔 Вимкнути", "refresh:focus:off"),
            InlineButton::new("🔄", "refresh:focus:status"),
        ]],
    }
}

fn format_focus_status(s: &focus::FocusCheck) -> String {
    match s {
        focus::FocusCheck::Ready => "🔔 Focus готовий: `/focus on` або `/focus off`.".into(),
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
            format!("⚠️ Відсутнє: {missing}.\n{}", focus::setup_instructions())
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
            arg.clone()
        };
        let for_label = city.clone();
        // Refresh re-asks for the same city when it was typed explicitly
        // and fits in the callback payload; otherwise fall back to the
        // memory-derived default.
        let refresh = if arg.is_empty() {
            "refresh:weather".to_string()
        } else {
            let cb = format!("refresh:weather:{arg}");
            if cb.len() <= 64 {
                cb
            } else {
                "refresh:weather".to_string()
            }
        };
        let text = match weather::fetch_weather(&city).await {
            Ok(body) => format!("🌦 {for_label}\n{body}"),
            Err(e) => format!("⚠️ погода: {e}"),
        };
        Reply {
            text,
            keyboard: Some(super::menu::nav_keyboard(&refresh)),
            ..Default::default()
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
                Ok(Ok(names)) => app_running_reply(&names),
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
                    Ok(Ok(())) => app_reply(format!("🚀 Відкрив: {name}"), &[("👻 Згорнути", "hide", &name), ("🛑 Закрити", "quitask", &name)]),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            // "🛑 Закрити" button → confirm in the same card first, so a
            // stray tap can't kill an app with unsaved work.
            "quitask" => app_reply(
                format!("🛑 Закрити {name}?"),
                &[("✅ Так, закрити", "quit", &name), ("✖ Ні", "keep", &name)],
            ),
            "keep" => app_reply(
                format!("🚀 {name}"),
                &[("👻 Згорнути", "hide", &name), ("🛑 Закрити", "quitask", &name)],
            ),
            "hide" | "minimize" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::hide_app(&n)).await;
                match result {
                    Ok(Ok(())) => app_reply(format!("👻 Згорнув: {name}"), &[("🚀 Відкрити", "open", &name)]),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            "quit" | "close" | "exit" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::quit_app(&n)).await;
                match result {
                    Ok(Ok(apps_control::QuitOutcome::Quit { resolved_name })) => {
                        app_reply(format!("🛑 Закрив: {resolved_name}"), &[("🚀 Відкрити", "open", &resolved_name)])
                    }
                    Ok(Ok(apps_control::QuitOutcome::NotRunning)) => {
                        Reply::text(format!("ℹ️ `{name}` не запущений — нема чого закривати."))
                    }
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

/// `app:<verb> <name>` payload, or `None` when the app name would push
/// it past Telegram's 64-byte callback limit.
fn app_cb(verb: &str, name: &str) -> Option<String> {
    let cb = format!("app:{verb} {name}");
    (cb.len() <= 64).then_some(cb)
}

/// Single-app result card with follow-up actions that edit it in place.
fn app_reply(text: String, actions: &[(&str, &str, &str)]) -> Reply {
    let row: Vec<InlineButton> = actions
        .iter()
        .filter_map(|(label, verb, name)| {
            app_cb(verb, name).map(|cb| InlineButton::new(*label, format!("refresh:{cb}")))
        })
        .filter(|b| b.callback_data.len() <= 64)
        .collect();
    Reply {
        text,
        keyboard: (!row.is_empty()).then(|| InlineKeyboard { rows: vec![row] }),
        ..Default::default()
    }
}

/// Running-apps list with a "hide" button per app (non-destructive, so a
/// mis-tap is harmless) plus refresh.
fn app_running_reply(names: &[String]) -> Reply {
    let buttons: Vec<InlineButton> = names
        .iter()
        .take(12)
        .filter_map(|n| app_cb("hide", n).map(|cb| InlineButton::new(format!("👻 {n}"), cb)))
        .collect();
    let mut rows: Vec<Vec<InlineButton>> = buttons.chunks(3).map(|c| c.to_vec()).collect();
    rows.push(super::menu::nav_row("refresh:app:running"));
    Reply {
        text: format!("🪟 Запущено: {}", names.join(", ")),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

/// Tab IDs the frontend's module registry currently recognises. Kept in
/// sync manually with `src/modules/*/index.tsx` + `src/settings/index.tsx`
/// — the `known_tabs_cover_every_frontend_module` test fails when a
/// frontend tab is missing here (see CLAUDE.md "Agent surface").
pub const KNOWN_TABS: &[&str] = &[
    "clipboard",
    "translator",
    "notes",
    "ai",
    "telegram",
    "valeton-editor",
    "music",
    "downloads",
    "pomodoro",
    "terminal",
    "web",
    "system",
    "canvas",
    "converter",
    "separator",
    "reminders",
    "dev",
    "settings",
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
/// same path used by `reveal_music_tab` and the `⌘⇧J` Notes shortcut.
fn reveal_tab(app: &tauri::AppHandle, tab_id: &str) {
    let _ = app.emit("nav:activate", tab_id);
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

// -------------------- /metronome --------------------

use crate::modules::metronome::commands::MetronomeStateHandle;
use crate::modules::metronome::state::{
    MetronomeState, Preset as MetronomePreset, TrainerConfig as MetronomeTrainer,
};

/// Payload for the `metronome:remote` event. Frontend applies the patch
/// (any `Some` field), then reacts to `action`. Fields are already resolved
/// against the persisted state (relative BPM, presets, trainer merge), so the
/// listener only has to copy them in.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MetronomeRemote {
    pub action: Option<String>,
    pub bpm: Option<u32>,
    pub numerator: Option<u8>,
    pub denominator: Option<u8>,
    pub subdivision: Option<u8>,
    pub sound: Option<String>,
    /// Linear 0..1, same unit as the tab's slider.
    pub click_volume: Option<f32>,
    pub accent_volume: Option<f32>,
    pub beat_accents: Option<Vec<bool>>,
    /// Full trainer config after merging the requested changes.
    pub trainer: Option<MetronomeTrainer>,
    /// Full preset list, sent only when a preset was saved or deleted.
    pub presets: Option<Vec<MetronomePreset>>,
}

/// Parsed `/metronome` arguments — raw user intent before it is resolved
/// against the persisted state (see `resolve_metronome`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetronomeArgs {
    pub action: Option<String>,
    pub bpm: Option<u32>,
    /// Relative BPM change (`bpm=+5` / `bpm=-1`).
    pub bpm_delta: Option<i32>,
    pub numerator: Option<u8>,
    pub denominator: Option<u8>,
    pub subdivision: Option<u8>,
    pub sound: Option<String>,
    /// Percent 0..100.
    pub click_volume: Option<u8>,
    /// Percent 0..100.
    pub accent_volume: Option<u8>,
    pub beat_accents: Option<Vec<bool>>,
    pub trainer_enabled: Option<bool>,
    pub trainer_step: Option<u32>,
    pub trainer_bars: Option<u32>,
    pub trainer_target: Option<u32>,
    /// Apply a saved preset (by id or case-insensitive name).
    pub preset: Option<String>,
    /// Save the resulting state as a preset with this name.
    pub save_preset: Option<String>,
    /// Delete a saved preset (by id or case-insensitive name).
    pub delete_preset: Option<String>,
}

pub struct MetronomeCmd;

#[async_trait]
impl CommandHandler for MetronomeCmd {
    fn name(&self) -> &'static str {
        "metronome"
    }
    fn description(&self) -> &'static str {
        "Керувати метрономом. Приклади: `start bpm=140 sig=6/8`, `stop`, `bpm=+5`, `vol=60`, `trainer=on`, `preset=\"Slow blues\"`."
    }
    fn usage(&self) -> &'static str {
        "/metronome [start|stop|toggle|status] [bpm=N|+N|-N] [sig=N/D] [sub=1..4] [sound=click|wood|beep] \
         [vol=0..100] [accent_vol=0..100] [accents=1000] [trainer=on|off] [trainer_step=N] \
         [trainer_bars=N] [trainer_target=N] [preset=<name>] [save=<name>] [delete=<name>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let parsed = match parse_metronome_args(args) {
            Ok(p) => p,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        let path = metronome_state_path(&ctx.app);
        let current = path
            .as_ref()
            .map(MetronomeState::load)
            .unwrap_or_default();
        let (mut remote, next) = match resolve_metronome(&parsed, &current, now_ms()) {
            Ok(r) => r,
            Err(e) => {
                return metronome_card(&current, None, Some(&format!("⚠️ {e}")));
            }
        };
        // Persist first so the change sticks even when the Valeton tab isn't
        // mounted — the shell hydrates from disk on mount.
        if next != current {
            if let Some(p) = &path {
                if let Err(e) = next.save(p) {
                    tracing::warn!(error = %e, "metronome: persist failed");
                }
            }
        }
        // Bare `/metronome` (and the 🔄 button) is a status probe — ask the
        // shell whether it's playing without touching anything.
        if remote.action.is_none() && parsed == MetronomeArgs::default() {
            remote.action = Some("status".into());
        }
        // Playback needs the audio engine, which lives in the Valeton tab —
        // reveal it and keep re-emitting until the lazy chunk mounts and
        // acks. Pure setting changes are already on disk, so they only need
        // a short ack window (live apply when the shell is mounted).
        let needs_ui = matches!(remote.action.as_deref(), Some("start" | "toggle"));
        if needs_ui {
            reveal_tab(&ctx.app, "valeton-editor");
        }
        let window = if needs_ui {
            std::time::Duration::from_secs(4)
        } else {
            std::time::Duration::from_millis(400)
        };
        let payload = serde_json::to_value(&remote).unwrap_or_default();
        let ack = emit_with_ack(&ctx.app, "metronome:remote", payload, window).await;
        let playing = ack
            .as_ref()
            .and_then(|v| v.get("playing"))
            .and_then(|v| v.as_bool());
        let note = if needs_ui && ack.is_none() {
            Some("⚠️ Метроном не відповів — відкрий Stash → Valeton (вигляд з педалями).".to_string())
        } else if remote.action.as_deref() == Some("status") {
            None
        } else {
            Some(format_metronome_reply(&remote))
        };
        metronome_card(&next, playing, note.as_deref())
    }
}

/// Same path resolution as `metronome::commands` (app-data dir, falling back
/// to the path captured at setup).
fn metronome_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let fallback = app
        .try_state::<MetronomeStateHandle>()
        .map(|h| h.path.lock().unwrap().clone());
    app.path()
        .app_data_dir()
        .map(|d| d.join("metronome.json"))
        .ok()
        .or(fallback)
}

static REMOTE_ACK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Emit `event` tagged with a fresh `ack_id` and wait for the frontend to
/// echo it on `<event>:ack`. Re-emits every 250 ms until `window` elapses so
/// a lazy tab that mounts mid-wait still receives the payload (replaces the
/// old blind "sleep 350 ms then emit"). The listener dedupes by `ack_id`, so
/// a re-emit never applies the same command twice. Returns the ack payload,
/// or `None` when nothing answered in time.
async fn emit_with_ack(
    app: &tauri::AppHandle,
    event: &str,
    mut payload: serde_json::Value,
    window: std::time::Duration,
) -> Option<serde_json::Value> {
    use tauri::Listener;
    let ack_id = REMOTE_ACK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("ack_id".into(), serde_json::json!(ack_id));
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let listener = app.listen(format!("{event}:ack"), move |e| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
            if v.get("ack_id").and_then(|x| x.as_u64()) == Some(ack_id) {
                let _ = tx.send(v);
            }
        }
    });
    let deadline = std::time::Instant::now() + window;
    let mut result = None;
    loop {
        let _ = app.emit(event, &payload);
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let wait = (deadline - now).min(std::time::Duration::from_millis(250));
        if let Ok(Some(v)) = tokio::time::timeout(wait, rx.recv()).await {
            result = Some(v);
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    app.unlisten(listener);
    result
}

/// Split on whitespace but keep `key="quoted value"` together (quotes
/// stripped) so preset names with spaces survive the slash syntax.
fn tokenize_quoted(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in s.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn parse_percent(key: &str, val: &str) -> Result<u8, String> {
    let n: u32 = val
        .trim_end_matches('%')
        .parse()
        .map_err(|_| format!("{key} має бути числом 0–100, отримано `{val}`"))?;
    if n > 100 {
        return Err(format!("{key} поза межами 0–100: {n}"));
    }
    Ok(n as u8)
}

fn parse_ranged_u32(key: &str, val: &str, min: u32, max: u32) -> Result<u32, String> {
    let n: u32 = val
        .parse()
        .map_err(|_| format!("{key} має бути числом, отримано `{val}`"))?;
    if !(min..=max).contains(&n) {
        return Err(format!("{key} поза межами {min}–{max}: {n}"));
    }
    Ok(n)
}

fn parse_metronome_args(args: &str) -> Result<MetronomeArgs, String> {
    let mut out = MetronomeArgs::default();
    for raw in tokenize_quoted(args) {
        let lower = raw.to_ascii_lowercase();
        match lower.as_str() {
            "start" | "play" => out.action = Some("start".into()),
            "stop" | "pause" => out.action = Some("stop".into()),
            "toggle" => out.action = Some("toggle".into()),
            "status" => out.action = Some("status".into()),
            other => {
                let (key, _) = other
                    .split_once('=')
                    .ok_or_else(|| format!("незрозумілий токен: `{other}`"))?;
                // Keep the original casing for free-text values (preset names).
                let val_raw = raw.split_once('=').map(|(_, v)| v).unwrap_or("");
                let val = val_raw.to_ascii_lowercase();
                let val = val.as_str();
                match key {
                    "bpm" => {
                        if let Some(rest) = val.strip_prefix('+') {
                            let n: i32 = rest
                                .parse()
                                .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                            out.bpm_delta = Some(n.clamp(0, 200));
                        } else if val.starts_with('-') {
                            let n: i32 = val
                                .parse()
                                .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                            out.bpm_delta = Some(n.clamp(-200, 0));
                        } else {
                            out.bpm = Some(parse_ranged_u32("bpm", val, 40, 240)?);
                        }
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
                        let n: u8 = val.parse().map_err(|_| format!("sub не число: `{val}`"))?;
                        if !(1..=4).contains(&n) {
                            return Err(format!("sub поза 1–4: {n}"));
                        }
                        out.subdivision = Some(n);
                    }
                    "sound" => {
                        if !matches!(val, "click" | "wood" | "beep") {
                            return Err(format!(
                                "sound має бути click|wood|beep, отримано `{val}`"
                            ));
                        }
                        out.sound = Some(val.to_string());
                    }
                    "vol" | "volume" | "click_vol" | "click_volume" => {
                        out.click_volume = Some(parse_percent("vol", val)?);
                    }
                    "accent_vol" | "accentvol" | "accent_volume" => {
                        out.accent_volume = Some(parse_percent("accent_vol", val)?);
                    }
                    "accents" => {
                        let pattern: Result<Vec<bool>, String> = val
                            .chars()
                            .filter(|c| !matches!(c, ',' | ' '))
                            .map(|c| match c {
                                '1' | 'x' | '>' => Ok(true),
                                '0' | '.' | '-' => Ok(false),
                                other => Err(format!(
                                    "accents: незрозумілий символ `{other}` (1/x = акцент, 0/. = ні)"
                                )),
                            })
                            .collect();
                        let pattern = pattern?;
                        if pattern.is_empty() || pattern.len() > 16 {
                            return Err("accents: від 1 до 16 долей".into());
                        }
                        out.beat_accents = Some(pattern);
                    }
                    "trainer" => {
                        out.trainer_enabled = Some(match val {
                            "on" | "1" | "true" | "yes" => true,
                            "off" | "0" | "false" | "no" => false,
                            other => return Err(format!("trainer має бути on|off, отримано `{other}`")),
                        });
                    }
                    "trainer_step" | "step" => {
                        out.trainer_step = Some(parse_ranged_u32("trainer_step", val, 1, 50)?);
                    }
                    "trainer_bars" | "bars" => {
                        out.trainer_bars = Some(parse_ranged_u32("trainer_bars", val, 1, 64)?);
                    }
                    "trainer_target" | "target" => {
                        out.trainer_target = Some(parse_ranged_u32("trainer_target", val, 40, 240)?);
                    }
                    "preset" | "load" => out.preset = Some(non_empty("preset", val_raw)?),
                    "save" | "save_preset" => out.save_preset = Some(non_empty("save", val_raw)?),
                    "delete" | "delete_preset" => {
                        out.delete_preset = Some(non_empty("delete", val_raw)?)
                    }
                    _ => return Err(format!("невідомий параметр: `{key}`")),
                }
            }
        }
    }
    Ok(out)
}

fn non_empty(key: &str, v: &str) -> Result<String, String> {
    let t = v.trim();
    if t.is_empty() {
        return Err(format!("{key}: порожнє значення"));
    }
    Ok(t.chars().take(60).collect())
}

fn find_metronome_preset<'a>(presets: &'a [MetronomePreset], key: &str) -> Option<&'a MetronomePreset> {
    presets
        .iter()
        .find(|p| p.id == key)
        .or_else(|| presets.iter().find(|p| p.name.eq_ignore_ascii_case(key)))
}

/// Resolve parsed args against the persisted state. Returns the payload to
/// emit (only changed fields) and the full next state to persist. Order:
/// preset → explicit fields → save/delete, so `preset=x bpm=+5 save=y`
/// does what it reads like.
fn resolve_metronome(
    args: &MetronomeArgs,
    cur: &MetronomeState,
    id_seed: i64,
) -> Result<(MetronomeRemote, MetronomeState), String> {
    let mut next = cur.clone();
    let mut remote = MetronomeRemote {
        action: args.action.clone(),
        ..Default::default()
    };

    if let Some(key) = &args.preset {
        let p = find_metronome_preset(&cur.presets, key)
            .ok_or_else(|| format!("пресет `{key}` не знайдено"))?
            .clone();
        next.bpm = p.bpm;
        next.numerator = p.numerator;
        next.denominator = p.denominator;
        next.subdivision = p.subdivision;
        next.sound = p.sound.clone();
        next.beat_accents = p.beat_accents.clone();
        remote.bpm = Some(p.bpm);
        remote.numerator = Some(p.numerator);
        remote.denominator = Some(p.denominator);
        remote.subdivision = Some(p.subdivision);
        remote.sound = Some(p.sound);
        remote.beat_accents = Some(p.beat_accents);
    }

    if let Some(bpm) = args.bpm {
        next.bpm = bpm;
        remote.bpm = Some(bpm);
    }
    if let Some(delta) = args.bpm_delta {
        let bpm = (next.bpm as i32 + delta).clamp(40, 240) as u32;
        next.bpm = bpm;
        remote.bpm = Some(bpm);
    }
    if let (Some(n), Some(d)) = (args.numerator, args.denominator) {
        if n != next.numerator {
            // Same reshape rule as the tab: keep the prefix, pad with downbeat.
            next.beat_accents = (0..n as usize)
                .map(|i| next.beat_accents.get(i).copied().unwrap_or(i == 0))
                .collect();
        }
        next.numerator = n;
        next.denominator = d;
        remote.numerator = Some(n);
        remote.denominator = Some(d);
    }
    if let Some(s) = args.subdivision {
        next.subdivision = s;
        remote.subdivision = Some(s);
    }
    if let Some(s) = &args.sound {
        next.sound = s.clone();
        remote.sound = Some(s.clone());
    }
    if let Some(v) = args.click_volume {
        next.click_volume = v as f32 / 100.0;
        remote.click_volume = Some(next.click_volume);
    }
    if let Some(v) = args.accent_volume {
        next.accent_volume = v as f32 / 100.0;
        remote.accent_volume = Some(next.accent_volume);
    }
    if let Some(acc) = &args.beat_accents {
        if acc.len() != next.numerator as usize {
            return Err(format!(
                "accents має {} долей, а розмір {}/{} — потрібно {}",
                acc.len(),
                next.numerator,
                next.denominator,
                next.numerator
            ));
        }
        next.beat_accents = acc.clone();
        remote.beat_accents = Some(acc.clone());
    }
    let trainer_touched = args.trainer_enabled.is_some()
        || args.trainer_step.is_some()
        || args.trainer_bars.is_some()
        || args.trainer_target.is_some();
    if trainer_touched {
        if let Some(v) = args.trainer_enabled {
            next.trainer.enabled = v;
        }
        if let Some(v) = args.trainer_step {
            next.trainer.step_bpm = v;
        }
        if let Some(v) = args.trainer_bars {
            next.trainer.every_bars = v;
        }
        if let Some(v) = args.trainer_target {
            next.trainer.target_bpm = v;
        }
        remote.trainer = Some(next.trainer.clone());
    }

    let mut presets_changed = false;
    if let Some(key) = &args.delete_preset {
        let id = find_metronome_preset(&next.presets, key)
            .map(|p| p.id.clone())
            .ok_or_else(|| format!("пресет `{key}` не знайдено"))?;
        next.presets.retain(|p| p.id != id);
        presets_changed = true;
    }
    if let Some(name) = &args.save_preset {
        let snapshot = |id: String| MetronomePreset {
            id,
            name: name.clone(),
            bpm: next.bpm,
            numerator: next.numerator,
            denominator: next.denominator,
            subdivision: next.subdivision,
            sound: next.sound.clone(),
            beat_accents: next.beat_accents.clone(),
        };
        // Re-using a name overwrites that preset in place (keeps its id).
        let existing = next
            .presets
            .iter()
            .position(|p| p.name.eq_ignore_ascii_case(name));
        match existing {
            Some(i) => {
                let id = next.presets[i].id.clone();
                next.presets[i] = snapshot(id);
            }
            None => {
                let id = format!("p_tg{}", id_seed.rem_euclid(36_i64.pow(8)));
                let p = snapshot(id);
                next.presets.push(p);
            }
        }
        presets_changed = true;
    }
    if presets_changed {
        remote.presets = Some(next.presets.clone());
    }
    next.normalize();
    Ok((remote, next))
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
    if let Some(v) = r.click_volume {
        parts.push(format!("гучність {}%", (v * 100.0).round() as u32));
    }
    if let Some(v) = r.accent_volume {
        parts.push(format!("акцент {}%", (v * 100.0).round() as u32));
    }
    if r.beat_accents.is_some() {
        parts.push("акценти".into());
    }
    if let Some(t) = &r.trainer {
        parts.push(format!("тренер {}", if t.enabled { "on" } else { "off" }));
    }
    if r.presets.is_some() {
        parts.push("пресети оновлено".into());
    }
    if parts.is_empty() {
        "🥁 Метроном без змін.".to_string()
    } else {
        format!("🥁 Метроном: {}", parts.join(", "))
    }
}

fn subdivision_glyph(sub: u8) -> &'static str {
    match sub {
        2 => "♪♪",
        3 => "♪♪♪",
        4 => "♬",
        _ => "♩",
    }
}

/// Live card text: state line first so taps visibly change it.
fn format_metronome_card(st: &MetronomeState, playing: Option<bool>) -> String {
    let icon = if playing == Some(true) { "▶️" } else { "⏹" };
    let mut lines = vec![format!(
        "{icon} {} BPM · {}/{} · {} · {}",
        st.bpm,
        st.numerator,
        st.denominator,
        subdivision_glyph(st.subdivision),
        st.sound
    )];
    lines.push(format!(
        "🔊 клік {}% · акцент {}%",
        (st.click_volume * 100.0).round() as u32,
        (st.accent_volume * 100.0).round() as u32
    ));
    let accents: String = st
        .beat_accents
        .iter()
        .map(|a| if *a { '●' } else { '○' })
        .collect();
    lines.push(format!("🥁 {accents}"));
    if st.trainer.enabled {
        lines.push(format!(
            "🎯 тренер: +{} BPM кожні {} такт. → {}",
            st.trainer.step_bpm, st.trainer.every_bars, st.trainer.target_bpm
        ));
    }
    if !st.presets.is_empty() {
        let names: Vec<&str> = st.presets.iter().map(|p| p.name.as_str()).collect();
        lines.push(format!("🎼 пресети: {}", names.join(", ")));
    }
    if playing.is_none() {
        lines.push("💤 Вкладка Valeton не відкрита — зміни збережено й застосуються при відкритті.".into());
    }
    lines.join("\n")
}

fn metronome_keyboard(st: &MetronomeState, playing: Option<bool>) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:metronome:{args}"));
    let transport = if playing == Some(true) {
        b("⏹ Стоп", "stop")
    } else {
        b("▶️ Старт", "start")
    };
    let mut rows = vec![
        vec![transport, b("🔄", "")],
        vec![
            b("−5", "bpm=-5"),
            b("−1", "bpm=-1"),
            b("+1", "bpm=+1"),
            b("+5", "bpm=+5"),
        ],
        [(2u8, 4u8), (3, 4), (4, 4), (6, 8)]
            .iter()
            .map(|&(n, d)| {
                let label = if st.numerator == n && st.denominator == d {
                    format!("• {n}/{d}")
                } else {
                    format!("{n}/{d}")
                };
                b(&label, &format!("sig={n}/{d}"))
            })
            .collect(),
        (1u8..=4)
            .map(|s| {
                let glyph = subdivision_glyph(s);
                let label = if st.subdivision == s {
                    format!("• {glyph}")
                } else {
                    glyph.to_string()
                };
                b(&label, &format!("sub={s}"))
            })
            .collect(),
        vec![if st.trainer.enabled {
            b("🎯 Тренер: on", "trainer=off")
        } else {
            b("🎯 Тренер: off", "trainer=on")
        }],
    ];
    // Presets by id — names may be long or contain spaces; ids are short.
    let presets: Vec<InlineButton> = st
        .presets
        .iter()
        .map(|p| {
            let name: String = p.name.chars().take(16).collect();
            b(&format!("🎼 {name}"), &format!("preset={}", p.id))
        })
        .filter(|btn| btn.callback_data.len() <= 64)
        .take(4)
        .collect();
    for chunk in presets.chunks(2) {
        rows.push(chunk.to_vec());
    }
    InlineKeyboard { rows }
}

fn metronome_card(st: &MetronomeState, playing: Option<bool>, note: Option<&str>) -> Reply {
    let body = format_metronome_card(st, playing);
    let text = match note {
        Some(n) => format!("{n}\n\n{body}"),
        None => body,
    };
    Reply {
        text,
        keyboard: Some(metronome_keyboard(st, playing)),
        ..Default::default()
    }
}

// -------------------- /record --------------------

/// Payload for the `recorder:remote` event. The embedded Recorder shell starts
/// or stops capture in response. Capture is inherently UI-bound, so this only
/// takes effect once the Valeton tab (which hosts the recorder) is mounted.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct RecorderRemote {
    pub action: Option<String>,
    /// Input gain as a linear multiplier (`1.0` = unity). When present the
    /// shell applies and persists it; clamped to the supported range there.
    pub gain: Option<f32>,
}

pub struct RecordCmd;

#[async_trait]
impl CommandHandler for RecordCmd {
    fn name(&self) -> &'static str {
        "record"
    }
    fn description(&self) -> &'static str {
        "Керувати рекордером у Valeton. Приклади: `start`, `stop`, `toggle`, `gain 1.5`."
    }
    fn usage(&self) -> &'static str {
        "/record [start|stop|toggle|gain <0..2>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let mut toks = args.split_whitespace();
        let first = toks.next();

        // `gain <n>` sets the input level (linear multiplier) without touching
        // capture — applies live to an in-flight take and persists for the next.
        if first.is_some_and(|t| t.eq_ignore_ascii_case("gain")) {
            let raw = toks.next();
            let gain = match raw.and_then(|v| v.parse::<f32>().ok()) {
                Some(g) if g.is_finite() => g.clamp(0.0, 2.0),
                _ => {
                    return Reply::text(format!(
                        "⚠️ потрібне число для gain (наприклад `1.5`)\nВикористання: {}",
                        self.usage()
                    ))
                }
            };
            reveal_tab(&ctx.app, "valeton-editor");
            let payload = RecorderRemote {
                gain: Some(gain),
                ..Default::default()
            };
            let ack = emit_recorder(&ctx.app, &payload).await;
            let Some(recording) = ack else {
                return record_card(RECORDER_NO_ACK.to_string());
            };
            return record_card(format!(
                "🎚 Підсилення → {}%.{}",
                (gain * 100.0).round() as i64,
                if recording { "\n🔴 Йде запис." } else { "" }
            ));
        }

        let action = match first {
            // Bare `/record` toggles — the most common quick action.
            None => "toggle".to_string(),
            Some(tok) => match tok.to_ascii_lowercase().as_str() {
                "start" | "rec" | "record" => "start".to_string(),
                "stop" | "save" => "stop".to_string(),
                "toggle" => "toggle".to_string(),
                other => {
                    return Reply::text(format!(
                        "⚠️ невідома дія `{other}`\nВикористання: {}",
                        self.usage()
                    ))
                }
            },
        };
        // Reveal + mount the Valeton editor (which hosts the recorder shell)
        // so its `recorder:remote` listener is attached before we emit.
        reveal_tab(&ctx.app, "valeton-editor");
        let payload = RecorderRemote {
            action: Some(action.clone()),
            ..Default::default()
        };
        // The shell acks with the phase it ended up in, so a toggle reports
        // what actually happened instead of guessing.
        record_card(match emit_recorder(&ctx.app, &payload).await {
            None => RECORDER_NO_ACK.to_string(),
            Some(true) => "🔴 Запис почато.".to_string(),
            Some(false) if action == "start" => "⚠️ Запис не стартував.".to_string(),
            Some(false) => "⏹ Запис зупинено й збережено.".to_string(),
        })
    }
}

const RECORDER_NO_ACK: &str =
    "⚠️ Рекордер не відповів — відкрий Stash → Valeton (вигляд з педалями).";

/// Deliver a `recorder:remote` payload with retries until the (lazy) Valeton
/// tab mounts and acks. Returns the shell's `recording` flag, or `None` when
/// nothing answered in time.
async fn emit_recorder(app: &tauri::AppHandle, payload: &RecorderRemote) -> Option<bool> {
    let value = serde_json::to_value(payload).unwrap_or_default();
    let ack = emit_with_ack(app, "recorder:remote", value, std::time::Duration::from_secs(4)).await?;
    Some(ack.get("recording").and_then(|v| v.as_bool()).unwrap_or(false))
}

/// Explicit start/stop (idempotent) rather than toggle — a stale card must
/// never flip the recorder.
fn record_card(text: String) -> Reply {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:record:{args}"));
    Reply {
        text,
        keyboard: Some(InlineKeyboard {
            rows: vec![
                vec![b("🔴 Запис", "start"), b("⏹ Стоп", "stop")],
                vec![
                    b("🎚 50%", "gain 0.5"),
                    b("🎚 100%", "gain 1"),
                    b("🎚 150%", "gain 1.5"),
                ],
            ],
        }),
        ..Default::default()
    }
}

// -------------------- /valeton --------------------

/// Payload for the `valeton:remote` event. The Valeton editor applies every
/// `Some` field against the current patch / device, in this order: select
/// patch → apply AI preset → bpm/division → block on/off → save. Device I/O is
/// best-effort: if the GP-5 isn't connected the editor updates its UI state and
/// the changes flush on the next connect.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ValetonRemote {
    /// Switch to patch 0..99 on the device.
    pub patch: Option<u8>,
    /// Tap-tempo / delay-sync BPM (40..240).
    pub bpm: Option<u32>,
    /// Note division for the tempo: `quarter` | `eighth` | `dotted`.
    pub division: Option<String>,
    /// Effect block key to toggle (`nr|pre|dst|amp|cab|eq|mod|dly|rvb|ns`).
    pub block: Option<String>,
    /// Target on/off state for `block`.
    pub block_on: Option<bool>,
    /// Persist the current edit buffer into the active patch on the device.
    pub save: Option<bool>,
    /// AI-generated preset JSON to parse + apply (set by `/valeton tone …`).
    pub preset_json: Option<String>,
}

/// The ten GP-5 effect-block keys, in protocol order.
const VALETON_BLOCKS: &[&str] = &[
    "nr", "pre", "dst", "amp", "cab", "eq", "mod", "dly", "rvb", "ns",
];

pub struct ValetonCmd;

#[async_trait]
impl CommandHandler for ValetonCmd {
    fn name(&self) -> &'static str {
        "valeton"
    }
    fn description(&self) -> &'static str {
        "Керувати редактором Valeton GP-5. Приклади: `tone warm gilmour lead`, \
         `patch=12`, `bpm=120`, `amp=on`, `save`."
    }
    fn usage(&self) -> &'static str {
        "/valeton tone <опис тону> | [patch=0..99] [bpm=40..240] \
         [div=quarter|eighth|dotted] [<block>=on|off] [save]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let args = args.trim();
        if args.is_empty() {
            return Reply::text(format!("⚠️ нічого не задано\nВикористання: {}", self.usage()));
        }

        // `tone <free text>` — generate a preset from a natural-language tone
        // description and apply it to the current patch. Everything after the
        // `tone` keyword is the prompt (it has spaces, unlike key=val tokens).
        if let Some(rest) = args
            .strip_prefix("tone")
            .filter(|r| r.is_empty() || r.starts_with(char::is_whitespace))
        {
            let desc = rest.trim();
            if desc.is_empty() {
                return Reply::text(
                    "⚠️ опиши потрібний тон, напр. `tone warm gilmour lead`.".to_string(),
                );
            }
            let json = match crate::modules::valeton::commands::generate_preset_json(&ctx.app, desc)
                .await
            {
                Ok(j) => j,
                Err(e) => return Reply::text(format!("⚠️ не вдалося згенерувати тон: {e}")),
            };
            reveal_tab(&ctx.app, "valeton-editor");
            let delivered = emit_valeton(
                &ctx.app,
                &ValetonRemote {
                    preset_json: Some(json),
                    ..Default::default()
                },
            )
            .await;
            return Reply::text(with_valeton_note(format!("🎸 Застосовую тон: {desc}"), delivered));
        }

        let parsed = match parse_valeton_args(args) {
            Ok(p) => p,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        // Reveal + mount the editor and re-emit until its `valeton:remote`
        // listener acks, so a lazy first mount doesn't drop the command.
        reveal_tab(&ctx.app, "valeton-editor");
        let reply = format_valeton_reply(&parsed);
        let delivered = emit_valeton(&ctx.app, &parsed).await;
        Reply::text(with_valeton_note(reply, delivered))
    }
}

/// Deliver a `valeton:remote` payload with retries until the editor acks.
async fn emit_valeton(app: &tauri::AppHandle, payload: &ValetonRemote) -> bool {
    let value = serde_json::to_value(payload).unwrap_or_default();
    emit_with_ack(app, "valeton:remote", value, std::time::Duration::from_secs(4))
        .await
        .is_some()
}

fn with_valeton_note(reply: String, delivered: bool) -> String {
    if delivered {
        reply
    } else {
        format!("{reply}\n⚠️ Редактор Valeton не відповів — відкрий Stash → Valeton.")
    }
}

fn parse_valeton_args(args: &str) -> Result<ValetonRemote, String> {
    let mut out = ValetonRemote::default();
    for tok in args.split_whitespace() {
        let lower = tok.to_ascii_lowercase();
        if lower == "save" {
            out.save = Some(true);
            continue;
        }
        let (key, val) = lower
            .split_once('=')
            .ok_or_else(|| format!("незрозумілий токен: `{tok}` (очікую key=value або save)"))?;
        match key {
            "patch" | "preset" => {
                let n: u8 = val
                    .parse()
                    .map_err(|_| format!("patch має бути числом, отримано `{val}`"))?;
                if n > 99 {
                    return Err(format!("patch поза межами 0–99: {n}"));
                }
                out.patch = Some(n);
            }
            "bpm" => {
                let n: u32 = val
                    .parse()
                    .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                if !(40..=240).contains(&n) {
                    return Err(format!("bpm поза межами 40–240: {n}"));
                }
                out.bpm = Some(n);
            }
            "div" | "division" => {
                let d = match val {
                    "quarter" | "q" | "1/4" => "quarter",
                    "eighth" | "8" | "1/8" => "eighth",
                    "dotted" | "dot" => "dotted",
                    _ => return Err(format!("div має бути quarter|eighth|dotted, отримано `{val}`")),
                };
                out.division = Some(d.to_string());
            }
            block if VALETON_BLOCKS.contains(&block) => {
                let on = match val {
                    "on" | "1" | "true" | "enable" => true,
                    "off" | "0" | "false" | "disable" => false,
                    _ => return Err(format!("{block} приймає on|off, отримано `{val}`")),
                };
                out.block = Some(block.to_string());
                out.block_on = Some(on);
            }
            _ => return Err(format!("невідомий параметр: `{key}`")),
        }
    }
    if out.patch.is_none()
        && out.bpm.is_none()
        && out.division.is_none()
        && out.block.is_none()
        && out.save.is_none()
    {
        return Err("жодної дії не розпізнано".into());
    }
    Ok(out)
}

fn format_valeton_reply(r: &ValetonRemote) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = r.patch {
        parts.push(format!("патч {p}"));
    }
    if let Some(bpm) = r.bpm {
        parts.push(format!("{bpm} BPM"));
    }
    if let Some(div) = &r.division {
        parts.push(format!("поділ={div}"));
    }
    if let (Some(b), Some(on)) = (&r.block, r.block_on) {
        parts.push(format!("{} {}", b.to_uppercase(), if on { "on" } else { "off" }));
    }
    if r.save == Some(true) {
        parts.push("збереження".into());
    }
    if parts.is_empty() {
        "🎸 Valeton без змін.".to_string()
    } else {
        format!("🎸 Valeton: {}", parts.join(", "))
    }
}

// -------------------- /tuner --------------------

use crate::modules::tuner::commands::TunerStateHandle;
use crate::modules::tuner::state::{is_valid_tuning, TunerState};

/// Payload for the `tuner:remote` event. The Valeton editor opens the tuner
/// modal in response, and the tuner shell switches to the requested tuning.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct TunerRemote {
    pub tuning_id: Option<String>,
}

/// A single note token (with flats/sharps) → the pitch-class slug used in
/// tuning ids (all sharp-based, e.g. `eb` and `d#` both map to `dsharp`).
fn note_to_slug(tok: &str) -> Option<&'static str> {
    match tok {
        "e" => Some("e"),
        "eb" | "d#" | "ds" | "dsharp" => Some("dsharp"),
        "d" => Some("d"),
        "db" | "c#" | "cs" | "csharp" => Some("csharp"),
        "c" => Some("c"),
        "b" => Some("b"),
        "bb" | "a#" | "as" | "asharp" => Some("asharp"),
        "a" => Some("a"),
        _ => None,
    }
}

/// Resolve free-form input ("drop d", "eb standard", a raw id) to a canonical
/// tuning id, or None when nothing recognisable is present.
fn resolve_tuning(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    let s = s.strip_prefix("tuning=").unwrap_or(&s).trim();
    if s.is_empty() {
        return None;
    }
    // Already a canonical id (allow spaces/underscores in place of dashes).
    let dashed = s.replace([' ', '_'], "-");
    if is_valid_tuning(&dashed) {
        return Some(dashed);
    }
    let is_drop = s.contains("drop");
    let prefix = if is_drop { "drop" } else { "standard" };
    // First note-like token wins (skips words like "drop"/"standard").
    let root = s.split([' ', '-', '_']).find_map(note_to_slug);
    let id = match root {
        Some(r) => format!("{prefix}-{r}"),
        // "drop" / "standard" with no explicit root → the canonical default.
        None if is_drop => "drop-d".to_string(),
        None if s.contains("standard") || s.contains("std") => "standard-e".to_string(),
        None => return None,
    };
    is_valid_tuning(&id).then_some(id)
}

/// Persist the chosen tuning so it survives even when the modal is closed
/// (the live `tuner:remote` event only reaches an open modal).
fn persist_tuner_tuning(app: &tauri::AppHandle, tuning_id: &str) {
    if let Some(handle) = app.try_state::<TunerStateHandle>() {
        let fallback = handle.path.lock().unwrap().clone();
        let path = app
            .path()
            .app_data_dir()
            .map(|d| d.join("tuner.json"))
            .unwrap_or(fallback);
        let mut st = TunerState::load(&path);
        st.tuning_id = tuning_id.to_string();
        st.normalize();
        let _ = st.save(&path);
    }
}

pub struct TunerCmd;

#[async_trait]
impl CommandHandler for TunerCmd {
    fn name(&self) -> &'static str {
        "tuner"
    }
    fn description(&self) -> &'static str {
        "Відкрити тюнер у Valeton і обрати стрій. Приклади: `drop d`, `eb standard`, `standard-a`."
    }
    fn usage(&self) -> &'static str {
        "/tuner [<tuning>]  напр. `e standard`, `drop d`, `drop a`, `standard-csharp`"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        // Bare `/tuner` just opens the tuner with whatever's saved.
        let tuning_id = if args.trim().is_empty() {
            None
        } else {
            match resolve_tuning(args) {
                Some(id) => Some(id),
                None => {
                    return Reply::text(format!(
                        "⚠️ невідомий стрій `{}`\nВикористання: {}",
                        args.trim(),
                        self.usage()
                    ))
                }
            }
        };
        if let Some(id) = &tuning_id {
            persist_tuner_tuning(&ctx.app, id);
        }
        // Reveal the Valeton editor and keep re-emitting: the first emit that
        // lands opens the tuner modal, and the tuner shell (mounted inside it)
        // applies the tuning and acks.
        reveal_tab(&ctx.app, "valeton-editor");
        let payload = serde_json::to_value(TunerRemote {
            tuning_id: tuning_id.clone(),
        })
        .unwrap_or_default();
        let ack = emit_with_ack(
            &ctx.app,
            "tuner:remote",
            payload,
            std::time::Duration::from_secs(4),
        )
        .await;
        let current = tuning_id.clone().unwrap_or_else(|| read_tuner_tuning(&ctx.app));
        let text = if ack.is_some() {
            format!("🎸 Тюнер відкрито · стрій {current}")
        } else {
            format!(
                "⚠️ Тюнер не відповів — відкрий Stash → Valeton. Стрій {current} збережено."
            )
        };
        Reply {
            text,
            keyboard: Some(tuner_keyboard(&current)),
            ..Default::default()
        }
    }
}

fn read_tuner_tuning(app: &tauri::AppHandle) -> String {
    let Some(handle) = app.try_state::<TunerStateHandle>() else {
        return crate::modules::tuner::state::DEFAULT_TUNING_ID.to_string();
    };
    let fallback = handle.path.lock().unwrap().clone();
    let path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("tuner.json"))
        .unwrap_or(fallback);
    TunerState::load(&path).tuning_id
}

/// Common tunings as one-tap picks; the current one is marked with `•`.
fn tuner_keyboard(current: &str) -> InlineKeyboard {
    let b = |label: &str, id: &str| {
        let text = if id == current {
            format!("• {label}")
        } else {
            label.to_string()
        };
        InlineButton::new(text, format!("refresh:tuner:{id}"))
    };
    InlineKeyboard {
        rows: vec![
            vec![
                b("E std", "standard-e"),
                b("E♭ std", "standard-dsharp"),
                b("D std", "standard-d"),
            ],
            vec![
                b("Drop D", "drop-d"),
                b("Drop C♯", "drop-csharp"),
                b("Drop C", "drop-c"),
            ],
            vec![InlineButton::new("🔄 Відкрити знову", "refresh:tuner")],
        ],
    }
}

// -------------------- /pomodoro --------------------

use crate::modules::pomodoro::commands::{
    edit_blocks_session, pause_session, resume_session, skip_to_session, start_session,
    stop_session,
};
use crate::modules::pomodoro::engine::{SessionSnapshot, SessionStatus};
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

/// Parsed `/pomodoro` sub-command. Typed slash args and inline-button
/// callbacks share this grammar.
#[derive(Debug, Clone, PartialEq)]
enum PomodoroAction {
    Status,
    /// Raw block spec, e.g. `25/sit 5/walk`.
    Start(String),
    /// Start a saved preset by id.
    Preset(i64),
    Pause,
    Resume,
    /// Pause when running, resume when paused.
    Toggle,
    /// `None` = next block; `Some(n)` = 1-based block number.
    Skip(Option<usize>),
    Stop,
    Presets,
    Delete { id: i64, confirmed: bool },
    History(u32),
    /// Replace the blocks of the running session.
    Edit(String),
}

fn parse_pomodoro_action(args: &str) -> Result<PomodoroAction, String> {
    let sub = args.trim();
    let mut parts = sub.splitn(2, char::is_whitespace);
    let verb = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("").trim();
    let parse_id = |s: &str| -> Result<i64, String> {
        s.trim_start_matches('#')
            .parse::<i64>()
            .map_err(|_| format!("очікую id пресета (число), отримано `{s}`"))
    };
    Ok(match verb.as_str() {
        "" | "status" => PomodoroAction::Status,
        "start" | "begin" | "go" => PomodoroAction::Start(rest.to_string()),
        "preset" | "run" => PomodoroAction::Preset(parse_id(rest)?),
        "pause" => PomodoroAction::Pause,
        "resume" | "continue" => PomodoroAction::Resume,
        "toggle" => PomodoroAction::Toggle,
        "skip" | "next" => {
            if rest.is_empty() {
                PomodoroAction::Skip(None)
            } else {
                let n: usize = rest
                    .parse()
                    .map_err(|_| format!("skip очікує номер блоку, отримано `{rest}`"))?;
                if n == 0 {
                    return Err("номер блоку починається з 1".into());
                }
                PomodoroAction::Skip(Some(n))
            }
        }
        "stop" | "cancel" | "end" => PomodoroAction::Stop,
        "presets" | "list" => PomodoroAction::Presets,
        "delete" | "del" | "rm" => {
            let mut it = rest.split_whitespace();
            let id = parse_id(it.next().unwrap_or(""))?;
            let confirmed = it
                .next()
                .is_some_and(|t| matches!(t.to_ascii_lowercase().as_str(), "yes" | "y" | "confirm" | "так"));
            PomodoroAction::Delete { id, confirmed }
        }
        "history" | "log" => {
            let n = if rest.is_empty() {
                10
            } else {
                rest.parse::<u32>()
                    .map_err(|_| format!("history очікує число, отримано `{rest}`"))?
            };
            PomodoroAction::History(n.clamp(1, 30))
        }
        "edit" => PomodoroAction::Edit(rest.to_string()),
        other => return Err(format!("невідома підкоманда `{other}`")),
    })
}

/// Carry block ids over by position so the engine's id-based cursor
/// preservation (`edit_blocks`) keeps the current block and its remaining
/// time when the user edits a running session.
pub(crate) fn reuse_block_ids(mut new_blocks: Vec<Block>, old: &[Block]) -> Vec<Block> {
    for (nb, ob) in new_blocks.iter_mut().zip(old.iter()) {
        nb.id = ob.id.clone();
    }
    new_blocks
}

/// Skip to the block after the current one (finishes the session when the
/// current block is the last).
pub(crate) fn pomodoro_skip_next(app: &tauri::AppHandle, state: &Arc<PomodoroState>) -> SessionSnapshot {
    let idx = state
        .core
        .lock()
        .map(|c| c.snapshot().current_idx)
        .unwrap_or(0);
    skip_to_session(app, state, idx + 1)
}

fn pomodoro_snapshot(state: &Arc<PomodoroState>) -> Option<SessionSnapshot> {
    state.core.lock().ok().map(|c| c.snapshot())
}

#[async_trait]
impl CommandHandler for PomodoroCmd {
    fn name(&self) -> &'static str {
        "pomodoro"
    }
    fn description(&self) -> &'static str {
        "Керувати таймером Pomodoro. Приклади: `start 25/sit 5/walk`, `pause`, `resume`, `skip`, `stop`, `presets`, `history`."
    }
    fn usage(&self) -> &'static str {
        "/pomodoro [status|start <min>/<posture> …|preset <id>|pause|resume|toggle|skip [n]|stop|edit <blocks>|presets|delete <id>|history [n]]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let action = match parse_pomodoro_action(args) {
            Ok(a) => a,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        let st = &self.state;
        let status = pomodoro_snapshot(st).map(|s| s.status);
        let is_idle = matches!(status, None | Some(SessionStatus::Idle));
        match action {
            PomodoroAction::Status => pomodoro_card(st, None),
            PomodoroAction::Stop => {
                if is_idle {
                    return pomodoro_card(st, Some("ℹ️ Pomodoro не запущено."));
                }
                let _ = stop_session(&ctx.app, st);
                pomodoro_card(st, Some("⏹ Pomodoro зупинено."))
            }
            PomodoroAction::Pause => {
                if status != Some(SessionStatus::Running) {
                    return pomodoro_card(st, Some("ℹ️ Нема що ставити на паузу."));
                }
                let _ = pause_session(&ctx.app, st);
                pomodoro_card(st, Some("⏸ Пауза."))
            }
            PomodoroAction::Resume => {
                if status != Some(SessionStatus::Paused) {
                    return pomodoro_card(st, Some("ℹ️ Pomodoro не на паузі."));
                }
                let _ = resume_session(&ctx.app, st);
                pomodoro_card(st, Some("▶️ Продовжуємо."))
            }
            PomodoroAction::Toggle => match status {
                Some(SessionStatus::Running) => {
                    let _ = pause_session(&ctx.app, st);
                    pomodoro_card(st, Some("⏸ Пауза."))
                }
                Some(SessionStatus::Paused) => {
                    let _ = resume_session(&ctx.app, st);
                    pomodoro_card(st, Some("▶️ Продовжуємо."))
                }
                _ => pomodoro_card(st, Some("ℹ️ Pomodoro не запущено.")),
            },
            PomodoroAction::Skip(target) => {
                if is_idle {
                    return pomodoro_card(st, Some("ℹ️ Pomodoro не запущено."));
                }
                let snap = match target {
                    None => pomodoro_skip_next(&ctx.app, st),
                    Some(n) => {
                        let len = pomodoro_snapshot(st).map(|s| s.blocks.len()).unwrap_or(0);
                        if n > len {
                            return pomodoro_card(
                                st,
                                Some(&format!("⚠️ У сесії лише {len} блок(ів).")),
                            );
                        }
                        skip_to_session(&ctx.app, st, n - 1)
                    }
                };
                let note = if snap.status == SessionStatus::Idle {
                    "🏁 Сесію завершено.".to_string()
                } else {
                    let name = snap
                        .blocks
                        .get(snap.current_idx)
                        .map(|b| b.name.clone())
                        .unwrap_or_default();
                    format!("⏭ Перейшли до «{name}».")
                };
                pomodoro_card(st, Some(&note))
            }
            PomodoroAction::Start(spec) => {
                let blocks = match parse_pomodoro_blocks(&spec, now_ms()) {
                    Ok(b) => b,
                    Err(e) => {
                        return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage()))
                    }
                };
                reveal_tab(&ctx.app, "pomodoro");
                match start_session(&ctx.app, st, blocks, None) {
                    Ok(snap) => {
                        let total_min: u32 = snap.blocks.iter().map(|b| b.duration_sec / 60).sum();
                        let summary = snap
                            .blocks
                            .iter()
                            .map(|b| {
                                format!("{}/{}", b.duration_sec / 60, posture_word(&b.posture))
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        pomodoro_card(
                            st,
                            Some(&format!("🍅 Стартував Pomodoro ({total_min} хв): {summary}")),
                        )
                    }
                    Err(e) => Reply::text(format!("⚠️ pomodoro: {e}")),
                }
            }
            PomodoroAction::Preset(id) => {
                let preset = st.repo.lock().ok().and_then(|r| r.get_preset(id).ok().flatten());
                let Some(preset) = preset else {
                    return pomodoro_card(st, Some(&format!("⚠️ Пресет #{id} не знайдено.")));
                };
                reveal_tab(&ctx.app, "pomodoro");
                match start_session(&ctx.app, st, preset.blocks.clone(), Some(preset.id)) {
                    Ok(_) => pomodoro_card(st, Some(&format!("🍅 Стартував пресет «{}».", preset.name))),
                    Err(e) => Reply::text(format!("⚠️ pomodoro: {e}")),
                }
            }
            PomodoroAction::Edit(spec) => {
                if is_idle {
                    return pomodoro_card(
                        st,
                        Some("ℹ️ Pomodoro не запущено — використай `start`."),
                    );
                }
                let blocks = match parse_pomodoro_blocks(&spec, now_ms()) {
                    Ok(b) => b,
                    Err(e) => {
                        return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage()))
                    }
                };
                let old = pomodoro_snapshot(st).map(|s| s.blocks).unwrap_or_default();
                let _ = edit_blocks_session(&ctx.app, st, reuse_block_ids(blocks, &old));
                pomodoro_card(st, Some("✏️ Блоки оновлено."))
            }
            PomodoroAction::Presets => pomodoro_presets_card(st, None),
            PomodoroAction::Delete { id, confirmed } => {
                let preset = st.repo.lock().ok().and_then(|r| r.get_preset(id).ok().flatten());
                let Some(preset) = preset else {
                    return pomodoro_presets_card(st, Some(&format!("⚠️ Пресет #{id} не знайдено.")));
                };
                if !confirmed {
                    return Reply {
                        text: format!("🗑 Видалити пресет «{}» (#{id})?", preset.name),
                        keyboard: Some(InlineKeyboard {
                            rows: vec![vec![
                                InlineButton::new(
                                    "✅ Так, видалити",
                                    format!("refresh:pomodoro:delete {id} yes"),
                                ),
                                InlineButton::new("↩️ Скасувати", "refresh:pomodoro:presets"),
                            ]],
                        }),
                        ..Default::default()
                    };
                }
                let res = st
                    .repo
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|mut r| r.delete_preset(id).map_err(|e| e.to_string()));
                match res {
                    Ok(()) => {
                        let _ = ctx.app.emit("pomodoro:presets_changed", id);
                        pomodoro_presets_card(st, Some(&format!("🗑 Пресет «{}» видалено.", preset.name)))
                    }
                    Err(e) => pomodoro_presets_card(st, Some(&format!("⚠️ {e}"))),
                }
            }
            PomodoroAction::History(limit) => pomodoro_history_card(st, limit),
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

/// Quick-start presets offered on the idle card (label, block spec).
const POMODORO_QUICK_STARTS: &[(&str, &str)] = &[
    ("⚡ 25/5", "25/sit 5/walk"),
    ("⚡ 50/10", "50/sit 10/walk"),
    ("⚡ 3×25", "25/sit 5/walk 25/sit 5/walk 25/sit 5/walk"),
];

/// Live control card. Buttons use `refresh:` so taps edit this message.
fn pomodoro_keyboard(status: SessionStatus, presets: &[(i64, String)]) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:pomodoro:{args}"));
    let rows = match status {
        SessionStatus::Running | SessionStatus::Paused => {
            let transport = if status == SessionStatus::Running {
                b("⏸ Пауза", "pause")
            } else {
                b("▶️ Далі", "resume")
            };
            vec![
                vec![transport, b("⏭ Skip", "skip"), b("⏹ Стоп", "stop")],
                vec![b("🔄", "status")],
            ]
        }
        SessionStatus::Idle => {
            let mut rows: Vec<Vec<InlineButton>> = Vec::new();
            let preset_btns: Vec<InlineButton> = presets
                .iter()
                .take(6)
                .map(|(id, name)| {
                    let short: String = name.chars().take(18).collect();
                    b(&format!("🍅 {short}"), &format!("preset {id}"))
                })
                .collect();
            for chunk in preset_btns.chunks(2) {
                rows.push(chunk.to_vec());
            }
            rows.push(
                POMODORO_QUICK_STARTS
                    .iter()
                    .map(|(label, spec)| b(label, &format!("start {spec}")))
                    .filter(|btn| btn.callback_data.len() <= 64)
                    .collect(),
            );
            rows.push(vec![
                b("📚 Пресети", "presets"),
                b("📜 Історія", "history"),
                b("🔄", "status"),
            ]);
            rows
        }
    };
    InlineKeyboard { rows }
}

fn pomodoro_card(state: &Arc<PomodoroState>, note: Option<&str>) -> Reply {
    let snap = pomodoro_snapshot(state);
    let status = snap.as_ref().map(|s| s.status).unwrap_or(SessionStatus::Idle);
    let mut text = format_pomodoro_status(state);
    if let Some(s) = &snap {
        if status != SessionStatus::Idle {
            if let Some(nb) = s.blocks.get(s.current_idx + 1) {
                text.push_str(&format!(
                    "\n⏭ Далі: {} · {} хв",
                    nb.name,
                    (nb.duration_sec + 59) / 60
                ));
            } else {
                text.push_str("\n🏁 Останній блок");
            }
            if status == SessionStatus::Paused {
                text.push_str("\n⏸ На паузі");
            }
        } else {
            text.push_str("\nОбери пресет або швидкий старт:");
        }
    }
    let presets = pomodoro_preset_names(state);
    let text = match note {
        Some(n) => format!("{n}\n\n{text}"),
        None => text,
    };
    Reply {
        text,
        keyboard: Some(pomodoro_keyboard(status, &presets)),
        ..Default::default()
    }
}

fn pomodoro_preset_names(state: &Arc<PomodoroState>) -> Vec<(i64, String)> {
    state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_presets().ok())
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.id, p.name))
        .collect()
}

fn pomodoro_presets_card(state: &Arc<PomodoroState>, note: Option<&str>) -> Reply {
    let presets = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_presets().ok())
        .unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    if let Some(n) = note {
        lines.push(n.to_string());
        lines.push(String::new());
    }
    if presets.is_empty() {
        lines.push("📚 Збережених пресетів нема. Створи у вкладці Pomodoro або попроси асистента.".into());
    } else {
        lines.push("📚 Пресети Pomodoro:".into());
    }
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    for p in presets.iter().take(10) {
        let total_min: u32 = p.blocks.iter().map(|b| b.duration_sec).sum::<u32>() / 60;
        let spec = p
            .blocks
            .iter()
            .map(|b| format!("{}/{}", (b.duration_sec + 59) / 60, posture_word(&b.posture)))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("#{} {} — {total_min} хв · {spec}", p.id, p.name));
        let short: String = p.name.chars().take(20).collect();
        rows.push(vec![
            InlineButton::new(format!("▶️ {short}"), format!("refresh:pomodoro:preset {}", p.id)),
            InlineButton::new("🗑", format!("refresh:pomodoro:delete {}", p.id)),
        ]);
    }
    rows.push(vec![InlineButton::new("⬅️ Назад", "refresh:pomodoro:status")]);
    Reply {
        text: lines.join("\n"),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

/// "5 хв тому" / "3 год тому" / "2 дн тому" — no chrono in the tree.
fn format_ago(secs: i64) -> String {
    let s = secs.max(0);
    if s < 3600 {
        format!("{} хв тому", s / 60)
    } else if s < 86_400 {
        format!("{} год тому", s / 3600)
    } else {
        format!("{} дн тому", s / 86_400)
    }
}

fn pomodoro_history_card(state: &Arc<PomodoroState>, limit: u32) -> Reply {
    let rows = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_sessions(limit).ok())
        .unwrap_or_default();
    let now = now_secs();
    let mut lines = vec![format!("📜 Останні сесії ({}):", rows.len())];
    if rows.is_empty() {
        lines = vec!["📜 Історія порожня.".into()];
    }
    for r in &rows {
        let total = r.blocks.len();
        let done = r.completed_idx.min(total);
        let focus_min: u32 = r
            .blocks
            .iter()
            .take(done)
            .map(|b| b.duration_sec)
            .sum::<u32>()
            / 60;
        let state_icon = if r.ended_at.is_none() {
            "▶️"
        } else if done >= total {
            "✅"
        } else {
            "⏹"
        };
        lines.push(format!(
            "{state_icon} {} — {done}/{total} блоків · {focus_min} хв",
            format_ago(now - r.started_at)
        ));
    }
    Reply {
        text: lines.join("\n"),
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![
                InlineButton::new("⬅️ Назад", "refresh:pomodoro:status"),
                InlineButton::new("🔄", format!("refresh:pomodoro:history {limit}")),
            ]],
        }),
        ..Default::default()
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
        let (dur_str, posture_str) = tok.split_once('/').ok_or_else(|| {
            format!("блок {i} має бути `<тривалість>/<posture>`, отримано `{tok}`")
        })?;
        let duration_sec = parse_duration_to_sec(dur_str).map_err(|e| format!("блок {i}: {e}"))?;
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
            other => {
                return Err(format!(
                    "блок {i}: невідома posture `{other}` (sit|stand|walk)"
                ))
            }
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

async fn handle_power_cmd(timers: &Arc<PowerTimers>, kind: PowerKind, args: &str) -> Reply {
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
        // Typed `/sleep` stays immediate; buttons go through `ask` → `now`.
        "" | "now" => immediate(kind).await,
        "ask" => power_confirm_card(kind),
        "no" => Reply::text(format!("👌 {} скасовано.", label(kind, true))),
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

/// Second-tap confirmation for the one-tap power buttons (battery alert,
/// dashboard). Both answers edit this card in place.
fn power_confirm_card(kind: PowerKind) -> Reply {
    let (text, yes) = match kind {
        PowerKind::Sleep => ("💤 Приспати Mac зараз?", "✅ Так, приспати"),
        PowerKind::Shutdown => ("⏻ Вимкнути Mac зараз?", "✅ Так, вимкнути"),
    };
    let cmd = kind_word(kind);
    Reply {
        text: text.to_string(),
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![
                InlineButton::new(yes, format!("refresh:{cmd}:now")),
                InlineButton::new("✖ Ні", format!("refresh:{cmd}:no")),
            ]],
        }),
        ..Default::default()
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
                let suffix = if it.content.chars().count() > 40 {
                    "…"
                } else {
                    ""
                };
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
                InlineButton::new("💤 Sleep", "sleep:ask"),
                InlineButton::new("🌙 Display off", "display"),
                InlineButton::new("❓ Help", "help"),
            ],
        ],
        // Page 3 — jump to any app tab.
        _ => vec![
            vec![
                InlineButton::new("📋 Clipboard", "navigate:clipboard"),
                InlineButton::new("🌍 Translator", "navigate:translator"),
                InlineButton::new("📝 Notes", "navigate:notes"),
            ],
            vec![
                InlineButton::new("🤖 AI", "navigate:ai"),
                InlineButton::new("✉️ Telegram", "navigate:telegram"),
                InlineButton::new("🎸 Valeton", "navigate:valeton-editor"),
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
            vec![
                InlineButton::new("🖼 Canvas", "navigate:canvas"),
                InlineButton::new("🔄 Converter", "navigate:converter"),
                InlineButton::new("🎚 Stems", "navigate:separator"),
            ],
            vec![
                InlineButton::new("⏰ Reminders", "navigate:reminders"),
                InlineButton::new("🛠 Dev", "navigate:dev"),
                InlineButton::new("🔧 Settings", "navigate:settings"),
            ],
        ],
    };
    // Footer row is shared: Refresh self + paginate. Arrows wrap around
    // so you can tap Next on the last page and land on page 1.
    let prev_page = if page == 1 { DASHBOARD_PAGES } else { page - 1 };
    let next_page = if page == DASHBOARD_PAGES { 1 } else { page + 1 };
    rows.push(vec![super::menu::menu_button()]);
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

// -------------------- voice action buttons --------------------

/// Helper used by the voice-transcript flow in `transport.rs` to build
/// the action keyboard that lands under each `📝 …` message. Each
/// button's callback_data points at the `voice` command below.
pub fn voice_action_keyboard(inbox_id: i64) -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![
            vec![
                InlineButton::new("🤖 Reply", format!("voice:reply:{inbox_id}")),
                InlineButton::new("📋 Summary", format!("voice:summary:{inbox_id}")),
            ],
            vec![
                InlineButton::new("🌐 EN", format!("voice:translate:{inbox_id}")),
                InlineButton::new("✏️ Improve", format!("voice:improve:{inbox_id}")),
            ],
        ],
    }
}

/// Inline-button handler for `voice:<action>:<inbox_id>`. Replaces the
/// old "auto-reply on every transcript" flow — the transcript itself
/// lands as plain text under the user's voice note, and any AI follow
/// -up is opt-in per message via the buttons we attach to it.
pub struct VoiceActionCmd {
    state: Arc<TelegramState>,
}

impl VoiceActionCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for VoiceActionCmd {
    fn name(&self) -> &'static str {
        "voice"
    }
    fn description(&self) -> &'static str {
        "Run an AI action over a recently-transcribed voice note"
    }
    fn usage(&self) -> &'static str {
        "(driven by the inline buttons under each transcript)"
    }

    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        // args = "<action>:<inbox_id>". Empty action is treated as a
        // no-op button (e.g. a ✕ "dismiss" we may add later) so the
        // user can tap to clear the keyboard without errors.
        let (action, id_str) = match args.split_once(':') {
            Some(p) => p,
            None => return Reply::text("⚠️ /voice: missing inbox id"),
        };
        let id: i64 = match id_str.parse() {
            Ok(n) => n,
            Err(_) => return Reply::text("⚠️ /voice: bad inbox id"),
        };

        let transcript = match self.state.repo.lock() {
            Ok(repo) => repo.inbox_transcript(id).unwrap_or(None),
            Err(e) => return Reply::text(format!("⚠️ /voice: {e}")),
        };
        let Some(transcript) = transcript.filter(|s| !s.trim().is_empty()) else {
            return Reply::text(
                "⚠️ Транскрипт уже видалено або порожній — спробуй надіслати голосове ще раз.",
            );
        };

        let prompt = match action {
            // "Reply" sends the transcript through the assistant as if
            // the user had typed it themselves — preserves history,
            // tool calls, the works.
            "reply" => transcript.clone(),
            "summary" => format!(
                "Підсумуй коротко українською (1-3 речення), без преамбули, лише суть:\n\n{transcript}"
            ),
            "translate" => format!(
                "Translate the following Ukrainian text to natural English. \
                 Reply with the translation only, no commentary:\n\n{transcript}"
            ),
            "improve" => format!(
                "Виправ граматику й стиль українською. Поверни лише виправлений текст:\n\n{transcript}"
            ),
            other => return Reply::text(format!("⚠️ /voice: unknown action `{other}`")),
        };

        match super::assistant::handle_user_text(&ctx.app, &self.state, &prompt).await {
            Ok(reply) => {
                let body = reply.text.trim();
                if body.is_empty() {
                    Reply::text("🤖 (нічого нового додати)")
                } else {
                    Reply::text(format!("🤖 {body}"))
                }
            }
            Err(e) => Reply::text(format!("🤖 ⚠️ не вдалося опрацювати: {e}")),
        }
    }
}

#[cfg(test)]
mod voice_action_tests {
    use super::*;

    #[test]
    fn keyboard_carries_inbox_id_in_every_callback() {
        let kb = voice_action_keyboard(42);
        let actions: Vec<&str> = kb
            .rows
            .iter()
            .flat_map(|r| r.iter().map(|b| b.callback_data.as_str()))
            .collect();
        assert!(actions.contains(&"voice:reply:42"));
        assert!(actions.contains(&"voice:summary:42"));
        assert!(actions.contains(&"voice:translate:42"));
        assert!(actions.contains(&"voice:improve:42"));
    }
}

// ────────────────────────────────────────────────────────────────────
// /stems and /bpm — Demucs + BeatNet over the Telegram surface.
// ────────────────────────────────────────────────────────────────────
//
// Both commands accept a local file path as the first argument. URLs are
// not supported here on purpose: downloading a YouTube video from inside
// Telegram is the `downloader` module's job, and forcing the two paths
// to fight over yt-dlp / cookies / progress events would tangle the
// surfaces. The intended flow is "save with /dl, then /stems".

use crate::modules::separator;

pub struct SeparateStemsCmd;

#[async_trait]
impl CommandHandler for SeparateStemsCmd {
    fn name(&self) -> &'static str {
        "stems"
    }
    fn description(&self) -> &'static str {
        "Split audio into 6 stems (vocals/drums/bass/guitar/piano/other) + detect BPM. Demucs+BeatNet, local."
    }
    fn usage(&self) -> &'static str {
        "/stems <file_path> [stems_csv]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        run_separator_cmd(ctx, args, separator::SeparatorRunArgs {
            input_path: String::new(),
            model: None,
            mode: Some("analyze".into()),
            stems: None,
            output_dir: None,
        })
        .await
    }
}

pub struct DetectBpmCmd;

#[async_trait]
impl CommandHandler for DetectBpmCmd {
    fn name(&self) -> &'static str {
        "bpm"
    }
    fn description(&self) -> &'static str {
        "Detect BPM of an audio file without stem separation. BeatNet, local."
    }
    fn usage(&self) -> &'static str {
        "/bpm <file_path>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        run_separator_cmd(ctx, args, separator::SeparatorRunArgs {
            input_path: String::new(),
            model: None,
            mode: Some("bpm".into()),
            stems: None,
            output_dir: None,
        })
        .await
    }
}

/// Stem names the separator understands — used to tell a trailing
/// `stems_csv` apart from the last word of an unquoted path.
const STEM_NAMES: [&str; 6] = ["vocals", "drums", "bass", "guitar", "piano", "other"];

/// Parse `/stems` / `/bpm` args: `<path> [stems_csv]`.
///
/// The path may contain spaces (downloaded titles usually do): either
/// quote it (`"…"` or `'…'`, the rest must be a stems list), or leave it
/// bare — then trailing words that are known stem names / comma lists
/// (`vocals, drums`, `vocals,bass`) are peeled off as stems and the rest
/// is the path. If the peeled path doesn't exist on disk but the whole
/// argument string does, the whole string wins. `None` when no path given.
pub fn parse_separator_args(args: &str) -> Option<(String, Option<Vec<String>>)> {
    parse_separator_args_with(args, |p| std::path::Path::new(p).is_file())
}

/// Pure core of [`parse_separator_args`] with an injectable "file exists"
/// predicate so the disambiguation is unit-testable.
fn parse_separator_args_with(
    args: &str,
    exists: impl Fn(&str) -> bool,
) -> Option<(String, Option<Vec<String>>)> {
    let args = args.trim();
    let quoted = args
        .chars()
        .next()
        .filter(|c| *c == '"' || *c == '\'')
        .and_then(|q| {
            let close = args[1..].find(q)? + 1;
            let rest = args[close + 1..].trim();
            // The remainder after a closing quote must be a stems list;
            // otherwise the quote was part of the name (`'Rock 'n' Roll.mp3'`).
            (rest.is_empty() || is_stems_list(rest))
                .then(|| (args[1..close].to_string(), rest.to_string()))
        });
    let (path, mut rest) = match quoted {
        Some(pair) => pair,
        None => {
            let (head, tail) = split_trailing_stems(strip_outer_quotes(args));
            (head.to_string(), tail.to_string())
        }
    };
    let mut path = path.trim().to_string();
    if !path.is_empty() && !exists(&path) {
        let whole = strip_outer_quotes(args).trim();
        if whole != path && exists(whole) {
            path = whole.to_string();
            rest.clear();
        }
    }
    if path.is_empty() {
        return None;
    }
    let stems: Vec<String> = rest
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect();
    Some((path, (!stems.is_empty()).then_some(stems)))
}

/// `"…"` / `'…'` wrapping the whole string → inner text; a lone dangling
/// quote at either end is dropped.
fn strip_outer_quotes(s: &str) -> &str {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s.trim_matches(['"', '\''])
}

/// Peel trailing whitespace-separated tokens that are stem names / comma
/// lists off a bare path. Returns `(path_part, stems_part)`; the path part
/// always keeps at least its first token.
fn split_trailing_stems(s: &str) -> (&str, &str) {
    let s = s.trim();
    let mut head = s;
    while let Some((h, last)) = head.rsplit_once(char::is_whitespace) {
        // A lone `,` (from `vocals , bass`) is a separator, not a path word.
        let sep_only = last.chars().all(|c| c == ',');
        if h.trim().is_empty() || !(sep_only || is_stems_list(last)) {
            break;
        }
        head = h.trim_end();
    }
    let tail = s[head.len()..].trim();
    if is_stems_list(tail) {
        (head, tail)
    } else {
        (s, "")
    }
}

/// Text made solely of known stem names separated by commas / whitespace.
fn is_stems_list(s: &str) -> bool {
    let mut parts = s
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|x| !x.is_empty())
        .peekable();
    parts.peek().is_some() && parts.all(|x| STEM_NAMES.contains(&x.to_ascii_lowercase().as_str()))
}

async fn run_separator_cmd(
    ctx: Ctx,
    args: &str,
    mut spec: separator::SeparatorRunArgs,
) -> Reply {
    let Some((path, stems)) = parse_separator_args(args) else {
        return Reply::text("⚠️ /stems <file_path> [stems_csv]");
    };
    if !std::path::Path::new(&path).is_file() {
        return Reply::text(format!("⚠️ файл не знайдено: {path}"));
    }
    spec.input_path = path;
    if stems.is_some() {
        spec.stems = stems;
    }
    match enqueue_separator(&ctx.app, spec) {
        Ok((state, job_id)) => await_separator_job(&state, &job_id).await,
        Err(e) => Reply::text(format!("⚠️ {e}")),
    }
}

/// Queue a Demucs/BeatNet job. Returns the separator state + job id to
/// hand to `await_separator_job`. Shared with the downloader's buttons.
pub fn enqueue_separator(
    app: &tauri::AppHandle,
    spec: separator::SeparatorRunArgs,
) -> Result<(Arc<separator::SeparatorState>, String), String> {
    let state = app
        .try_state::<Arc<separator::SeparatorState>>()
        .map(|s| Arc::clone(&s))
        .ok_or("модуль Stems не ініціалізовано")?;
    let job_id = separator::enqueue_job(app, &state, spec)?;
    Ok((state, job_id))
}

/// Wait for a separator job to settle and render the result card.
pub async fn await_separator_job(state: &Arc<separator::SeparatorState>, job_id: &str) -> Reply {
    // The sidecar is single-job, so we poll the in-memory state every
    // 500ms; this matches the cadence of the UI's progress events without
    // overloading the lock. Hard cap of 30 minutes per job — stems
    // separation on CPU averages 2-5× realtime, and a 30-minute cap
    // covers any realistic input.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30 * 60);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if std::time::Instant::now() > deadline {
            return Reply::text("⚠️ Stems: таймаут (30 хв)");
        }
        let snapshot = state
            .jobs
            .lock()
            .unwrap()
            .iter()
            .find(|j| j.id == job_id)
            .cloned();
        let Some(job) = snapshot else {
            return Reply::text("⚠️ Stems: задачу втрачено");
        };
        match job.status {
            separator::JobStatus::Completed => return reply_for_completed_job(&job),
            separator::JobStatus::Failed => {
                let err = job.error.unwrap_or_else(|| "unknown".into());
                let head = err.lines().next().unwrap_or(&err).to_string();
                return Reply::text(format!("⚠️ Stems: {head}"));
            }
            separator::JobStatus::Cancelled => {
                return Reply::text("✖ Stems: скасовано");
            }
            _ => continue,
        }
    }
}

fn reply_for_completed_job(job: &separator::SeparatorJob) -> Reply {
    let result = job.result.as_ref();
    let bpm_line = result
        .and_then(|r| r.bpm)
        .map(|b| format!("BPM: {b:.1}"))
        .unwrap_or_default();
    let stems_map = result.and_then(|r| r.stems.as_ref());

    let mut text = String::new();
    if let Some(stems) = stems_map {
        text.push_str(&format!("🎚 Стеми готові ({})\n", stems.len()));
    } else {
        text.push_str("🎚 Готово\n");
    }
    if !bpm_line.is_empty() {
        text.push_str(&bpm_line);
        text.push('\n');
    }
    if let Some(stems) = stems_map {
        for name in [
            "vocals", "drums", "bass", "guitar", "piano", "other",
        ] {
            if let Some(p) = stems.get(name) {
                text.push_str(&format!("• {name}: {p}\n"));
            }
        }
    }

    let documents = stems_map
        .map(|m| {
            let order = ["vocals", "drums", "bass", "guitar", "piano", "other"];
            let mut paths: Vec<std::path::PathBuf> = order
                .iter()
                .filter_map(|k| m.get(*k))
                .map(std::path::PathBuf::from)
                .collect();
            // Anything the model emits that isn't in our preferred order
            // (future stems, custom subsets) still gets attached.
            for (k, v) in m {
                if !order.contains(&k.as_str()) {
                    paths.push(std::path::PathBuf::from(v));
                }
            }
            paths
        })
        .unwrap_or_default();
    // Telegram rejects bot uploads over 50 MB — keep those on disk only.
    let limit = crate::modules::downloader::agent::TELEGRAM_UPLOAD_LIMIT;
    let (documents, big): (Vec<_>, Vec<_>) = documents
        .into_iter()
        .partition(|p| std::fs::metadata(p).is_ok_and(|m| m.len() < limit));
    if !big.is_empty() {
        text.push_str(&format!(
            "{} файл(и) завеликі для Telegram — див. вкладку Stems\n",
            big.len()
        ));
    }

    Reply {
        text: text.trim_end().to_string(),
        documents,
        keyboard: None,
    }
}

#[cfg(test)]
mod separator_args_tests {
    use super::{parse_separator_args, parse_separator_args_with};

    fn v(xs: &[&str]) -> Option<Vec<String>> {
        Some(xs.iter().map(|x| x.to_string()).collect())
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(parse_separator_args("   "), None);
        assert_eq!(parse_separator_args("\"\""), None);
    }

    #[test]
    fn bare_path_with_spaces_is_whole_remainder() {
        assert_eq!(
            parse_separator_args("  /Users/me/Downloads/My Song (Live) .mp3  "),
            Some(("/Users/me/Downloads/My Song (Live) .mp3".into(), None))
        );
    }

    #[test]
    fn bare_path_with_trailing_stems_csv() {
        assert_eq!(
            parse_separator_args("/tmp/My Song.mp3 vocals,Drums"),
            Some(("/tmp/My Song.mp3".into(), v(&["vocals", "Drums"])))
        );
        // A last word that isn't a stems list stays part of the path.
        assert_eq!(
            parse_separator_args("/tmp/Song vocals live.mp3"),
            Some(("/tmp/Song vocals live.mp3".into(), None))
        );
    }

    #[test]
    fn quoted_path_then_stems() {
        assert_eq!(
            parse_separator_args("\"/tmp/a b.wav\" vocals, bass"),
            Some(("/tmp/a b.wav".into(), v(&["vocals", "bass"])))
        );
        assert_eq!(
            parse_separator_args("'/tmp/it\"s.wav'"),
            Some(("/tmp/it\"s.wav".into(), None))
        );
    }

    #[test]
    fn bare_path_with_spaced_stems_list() {
        assert_eq!(
            parse_separator_args_with("/tmp/a.mp3 vocals, drums", |_| true),
            Some(("/tmp/a.mp3".into(), v(&["vocals", "drums"])))
        );
        assert_eq!(
            parse_separator_args_with("/tmp/My Song.mp3 vocals , bass,  piano", |_| true),
            Some(("/tmp/My Song.mp3".into(), v(&["vocals", "bass", "piano"])))
        );
    }

    #[test]
    fn whole_args_win_when_peeled_path_missing() {
        // A file literally named "Best of drums": the peeled "/tmp/Best of"
        // doesn't exist, the full string does.
        let exists = |p: &str| p == "/tmp/Best of drums";
        assert_eq!(
            parse_separator_args_with("/tmp/Best of drums", exists),
            Some(("/tmp/Best of drums".into(), None))
        );
        // Neither exists: keep the peeled interpretation (caller reports).
        assert_eq!(
            parse_separator_args_with("/tmp/x.mp3 drums", |_| false),
            Some(("/tmp/x.mp3".into(), v(&["drums"])))
        );
    }

    #[test]
    fn quoted_remainder_must_be_stems() {
        assert_eq!(
            parse_separator_args_with("'/tmp/Rock 'n' Roll.mp3'", |_| true),
            Some(("/tmp/Rock 'n' Roll.mp3".into(), None))
        );
        assert_eq!(
            parse_separator_args_with("\"/tmp/a b.wav\" vocals drums", |_| true),
            Some(("/tmp/a b.wav".into(), v(&["vocals", "drums"])))
        );
    }

    #[test]
    fn unterminated_quote_falls_back_to_bare() {
        assert_eq!(
            parse_separator_args("\"/tmp/a b.wav"),
            Some(("/tmp/a b.wav".into(), None))
        );
    }
}

// -------------------- /keepawake --------------------

pub struct KeepAwakeCmd;

#[async_trait]
impl CommandHandler for KeepAwakeCmd {
    fn name(&self) -> &'static str {
        "keepawake"
    }
    fn description(&self) -> &'static str {
        "Не давати Mac засинати. on вмикає caffeinate + щогодинне нагадування, off вимикає."
    }
    fn usage(&self) -> &'static str {
        "/keepawake on|off|status"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        use tauri::Manager;
        let action = args.trim().to_ascii_lowercase();
        let state = match ctx
            .app
            .try_state::<std::sync::Arc<crate::modules::keepawake::KeepAwakeState>>()
        {
            Some(s) => s,
            None => {
                return Reply::text("⚠️ keepawake state not initialised (app setup issue)");
            }
        };

        let want = match action.as_str() {
            "" | "status" => None,
            "on" | "1" | "true" | "enable" | "увімкни" | "увімкнути" => Some(true),
            "off" | "0" | "false" | "disable" | "вимкни" | "вимкнути" => Some(false),
            other => {
                return Reply::text(format!(
                    "❓ Невідомо: `{other}`. Використання: {}",
                    self.usage()
                ));
            }
        };

        let status_now = match want {
            Some(target) => match crate::modules::keepawake::commands::set(&ctx.app, state.inner(), target) {
                Ok(s) => s,
                Err(e) => return Reply::text(format!("⚠️ keepawake: {e}")),
            },
            None => crate::modules::keepawake::commands::status(state.inner()),
        };

        if status_now.active {
            let elapsed = status_now
                .since_unix
                .map(|s| (now_ms() / 1000 - s).max(0))
                .unwrap_or(0);
            let h = elapsed / 3600;
            let m = (elapsed % 3600) / 60;
            keepawake_card(
                format!(
                    "☕ Mac не засинає (≈{h} год {m:02} хв). \
                     Нагадування — щогодини. Вимкнути: /keepawake off"
                ),
                true,
            )
        } else {
            keepawake_card(
                "💤 Mac засинає як зазвичай. Увімкнути keep-awake: /keepawake on".into(),
                false,
            )
        }
    }
}

fn keepawake_card(text: String, active: bool) -> Reply {
    let toggle = if active {
        InlineButton::new("💤 Вимкнути", "refresh:keepawake:off")
    } else {
        InlineButton::new("☕ Увімкнути", "refresh:keepawake:on")
    };
    Reply {
        text,
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![toggle, InlineButton::new("🔄", "refresh:keepawake:status")]],
        }),
        ..Default::default()
    }
}

// -------------------- /claude_code --------------------

pub struct LaunchClaudeCmd;

#[async_trait]
impl CommandHandler for LaunchClaudeCmd {
    fn name(&self) -> &'static str {
        "claude_code"
    }
    fn description(&self) -> &'static str {
        "Запустити Claude Code у Terminal-вкладці Stash, використовуючи Launcher command із Settings."
    }
    fn usage(&self) -> &'static str {
        "/claude_code"
    }
    async fn handle(&self, ctx: Ctx, _args: &str) -> Reply {
        // Reveal the Terminal tab first — TerminalShell mounts lazily,
        // and we need its event listener wired before we ask it to
        // launch Claude.
        reveal_tab(&ctx.app, "terminal");
        // Give the lazy import + React mount a moment to settle,
        // then emit. The pane-side listener replays the event if it
        // arrives during mount, but the delay keeps the common path
        // race-free without that fallback firing.
        let app = ctx.app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;
            let _ = app.emit("terminal:launch_claude", ());
        });
        Reply::text("💻 Відкриваю Terminal і запускаю Claude Code…")
    }
}

// -------------------- /update --------------------

pub struct UpdateCmd;

#[async_trait]
impl CommandHandler for UpdateCmd {
    fn name(&self) -> &'static str {
        "update"
    }
    fn description(&self) -> &'static str {
        "Перевірити оновлення Stash; без аргументів — завантажити, встановити й перезапустити"
    }
    fn usage(&self) -> &'static str {
        "/update [check]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        use tauri_plugin_updater::UpdaterExt;

        let current = ctx.app.package_info().version.to_string();
        let check_only = match args.trim() {
            "" | "install" => false,
            "check" => true,
            other => return Reply::text(format!("Невідомий аргумент «{other}». Використання: /update [check]")),
        };
        let update = match ctx.app.updater() {
            Ok(u) => match u.check().await {
                Ok(u) => u,
                Err(e) => return Reply::text(format!("⚠️ Не вдалося перевірити оновлення: {e}")),
            },
            Err(e) => return Reply::text(format!("⚠️ Updater недоступний: {e}")),
        };
        let Some(update) = update else {
            return Reply::text(format!("✅ Stash v{current} — це остання версія."));
        };
        let latest = update.version.clone();
        if check_only {
            return Reply::text(format!(
                "⬆️ Доступна v{latest} (зараз v{current}). Встановити: /update"
            ));
        }
        // Download + install runs detached: the archive can take longer than
        // the CLI/MCP 60 s reply timeout, and the restart kills this process
        // anyway, so the caller gets an immediate ack instead.
        let app = ctx.app.clone();
        tauri::async_runtime::spawn(async move {
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => {
                    tracing::info!(version = %update.version, "update: installed, restarting");
                    app.restart();
                }
                Err(e) => tracing::warn!(error = %e, "update: download/install failed"),
            }
        });
        Reply::text(format!(
            "⬇️ Встановлюю v{latest} (зараз v{current}). Stash перезапуститься сам за хвилину."
        ))
    }
}

#[cfg(test)]
mod cockpit_tests {
    use super::*;

    fn all_callbacks(kb: &InlineKeyboard) -> Vec<String> {
        kb.rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.clone())
            .collect()
    }

    fn assert_fits(kb: &InlineKeyboard) {
        for data in all_callbacks(kb) {
            assert!(data.len() <= 64, "callback too long ({}): {data}", data.len());
        }
    }

    fn preset(id: &str, name: &str, n: u8) -> MetronomePreset {
        MetronomePreset {
            id: id.into(),
            name: name.into(),
            bpm: 90,
            numerator: n,
            denominator: 4,
            subdivision: 2,
            sound: "wood".into(),
            beat_accents: (0..n).map(|i| i == 0).collect(),
        }
    }

    // ---- metronome ----

    #[test]
    fn metronome_parses_relative_bpm_and_new_knobs() {
        let r = parse_metronome_args(
            "bpm=+5 vol=60 accent_vol=85% accents=x.x. trainer=on trainer_step=2 trainer_bars=8 trainer_target=180",
        )
        .unwrap();
        assert_eq!(r.bpm, None);
        assert_eq!(r.bpm_delta, Some(5));
        assert_eq!(r.click_volume, Some(60));
        assert_eq!(r.accent_volume, Some(85));
        assert_eq!(r.beat_accents, Some(vec![true, false, true, false]));
        assert_eq!(r.trainer_enabled, Some(true));
        assert_eq!(r.trainer_step, Some(2));
        assert_eq!(r.trainer_bars, Some(8));
        assert_eq!(r.trainer_target, Some(180));
        assert_eq!(parse_metronome_args("bpm=-1").unwrap().bpm_delta, Some(-1));
    }

    #[test]
    fn metronome_rejects_bad_new_knobs() {
        assert!(parse_metronome_args("vol=150").unwrap_err().contains("vol"));
        assert!(parse_metronome_args("accents=1z0").unwrap_err().contains("accents"));
        assert!(parse_metronome_args("trainer=maybe").unwrap_err().contains("trainer"));
        assert!(parse_metronome_args("trainer_step=99").unwrap_err().contains("trainer_step"));
        assert!(parse_metronome_args("save=").unwrap_err().contains("save"));
    }

    #[test]
    fn metronome_quoted_preset_names_keep_case_and_spaces() {
        assert_eq!(
            tokenize_quoted(r#"start save="Slow Blues" bpm=80"#),
            vec!["start", "save=Slow Blues", "bpm=80"]
        );
        let r = parse_metronome_args(r#"preset="Slow Blues""#).unwrap();
        assert_eq!(r.preset.as_deref(), Some("Slow Blues"));
    }

    #[test]
    fn metronome_resolve_relative_bpm_clamps() {
        let cur = MetronomeState {
            bpm: 238,
            ..Default::default()
        };
        let args = parse_metronome_args("bpm=+5").unwrap();
        let (remote, next) = resolve_metronome(&args, &cur, 1).unwrap();
        assert_eq!(remote.bpm, Some(240));
        assert_eq!(next.bpm, 240);
        assert!(remote.numerator.is_none(), "untouched fields stay None");
    }

    #[test]
    fn metronome_resolve_applies_preset_then_explicit_fields() {
        let mut cur = MetronomeState::default();
        cur.presets.push(preset("p_a", "Waltz", 3));
        let args = parse_metronome_args("preset=waltz bpm=+10").unwrap();
        let (remote, next) = resolve_metronome(&args, &cur, 1).unwrap();
        assert_eq!(next.bpm, 100);
        assert_eq!(next.numerator, 3);
        assert_eq!(next.sound, "wood");
        assert_eq!(remote.beat_accents, Some(vec![true, false, false]));
        assert!(resolve_metronome(&parse_metronome_args("preset=nope").unwrap(), &cur, 1).is_err());
    }

    #[test]
    fn metronome_resolve_saves_overwrites_and_deletes_presets() {
        let cur = MetronomeState::default();
        let (remote, next) =
            resolve_metronome(&parse_metronome_args("bpm=120 save=Mine").unwrap(), &cur, 42).unwrap();
        assert_eq!(next.presets.len(), 1);
        assert_eq!(next.presets[0].bpm, 120);
        assert_eq!(remote.presets.as_ref().map(|p| p.len()), Some(1));
        let id = next.presets[0].id.clone();
        // Same name (different case) overwrites in place, keeping the id.
        let (_, next2) =
            resolve_metronome(&parse_metronome_args("bpm=130 save=mine").unwrap(), &next, 43).unwrap();
        assert_eq!(next2.presets.len(), 1);
        assert_eq!(next2.presets[0].id, id);
        assert_eq!(next2.presets[0].bpm, 130);
        let (remote3, next3) =
            resolve_metronome(&parse_metronome_args(&format!("delete={id}")).unwrap(), &next2, 44)
                .unwrap();
        assert!(next3.presets.is_empty());
        assert_eq!(remote3.presets, Some(vec![]));
    }

    #[test]
    fn metronome_resolve_validates_accents_against_resulting_numerator() {
        let cur = MetronomeState::default(); // 4/4
        let err = resolve_metronome(&parse_metronome_args("accents=101").unwrap(), &cur, 1)
            .unwrap_err();
        assert!(err.contains("accents"));
        let (_, next) =
            resolve_metronome(&parse_metronome_args("sig=3/4 accents=101").unwrap(), &cur, 1)
                .unwrap();
        assert_eq!(next.beat_accents, vec![true, false, true]);
        // Signature change alone reshapes like the tab does.
        let (_, next) =
            resolve_metronome(&parse_metronome_args("sig=6/8").unwrap(), &cur, 1).unwrap();
        assert_eq!(next.beat_accents.len(), 6);
        assert!(next.beat_accents[0]);
    }

    #[test]
    fn metronome_resolve_merges_trainer_and_volumes() {
        let cur = MetronomeState::default();
        let (remote, next) =
            resolve_metronome(&parse_metronome_args("trainer=on vol=50").unwrap(), &cur, 1).unwrap();
        let t = remote.trainer.unwrap();
        assert!(t.enabled);
        assert_eq!(t.step_bpm, cur.trainer.step_bpm, "unset trainer fields preserved");
        assert!((next.click_volume - 0.5).abs() < 1e-6);
        assert_eq!(remote.click_volume, Some(0.5));
    }

    #[test]
    fn metronome_card_reflects_state_and_buttons_fit() {
        let mut st = MetronomeState::default();
        st.presets
            .push(preset("p_lzx9k2q1_ab12", "A very long preset name indeed", 4));
        st.presets.push(preset(&"x".repeat(60), "Too long id", 4));
        let text = format_metronome_card(&st, Some(true));
        assert!(text.starts_with("▶️ 100 BPM · 4/4"));
        let kb = metronome_keyboard(&st, Some(true));
        assert_fits(&kb);
        let data = all_callbacks(&kb);
        assert!(data.contains(&"refresh:metronome:stop".to_string()));
        assert!(data.contains(&"refresh:metronome:bpm=+5".to_string()));
        assert!(data.contains(&"refresh:metronome:preset=p_lzx9k2q1_ab12".to_string()));
        // Over-long preset ids are dropped rather than sent as broken buttons.
        assert!(!data.iter().any(|d| d.contains(&"x".repeat(60))));
        let idle = metronome_keyboard(&st, None);
        assert!(all_callbacks(&idle).contains(&"refresh:metronome:start".to_string()));
        // Every metronome button arg must parse back through the slash grammar.
        for d in data {
            let args = d.strip_prefix("refresh:metronome:").unwrap();
            assert!(parse_metronome_args(args).is_ok(), "unparseable button arg: {args}");
        }
    }

    // ---- pomodoro ----

    #[test]
    fn pomodoro_action_parser_covers_all_verbs() {
        use PomodoroAction::*;
        assert_eq!(parse_pomodoro_action("").unwrap(), Status);
        assert_eq!(parse_pomodoro_action("pause").unwrap(), Pause);
        assert_eq!(parse_pomodoro_action("resume").unwrap(), Resume);
        assert_eq!(parse_pomodoro_action("toggle").unwrap(), Toggle);
        assert_eq!(parse_pomodoro_action("skip").unwrap(), Skip(None));
        assert_eq!(parse_pomodoro_action("skip 3").unwrap(), Skip(Some(3)));
        assert!(parse_pomodoro_action("skip 0").is_err());
        assert_eq!(parse_pomodoro_action("stop").unwrap(), Stop);
        assert_eq!(parse_pomodoro_action("preset 7").unwrap(), Preset(7));
        assert_eq!(parse_pomodoro_action("preset #7").unwrap(), Preset(7));
        assert_eq!(parse_pomodoro_action("presets").unwrap(), Presets);
        assert_eq!(
            parse_pomodoro_action("delete 4").unwrap(),
            Delete { id: 4, confirmed: false }
        );
        assert_eq!(
            parse_pomodoro_action("delete 4 yes").unwrap(),
            Delete { id: 4, confirmed: true }
        );
        assert_eq!(parse_pomodoro_action("history").unwrap(), History(10));
        assert_eq!(parse_pomodoro_action("history 99").unwrap(), History(30));
        assert_eq!(
            parse_pomodoro_action("start 25/sit 5/walk").unwrap(),
            Start("25/sit 5/walk".into())
        );
        assert_eq!(
            parse_pomodoro_action("edit 30/sit").unwrap(),
            Edit("30/sit".into())
        );
        assert!(parse_pomodoro_action("fly").is_err());
        assert!(parse_pomodoro_action("preset abc").is_err());
    }

    #[test]
    fn pomodoro_reuse_block_ids_preserves_cursor_ids_by_position() {
        let old = parse_pomodoro_blocks("25/sit 5/walk", 1).unwrap();
        let new = parse_pomodoro_blocks("30/sit 5/walk 10/stand", 2).unwrap();
        let merged = reuse_block_ids(new, &old);
        assert_eq!(merged[0].id, old[0].id);
        assert_eq!(merged[1].id, old[1].id);
        assert_eq!(merged[2].id, "cli-2-2");
        assert_eq!(merged[0].duration_sec, 1800);
    }

    #[test]
    fn pomodoro_keyboards_fit_and_parse_back() {
        let presets = vec![
            (i64::MAX, "Very long preset name that goes on".to_string()),
            (2, "Deep work".to_string()),
        ];
        for status in [SessionStatus::Idle, SessionStatus::Running, SessionStatus::Paused] {
            let kb = pomodoro_keyboard(status, &presets);
            assert_fits(&kb);
            for d in all_callbacks(&kb) {
                let args = d.strip_prefix("refresh:pomodoro:").unwrap();
                assert!(parse_pomodoro_action(args).is_ok(), "unparseable: {args}");
            }
        }
        // All quick starts survive the 64-byte filter and parse as blocks.
        let idle = all_callbacks(&pomodoro_keyboard(SessionStatus::Idle, &[]));
        for (_, spec) in POMODORO_QUICK_STARTS {
            assert!(idle.contains(&format!("refresh:pomodoro:start {spec}")));
            assert!(parse_pomodoro_blocks(spec, 0).is_ok());
        }
        let running = all_callbacks(&pomodoro_keyboard(SessionStatus::Running, &[]));
        assert!(running.contains(&"refresh:pomodoro:pause".to_string()));
        let paused = all_callbacks(&pomodoro_keyboard(SessionStatus::Paused, &[]));
        assert!(paused.contains(&"refresh:pomodoro:resume".to_string()));
        assert!(format!("refresh:pomodoro:delete {} yes", i64::MAX).len() <= 64);
    }

    #[test]
    fn format_ago_buckets() {
        assert_eq!(format_ago(120), "2 хв тому");
        assert_eq!(format_ago(7200), "2 год тому");
        assert_eq!(format_ago(2 * 86_400), "2 дн тому");
        assert_eq!(format_ago(-5), "0 хв тому");
    }

    // ---- volume / music / misc cards ----

    #[test]
    fn volume_action_parser_handles_relative_and_toggle() {
        assert!(matches!(parse_volume_action("").unwrap(), VolumeAction::Status));
        assert!(matches!(parse_volume_action("+1").unwrap(), VolumeAction::Step(1)));
        assert!(matches!(parse_volume_action("-10").unwrap(), VolumeAction::Step(-10)));
        assert!(matches!(parse_volume_action("+").unwrap(), VolumeAction::Step(10)));
        assert!(matches!(parse_volume_action("55").unwrap(), VolumeAction::Set(55)));
        assert!(matches!(parse_volume_action("500").unwrap(), VolumeAction::Set(100)));
        assert!(matches!(parse_volume_action("toggle").unwrap(), VolumeAction::ToggleMute));
        assert!(parse_volume_action("loud").is_err());
    }

    #[test]
    fn misc_cockpit_keyboards_fit() {
        for kb in [
            volume_keyboard(false),
            volume_keyboard(true),
            music_keyboard(),
            music_open_keyboard(),
            tuner_keyboard("drop-csharp"),
            display_keyboard(),
            focus_keyboard(),
        ] {
            assert_fits(&kb);
            assert!(all_callbacks(&kb).iter().all(|d| d.starts_with("refresh:")));
        }
        for d in all_callbacks(&volume_keyboard(false)) {
            let args = d.strip_prefix("refresh:volume:").unwrap_or("");
            assert!(parse_volume_action(args).is_ok(), "unparseable: {args}");
        }
        for d in all_callbacks(&tuner_keyboard("standard-e")) {
            if let Some(id) = d.strip_prefix("refresh:tuner:") {
                assert!(is_valid_tuning(id), "bad tuning id: {id}");
            }
        }
        let rec = record_card("x".into()).keyboard.unwrap();
        assert_fits(&rec);
        let ka = keepawake_card("x".into(), true).keyboard.unwrap();
        assert_eq!(ka.rows[0][0].callback_data, "refresh:keepawake:off");
    }
}
