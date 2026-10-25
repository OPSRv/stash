//! Agent surface — Terminal: `/claude_code`.
//!
//! Moved verbatim from `telegram/module_cmds.rs` / `telegram/tools/stash.rs`
//! (see `docs/agent-surface-refactor.md`). Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use tauri::Emitter;

use crate::modules::telegram::agent_util::reveal_tab;
use crate::modules::telegram::commands_registry::{CommandHandler, Ctx, Reply};
use crate::modules::telegram::state::TelegramState;

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(LaunchClaudeCmd);
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
