//! Agent surface — npm scripts: `npm_list_scripts`, `npm_run_script`, `npm_stop_script`.
//!
//! Placeholder wired into `lib.rs` / `telegram::assistant` ahead of the
//! per-module move (G4, see `docs/agent-surface-refactor.md`). Shared
//! helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::ToolRegistry;

/// Register this module's slash commands.
pub fn register_commands(_tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {}

/// Register this module's LLM tools.
pub fn register_tools(_tools: &mut ToolRegistry, _app: &tauri::AppHandle) {}
