//! Agent surface — Circle of fifths: `circle_progression`.
//!
//! Moved verbatim from `telegram/tools/stash.rs` (G1, see
//! `docs/agent-surface-refactor.md`). No slash command.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

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

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(CircleProgression);
}
