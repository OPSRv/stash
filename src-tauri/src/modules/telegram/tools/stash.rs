//! Tools exposing Stash state and actions to the assistant: read-only
//! look-ups plus module controls (notes, pomodoro, music, Telegram send…).
//!
//! Being dismantled: tools move to `modules/<m>/agent.rs` in four parallel
//! groups (see `docs/agent-surface-refactor.md`). Each group owns exactly
//! the code between its `BEGIN Gn` / `END Gn` markers — keep the markers.

// Transitional: imports below go unused as groups move out.
#![allow(unused_imports)]

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

use super::{Tool, ToolCtx};
use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::pomodoro::commands::{start_session, stop_session};
use crate::modules::pomodoro::model::{Block, Posture, PresetKind};
use crate::modules::pomodoro::state::PomodoroState;
use crate::modules::telegram::agent_util::{
    read_battery, require_app, run_slash, truncate_preview, BatterySnapshot,
};

// ═══════════════ BEGIN G1 ═══════════════
// ═══════════════ END G1 ═══════════════

// ═══════════════ BEGIN G2 ═══════════════
// ═══════════════ END G2 ═══════════════

// ═══════════════ BEGIN G3 ═══════════════
// ═══════════════ END G3 ═══════════════

// ═══════════════ BEGIN G4 ═══════════════
// G4 media/AI — canvas OCR, send_telegram, npm scripts, separator, converter.
// Owned by one move agent; see docs/agent-surface-refactor.md.

// Kept until G2 lands: the clipboard tools above call `try_state`.
use tauri::Manager;
// ═══════════════ END G4 ═══════════════
