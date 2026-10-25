//! Agent surface — Valeton GP-5: `/valeton` + `valeton_set_tone` / `valeton_control`.
//!
//! Moved verbatim from `telegram/module_cmds.rs` / `telegram/tools/stash.rs`
//! (G1, see `docs/agent-surface-refactor.md`). Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::modules::telegram::agent_util::{emit_with_ack, reveal_tab, run_slash};
use crate::modules::telegram::commands_registry::{CommandHandler, Ctx, Reply};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

// -------------------- /valeton --------------------

/// Payload for the `valeton:remote` event. The Valeton editor applies every
/// `Some` field against the current patch / device, in this order: select
/// patch → apply AI preset → bpm/division → block on/off → save. Device I/O is
/// best-effort: if the GP-5 isn't connected the editor updates its UI state and
/// the changes flush on the next connect.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ValetonRemote {
    /// Switch to patch 0..99 on the device.
    pub patch: Option<u8>,
    /// Tap-tempo / delay-sync BPM (40..240).
    pub bpm: Option<u32>,
    /// Note division for the tempo: `quarter` | `eighth` | `dotted`.
    pub division: Option<String>,
    /// Effect block key to toggle (`nr|pre|dst|amp|cab|eq|mod|dly|rvb|ns`).
    pub block: Option<String>,
    /// Target on/off state for `block`.
    pub block_on: Option<bool>,
    /// Persist the current edit buffer into the active patch on the device.
    pub save: Option<bool>,
    /// AI-generated preset JSON to parse + apply (set by `/valeton tone …`).
    pub preset_json: Option<String>,
}

/// The ten GP-5 effect-block keys, in protocol order.
const VALETON_BLOCKS: &[&str] = &[
    "nr", "pre", "dst", "amp", "cab", "eq", "mod", "dly", "rvb", "ns",
];

pub struct ValetonCmd;

#[async_trait]
impl CommandHandler for ValetonCmd {
    fn name(&self) -> &'static str {
        "valeton"
    }
    fn description(&self) -> &'static str {
        "Керувати редактором Valeton GP-5. Приклади: `tone warm gilmour lead`, \
         `patch=12`, `bpm=120`, `amp=on`, `save`."
    }
    fn usage(&self) -> &'static str {
        "/valeton tone <опис тону> | [patch=0..99] [bpm=40..240] \
         [div=quarter|eighth|dotted] [<block>=on|off] [save]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let args = args.trim();
        if args.is_empty() {
            return Reply::text(format!("⚠️ нічого не задано\nВикористання: {}", self.usage()));
        }

        // `tone <free text>` — generate a preset from a natural-language tone
        // description and apply it to the current patch. Everything after the
        // `tone` keyword is the prompt (it has spaces, unlike key=val tokens).
        if let Some(rest) = args
            .strip_prefix("tone")
            .filter(|r| r.is_empty() || r.starts_with(char::is_whitespace))
        {
            let desc = rest.trim();
            if desc.is_empty() {
                return Reply::text(
                    "⚠️ опиши потрібний тон, напр. `tone warm gilmour lead`.".to_string(),
                );
            }
            let json = match crate::modules::valeton::commands::generate_preset_json(&ctx.app, desc)
                .await
            {
                Ok(j) => j,
                Err(e) => return Reply::text(format!("⚠️ не вдалося згенерувати тон: {e}")),
            };
            reveal_tab(&ctx.app, "valeton-editor");
            let delivered = emit_valeton(
                &ctx.app,
                &ValetonRemote {
                    preset_json: Some(json),
                    ..Default::default()
                },
            )
            .await;
            return Reply::text(with_valeton_note(format!("🎸 Застосовую тон: {desc}"), delivered));
        }

        let parsed = match parse_valeton_args(args) {
            Ok(p) => p,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        // Reveal + mount the editor and re-emit until its `valeton:remote`
        // listener acks, so a lazy first mount doesn't drop the command.
        reveal_tab(&ctx.app, "valeton-editor");
        let reply = format_valeton_reply(&parsed);
        let delivered = emit_valeton(&ctx.app, &parsed).await;
        Reply::text(with_valeton_note(reply, delivered))
    }
}

/// Deliver a `valeton:remote` payload with retries until the editor acks.
async fn emit_valeton(app: &tauri::AppHandle, payload: &ValetonRemote) -> bool {
    let value = serde_json::to_value(payload).unwrap_or_default();
    emit_with_ack(app, "valeton:remote", value, std::time::Duration::from_secs(4))
        .await
        .is_some()
}

fn with_valeton_note(reply: String, delivered: bool) -> String {
    if delivered {
        reply
    } else {
        format!("{reply}\n⚠️ Редактор Valeton не відповів — відкрий Stash → Valeton.")
    }
}

fn parse_valeton_args(args: &str) -> Result<ValetonRemote, String> {
    let mut out = ValetonRemote::default();
    for tok in args.split_whitespace() {
        let lower = tok.to_ascii_lowercase();
        if lower == "save" {
            out.save = Some(true);
            continue;
        }
        let (key, val) = lower
            .split_once('=')
            .ok_or_else(|| format!("незрозумілий токен: `{tok}` (очікую key=value або save)"))?;
        match key {
            "patch" | "preset" => {
                let n: u8 = val
                    .parse()
                    .map_err(|_| format!("patch має бути числом, отримано `{val}`"))?;
                if n > 99 {
                    return Err(format!("patch поза межами 0–99: {n}"));
                }
                out.patch = Some(n);
            }
            "bpm" => {
                let n: u32 = val
                    .parse()
                    .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                if !(40..=240).contains(&n) {
                    return Err(format!("bpm поза межами 40–240: {n}"));
                }
                out.bpm = Some(n);
            }
            "div" | "division" => {
                let d = match val {
                    "quarter" | "q" | "1/4" => "quarter",
                    "eighth" | "8" | "1/8" => "eighth",
                    "dotted" | "dot" => "dotted",
                    _ => return Err(format!("div має бути quarter|eighth|dotted, отримано `{val}`")),
                };
                out.division = Some(d.to_string());
            }
            block if VALETON_BLOCKS.contains(&block) => {
                let on = match val {
                    "on" | "1" | "true" | "enable" => true,
                    "off" | "0" | "false" | "disable" => false,
                    _ => return Err(format!("{block} приймає on|off, отримано `{val}`")),
                };
                out.block = Some(block.to_string());
                out.block_on = Some(on);
            }
            _ => return Err(format!("невідомий параметр: `{key}`")),
        }
    }
    if out.patch.is_none()
        && out.bpm.is_none()
        && out.division.is_none()
        && out.block.is_none()
        && out.save.is_none()
    {
        return Err("жодної дії не розпізнано".into());
    }
    Ok(out)
}

fn format_valeton_reply(r: &ValetonRemote) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = r.patch {
        parts.push(format!("патч {p}"));
    }
    if let Some(bpm) = r.bpm {
        parts.push(format!("{bpm} BPM"));
    }
    if let Some(div) = &r.division {
        parts.push(format!("поділ={div}"));
    }
    if let (Some(b), Some(on)) = (&r.block, r.block_on) {
        parts.push(format!("{} {}", b.to_uppercase(), if on { "on" } else { "off" }));
    }
    if r.save == Some(true) {
        parts.push("збереження".into());
    }
    if parts.is_empty() {
        "🎸 Valeton без змін.".to_string()
    } else {
        format!("🎸 Valeton: {}", parts.join(", "))
    }
}

// -------------------- valeton tools --------------------

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

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(ValetonCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(ValetonSetTone);
    tools.register(ValetonControl);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valeton_collects_patch_bpm_division() {
        let r = parse_valeton_args("patch=12 bpm=120 div=eighth").unwrap();
        assert_eq!(r.patch, Some(12));
        assert_eq!(r.bpm, Some(120));
        assert_eq!(r.division.as_deref(), Some("eighth"));
    }

    #[test]
    fn parse_valeton_block_on_off() {
        let on = parse_valeton_args("amp=on").unwrap();
        assert_eq!(on.block.as_deref(), Some("amp"));
        assert_eq!(on.block_on, Some(true));
        let off = parse_valeton_args("dly=off").unwrap();
        assert_eq!(off.block.as_deref(), Some("dly"));
        assert_eq!(off.block_on, Some(false));
    }

    #[test]
    fn parse_valeton_bare_save() {
        let r = parse_valeton_args("save").unwrap();
        assert_eq!(r.save, Some(true));
    }

    #[test]
    fn parse_valeton_rejects_out_of_range_and_unknown() {
        assert!(parse_valeton_args("patch=200").unwrap_err().contains("0–99"));
        assert!(parse_valeton_args("bpm=999").unwrap_err().contains("40–240"));
        assert!(parse_valeton_args("div=triplet").unwrap_err().contains("div"));
        assert!(parse_valeton_args("amp=maybe").unwrap_err().contains("on|off"));
        assert!(parse_valeton_args("foo=1").unwrap_err().contains("невідомий"));
        // no recognised action at all
        assert!(parse_valeton_args("").unwrap_err().contains("жодної"));
    }

    #[test]
    fn format_valeton_reply_summarises_fields() {
        let r = ValetonRemote {
            patch: Some(7),
            bpm: Some(90),
            block: Some("amp".into()),
            block_on: Some(true),
            save: Some(true),
            ..Default::default()
        };
        let out = format_valeton_reply(&r);
        assert!(out.contains("патч 7"));
        assert!(out.contains("90 BPM"));
        assert!(out.contains("AMP on"));
        assert!(out.contains("збереження"));
    }
}
