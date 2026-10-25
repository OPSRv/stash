//! Slash-command handlers that bridge Telegram to other Stash modules.
//! Each handler captures an `Arc` of the module state it targets and is
//! registered into the `CommandRegistry` from `lib.rs` after all module
//! states exist.
//!
//! Being dismantled: handlers move out to `modules/<m>/agent.rs` in four
//! parallel groups (G1–G4, see `docs/agent-surface-refactor.md`). Each
//! group owns exactly the code between its `BEGIN Gn` / `END Gn` markers;
//! leave the marker lines in place so parallel deletions never touch.

// Transitional: imports below go unused as groups move out; the final
// cleanup deletes this file (or the allow) once every group has landed.
#![allow(unused_imports)]

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

// Shared helpers now live in `agent_util`; re-exported so existing paths
// (`module_cmds::read_battery`, …) keep compiling during the per-module move.
pub use super::agent_util::{
    await_separator_job, emit_with_ack, enqueue_separator, format_pomodoro_status, now_ms,
    now_secs, read_battery, read_volume, reveal_tab, tokenize_quoted, truncate_preview,
    apply_volume, volume_bar, BatterySnapshot, VolumeAction, VolumeSnapshot, KNOWN_TABS,
};

// ═══════════════ BEGIN G1 ═══════════════
// ═══════════════ END G1 ═══════════════

// ═══════════════ BEGIN G2 ═══════════════
// Kept only for G3's `DashboardCmd` (it relied on G2's pomodoro import);
// delete with the final cleanup once G3 has moved out.
use crate::modules::pomodoro::state::PomodoroState;
// ═══════════════ END G2 ═══════════════

// ═══════════════ BEGIN G3 ═══════════════
// G3 system — battery, volume, screenshot, display/sleep/shutdown, focus, weather, app, navigate, dashboard, keepawake, update.
// Owned by one move agent; see docs/agent-surface-refactor.md.

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
mod g3_system_tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::*;

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
    fn app_callbacks_fit_telegram_limit() {
        assert!(app_cb("quit", &"x".repeat(80)).is_none());
        let r = app_reply("t".into(), &[("🛑", "quit", &"Ж".repeat(26))]);
        assert!(r.keyboard.is_none(), "over-long refresh payload must be dropped");
    }

    #[test]
    fn misc_system_keyboards_fit() {
        for kb in [
            volume_keyboard(false),
            volume_keyboard(true),
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
        let ka = keepawake_card("x".into(), true).keyboard.unwrap();
        assert_eq!(ka.rows[0][0].callback_data, "refresh:keepawake:off");
    }
}
// ═══════════════ END G3 ═══════════════

// ═══════════════ BEGIN G4 ═══════════════
// G4 media/AI — ocr, send, summarize, ai, voice, stems/bpm, claude_code.
// Owned by one move agent; see docs/agent-surface-refactor.md.
// ═══════════════ END G4 ═══════════════
