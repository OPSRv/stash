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
use crate::modules::pomodoro::commands::{start_session, stop_session};
use crate::modules::pomodoro::model::{Block, Posture, PresetKind};
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
    }
}

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
    }
}

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

pub struct PomodoroStart {
    state: Arc<PomodoroState>,
}

impl PomodoroStart {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

fn parse_posture(s: &str) -> Result<Posture, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "sit" => Ok(Posture::Sit),
        "stand" => Ok(Posture::Stand),
        "walk" => Ok(Posture::Walk),
        other => Err(format!(
            "unknown posture: {other} (expected sit|stand|walk)"
        )),
    }
}

/// Parse the `blocks` array used by both `pomodoro_start` and
/// `pomodoro_save_preset`. `id_seed` gives each block a stable unique id
/// so the engine's cursor-preservation logic (`edit_blocks`) keeps
/// working even when the user saves a preset during an active session.
fn parse_blocks(raw_blocks: &[Value], id_seed: i64) -> Result<Vec<Block>, String> {
    if raw_blocks.is_empty() {
        return Err("blocks must contain at least one item".to_string());
    }
    let mut out: Vec<Block> = Vec::with_capacity(raw_blocks.len());
    for (i, raw) in raw_blocks.iter().enumerate() {
        let duration_sec = raw
            .get("duration_sec")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("blocks[{i}].duration_sec missing or not a number"))?;
        if duration_sec == 0 {
            return Err(format!("blocks[{i}].duration_sec must be > 0"));
        }
        let posture_str = raw
            .get("posture")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("blocks[{i}].posture missing"))?;
        let posture = parse_posture(posture_str).map_err(|e| format!("blocks[{i}]: {e}"))?;
        let label = raw
            .get("label")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let name = label.map(str::to_string).unwrap_or_else(|| match posture {
            Posture::Sit => "Focus".to_string(),
            Posture::Stand => "Stand".to_string(),
            Posture::Walk => "Walk".to_string(),
        });
        out.push(Block {
            id: format!("ai-{id_seed}-{i}"),
            name,
            duration_sec: duration_sec.min(u32::MAX as u64) as u32,
            posture,
            mid_nudge_sec: None,
        });
    }
    Ok(out)
}

/// Shared JSON-schema for a block list — reused by pomodoro_start and
/// pomodoro_save_preset so the AI sees the same shape for both.
fn blocks_schema() -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "items": {
            "type": "object",
            "properties": {
                "duration_sec": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 14400,
                    "description": "Block length in seconds."
                },
                "posture": {
                    "type": "string",
                    "enum": ["sit", "stand", "walk"]
                },
                "label": {
                    "type": "string",
                    "description": "Short human-readable name, e.g. \"Focus\" or \"Walk\"."
                }
            },
            "required": ["duration_sec", "posture"],
            "additionalProperties": false
        }
    })
}

#[async_trait]
impl Tool for PomodoroStart {
    fn name(&self) -> &'static str {
        "pomodoro_start"
    }
    fn description(&self) -> &'static str {
        "Start a Pomodoro session with a custom sequence of blocks. Each block \
         has a duration in seconds, a posture (sit / stand / walk), and an \
         optional free-text label. Replaces any already-running session. \
         The returned payload lists the exact blocks that were scheduled so \
         the assistant can confirm them back to the user."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "blocks": blocks_schema() },
            "required": ["blocks"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let raw_blocks = args
            .get("blocks")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "missing required field: blocks".to_string())?;
        let blocks = parse_blocks(raw_blocks, ctx.now_ms)?;
        let app = ctx
            .app
            .clone()
            .ok_or_else(|| "pomodoro_start requires a Tauri AppHandle (not in test)".to_string())?;
        let snap = start_session(&app, &self.state, blocks, None)?;
        let total_sec: i64 = snap.blocks.iter().map(|b| b.duration_sec as i64).sum();
        let blocks_json: Vec<Value> = snap
            .blocks
            .iter()
            .map(|b| {
                json!({
                    "label": b.name,
                    "posture": format!("{:?}", b.posture).to_lowercase(),
                    "duration_sec": b.duration_sec,
                })
            })
            .collect();
        Ok(json!({
            "started": true,
            "total_sec": total_sec,
            "blocks": blocks_json,
        }))
    }
}

pub struct PomodoroSavePreset {
    state: Arc<PomodoroState>,
}

impl PomodoroSavePreset {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroSavePreset {
    fn name(&self) -> &'static str {
        "pomodoro_save_preset"
    }
    fn description(&self) -> &'static str {
        "Save a named Pomodoro preset so the user can re-run the same block \
         sequence later from the Pomodoro tab. Name is trimmed and must be \
         non-empty; re-using an existing name overwrites that preset. `kind`: \
         'session' = one-shot run (typical focus timer), 'daily' = longer \
         multi-posture day plan. Does not start the session — call \
         `pomodoro_start` afterwards if the user wants it running now."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 60,
                    "description": "Display name of the preset."
                },
                "kind": {
                    "type": "string",
                    "enum": ["session", "daily"]
                },
                "blocks": blocks_schema()
            },
            "required": ["name", "kind", "blocks"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing required field: name".to_string())?
            .to_string();
        let kind_str = args
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: kind".to_string())?;
        let kind = match kind_str.trim().to_ascii_lowercase().as_str() {
            "session" => PresetKind::Session,
            "daily" => PresetKind::Daily,
            other => return Err(format!("kind must be session|daily (got {other})")),
        };
        let raw_blocks = args
            .get("blocks")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "missing required field: blocks".to_string())?;
        let blocks = parse_blocks(raw_blocks, ctx.now_ms)?;
        let now_sec = ctx.now_ms / 1000;
        let preset = self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())?
            .save_preset(&name, kind, &blocks, now_sec)
            .map_err(|e| e.to_string())?;
        // Nudge the frontend panel to reload its preset chips so the new
        // entry shows up immediately without a tab switch.
        if let Some(app) = ctx.app.clone() {
            let _ = tauri::Emitter::emit(&app, "pomodoro:presets_changed", preset.id);
        }
        let total_sec: u32 = preset.blocks.iter().map(|b| b.duration_sec).sum();
        Ok(json!({
            "saved": true,
            "id": preset.id,
            "name": preset.name,
            "kind": kind_str,
            "block_count": preset.blocks.len(),
            "total_sec": total_sec,
        }))
    }
}

pub struct PomodoroStop {
    state: Arc<PomodoroState>,
}

impl PomodoroStop {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroStop {
    fn name(&self) -> &'static str {
        "pomodoro_stop"
    }
    fn description(&self) -> &'static str {
        "Stop the currently running Pomodoro session, if any. Safe to call \
         when nothing is running — returns {was_running:false}."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        // Cheap no-op when idle — report back without needing an AppHandle,
        // so the assistant can call this tool defensively.
        let was_running = {
            let core = self.state.core.lock().map_err(|e| e.to_string())?;
            !core.is_idle()
        };
        if !was_running {
            return Ok(json!({ "was_running": false }));
        }
        let app = ctx
            .app
            .clone()
            .ok_or_else(|| "pomodoro_stop requires a Tauri AppHandle (not in test)".to_string())?;
        let _ = stop_session(&app, &self.state);
        Ok(json!({ "was_running": true }))
    }
}

/// Delegate a typed tool to its slash-command twin so we don't reimplement
/// the business logic. Runs the registered handler with the stringified
/// args and returns its text reply. Required by every tool that isn't
/// side-effect-free (needs an `AppHandle` for `emit` / tauri state).
async fn run_slash(ctx: &ToolCtx, cmd: &str, slash_args: &str) -> Result<Value, String> {
    let app = ctx
        .app
        .clone()
        .ok_or_else(|| format!("{cmd} requires a Tauri AppHandle (not in test)"))?;
    let handler = ctx
        .state
        .find_command(cmd)
        .ok_or_else(|| format!("unknown slash-command: /{cmd} (registry not yet populated?)"))?;
    let reply = handler
        .handle(
            crate::modules::telegram::commands_registry::Ctx { app },
            slash_args,
        )
        .await;
    Ok(json!({ "text": reply.text }))
}

// ---- Metronome ----

pub struct MetronomeControl;

#[async_trait]
impl Tool for MetronomeControl {
    fn name(&self) -> &'static str {
        "metronome_control"
    }
    fn description(&self) -> &'static str {
        "Start / stop / adjust the Metronome tab with a fully typed payload \
         — BPM, time signature, subdivision, sound. Any field you omit is \
         left untouched. Use `action:\"start\"` to begin playback; \
         `action:\"stop\"` to halt. The tab is revealed automatically."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "stop", "toggle", "status"]
                },
                "bpm": {
                    "type": "integer",
                    "minimum": 40,
                    "maximum": 240
                },
                "numerator": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 16,
                    "description": "Top number of the time signature (beats per bar)."
                },
                "denominator": {
                    "type": "integer",
                    "description": "Bottom number of the time signature. Must be 2, 4, or 8."
                },
                "subdivision": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 4
                },
                "sound": {
                    "type": "string",
                    "enum": ["click", "wood", "beep"]
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let mut parts: Vec<String> = Vec::new();
        if let Some(a) = args.get("action").and_then(|v| v.as_str()) {
            parts.push(a.to_string());
        }
        if let Some(bpm) = args.get("bpm").and_then(|v| v.as_u64()) {
            parts.push(format!("bpm={bpm}"));
        }
        let num = args.get("numerator").and_then(|v| v.as_u64());
        let den = args.get("denominator").and_then(|v| v.as_u64());
        match (num, den) {
            (Some(n), Some(d)) => {
                if !matches!(d, 2 | 4 | 8) {
                    return Err(format!("denominator must be 2, 4, or 8 (got {d})"));
                }
                parts.push(format!("sig={n}/{d}"));
            }
            (Some(_), None) | (None, Some(_)) => {
                return Err("numerator and denominator must be provided together".to_string());
            }
            _ => {}
        }
        if let Some(sub) = args.get("subdivision").and_then(|v| v.as_u64()) {
            parts.push(format!("sub={sub}"));
        }
        if let Some(sound) = args.get("sound").and_then(|v| v.as_str()) {
            parts.push(format!("sound={sound}"));
        }
        if parts.is_empty() {
            return Err(
                "at least one of action/bpm/numerator/subdivision/sound required".to_string(),
            );
        }
        run_slash(ctx, "metronome", &parts.join(" ")).await
    }
}

// ---- Music ----

pub struct MusicControl;

#[async_trait]
impl Tool for MusicControl {
    fn name(&self) -> &'static str {
        "music_control"
    }
    fn description(&self) -> &'static str {
        "Control the YouTube Music webview inside Stash. `status` returns \
         the current track; `play` / `pause` / `toggle` / `next` / `prev` \
         drive playback. `open` reveals the tab without touching playback."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "play", "pause", "toggle", "next", "prev", "open"]
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: action".to_string())?;
        let slash_arg = if matches!(action, "status") {
            ""
        } else {
            action
        };
        run_slash(ctx, "music", slash_arg).await
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
        "Adjust macOS system output volume. Provide exactly one of: \
         `level` (absolute 0-100), `step` (\"up\" or \"down\" — 10-point \
         nudge), or `mute` (boolean). Pass `{}` to return the current \
         level + mute state."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "level": { "type": "integer", "minimum": 0, "maximum": 100 },
                "step":  { "type": "string", "enum": ["up", "down"] },
                "mute":  { "type": "boolean" }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let level = args.get("level").and_then(|v| v.as_i64());
        let step = args.get("step").and_then(|v| v.as_str());
        let mute = args.get("mute").and_then(|v| v.as_bool());
        let count = [level.is_some(), step.is_some(), mute.is_some()]
            .iter()
            .filter(|&&b| b)
            .count();
        if count > 1 {
            return Err("provide at most one of level/step/mute".to_string());
        }
        let slash_args = if let Some(n) = level {
            n.clamp(0, 100).to_string()
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

// ---- Notes ----

pub struct SaveNote;

#[async_trait]
impl Tool for SaveNote {
    fn name(&self) -> &'static str {
        "save_note"
    }
    fn description(&self) -> &'static str {
        "Create a note in Stash's Notes tab. `body` is required (plain text, \
         may contain newlines). Title is taken from the first line automatically \
         — do not prefix or wrap the body."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "body": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Full note body. The first line becomes the title."
                }
            },
            "required": ["body"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: body".to_string())?;
        if body.trim().is_empty() {
            return Err("body must not be empty".to_string());
        }
        run_slash(ctx, "note", body).await
    }
}

pub struct ListNotes;

#[async_trait]
impl Tool for ListNotes {
    fn name(&self) -> &'static str {
        "list_notes"
    }
    fn description(&self) -> &'static str {
        "Return the most recent Stash notes (newest-first). Use when the \
         user asks 'what did I write yesterday?' or similar. The underlying \
         /notes handler caps the count internally — no args needed."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        run_slash(ctx, "notes", "").await
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::clipboard::commands::ClipboardState;
    use crate::modules::clipboard::repo::ClipboardRepo;
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
        assert!(
            present.is_some(),
            "expected a boolean `present` field, got {out}"
        );
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
        let out = PomodoroStatus::new(pomo)
            .invoke(&ctx(), json!({}))
            .await
            .unwrap();
        assert_eq!(out["status"], "idle");
        assert_eq!(out["remaining_sec"], 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_start_errors_without_app_handle() {
        // The tool needs an AppHandle to emit the snapshot; in unit-test
        // context (`ctx.app == None`) that must fail loudly rather than
        // mutating engine state silently.
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let err = PomodoroStart::new(pomo)
            .invoke(
                &ctx(),
                json!({ "blocks": [{ "duration_sec": 60, "posture": "sit" }] }),
            )
            .await
            .unwrap_err();
        assert!(err.contains("AppHandle"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_start_rejects_empty_blocks() {
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let err = PomodoroStart::new(pomo)
            .invoke(&ctx(), json!({ "blocks": [] }))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("at least one"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_start_rejects_unknown_posture() {
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let err = PomodoroStart::new(pomo)
            .invoke(
                &ctx(),
                json!({ "blocks": [{ "duration_sec": 60, "posture": "fly" }] }),
            )
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("posture"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn metronome_control_requires_at_least_one_field() {
        let err = MetronomeControl
            .invoke(&ctx(), json!({}))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("at least one"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn metronome_control_rejects_partial_time_signature() {
        let err = MetronomeControl
            .invoke(&ctx(), json!({ "numerator": 6 }))
            .await
            .unwrap_err();
        assert!(err.contains("together"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn music_control_requires_action_field() {
        let err = MusicControl.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("action"));
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
    async fn save_note_requires_non_empty_body() {
        let err = SaveNote.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("body"));
        let err2 = SaveNote
            .invoke(&ctx(), json!({ "body": "   " }))
            .await
            .unwrap_err();
        assert!(err2.to_lowercase().contains("empty"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn navigate_tab_requires_tab_field() {
        let err = NavigateTab.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("tab"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_save_preset_persists_and_returns_totals() {
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let out = PomodoroSavePreset::new(Arc::clone(&pomo))
            .invoke(
                &ctx(),
                json!({
                    "name": "ООООР",
                    "kind": "session",
                    "blocks": [
                        { "duration_sec": 600, "posture": "walk", "label": "Walk" },
                        { "duration_sec": 600, "posture": "stand" },
                        { "duration_sec": 600, "posture": "sit", "label": "Focus" }
                    ]
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["saved"], true);
        assert_eq!(out["name"], "ООООР");
        assert_eq!(out["block_count"], 3);
        assert_eq!(out["total_sec"], 1800);
        // Re-saving with the same name should overwrite, not duplicate.
        let again = PomodoroSavePreset::new(pomo)
            .invoke(
                &ctx(),
                json!({
                    "name": "ООООР",
                    "kind": "daily",
                    "blocks": [ { "duration_sec": 60, "posture": "sit" } ]
                }),
            )
            .await
            .unwrap();
        assert_eq!(again["id"], out["id"], "re-save should reuse the same id");
        assert_eq!(again["block_count"], 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_save_preset_rejects_empty_name() {
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let err = PomodoroSavePreset::new(pomo)
            .invoke(
                &ctx(),
                json!({
                    "name": "   ",
                    "kind": "session",
                    "blocks": [ { "duration_sec": 60, "posture": "sit" } ]
                }),
            )
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("name"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pomodoro_stop_reports_not_running_when_idle() {
        let repo = PomodoroRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let pomo = Arc::new(PomodoroState::new(repo));
        let out = PomodoroStop::new(pomo)
            .invoke(&ctx(), json!({}))
            .await
            .unwrap();
        assert_eq!(out["was_running"], false);
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
