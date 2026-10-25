//! Agent surface — Cross-cutting bot commands: `/dashboard`, `/navigate`,
//! `/update` + `navigate_tab`, `invoke_command` tools. They span every
//! module, so they live with the bot rather than in one module's
//! `agent.rs`. Shared helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;

use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::pomodoro::state::PomodoroState;
use crate::modules::telegram::agent_util::{
    format_pomodoro_status, now_secs, read_battery, reveal_tab, run_slash, BatterySnapshot,
    KNOWN_TABS,
};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

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
    rows.push(vec![crate::modules::telegram::menu::menu_button()]);
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

// ---- LLM tools ----

// ---- Navigate ----

pub struct NavigateTab;

#[async_trait]
impl Tool for NavigateTab {
    fn name(&self) -> &'static str {
        "navigate_tab"
    }
    fn description(&self) -> &'static str {
        "Open a specific Stash tab in the popup. Use when the user asks \
         to \"show me the notes\" / \"open clipboard\" / etc. Calls with an \
         unknown tab name return an error listing valid IDs."
    }
    fn schema(&self) -> Value {
        use crate::modules::telegram::agent_util::KNOWN_TABS;
        json!({
            "type": "object",
            "properties": {
                "tab": {
                    "type": "string",
                    "enum": KNOWN_TABS
                }
            },
            "required": ["tab"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let tab = args
            .get("tab")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: tab".to_string())?;
        run_slash(ctx, "navigate", tab).await
    }
}

/// Generic dispatcher that invokes any registered slash-command. The
/// list of names + descriptions is injected into the conversation via
/// a system message in `Assistant::handle`, so the model knows what it
/// can call without a discovery round-trip.
pub struct InvokeCommand;

#[async_trait]
impl Tool for InvokeCommand {
    fn name(&self) -> &'static str {
        "invoke_command"
    }
    fn description(&self) -> &'static str {
        "Execute any registered Stash slash-command by name. The catalog of \
         available commands is provided in a system message at the start of \
         the conversation. Use this for actions like changing volume, \
         controlling music, creating notes, etc. Destructive commands \
         (shutdown, sleep, update, quitting apps) are not run directly: \
         the user gets a confirmation button instead — do not retry them."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Command name without the leading slash, e.g. \"volume\" or \"note\"."
                },
                "args": {
                    "type": "string",
                    "description": "Raw argument string passed to the command. Empty string when the command takes no arguments."
                }
            },
            "required": ["name"],
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: name".to_string())?
            .trim()
            .trim_start_matches('/');
        if name.is_empty() {
            return Err("command name is empty".to_string());
        }
        if crate::modules::telegram::tools::is_llm_excluded_command(name) {
            return Err(format!(
                "/{name} cannot be invoked from the assistant (it re-enters the AI or is \
                 internal). Answer the user directly instead."
            ));
        }
        let cmd_args = args.get("args").and_then(|v| v.as_str()).unwrap_or("");
        let app = ctx
            .app
            .clone()
            .ok_or_else(|| "invoke_command requires a Tauri AppHandle (not in test)".to_string())?;
        let handler = ctx
            .state
            .find_command(name)
            .ok_or_else(|| format!("unknown command: /{name}"))?;
        // Destructive commands (shutdown, sleep, update, app quit, …) are
        // parked behind a Telegram ✅/✖ card instead of running now.
        if crate::modules::telegram::confirm::command_needs_confirmation(&*handler, cmd_args) {
            let pending = crate::modules::telegram::confirm::PendingAction::Command {
                name: name.to_string(),
                args: cmd_args.trim().to_string(),
            };
            let description = crate::modules::telegram::confirm::describe_command(name, cmd_args);
            return Ok(crate::modules::telegram::confirm::request(
                &ctx.state,
                pending,
                &description,
            ));
        }
        let reply = handler
            .handle(
                crate::modules::telegram::commands_registry::Ctx { app },
                cmd_args,
            )
            .await;
        Ok(json!({ "text": reply.text }))
    }
    fn timeout(&self) -> Option<std::time::Duration> {
        // Commands like /stems, /weather or /screenshot legitimately take
        // longer than the 5 s default for local tools.
        Some(std::time::Duration::from_secs(30))
    }
}

/// Register the cross-cutting slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(DashboardCmd::new(Arc::clone(tg)));
    tg.register_command(NavigateCmd);
    tg.register_command(UpdateCmd);
}

/// Register the cross-cutting LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(NavigateTab);
    tools.register(InvokeCommand);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;

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

    #[tokio::test(flavor = "current_thread")]
    async fn navigate_tab_requires_tab_field() {
        let err = NavigateTab.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("tab"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_command_missing_name_errors() {
        let err = InvokeCommand.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("name"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_command_rejects_unknown_name() {
        // `ctx.app` is None so the tool errors *before* looking up an
        // unknown name — assert on that order explicitly.
        let err = InvokeCommand
            .invoke(&ctx(), json!({ "name": "absolutely-not-a-command" }))
            .await
            .unwrap_err();
        assert!(err.contains("AppHandle"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_command_refuses_recursive_commands() {
        // Re-entering the LLM through /ai (or /summarize, /voice) would
        // recurse and get killed by the tool timeout — refuse up front.
        for name in ["ai", "/summarize", "voice", "confirm"] {
            let err = InvokeCommand
                .invoke(&ctx(), json!({ "name": name, "args": "hi" }))
                .await
                .unwrap_err();
            assert!(err.contains("cannot be invoked"), "{name}: {err}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_command_strips_leading_slash() {
        // No AppHandle in tests, so we can't reach actual dispatch,
        // but the tool must still accept `/name` and `name` alike —
        // the missing-app error is produced only after name parsing.
        let err = InvokeCommand
            .invoke(&ctx(), json!({ "name": "/note" }))
            .await
            .unwrap_err();
        assert!(err.contains("AppHandle"));
    }
}
