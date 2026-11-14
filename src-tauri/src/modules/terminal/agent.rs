//! Agent surface — Terminal: `/claude_code`.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

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
        "Запустити Claude Code у новій Terminal-вкладці Stash — у вказаній папці або в Working folder із Settings → Terminal."
    }
    fn usage(&self) -> &'static str {
        "/claude_code [folder]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let cwd = match resolve_folder(args, std::env::var("HOME").ok().as_deref()) {
            Ok(cwd) => cwd,
            Err(e) => return Reply::text(format!("⚠️ {e}")),
        };
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
            let _ = app.emit("terminal:launch_claude", LaunchClaudePayload { cwd });
        });
        Reply::text("💻 Відкриваю Terminal і запускаю Claude Code…")
    }
}

#[derive(Clone, serde::Serialize)]
struct LaunchClaudePayload {
    /// Explicit folder from the command argument; `None` lets the frontend
    /// fall back to Settings → Terminal → Working folder.
    cwd: Option<String>,
}

/// Turn the optional `/claude_code` argument into an existing directory.
/// Empty → `None`; `~` / `~/…` expand against `home`.
fn resolve_folder(arg: &str, home: Option<&str>) -> Result<Option<String>, String> {
    let arg = arg.trim();
    if arg.is_empty() {
        return Ok(None);
    }
    let expanded = match (arg.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            format!("{home}{rest}")
        }
        _ => arg.to_string(),
    };
    if std::path::Path::new(&expanded).is_dir() {
        Ok(Some(expanded))
    } else {
        Err(format!("Папку не знайдено: {expanded}"))
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_folder;

    #[test]
    fn empty_arg_means_default_folder() {
        assert_eq!(resolve_folder("  ", Some("/tmp")), Ok(None));
    }

    #[test]
    fn expands_tilde_against_home() {
        assert_eq!(resolve_folder("~", Some("/tmp")), Ok(Some("/tmp".into())));
        assert_eq!(resolve_folder("~/", Some("/tmp")), Ok(Some("/tmp/".into())));
    }

    #[test]
    fn rejects_missing_folder() {
        assert!(resolve_folder("/definitely/not/here", None).is_err());
    }
}
