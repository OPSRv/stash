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
// G2 productivity — clipboard, pomodoro, notes.
// Owned by one move agent; see docs/agent-surface-refactor.md.

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

fn pomodoro_snapshot_json(snap: &crate::modules::pomodoro::engine::SessionSnapshot) -> Value {
    use crate::modules::pomodoro::engine::SessionStatus;
    let status = match snap.status {
        SessionStatus::Idle => "idle",
        SessionStatus::Running => "running",
        SessionStatus::Paused => "paused",
    };
    let blocks: Vec<Value> = snap
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
    json!({
        "status": status,
        "current_block_index": if snap.status == SessionStatus::Idle { Value::Null } else { json!(snap.current_idx + 1) },
        "remaining_sec": (snap.remaining_ms / 1000).max(0),
        "blocks": blocks,
    })
}

/// Pause / resume / skip within the running Pomodoro session.
pub struct PomodoroControl {
    state: Arc<PomodoroState>,
}

impl PomodoroControl {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroControl {
    fn name(&self) -> &'static str {
        "pomodoro_control"
    }
    fn description(&self) -> &'static str {
        "Control the running Pomodoro session: `pause`, `resume`, `toggle` \
         (pause↔resume), `skip` (jump to the next block; finishes the session \
         on the last block) or `skip_to` with a 1-based `block` number. \
         Returns the resulting session snapshot. Use pomodoro_stop to end it."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["pause", "resume", "toggle", "skip", "skip_to"]
                },
                "block": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "1-based block number for skip_to."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        use crate::modules::pomodoro::commands::{pause_session, resume_session, skip_to_session};
        use crate::modules::pomodoro::engine::SessionStatus;
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: action".to_string())?;
        let snap = self.state.core.lock().map_err(|e| e.to_string())?.snapshot();
        if snap.status == SessionStatus::Idle {
            return Err("no Pomodoro session is running".to_string());
        }
        let app = require_app(ctx, "pomodoro_control")?;
        let out = match action {
            "pause" => pause_session(&app, &self.state),
            "resume" => resume_session(&app, &self.state),
            "toggle" if snap.status == SessionStatus::Running => pause_session(&app, &self.state),
            "toggle" => resume_session(&app, &self.state),
            "skip" => crate::modules::telegram::module_cmds::pomodoro_skip_next(&app, &self.state),
            "skip_to" => {
                let n = args
                    .get("block")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "skip_to requires `block`".to_string())? as usize;
                if n == 0 || n > snap.blocks.len() {
                    return Err(format!("block must be 1..={}", snap.blocks.len()));
                }
                skip_to_session(&app, &self.state, n - 1)
            }
            other => return Err(format!("unknown action: {other}")),
        };
        Ok(pomodoro_snapshot_json(&out))
    }
}

/// Replace the block list of the running session (cursor preserved by position).
pub struct PomodoroEditBlocks {
    state: Arc<PomodoroState>,
}

impl PomodoroEditBlocks {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroEditBlocks {
    fn name(&self) -> &'static str {
        "pomodoro_edit_blocks"
    }
    fn description(&self) -> &'static str {
        "Replace the blocks of the currently running Pomodoro session without \
         restarting it (e.g. extend the current focus block, add a walk at the \
         end). Pass the FULL new list — read it first with pomodoro_status or \
         pomodoro_control. Blocks are matched by position, so the current \
         block keeps its remaining time when its position is unchanged."
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
        let snap = self.state.core.lock().map_err(|e| e.to_string())?.snapshot();
        if snap.status == crate::modules::pomodoro::engine::SessionStatus::Idle {
            return Err("no Pomodoro session is running — use pomodoro_start".to_string());
        }
        let app = require_app(ctx, "pomodoro_edit_blocks")?;
        let blocks = crate::modules::telegram::module_cmds::reuse_block_ids(blocks, &snap.blocks);
        let out = crate::modules::pomodoro::commands::edit_blocks_session(&app, &self.state, blocks);
        Ok(pomodoro_snapshot_json(&out))
    }
}

/// List / start / delete saved Pomodoro presets.
pub struct PomodoroPresets {
    state: Arc<PomodoroState>,
}

impl PomodoroPresets {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroPresets {
    fn name(&self) -> &'static str {
        "pomodoro_presets"
    }
    fn description(&self) -> &'static str {
        "Manage saved Pomodoro presets. `list` returns every preset (id, name, \
         kind, blocks). `start` runs the preset with `id` (replacing any \
         running session). `delete` removes the preset with `id` — only when \
         the user clearly asked to delete it. Create presets with \
         pomodoro_save_preset."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "start", "delete"] },
                "id": { "type": "integer", "description": "Preset id (from `list`) for start/delete." }
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
        if action == "list" {
            let presets = self
                .state
                .repo
                .lock()
                .map_err(|e| e.to_string())?
                .list_presets()
                .map_err(|e| e.to_string())?;
            let items: Vec<Value> = presets
                .iter()
                .map(|p| {
                    json!({
                        "id": p.id,
                        "name": p.name,
                        "kind": p.kind,
                        "total_sec": p.blocks.iter().map(|b| b.duration_sec).sum::<u32>(),
                        "blocks": p.blocks.iter().map(|b| json!({
                            "label": b.name,
                            "posture": format!("{:?}", b.posture).to_lowercase(),
                            "duration_sec": b.duration_sec,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect();
            return Ok(json!({ "presets": items }));
        }
        let id = args
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| format!("{action} requires `id`"))?;
        let preset = self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())?
            .get_preset(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("preset {id} not found"))?;
        let app = require_app(ctx, "pomodoro_presets")?;
        match action {
            "start" => {
                let snap = start_session(&app, &self.state, preset.blocks.clone(), Some(preset.id))?;
                let mut out = pomodoro_snapshot_json(&snap);
                out["preset"] = json!(preset.name);
                Ok(out)
            }
            "delete" => {
                self.state
                    .repo
                    .lock()
                    .map_err(|e| e.to_string())?
                    .delete_preset(id)
                    .map_err(|e| e.to_string())?;
                let _ = tauri::Emitter::emit(&app, "pomodoro:presets_changed", id);
                Ok(json!({ "deleted": true, "id": id, "name": preset.name }))
            }
            other => Err(format!("unknown action: {other}")),
        }
    }
}

/// Recent Pomodoro sessions (history log).
pub struct PomodoroHistory {
    state: Arc<PomodoroState>,
}

impl PomodoroHistory {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for PomodoroHistory {
    fn name(&self) -> &'static str {
        "pomodoro_history"
    }
    fn description(&self) -> &'static str {
        "Return recent Pomodoro sessions, newest first: start/end unix \
         seconds, blocks, and how many blocks were completed. Use it to \
         answer \"how much did I focus today/this week\"."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Default 20." }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .clamp(1, 200) as u32;
        let rows = self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())?
            .list_sessions(limit)
            .map_err(|e| e.to_string())?;
        let items: Vec<Value> = rows
            .iter()
            .map(|r| {
                let done = r.completed_idx.min(r.blocks.len());
                json!({
                    "id": r.id,
                    "preset_id": r.preset_id,
                    "started_at": r.started_at,
                    "ended_at": r.ended_at,
                    "blocks_total": r.blocks.len(),
                    "blocks_completed": done,
                    "completed_sec": r.blocks.iter().take(done).map(|b| b.duration_sec).sum::<u32>(),
                    "blocks": r.blocks.iter().map(|b| json!({
                        "label": b.name,
                        "posture": format!("{:?}", b.posture).to_lowercase(),
                        "duration_sec": b.duration_sec,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        Ok(json!({ "sessions": items }))
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

// Direct Notes-repo tools. Each holds the same `Arc<Mutex<NotesRepo>>`
// the Notes tab uses, and nudges it with `notes:changed` after writes.

type NotesRepoHandle = Arc<std::sync::Mutex<crate::modules::notes::repo::NotesRepo>>;

fn note_id_arg(args: &Value) -> Result<i64, String> {
    args.get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing required field: id".to_string())
}

fn note_title_from_body(body: &str) -> String {
    let t: String = body.lines().next().unwrap_or("").trim().chars().take(80).collect();
    if t.is_empty() {
        "Без заголовка".to_string()
    } else {
        t
    }
}

fn emit_notes_changed(ctx: &ToolCtx, id: i64) {
    if let Some(app) = ctx.app.as_ref() {
        use tauri::Emitter;
        let _ = app.emit("notes:changed", id);
    }
}

pub struct SearchNotes {
    repo: NotesRepoHandle,
}

impl SearchNotes {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for SearchNotes {
    fn name(&self) -> &'static str {
        "search_notes"
    }
    fn description(&self) -> &'static str {
        "Full-text search over Stash notes (title + body). Returns up to 20 \
         matches with id, title, preview and pinned flag. Use `get_note` to \
         read a match in full."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1, "description": "Words or substring to look for." }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or_else(|| "missing required field: query".to_string())?;
        let repo = self.repo.lock().map_err(|e| e.to_string())?;
        let hits = repo
            .search_summaries(query, crate::modules::notes::repo::FolderFilter::All)
            .map_err(|e| e.to_string())?;
        Ok(json!({
            "matches": hits.iter().take(20).map(|n| json!({
                "id": n.id,
                "title": n.title,
                "preview": truncate_preview(&n.preview, 200),
                "pinned": n.pinned,
                "updated_at_ms": n.updated_at,
            })).collect::<Vec<_>>(),
        }))
    }
}

pub struct GetNote {
    repo: NotesRepoHandle,
}

impl GetNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for GetNote {
    fn name(&self) -> &'static str {
        "get_note"
    }
    fn description(&self) -> &'static str {
        "Read one Stash note in full by numeric id (from list_notes / search_notes)."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Note id." } },
            "required": ["id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let repo = self.repo.lock().map_err(|e| e.to_string())?;
        let note = repo
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("note {id} not found"))?;
        Ok(json!({
            "id": note.id,
            "title": note.title,
            "body": truncate_preview(&note.body, 8_000),
            "pinned": note.pinned,
            "created_at_ms": note.created_at,
            "updated_at_ms": note.updated_at,
        }))
    }
}

pub struct AppendToNote {
    repo: NotesRepoHandle,
}

impl AppendToNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for AppendToNote {
    fn name(&self) -> &'static str {
        "append_to_note"
    }
    fn description(&self) -> &'static str {
        "Append text to the end of an existing Stash note (on a new line). \
         Use for 'add milk to my shopping list' once the note id is known."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Note id." },
                "text": { "type": "string", "minLength": 1, "description": "Text to append." }
            },
            "required": ["id", "text"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim_end)
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| "missing required field: text".to_string())?;
        {
            let mut repo = self.repo.lock().map_err(|e| e.to_string())?;
            let note = repo
                .get(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("note {id} not found"))?;
            let body = if note.body.trim().is_empty() {
                text.to_string()
            } else {
                format!("{}\n{text}", note.body.trim_end())
            };
            repo.update(id, &note.title, &body, ctx.now_ms)
                .map_err(|e| e.to_string())?;
        }
        emit_notes_changed(ctx, id);
        Ok(json!({ "id": id, "appended": true }))
    }
}

pub struct UpdateNote {
    repo: NotesRepoHandle,
}

impl UpdateNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for UpdateNote {
    fn name(&self) -> &'static str {
        "update_note"
    }
    fn description(&self) -> &'static str {
        "Replace the body (and optionally the title) of a Stash note. When \
         `title` is omitted, the first line of `body` becomes the title. \
         Prefer `append_to_note` for additions — this overwrites."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Note id." },
                "body": { "type": "string", "minLength": 1, "description": "New full body." },
                "title": { "type": "string", "description": "Optional explicit title." }
            },
            "required": ["id", "body"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .filter(|b| !b.trim().is_empty())
            .ok_or_else(|| "missing required field: body".to_string())?;
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| note_title_from_body(body));
        {
            let mut repo = self.repo.lock().map_err(|e| e.to_string())?;
            if repo.get(id).map_err(|e| e.to_string())?.is_none() {
                return Err(format!("note {id} not found"));
            }
            repo.update(id, &title, body, ctx.now_ms)
                .map_err(|e| e.to_string())?;
        }
        emit_notes_changed(ctx, id);
        Ok(json!({ "id": id, "title": title, "updated": true }))
    }
}

pub struct DeleteNote {
    repo: NotesRepoHandle,
}

impl DeleteNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for DeleteNote {
    fn name(&self) -> &'static str {
        "delete_note"
    }
    fn description(&self) -> &'static str {
        "Permanently delete a Stash note (and its audio / attachments) by id. \
         Destructive — confirm with the user first unless they were explicit."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Note id." } },
            "required": ["id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let deleted =
            crate::modules::telegram::module_cmds::delete_note(ctx.app.as_ref(), &self.repo, id)?;
        Ok(json!({ "id": id, "deleted": deleted }))
    }
}

/// Search clipboard history for entries matching `query`. Limited to 20
/// hits so a runaway model can't ask for the whole history.
pub struct ClipboardSearch {
    state: Arc<ClipboardState>,
}

impl ClipboardSearch {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ClipboardSearch {
    fn name(&self) -> &'static str {
        "clipboard_search"
    }
    fn description(&self) -> &'static str {
        "Search the user's clipboard history for entries containing `query`. \
         Returns up to 20 most recent matches with their id + content snippet. \
         Use to answer 'find that link I copied yesterday' kind of questions."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Substring or word to look up." }
            },
            "required": ["query"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: query".to_string())?
            .trim();
        if query.is_empty() {
            return Err("query is empty".into());
        }
        let repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        let items = repo.search(query, 20).map_err(|e| e.to_string())?;
        Ok(json!({
            "matches": items.iter().map(|i| json!({
                "id": i.id,
                "kind": i.kind,
                "pinned": i.pinned,
                "content": truncate_preview(&i.content, 200),
            })).collect::<Vec<_>>(),
        }))
    }
}

/// Toggle the pin flag on a clipboard entry by id. Pinned entries
/// survive the unpinned-cap trim.
pub struct ClipboardPin {
    state: Arc<ClipboardState>,
}

impl ClipboardPin {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ClipboardPin {
    fn name(&self) -> &'static str {
        "clipboard_pin"
    }
    fn description(&self) -> &'static str {
        "Toggle the pin flag on the clipboard entry with the given numeric id. \
         Pinned entries are kept even when the unpinned cap is hit. \
         Use after `clipboard_search` once the user asks to keep something."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Numeric id from clipboard_search." }
            },
            "required": ["id"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "missing required field: id".to_string())?;
        let mut repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        repo.toggle_pin(id).map_err(|e| e.to_string())?;
        let item = repo.get(id).map_err(|e| e.to_string())?;
        Ok(json!({
            "id": id,
            "pinned": item.map(|i| i.pinned).unwrap_or(false),
        }))
    }
}

/// Wipe the entire unpinned clipboard history. Pinned entries are
/// preserved so a user-facing "save for later" flag never disappears
/// behind a single tool call.
pub struct ClipboardClear {
    state: Arc<ClipboardState>,
}

impl ClipboardClear {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ClipboardClear {
    fn name(&self) -> &'static str {
        "clipboard_clear"
    }
    fn description(&self) -> &'static str {
        "Delete every unpinned entry from the clipboard history. Pinned \
         entries survive. Returns the number of rows removed. Confirm \
         with the user before invoking — this is destructive."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let mut repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        let removed = repo.clear_all().map_err(|e| e.to_string())?;
        Ok(json!({ "removed": removed }))
    }
}

fn clip_id_arg(args: &Value) -> Result<i64, String> {
    args.get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing required field: id".to_string())
}

/// Delete one clipboard entry by id (removes the captured PNG for image
/// rows, same as the Clipboard tab's delete).
pub struct ClipboardDelete;

#[async_trait]
impl Tool for ClipboardDelete {
    fn name(&self) -> &'static str {
        "clipboard_delete"
    }
    fn description(&self) -> &'static str {
        "Delete a single clipboard-history entry by numeric id (from \
         clipboard_search). Destructive — only when the user asked."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Numeric id from clipboard_search." } },
            "required": ["id"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = clip_id_arg(&args)?;
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "app handle unavailable".to_string())?;
        let state = app
            .try_state::<Arc<ClipboardState>>()
            .ok_or_else(|| "clipboard state not initialised".to_string())?;
        crate::modules::clipboard::commands::clipboard_delete(state, id)?;
        Ok(json!({ "id": id, "deleted": true }))
    }
}

/// Put a history entry (text, image or files) back onto the Mac's
/// system clipboard so the user can paste it there.
pub struct ClipboardCopyToMac;

#[async_trait]
impl Tool for ClipboardCopyToMac {
    fn name(&self) -> &'static str {
        "clipboard_copy_to_mac"
    }
    fn description(&self) -> &'static str {
        "Copy a clipboard-history entry (by id from clipboard_search) back \
         onto the Mac's system clipboard, ready to paste. Works for text, \
         images and files."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Numeric id from clipboard_search." } },
            "required": ["id"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = clip_id_arg(&args)?;
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "app handle unavailable".to_string())?;
        crate::modules::telegram::module_cmds::clip_copy_to_mac(app, id)?;
        Ok(json!({ "id": id, "copied": true }))
    }
}

#[cfg(test)]
mod g2_tool_tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;
    use crate::modules::clipboard::repo::ClipboardRepo;
    use crate::modules::pomodoro::repo::PomodoroRepo;
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
    async fn clipboard_search_returns_matching_rows() {
        let clip = fresh_clipboard();
        {
            let mut r = clip.repo.lock().unwrap();
            r.insert_text("alpha bravo", 1).unwrap();
            r.insert_text("charlie delta", 2).unwrap();
            r.insert_text("echo bravo", 3).unwrap();
        }
        let out = ClipboardSearch::new(clip)
            .invoke(&ctx(), json!({ "query": "bravo" }))
            .await
            .unwrap();
        let arr = out["matches"].as_array().expect("matches");
        assert_eq!(arr.len(), 2);
        // Most-recent first (per repo ordering).
        assert_eq!(arr[0]["content"], "echo bravo");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_search_rejects_empty_query() {
        let clip = fresh_clipboard();
        let err = ClipboardSearch::new(clip)
            .invoke(&ctx(), json!({ "query": "   " }))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_pin_toggles_flag() {
        let clip = fresh_clipboard();
        let id = {
            let mut r = clip.repo.lock().unwrap();
            r.insert_text("pin me", 1).unwrap()
        };
        let out1 = ClipboardPin::new(Arc::clone(&clip))
            .invoke(&ctx(), json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(out1["pinned"], true);
        let out2 = ClipboardPin::new(clip)
            .invoke(&ctx(), json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(out2["pinned"], false);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_clear_removes_unpinned_only() {
        let clip = fresh_clipboard();
        let pinned_id = {
            let mut r = clip.repo.lock().unwrap();
            let pin_id = r.insert_text("keep me", 1).unwrap();
            r.toggle_pin(pin_id).unwrap();
            r.insert_text("trash me", 2).unwrap();
            r.insert_text("trash me too", 3).unwrap();
            pin_id
        };
        let out = ClipboardClear::new(Arc::clone(&clip))
            .invoke(&ctx(), json!({}))
            .await
            .unwrap();
        assert_eq!(out["removed"], 2);
        let surviving = clip.repo.lock().unwrap().list(10).unwrap();
        assert_eq!(surviving.len(), 1);
        assert_eq!(surviving[0].id, pinned_id);
    }
}
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
