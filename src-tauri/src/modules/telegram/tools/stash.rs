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
// G3 system — battery, volume, navigate, invoke_command.
// Owned by one move agent; see docs/agent-surface-refactor.md.

pub struct GetBattery;

#[async_trait]
impl Tool for GetBattery {
    fn name(&self) -> &'static str {
        "get_battery"
    }
    fn description(&self) -> &'static str {
        "Return the Mac's current battery percentage + charging state. \
         Returns {present:false} on desktop Macs without a battery."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        Ok(match read_battery() {
            BatterySnapshot::Present { percent, charging } => {
                json!({ "present": true, "percent": percent, "charging": charging })
            }
            BatterySnapshot::NoBattery => {
                json!({ "present": false, "reason": "desktop_mac" })
            }
            BatterySnapshot::Unknown => {
                json!({ "present": false, "reason": "unavailable" })
            }
        })
    }
}

// ---- Volume ----

pub struct VolumeControl;

#[async_trait]
impl Tool for VolumeControl {
    fn name(&self) -> &'static str {
        "volume_control"
    }
    fn description(&self) -> &'static str {
        "Adjust macOS system output volume. Provide at most one of: \
         `level` (absolute 0-100), `delta` (relative change, e.g. 5 or -20), \
         `step` (\"up\" or \"down\" — 10-point nudge), `mute` (boolean), or \
         `toggle_mute` (true flips mute). Pass `{}` to return the current \
         level + mute state."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "level": { "type": "integer", "minimum": 0, "maximum": 100 },
                "delta": { "type": "integer", "minimum": -100, "maximum": 100 },
                "step":  { "type": "string", "enum": ["up", "down"] },
                "mute":  { "type": "boolean" },
                "toggle_mute": { "type": "boolean" }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let level = args.get("level").and_then(|v| v.as_i64());
        let step = args.get("step").and_then(|v| v.as_str());
        let mute = args.get("mute").and_then(|v| v.as_bool());
        let delta = args.get("delta").and_then(|v| v.as_i64());
        let toggle = args
            .get("toggle_mute")
            .and_then(|v| v.as_bool())
            .filter(|b| *b);
        let count = [
            level.is_some(),
            step.is_some(),
            mute.is_some(),
            delta.is_some(),
            toggle.is_some(),
        ]
        .iter()
        .filter(|&&b| b)
        .count();
        if count > 1 {
            return Err("provide at most one of level/delta/step/mute/toggle_mute".to_string());
        }
        let slash_args = if let Some(n) = level {
            n.clamp(0, 100).to_string()
        } else if let Some(d) = delta {
            format!("{:+}", d.clamp(-100, 100))
        } else if toggle.is_some() {
            "toggle".to_string()
        } else if let Some(s) = step {
            s.to_string()
        } else if let Some(m) = mute {
            if m {
                "mute".to_string()
            } else {
                "unmute".to_string()
            }
        } else {
            // No arg => status query
            String::new()
        };
        run_slash(ctx, "volume", &slash_args).await
    }
}

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
        use crate::modules::telegram::module_cmds::KNOWN_TABS;
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
        if super::is_llm_excluded_command(name) {
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

#[cfg(test)]
mod g3_tool_tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;

    #[tokio::test(flavor = "current_thread")]
    async fn get_battery_returns_present_or_fallback_shape() {
        let out = GetBattery.invoke(&ctx(), json!({})).await.unwrap();
        // Real `pmset` runs on the host; either shape is acceptable —
        // the important invariant is that the tool always returns
        // well-formed JSON with a `present` boolean.
        let present = out.get("present").and_then(|v| v.as_bool());
        assert!(
            present.is_some(),
            "expected a boolean `present` field, got {out}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn volume_control_rejects_multiple_mutually_exclusive_fields() {
        let err = VolumeControl
            .invoke(&ctx(), json!({ "level": 50, "mute": true }))
            .await
            .unwrap_err();
        assert!(err.contains("at most one"));
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
// ═══════════════ END G3 ═══════════════

// ═══════════════ BEGIN G4 ═══════════════
// G4 media/AI — canvas OCR, send_telegram, npm scripts, separator, converter.
// Owned by one move agent; see docs/agent-surface-refactor.md.

// Kept until G2 lands: the clipboard tools above call `try_state`.
use tauri::Manager;
// ═══════════════ END G4 ═══════════════
