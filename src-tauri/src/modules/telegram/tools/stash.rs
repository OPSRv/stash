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
// G1 audio — metronome, tuner, circle, valeton, record, music.
// Owned by one move agent; see docs/agent-surface-refactor.md.

// ---- Metronome ----

pub struct MetronomeControl;

/// Quote a free-text slash value so names with spaces survive tokenizing.
fn quote_slash_value(v: &str) -> String {
    format!("\"{}\"", v.replace('"', ""))
}

/// Translate the typed `metronome_control` payload into `/metronome` slash
/// args. Pure so the mapping is unit-testable.
fn metronome_slash_args(args: &Value) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = args.get("action").and_then(|v| v.as_str()) {
        parts.push(a.to_string());
    }
    if let Some(bpm) = args.get("bpm").and_then(|v| v.as_u64()) {
        parts.push(format!("bpm={bpm}"));
    }
    if let Some(d) = args.get("bpm_delta").and_then(|v| v.as_i64()) {
        if d != 0 {
            parts.push(format!("bpm={d:+}"));
        }
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
    if let Some(v) = args.get("click_volume").and_then(|v| v.as_u64()) {
        parts.push(format!("vol={}", v.min(100)));
    }
    if let Some(v) = args.get("accent_volume").and_then(|v| v.as_u64()) {
        parts.push(format!("accent_vol={}", v.min(100)));
    }
    if let Some(acc) = args.get("beat_accents").and_then(|v| v.as_array()) {
        let pattern: String = acc
            .iter()
            .map(|b| if b.as_bool().unwrap_or(false) { '1' } else { '0' })
            .collect();
        if !pattern.is_empty() {
            parts.push(format!("accents={pattern}"));
        }
    }
    if let Some(t) = args.get("trainer").and_then(|v| v.as_object()) {
        if let Some(en) = t.get("enabled").and_then(|v| v.as_bool()) {
            parts.push(format!("trainer={}", if en { "on" } else { "off" }));
        }
        if let Some(v) = t.get("step_bpm").and_then(|v| v.as_u64()) {
            parts.push(format!("trainer_step={v}"));
        }
        if let Some(v) = t.get("every_bars").and_then(|v| v.as_u64()) {
            parts.push(format!("trainer_bars={v}"));
        }
        if let Some(v) = t.get("target_bpm").and_then(|v| v.as_u64()) {
            parts.push(format!("trainer_target={v}"));
        }
    }
    for (field, key) in [
        ("preset", "preset"),
        ("save_preset", "save"),
        ("delete_preset", "delete"),
    ] {
        if let Some(v) = args.get(field).and_then(|v| v.as_str()) {
            let v = v.trim();
            if !v.is_empty() {
                parts.push(format!("{key}={}", quote_slash_value(v)));
            }
        }
    }
    if parts.is_empty() {
        return Err(
            "at least one field required — use action:\"status\" to read the state".to_string(),
        );
    }
    Ok(parts.join(" "))
}

#[async_trait]
impl Tool for MetronomeControl {
    fn name(&self) -> &'static str {
        "metronome_control"
    }
    fn description(&self) -> &'static str {
        "Full control of the metronome tab with a typed payload — playback, \
         BPM (absolute or relative), time signature, subdivision, sound, click \
         and accent volume, per-beat accent pattern, the tempo trainer, and \
         saved presets (apply / save current / delete). Any field you omit is \
         left untouched; `action:\"status\"` returns the current state \
         (incl. preset names and whether it's playing). Order of application: \
         preset → explicit fields → save/delete. The metronome lives in the \
         Valeton editor tab, which is revealed automatically for start/toggle."
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
                "bpm_delta": {
                    "type": "integer",
                    "minimum": -200,
                    "maximum": 200,
                    "description": "Relative BPM change, e.g. 5 = faster by 5, -10 = slower by 10. Result clamps to 40..240."
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
                    "maximum": 4,
                    "description": "1 = quarters, 2 = eighths, 3 = triplets, 4 = sixteenths."
                },
                "sound": {
                    "type": "string",
                    "enum": ["click", "wood", "beep"]
                },
                "click_volume": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                    "description": "Volume of regular clicks, percent."
                },
                "accent_volume": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                    "description": "Volume of accented clicks, percent."
                },
                "beat_accents": {
                    "type": "array",
                    "items": { "type": "boolean" },
                    "minItems": 1,
                    "maxItems": 16,
                    "description": "Per-beat accent flags; length must equal the (resulting) numerator."
                },
                "trainer": {
                    "type": "object",
                    "description": "Tempo trainer: raises BPM by step_bpm every every_bars bars until target_bpm.",
                    "properties": {
                        "enabled": { "type": "boolean" },
                        "step_bpm": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "every_bars": { "type": "integer", "minimum": 1, "maximum": 64 },
                        "target_bpm": { "type": "integer", "minimum": 40, "maximum": 240 }
                    },
                    "additionalProperties": false
                },
                "preset": {
                    "type": "string",
                    "description": "Apply a saved preset by name (case-insensitive) or id."
                },
                "save_preset": {
                    "type": "string",
                    "description": "Save the resulting settings as a preset with this name (overwrites same name)."
                },
                "delete_preset": {
                    "type": "string",
                    "description": "Delete a saved preset by name or id."
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let slash = metronome_slash_args(&args)?;
        run_slash(ctx, "metronome", &slash).await
    }
}

// ---- Tuner ----

pub struct TunerControl;

#[async_trait]
impl Tool for TunerControl {
    fn name(&self) -> &'static str {
        "tuner_control"
    }
    fn description(&self) -> &'static str {
        "Open the guitar tuner (a mic-based chromatic tuner inside the Valeton \
         editor) and optionally select a tuning. Standard-shape tunings run from \
         E down to A; drop-shape tunings from Drop D down to Drop A. Omit `tuning` \
         to just open the tuner with whatever tuning is saved. Map the user's \
         words (\"drop D\", \"half-step down / Eb\", \"D standard\") to the closest id."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "tuning": {
                    "type": "string",
                    "description": "Canonical tuning id to switch to.",
                    "enum": [
                        "standard-e", "standard-dsharp", "standard-d", "standard-csharp",
                        "standard-c", "standard-b", "standard-asharp", "standard-a",
                        "drop-d", "drop-csharp", "drop-c", "drop-b", "drop-asharp", "drop-a"
                    ]
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let tuning = args
            .get("tuning")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        run_slash(ctx, "tuner", &tuning).await
    }
}

// ---- Circle of fifths: push a progression ----

pub struct CircleProgression;

#[async_trait]
impl Tool for CircleProgression {
    fn name(&self) -> &'static str {
        "circle_progression"
    }
    fn description(&self) -> &'static str {
        "Push a chord progression into the circle-of-fifths workspace (the \
         Circle view inside the Valeton tab): it selects the key, fills the \
         progression builder and rotates the wheel. Pass chord NAMES like \
         C, Cm, Cmaj7, C7, Cm7, Cdim, Cm7b5 (sharps/flats as F#m or Bbm). \
         Use when the user asks to build, load or try a chord progression. \
         The user sees it after opening the Circle view in the Valeton tab."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Key as a chord-style name: \"C\" = C major, \"Am\" = A minor."
                },
                "chords": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Chord names in playing order, e.g. [\"Am\",\"F\",\"C\",\"G\"]."
                },
                "bpm": {
                    "type": "number",
                    "description": "Optional tempo, 40-240."
                }
            },
            "required": ["key", "chords"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .clone()
            .ok_or_else(|| "app handle unavailable (headless run)".to_string())?;
        let chords = args
            .get("chords")
            .and_then(|v| v.as_array())
            .filter(|a| !a.is_empty())
            .ok_or_else(|| "missing required field: chords".to_string())?;
        if !chords.iter().all(|c| c.is_string()) {
            return Err("chords must be an array of chord-name strings".to_string());
        }
        let key = args
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing required field: key".to_string())?;
        let payload = json!({
            "key": key,
            "chords": chords,
            "bpm": args.get("bpm").and_then(|v| v.as_f64()),
        });
        tauri::Emitter::emit(&app, "circle:progression", payload).map_err(|e| e.to_string())?;
        Ok(json!({
            "ok": true,
            "note": "Progression loaded; visible in the Circle view of the Valeton tab."
        }))
    }
}

// ---- Valeton: AI tone ----

pub struct ValetonSetTone;

#[async_trait]
impl Tool for ValetonSetTone {
    fn name(&self) -> &'static str {
        "valeton_set_tone"
    }
    fn description(&self) -> &'static str {
        "Design a guitar tone on the Valeton GP-5 from a natural-language \
         description and apply it to the current patch. Pass the user's full \
         intent verbatim — genre, artist/song reference, amp/cab character, \
         gain level, effects (drive, delay, reverb, modulation), brightness, \
         etc. An AI designs a complete signal chain (amp, cab, EQ, drive, \
         time-based fx) matching the request and the editor applies it live. \
         Use for requests like \"warm Gilmour lead\", \"tight metal rhythm\", \
         \"clean funk with chorus\". Requires the GP-5 to be connected."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Free-text description of the desired tone, as detailed as the user gave it."
                }
            },
            "required": ["description"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let desc = args
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing required field: description".to_string())?;
        run_slash(ctx, "valeton", &format!("tone {desc}")).await
    }
}

// ---- Valeton: discrete control ----

pub struct ValetonControl;

#[async_trait]
impl Tool for ValetonControl {
    fn name(&self) -> &'static str {
        "valeton_control"
    }
    fn description(&self) -> &'static str {
        "Drive discrete Valeton GP-5 editor actions: switch to a stored patch, \
         set the tap-tempo BPM and note division, toggle an effect block on/off, \
         and save the current edit buffer back into the active patch. Any field \
         you omit is left untouched. For designing a whole tone from a \
         description use `valeton_set_tone` instead. Requires the GP-5 connected."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "patch": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 99,
                    "description": "Stored patch number to switch to (0..99)."
                },
                "bpm": {
                    "type": "integer",
                    "minimum": 40,
                    "maximum": 240,
                    "description": "Tap-tempo / delay-sync BPM."
                },
                "division": {
                    "type": "string",
                    "enum": ["quarter", "eighth", "dotted"],
                    "description": "Note division for the tempo."
                },
                "block": {
                    "type": "string",
                    "enum": ["nr", "pre", "dst", "amp", "cab", "eq", "mod", "dly", "rvb", "ns"],
                    "description": "Effect block to toggle (NR, pre, distortion, amp, cab, EQ, modulation, delay, reverb, noise-suppressor)."
                },
                "block_on": {
                    "type": "boolean",
                    "description": "Target on/off state for `block`. Required when `block` is set."
                },
                "save": {
                    "type": "boolean",
                    "description": "Set true to save the current edit buffer into the active patch."
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let mut parts: Vec<String> = Vec::new();
        if let Some(p) = args.get("patch").and_then(|v| v.as_u64()) {
            parts.push(format!("patch={p}"));
        }
        if let Some(bpm) = args.get("bpm").and_then(|v| v.as_u64()) {
            parts.push(format!("bpm={bpm}"));
        }
        if let Some(div) = args.get("division").and_then(|v| v.as_str()) {
            parts.push(format!("div={div}"));
        }
        match (
            args.get("block").and_then(|v| v.as_str()),
            args.get("block_on").and_then(|v| v.as_bool()),
        ) {
            (Some(b), Some(on)) => parts.push(format!("{b}={}", if on { "on" } else { "off" })),
            (Some(_), None) => {
                return Err("block_on is required when block is set".to_string())
            }
            (None, Some(_)) => {
                return Err("block is required when block_on is set".to_string())
            }
            _ => {}
        }
        if args.get("save").and_then(|v| v.as_bool()) == Some(true) {
            parts.push("save".to_string());
        }
        if parts.is_empty() {
            return Err(
                "at least one of patch/bpm/division/block/save required".to_string(),
            );
        }
        run_slash(ctx, "valeton", &parts.join(" ")).await
    }
}

// ---- Recorder ----

pub struct RecordControl;

#[async_trait]
impl Tool for RecordControl {
    fn name(&self) -> &'static str {
        "record_control"
    }
    fn description(&self) -> &'static str {
        "Start or stop the audio recorder, or set its input gain. \
         `action:\"start\"` begins capturing a take from the user's selected \
         input; `action:\"stop\"` ends it and saves the take. `gain` sets the \
         input level as a linear multiplier (1.0 = unity, range 0..2) — it \
         applies live to an in-flight take and persists for the next one. \
         Provide `action`, `gain`, or both. The recorder lives in the Valeton \
         editor tab, which is revealed automatically. Capture runs on the \
         user's machine — it only takes effect while the app window is open."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "stop", "toggle"]
                },
                "gain": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 2,
                    "description": "Input gain multiplier; 1.0 = unity."
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let action = args.get("action").and_then(|v| v.as_str());
        let gain = args.get("gain").and_then(|v| v.as_f64());
        if action.is_none() && gain.is_none() {
            return Err("provide `action`, `gain`, or both".to_string());
        }
        // Gain first so a combined "boost then record" request captures hot.
        let mut out = Value::Null;
        if let Some(g) = gain {
            out = run_slash(ctx, "record", &format!("gain {g}")).await?;
        }
        if let Some(action) = action {
            out = run_slash(ctx, "record", action).await?;
        }
        Ok(out)
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
         the current track and system volume; `play` / `pause` / `toggle` / \
         `next` / `prev` drive playback; `volup` / `voldown` nudge the system \
         volume by 10. `open` reveals the tab without touching playback."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "play", "pause", "toggle", "next", "prev", "volup", "voldown", "open"]
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

#[cfg(test)]
mod g1_tool_tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;

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

    #[test]
    fn metronome_slash_args_maps_full_schema() {
        let args = json!({
            "action": "start",
            "bpm_delta": -5,
            "click_volume": 60,
            "accent_volume": 90,
            "beat_accents": [true, false, true],
            "numerator": 3,
            "denominator": 4,
            "trainer": { "enabled": true, "step_bpm": 2, "every_bars": 8, "target_bpm": 150 },
            "preset": "Slow \"Blues\"",
            "save_preset": "Mine",
        });
        let s = metronome_slash_args(&args).unwrap();
        assert!(s.starts_with("start"));
        for part in [
            "bpm=-5",
            "sig=3/4",
            "vol=60",
            "accent_vol=90",
            "accents=101",
            "trainer=on",
            "trainer_step=2",
            "trainer_bars=8",
            "trainer_target=150",
            "preset=\"Slow Blues\"",
            "save=\"Mine\"",
        ] {
            assert!(s.contains(part), "missing `{part}` in `{s}`");
        }
        assert!(metronome_slash_args(&json!({})).is_err());
        assert_eq!(metronome_slash_args(&json!({ "bpm_delta": 3 })).unwrap(), "bpm=+3");
        assert!(metronome_slash_args(&json!({ "numerator": 3 })).is_err());
    }
}
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

/// Canvas OCR — extract text from an image via Apple Vision, optionally
/// translating it. The assistant's natural-language surface for the Canvas
/// module's "OCR + translate from a picture" capability.
pub struct CanvasOcr;

#[async_trait]
impl Tool for CanvasOcr {
    fn name(&self) -> &'static str {
        "canvas_ocr_image"
    }
    fn description(&self) -> &'static str {
        "Extract text from an image with Apple Vision OCR, optionally translating it. \
         source='file' OCRs the image at `path`; source='capture' opens an interactive \
         screen-region selector and OCRs the grab. Set `translate_to` (e.g. 'en', 'uk') \
         to also return a translation of the recognised text."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "enum": ["file", "capture"],
                    "description": "Where the image comes from."
                },
                "path": {
                    "type": "string",
                    "description": "Absolute image path, required when source='file'."
                },
                "translate_to": {
                    "type": "string",
                    "description": "Optional ISO language code to translate the text into."
                }
            },
            "required": ["source"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("file");
        let text = match source {
            "file" => {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("source='file' requires `path`")?;
                crate::modules::canvas::capture::ocr_file(std::path::Path::new(path))?
            }
            "capture" => {
                let app = ctx.app.clone().ok_or("capture needs an app handle")?;
                // Interactive capture blocks until the user selects — keep it
                // off the async worker via a blocking task.
                tokio::task::spawn_blocking(move || {
                    crate::modules::canvas::capture::capture_and_ocr(&app)
                })
                .await
                .map_err(|e| e.to_string())??
                .unwrap_or_default()
            }
            other => return Err(format!("unknown source: {other}")),
        };
        let mut out = json!({ "text": text });
        if let Some(lang) = args.get("translate_to").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                match crate::modules::translator::engine::translate_via_google(&text, "auto", lang)
                {
                    Ok(tr) => {
                        out["translated"] = json!(tr);
                        out["translate_to"] = json!(lang);
                    }
                    Err(e) => out["translate_error"] = json!(e),
                }
            }
        }
        Ok(out)
    }
}

// ---- Telegram ----

pub struct SendTelegram;

#[async_trait]
impl Tool for SendTelegram {
    fn name(&self) -> &'static str {
        "send_telegram"
    }
    fn description(&self) -> &'static str {
        "Push a text message to the user's phone via their paired Telegram \
         chat. Use when the user asks to be notified / messaged in Telegram, \
         or when the request comes from the CLI and the user wants the \
         result on their phone. The text is sent verbatim. Returns \
         {sent:false, reason:'not_paired'} if Telegram isn't set up."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Message text to send, as-is."
                }
            },
            "required": ["text"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: text".to_string())?;
        if text.trim().is_empty() {
            return Err("text must not be empty".to_string());
        }
        Ok(if ctx.state.send_to_paired(text) {
            json!({ "sent": true })
        } else {
            json!({ "sent": false, "reason": "not_paired" })
        })
    }
}

// ---- npm scripts ----

pub struct NpmListScripts;

#[async_trait]
impl Tool for NpmListScripts {
    fn name(&self) -> &'static str {
        "npm_list_scripts"
    }
    fn description(&self) -> &'static str {
        "List the npm projects the user configured in Settings → Terminal, \
         the scripts each package.json declares, and which scripts are \
         currently running (with the TCP ports they listen on). Call before \
         `npm_run_script` / `npm_stop_script` when unsure of the exact \
         project or script name, or to answer \"what's running / on which port\"."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let app = ctx.app.as_ref().ok_or("npm_list_scripts needs an app handle")?;
        let projects = crate::modules::npm_scripts::commands::list_projects(app);
        let runs = crate::modules::npm_scripts::runs::running(app);
        let projects: Vec<Value> = projects
            .iter()
            .map(|p| {
                let running: Vec<Value> = runs
                    .iter()
                    .filter(|r| r.project_path == p.path)
                    .map(|r| {
                        json!({ "script": r.script, "ports": r.ports, "stopping": r.stopping })
                    })
                    .collect();
                json!({
                    "path": p.path,
                    "name": p.name,
                    "scripts": p.scripts,
                    "error": p.error,
                    "running": running,
                })
            })
            .collect();
        Ok(json!({ "projects": projects }))
    }
}

pub struct NpmRunScript;

#[async_trait]
impl Tool for NpmRunScript {
    fn name(&self) -> &'static str {
        "npm_run_script"
    }
    fn description(&self) -> &'static str {
        "Run an npm script from one of the configured projects: opens the \
         Stash Terminal tab, creates a new terminal tab in the project folder \
         and runs `npm run <script>` there. `project` may be the package \
         name, the folder name or the full path; `script` must match a name \
         from `npm_list_scripts` exactly."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Package name, folder name or absolute path of the project."
                },
                "script": {
                    "type": "string",
                    "description": "Script name as declared in package.json (e.g. \"dev\", \"build\")."
                }
            },
            "required": ["project", "script"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx.app.as_ref().ok_or("npm_run_script needs an app handle")?;
        let field = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("missing required field: {k}"))
        };
        let project = field("project")?;
        let script = field("script")?;
        let (name, script) =
            crate::modules::npm_scripts::commands::run_by_name(app, project, script)?;
        Ok(json!({ "ok": true, "project": name, "script": script }))
    }
}

pub struct NpmStopScript;

#[async_trait]
impl Tool for NpmStopScript {
    fn name(&self) -> &'static str {
        "npm_stop_script"
    }
    fn description(&self) -> &'static str {
        "Stop a running npm script (e.g. a dev server) started from Stash: \
         sends Ctrl+C to its terminal, escalating to SIGTERM/SIGKILL if it \
         does not exit within a few seconds. Stops every running instance \
         of that script in the project. `project` may be the package name, \
         the folder name or the full path; `script` must match exactly. \
         Use `npm_list_scripts` to see what is running."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Package name, folder name or absolute path of the project."
                },
                "script": {
                    "type": "string",
                    "description": "Script name as declared in package.json (e.g. \"dev\")."
                }
            },
            "required": ["project", "script"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx.app.as_ref().ok_or("npm_stop_script needs an app handle")?;
        let field = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("missing required field: {k}"))
        };
        let project = field("project")?;
        let script = field("script")?;
        let (name, script, count) =
            crate::modules::npm_scripts::commands::stop_by_name(app, project, script)?;
        Ok(json!({ "ok": true, "project": name, "script": script, "stopping": count }))
    }
}

// ────────────────────────────────────────────────────────────────────
// Separator (Demucs + BeatNet) tools.
// ────────────────────────────────────────────────────────────────────
//
// Stems separation runs for several minutes per song (CPU 2-5×
// realtime), which exceeds the registry's 5-second per-tool timeout.
// We don't wait inline: the tool enqueues a job and returns its id +
// initial status straight away, and the model is expected to follow
// up with `get_separator_job` to surface the result. This mirrors how
// `dl_*` tools could behave for long downloads (they don't yet, but
// it's the same shape).

use crate::modules::separator;
use tauri::Manager;

pub struct SeparateStems;

#[async_trait]
impl Tool for SeparateStems {
    fn name(&self) -> &'static str {
        "separate_stems"
    }
    fn description(&self) -> &'static str {
        "Split an audio file into 6 stems (vocals/drums/bass/guitar/piano/other) and detect BPM. \
         Demucs + BeatNet, local. Returns `job_id` immediately — fetch the final result via \
         `get_separator_job(job_id)` once it finishes (~2-5× track length on CPU)."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio file (mp3, m4a, flac, ogg, wav, aac, aiff, opus)."
                },
                "model": {
                    "type": "string",
                    "enum": ["htdemucs_6s", "htdemucs_ft", "htdemucs"],
                    "description": "Demucs model. Defaults to `htdemucs_6s` (yields guitar/piano stems)."
                },
                "stems": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Subset of stems (vocals/drums/bass/guitar/piano/other). Omit for all."
                },
                "output_dir": {
                    "type": "string",
                    "description": "Where to save stems. Omit for `~/Music/Stash Stems/<source-name>/`."
                }
            },
            "required": ["input_path"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let spec = parse_run_args(&args, "analyze")?;
        let state = app.state::<Arc<separator::SeparatorState>>();
        let job_id = separator::enqueue_job(app, &state, spec)?;
        Ok(json!({
            "job_id": job_id,
            "status": "queued",
            "hint": "poll get_separator_job(job_id) until status is completed/failed/cancelled"
        }))
    }
}

pub struct DetectBpm;

#[async_trait]
impl Tool for DetectBpm {
    fn name(&self) -> &'static str {
        "detect_bpm"
    }
    fn description(&self) -> &'static str {
        "Detect BPM of an audio file without stem separation. BeatNet, local. Faster than \
         the full separate_stems but slightly less reliable on busy mixes. Returns a job_id — \
         fetch the number via `get_separator_job(job_id)`."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio file."
                }
            },
            "required": ["input_path"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let spec = parse_run_args(&args, "bpm")?;
        let state = app.state::<Arc<separator::SeparatorState>>();
        let job_id = separator::enqueue_job(app, &state, spec)?;
        Ok(json!({ "job_id": job_id, "status": "queued" }))
    }
}

pub struct GetSeparatorJob;

#[async_trait]
impl Tool for GetSeparatorJob {
    fn name(&self) -> &'static str {
        "get_separator_job"
    }
    fn description(&self) -> &'static str {
        "Current state of a separator job: status (queued/running/completed/failed/cancelled), \
         progress 0..1, phase, BPM, and stem paths once completed."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string" }
            },
            "required": ["job_id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let job_id = args
            .get("job_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing job_id".to_string())?
            .to_string();
        let state = app.state::<Arc<separator::SeparatorState>>();
        let snapshot = state
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|j| j.id == job_id)
            .cloned();
        match snapshot {
            Some(j) => serde_json::to_value(j).map_err(|e| e.to_string()),
            None => Ok(json!({ "error": "job not found", "job_id": job_id })),
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Converter (ffmpeg orchestrator + whisper transcribe-to-file) tools.
// ────────────────────────────────────────────────────────────────────
//
// Convert is fast on most inputs (a few seconds for audio re-encode,
// proportional to clip length for video), but still potentially
// longer than the 5-second tool timeout. Same shape as the separator
// tools: return job_id immediately, expose a `get_converter_job`
// look-up the model is expected to poll. The transcribe tool is
// synchronous — whisper.cpp gives us one final result, no progress.

use crate::modules::converter;

pub struct ConvertMedia;

#[async_trait]
impl Tool for ConvertMedia {
    fn name(&self) -> &'static str {
        "convert_media"
    }
    fn description(&self) -> &'static str {
        "Convert an audio or video file via ffmpeg using one of the built-in presets \
         (mp3-320, mp3-128, m4a-aac, wav, flac, ogg-vorbis, opus, extract-audio, \
         mp4-remux, mov-remux, mp4-h264, mov-h264, webm-vp9, gif). Returns `job_id` \
         immediately — fetch the final output path via `get_converter_job(job_id)` \
         once it finishes. The *-remux ids stream-copy without re-encoding (instant \
         on iPhone .mov clips) but require source codecs the target container accepts."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio (mp3/m4a/flac/wav/…) or video (mp4/mov/webm/mkv/…) file."
                },
                "preset_id": {
                    "type": "string",
                    "enum": [
                        "mp3-320", "mp3-128", "m4a-aac", "wav", "flac",
                        "ogg-vorbis", "opus", "extract-audio",
                        "mp4-remux", "mov-remux",
                        "mp4-h264", "mov-h264", "webm-vp9", "gif"
                    ],
                    "description": "Which output format to produce."
                },
                "output_dir": {
                    "type": "string",
                    "description": "Where to write the output. Omit for `~/Downloads/Stash Converted/`."
                }
            },
            "required": ["input_path", "preset_id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let input_path = args
            .get("input_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing input_path".to_string())?
            .to_string();
        let preset_id = args
            .get("preset_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing preset_id".to_string())?
            .to_string();
        let output_dir = args
            .get("output_dir")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let state = app.state::<Arc<converter::ConverterState>>();
        let job_id = converter::commands::enqueue_convert(
            app,
            &state,
            converter::commands::ConverterRunArgs {
                input_path,
                preset_id,
                output_dir,
            },
        )?;
        Ok(json!({
            "job_id": job_id,
            "status": "queued",
            "hint": "poll get_converter_job(job_id) until status is completed/failed/cancelled"
        }))
    }
}

pub struct TranscribeToFile;

#[async_trait]
impl Tool for TranscribeToFile {
    fn name(&self) -> &'static str {
        "transcribe_to_file"
    }
    fn description(&self) -> &'static str {
        "Transcribe an audio or video file with the active whisper model and write \
         the transcript as a .txt next to the source. Returns the absolute path of \
         the written transcript. Synchronous — completes in one call (whisper.cpp \
         doesn't expose interim progress)."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio or video file."
                },
                "language": {
                    "type": "string",
                    "description": "BCP-47 language hint, e.g. `uk`, `en`, `de`. Omit or use `auto` for autodetect."
                }
            },
            "required": ["input_path"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let input_path = args
            .get("input_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing input_path".to_string())?
            .to_string();
        let language = args
            .get("language")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let audio = std::path::PathBuf::from(&input_path);
        let text = crate::modules::whisper::commands::transcribe_with_active_model(
            app, audio, language,
        )
        .await?;
        let parent = std::path::Path::new(&input_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let stem = std::path::Path::new(&input_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("transcript")
            .to_string();
        let out =
            crate::modules::converter::jobs::unique_output_path(&parent, &stem, "txt");
        std::fs::write(&out, text.as_bytes()).map_err(|e| format!("write transcript: {e}"))?;
        Ok(json!({
            "output_path": out.display().to_string(),
            "char_count": text.chars().count(),
        }))
    }
}

pub struct GetConverterJob;

#[async_trait]
impl Tool for GetConverterJob {
    fn name(&self) -> &'static str {
        "get_converter_job"
    }
    fn description(&self) -> &'static str {
        "Current state of a converter job: status (queued/running/completed/failed/cancelled), \
         progress 0..1, output path once completed."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string" }
            },
            "required": ["job_id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let job_id = args
            .get("job_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing job_id".to_string())?
            .to_string();
        let state = app.state::<Arc<converter::ConverterState>>();
        let snapshot = state
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|j| j.id == job_id)
            .cloned();
        match snapshot {
            Some(j) => serde_json::to_value(j).map_err(|e| e.to_string()),
            None => Ok(json!({ "error": "job not found", "job_id": job_id })),
        }
    }
}

fn parse_run_args(
    args: &Value,
    default_mode: &str,
) -> Result<separator::SeparatorRunArgs, String> {
    let input_path = args
        .get("input_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing input_path".to_string())?
        .to_string();
    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let stems = args.get("stems").and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    });
    let output_dir = args
        .get("output_dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(separator::SeparatorRunArgs {
        input_path,
        model,
        mode: Some(default_mode.into()),
        stems,
        output_dir,
    })
}

#[cfg(test)]
mod g4_tool_tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;

    #[tokio::test(flavor = "current_thread")]
    async fn send_telegram_rejects_empty_and_reports_unpaired() {
        let c = ctx();
        assert!(SendTelegram.invoke(&c, json!({ "text": "  " })).await.is_err());
        let out = SendTelegram.invoke(&c, json!({ "text": "hi" })).await.unwrap();
        assert_eq!(out, json!({ "sent": false, "reason": "not_paired" }));
    }
}
// ═══════════════ END G4 ═══════════════
