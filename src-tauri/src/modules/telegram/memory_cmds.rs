//! Agent surface — Telegram-owned memory + reminder slash commands: `/remind`,
//! `/reminders`, `/forget`, `/remember`, `/memory`, `/forget_fact`.
//! The matching LLM tools stay in `tools/memory.rs` / `tools/reminders.rs`.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use super::agent_util::{now_secs, truncate_preview};
use super::commands_registry::{CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply};
use super::reminders;
use super::state::TelegramState;

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(RemindCmd::new(Arc::clone(tg)));
    tg.register_command(RemindersCmd::new(Arc::clone(tg)));
    tg.register_command(ForgetCmd::new(Arc::clone(tg)));
    tg.register_command(RememberCmd::new(Arc::clone(tg)));
    tg.register_command(MemoryCmd::new(Arc::clone(tg)));
    tg.register_command(ForgetFactCmd::new(Arc::clone(tg)));
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn memory_callbacks_fit_telegram_limit() {
        let big = i64::MAX;
        let cb = format!("refresh:memory:del:{big}");
        assert!(cb.len() <= 64, "{cb} is {} bytes", cb.len());
    }
}
