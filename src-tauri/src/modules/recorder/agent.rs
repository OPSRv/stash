//! Agent surface — Recorder: `/record` + `record_control`.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::modules::telegram::agent_util::{emit_with_ack, reveal_tab, run_slash};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

// -------------------- /record --------------------

/// Payload for the `recorder:remote` event. The embedded Recorder shell starts
/// or stops capture in response. Capture is inherently UI-bound, so this only
/// takes effect once the Valeton tab (which hosts the recorder) is mounted.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct RecorderRemote {
    pub action: Option<String>,
    /// Input gain as a linear multiplier (`1.0` = unity). When present the
    /// shell applies and persists it; clamped to the supported range there.
    pub gain: Option<f32>,
}

pub struct RecordCmd;

#[async_trait]
impl CommandHandler for RecordCmd {
    fn name(&self) -> &'static str {
        "record"
    }
    fn description(&self) -> &'static str {
        "Керувати рекордером у Valeton. Приклади: `start`, `stop`, `toggle`, `gain 1.5`."
    }
    fn usage(&self) -> &'static str {
        "/record [start|stop|toggle|gain <0..2>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let mut toks = args.split_whitespace();
        let first = toks.next();

        // `gain <n>` sets the input level (linear multiplier) without touching
        // capture — applies live to an in-flight take and persists for the next.
        if first.is_some_and(|t| t.eq_ignore_ascii_case("gain")) {
            let raw = toks.next();
            let gain = match raw.and_then(|v| v.parse::<f32>().ok()) {
                Some(g) if g.is_finite() => g.clamp(0.0, 2.0),
                _ => {
                    return Reply::text(format!(
                        "⚠️ потрібне число для gain (наприклад `1.5`)\nВикористання: {}",
                        self.usage()
                    ))
                }
            };
            reveal_tab(&ctx.app, "valeton-editor");
            let payload = RecorderRemote {
                gain: Some(gain),
                ..Default::default()
            };
            let ack = emit_recorder(&ctx.app, &payload).await;
            let Some(recording) = ack else {
                return record_card(RECORDER_NO_ACK.to_string());
            };
            return record_card(format!(
                "🎚 Підсилення → {}%.{}",
                (gain * 100.0).round() as i64,
                if recording { "\n🔴 Йде запис." } else { "" }
            ));
        }

        let action = match first {
            // Bare `/record` toggles — the most common quick action.
            None => "toggle".to_string(),
            Some(tok) => match tok.to_ascii_lowercase().as_str() {
                "start" | "rec" | "record" => "start".to_string(),
                "stop" | "save" => "stop".to_string(),
                "toggle" => "toggle".to_string(),
                other => {
                    return Reply::text(format!(
                        "⚠️ невідома дія `{other}`\nВикористання: {}",
                        self.usage()
                    ))
                }
            },
        };
        // Reveal + mount the Valeton editor (which hosts the recorder shell)
        // so its `recorder:remote` listener is attached before we emit.
        reveal_tab(&ctx.app, "valeton-editor");
        let payload = RecorderRemote {
            action: Some(action.clone()),
            ..Default::default()
        };
        // The shell acks with the phase it ended up in, so a toggle reports
        // what actually happened instead of guessing.
        record_card(match emit_recorder(&ctx.app, &payload).await {
            None => RECORDER_NO_ACK.to_string(),
            Some(true) => "🔴 Запис почато.".to_string(),
            Some(false) if action == "start" => "⚠️ Запис не стартував.".to_string(),
            Some(false) => "⏹ Запис зупинено й збережено.".to_string(),
        })
    }
}

const RECORDER_NO_ACK: &str =
    "⚠️ Рекордер не відповів — відкрий Stash → Valeton (вигляд з педалями).";

/// Deliver a `recorder:remote` payload with retries until the (lazy) Valeton
/// tab mounts and acks. Returns the shell's `recording` flag, or `None` when
/// nothing answered in time.
async fn emit_recorder(app: &tauri::AppHandle, payload: &RecorderRemote) -> Option<bool> {
    let value = serde_json::to_value(payload).unwrap_or_default();
    let ack = emit_with_ack(app, "recorder:remote", value, std::time::Duration::from_secs(4)).await?;
    Some(ack.get("recording").and_then(|v| v.as_bool()).unwrap_or(false))
}

/// Explicit start/stop (idempotent) rather than toggle — a stale card must
/// never flip the recorder.
fn record_card(text: String) -> Reply {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:record:{args}"));
    Reply {
        text,
        keyboard: Some(InlineKeyboard {
            rows: vec![
                vec![b("🔴 Запис", "start"), b("⏹ Стоп", "stop")],
                vec![
                    b("🎚 50%", "gain 0.5"),
                    b("🎚 100%", "gain 1"),
                    b("🎚 150%", "gain 1.5"),
                ],
            ],
        }),
        ..Default::default()
    }
}

// -------------------- record_control tool --------------------

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

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(RecordCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(RecordControl);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::assert_fits;

    #[test]
    fn record_keyboard_fits() {
        let rec = record_card("x".into()).keyboard.unwrap();
        assert_fits(&rec);
    }
}
