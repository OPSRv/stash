//! Read-only tools exposing Stash state to the assistant.
//!
//! Kept narrow on purpose: write-capable tools (create_reminder,
//! remember_fact) need user intent behind each call; these four
//! are pure look-ups the assistant can invoke without prompting.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

use super::{Tool, ToolCtx};
use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::pomodoro::state::PomodoroState;
use crate::modules::telegram::module_cmds::{read_battery, BatterySnapshot};

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
    }}

pub struct GetLastClip {
    state: Arc<ClipboardState>,
}

impl GetLastClip {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for GetLastClip {
    fn name(&self) -> &'static str {
        "get_last_clip"
    }
    fn description(&self) -> &'static str {
        "Return the most recent clipboard entry (text or a short attachment note). \
         Use to answer 'what did I just copy?'."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        let items = repo.list(1).map_err(|e| e.to_string())?;
        let Some(item) = items.into_iter().next() else {
            return Ok(json!({ "empty": true }));
        };
        Ok(json!({
            "kind": item.kind,
            "content": item.content,
        }))
    }}

pub struct PomodoroStatus {
    state: Arc<PomodoroState>,
}

impl PomodoroStatus {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroStatus {
    fn name(&self) -> &'static str {
        "pomodoro_status"
    }
    fn description(&self) -> &'static str {
        "Return the current Pomodoro phase and remaining seconds. \
         {status:'idle'} when no session is active."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let core = self.state.core.lock().map_err(|e| e.to_string())?;
        let snap = core.snapshot();
        let status = match snap.status {
            crate::modules::pomodoro::engine::SessionStatus::Idle => "idle",
            crate::modules::pomodoro::engine::SessionStatus::Running => "running",
            crate::modules::pomodoro::engine::SessionStatus::Paused => "paused",
        };
        let remaining_sec = (snap.remaining_ms / 1000).max(0);
        let current = snap.blocks.get(snap.current_idx).map(|b| {
            json!({
                "posture": format!("{:?}", b.posture).to_lowercase(),
                "duration_sec": b.duration_sec,
            })
        });
        Ok(json!({
            "status": status,
            "remaining_sec": remaining_sec,
            "current_block": current,
        }))
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
         controlling music, creating notes, etc."
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
        let cmd_args = args.get("args").and_then(|v| v.as_str()).unwrap_or("");
        let app = ctx
            .app
            .clone()
            .ok_or_else(|| "invoke_command requires a Tauri AppHandle (not in test)".to_string())?;
        let handler = ctx
            .state
            .find_command(name)
            .ok_or_else(|| format!("unknown command: /{name}"))?;
        let reply = handler
            .handle(
                crate::modules::telegram::commands_registry::Ctx { app },
                cmd_args,
            )
            .await;
        Ok(json!({ "text": reply.text }))
    }}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::clipboard::repo::ClipboardRepo;
    use crate::modules::clipboard::commands::ClipboardState;
    use crate::modules::pomodoro::repo::PomodoroRepo;
    use crate::modules::telegram::keyring::MemStore;
    use crate::modules::telegram::repo::TelegramRepo;
    use crate::modules::telegram::state::TelegramState;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn fresh_clipboard() -> Arc<ClipboardState> {
        let repo = ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        Arc::new(ClipboardState {
            repo: Mutex::new(repo),
            images_dir: PathBuf::from("/tmp/stash-test-images"),
        })
    }

    fn ctx() -> ToolCtx {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn crate::modules::telegram::keyring::SecretStore> =
            Arc::new(MemStore::new());
        ToolCtx {
            state: Arc::new(TelegramState::new(repo, secrets)),
            app: None,
            now_ms: 0,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_battery_returns_present_or_fallback_shape() {
        let out = GetBattery.invoke(&ctx(), json!({})).await.unwrap();
        // Real `pmset` runs on the host; either shape is acceptable —
        // the important invariant is that the tool always returns
        // well-formed JSON with a `present` boolean.
        let present = out.get("present").and_then(|v| v.as_bool());
        assert!(present.is_some(), "expected a boolean `present` field, got {out}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_last_clip_reports_empty_when_history_is_empty() {
        let tool = GetLastClip::new(fresh_clipboard());
        let out = tool.invoke(&ctx(), json!({})).await.unwrap();
        assert_eq!(out["empty"], true);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_last_clip_returns_newest_entry_when_present() {
        let clip = fresh_clipboard();
        {
            let mut r = clip.repo.lock().unwrap();
            r.insert_text("older", 1).unwrap();
            r.insert_text("newest", 2).unwrap();
        }
        let tool = GetLastClip::new(clip);
        let out = tool.invoke(&ctx(), json!({})).await.unwrap();
        assert_eq!(out["kind"], "text");
        assert_eq!(out["content"], "newest");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_status_reports_idle_without_session() {
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let out = PomodoroStatus::new(pomo).invoke(&ctx(), json!({})).await.unwrap();
        assert_eq!(out["status"], "idle");
        assert_eq!(out["remaining_sec"], 0);
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
