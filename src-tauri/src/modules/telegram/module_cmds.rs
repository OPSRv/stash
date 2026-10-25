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
// ═══════════════ END G3 ═══════════════

// ═══════════════ BEGIN G4 ═══════════════
// G4 media/AI — ocr, send, summarize, ai, voice, stems/bpm, claude_code.
// Owned by one move agent; see docs/agent-surface-refactor.md.
// ═══════════════ END G4 ═══════════════
