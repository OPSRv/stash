//! Agent surface — Drums: `/drums` + `drums_control`.
//!
//! The drum machine lives in the Valeton editor tab (Drums view) and owns
//! the patterns and audio engine; Rust only validates intent and forwards a
//! `drums:remote` patch. The `drums_control` tool converts its typed args to
//! the slash grammar, so `build_remote` is the single payload builder.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use crate::modules::drums::commands::{default_export_dir, state_path};
use crate::modules::drums::state::{
    is_preset, is_voice, DrumsState, BPM_MAX, BPM_MIN, EXPORT_BARS, KITS, METERS, PRESET_IDS, VOICES,
};
use crate::modules::telegram::agent_util::{emit_with_ack, reveal_tab, run_slash, tokenize_quoted};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Max length of a step string; the frontend tiles/truncates it to the grid.
const MAX_PATTERN_LEN: usize = 32;
const SWING_MAX_PERCENT: u8 = 60;

// -------------------- payload --------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DrumsExport {
    pub format: String,
    pub bars: u8,
    pub dir: String,
}

/// Payload for the `drums:remote` event. Only changed fields are present.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DrumsRemote {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<u32>,
    /// Relative change; the frontend applies and clamps it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm_delta: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bars: Option<u8>,
    /// Fraction 0..0.6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swing: Option<f32>,
    /// Voice -> normalized step string (`x` hit, `X` accent, `.` off).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub steps: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub clear: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub mute: BTreeMap<String, bool>,
    /// Voice -> linear 0..1.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub volume: BTreeMap<String, f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master_volume: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export: Option<DrumsExport>,
}

/// Parsed `/drums` arguments (raw user intent, percent units).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DrumsArgs {
    pub action: Option<String>,
    pub bpm: Option<u32>,
    pub bpm_delta: Option<i32>,
    pub preset: Option<String>,
    pub meter: Option<String>,
    pub kit: Option<String>,
    pub bars: Option<u8>,
    /// Percent 0..60.
    pub swing: Option<u8>,
    pub steps: BTreeMap<String, String>,
    pub clear: Vec<String>,
    pub mute: BTreeMap<String, bool>,
    /// Voice -> percent 0..100.
    pub volume: BTreeMap<String, u8>,
    /// Percent 0..100.
    pub master: Option<u8>,
    pub export: Option<String>,
    pub export_bars: Option<u8>,
}

// -------------------- parsing --------------------

/// Validate a step string: `x` hit, `X` accent, `.`/`-` off; `|` and
/// whitespace are ignored as visual separators. Returns the normalized form
/// (`x`/`X`/`.`), length 1..=32.
pub fn parse_pattern(voice: &str, raw: &str) -> Result<String, String> {
    let mut out = String::new();
    for c in raw.chars() {
        match c {
            'x' | 'X' => out.push(c),
            '.' | '-' => out.push('.'),
            '|' => {}
            c if c.is_whitespace() => {}
            other => {
                return Err(format!(
                    "{voice}: незрозумілий символ `{other}` (x = удар, X = акцент, . або - = пауза)"
                ))
            }
        }
    }
    let n = out.chars().count();
    if n == 0 || n > MAX_PATTERN_LEN {
        return Err(format!("{voice}: патерн має бути від 1 до {MAX_PATTERN_LEN} кроків, отримано {n}"));
    }
    Ok(out)
}

/// Comma-separated voices; `all` expands to every voice. Result is deduped
/// and in canonical voice order.
fn parse_voice_list(key: &str, val: &str) -> Result<Vec<String>, String> {
    let mut picked = Vec::new();
    for v in val.split(',').map(str::trim).filter(|v| !v.is_empty()) {
        if v == "all" {
            picked.extend(VOICES.iter().map(|s| s.to_string()));
        } else if is_voice(v) {
            picked.push(v.to_string());
        } else {
            return Err(format!("{key}: невідомий інструмент `{v}` ({})", VOICES.join(", ")));
        }
    }
    if picked.is_empty() {
        return Err(format!("{key}: порожній список інструментів"));
    }
    Ok(VOICES
        .iter()
        .filter(|v| picked.iter().any(|p| p == *v))
        .map(|v| v.to_string())
        .collect())
}

fn parse_ranged(key: &str, val: &str, min: u32, max: u32) -> Result<u32, String> {
    let n: u32 = val
        .trim_end_matches('%')
        .parse()
        .map_err(|_| format!("{key} має бути числом, отримано `{val}`"))?;
    if !(min..=max).contains(&n) {
        return Err(format!("{key} поза межами {min}–{max}: {n}"));
    }
    Ok(n)
}

pub fn parse_drums_args(args: &str) -> Result<DrumsArgs, String> {
    let mut out = DrumsArgs::default();
    for raw in tokenize_quoted(args) {
        let lower = raw.to_ascii_lowercase();
        match lower.as_str() {
            "start" | "play" => out.action = Some("start".into()),
            "stop" | "pause" => out.action = Some("stop".into()),
            "toggle" => out.action = Some("toggle".into()),
            "status" => out.action = Some("status".into()),
            other => {
                let (key, val) = other
                    .split_once('=')
                    .ok_or_else(|| format!("незрозумілий токен: `{other}`"))?;
                // Patterns are case-sensitive (`x` vs `X`), keep the raw value.
                let val_raw = raw.split_once('=').map(|(_, v)| v).unwrap_or("");
                match key {
                    "bpm" => {
                        if val.starts_with('+') || val.starts_with('-') {
                            let n: i32 = val
                                .parse()
                                .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                            out.bpm_delta = Some(n.clamp(-200, 200));
                        } else {
                            out.bpm = Some(parse_ranged("bpm", val, BPM_MIN, BPM_MAX)?);
                        }
                    }
                    "preset" => {
                        if !is_preset(val) {
                            return Err(format!(
                                "невідомий пресет `{val}` ({})",
                                PRESET_IDS.join(", ")
                            ));
                        }
                        out.preset = Some(val.to_string());
                    }
                    "meter" | "sig" => {
                        if !METERS.contains(&val) {
                            return Err(format!("meter має бути {}, отримано `{val}`", METERS.join("|")));
                        }
                        out.meter = Some(val.to_string());
                    }
                    "kit" => {
                        if !KITS.contains(&val) {
                            return Err(format!("kit має бути {}, отримано `{val}`", KITS.join("|")));
                        }
                        out.kit = Some(val.to_string());
                    }
                    "bars" => out.bars = Some(parse_ranged("bars", val, 1, 2)? as u8),
                    "swing" => {
                        out.swing =
                            Some(parse_ranged("swing", val, 0, SWING_MAX_PERCENT as u32)? as u8)
                    }
                    "clear" => {
                        for v in parse_voice_list("clear", val)? {
                            if !out.clear.contains(&v) {
                                out.clear.push(v);
                            }
                        }
                    }
                    "mute" | "unmute" => {
                        for v in parse_voice_list(key, val)? {
                            out.mute.insert(v, key == "mute");
                        }
                    }
                    "master" | "master_volume" => {
                        out.master = Some(parse_ranged("master", val, 0, 100)? as u8)
                    }
                    "export" => {
                        if !matches!(val, "wav" | "mp3") {
                            return Err(format!("export має бути wav|mp3, отримано `{val}`"));
                        }
                        out.export = Some(val.to_string());
                    }
                    "export_bars" => {
                        let n = parse_ranged("export_bars", val, 1, 16)? as u8;
                        if !EXPORT_BARS.contains(&n) {
                            return Err(format!("export_bars має бути 1|2|4|8|16, отримано {n}"));
                        }
                        out.export_bars = Some(n);
                    }
                    k if is_voice(k) => {
                        out.steps.insert(k.to_string(), parse_pattern(k, val_raw)?);
                    }
                    k => {
                        if let Some(voice) = k.strip_prefix("vol_") {
                            if !is_voice(voice) {
                                return Err(format!(
                                    "{k}: невідомий інструмент `{voice}` ({})",
                                    VOICES.join(", ")
                                ));
                            }
                            out.volume
                                .insert(voice.to_string(), parse_ranged(k, val, 0, 100)? as u8);
                        } else {
                            return Err(format!("невідомий параметр: `{k}`"));
                        }
                    }
                }
            }
        }
    }
    if out.export_bars.is_some() && out.export.is_none() {
        return Err("export_bars потребує export=wav|mp3".into());
    }
    Ok(out)
}

/// The single builder of the `drums:remote` payload. `export_dir` is only
/// called when an export was requested (it creates the folder).
pub fn build_remote(
    args: &DrumsArgs,
    persisted: &DrumsState,
    export_dir: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<DrumsRemote, String> {
    let pct = |p: u8| p as f32 / 100.0;
    let export = match &args.export {
        Some(format) => Some(DrumsExport {
            format: format.clone(),
            bars: args.export_bars.unwrap_or(persisted.export_bars),
            dir: export_dir()?.display().to_string(),
        }),
        None => None,
    };
    let mut remote = DrumsRemote {
        action: args.action.clone(),
        bpm: args.bpm,
        bpm_delta: args.bpm_delta,
        preset: args.preset.clone(),
        meter: args.meter.clone(),
        kit: args.kit.clone(),
        bars: args.bars,
        swing: args.swing.map(pct),
        steps: args.steps.clone(),
        clear: args.clear.clone(),
        mute: args.mute.clone(),
        volume: args.volume.iter().map(|(k, &v)| (k.clone(), pct(v))).collect(),
        master_volume: args.master.map(pct),
        export,
    };
    // Bare `/drums` is a status probe.
    if remote == DrumsRemote::default() {
        remote.action = Some("status".into());
    }
    Ok(remote)
}

fn is_status_only(r: &DrumsRemote) -> bool {
    *r == DrumsRemote {
        action: Some("status".into()),
        ..Default::default()
    }
}

// -------------------- reply --------------------

fn format_drums_reply(r: &DrumsRemote) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = &r.action {
        parts.push(match a.as_str() {
            "start" => "▶️ старт".into(),
            "stop" => "⏹ стоп".into(),
            "toggle" => "⏯ перемкнуто".into(),
            "status" => "ℹ️ статус".into(),
            other => other.into(),
        });
    }
    if let Some(p) = &r.preset {
        parts.push(format!("пресет {p}"));
    }
    if let Some(bpm) = r.bpm {
        parts.push(format!("{bpm} BPM"));
    }
    if let Some(d) = r.bpm_delta {
        parts.push(format!("{d:+} BPM"));
    }
    if let Some(m) = &r.meter {
        parts.push(m.clone());
    }
    if let Some(k) = &r.kit {
        parts.push(format!("кіт {k}"));
    }
    if let Some(b) = r.bars {
        parts.push(format!("тактів: {b}"));
    }
    if let Some(s) = r.swing {
        parts.push(format!("свінг {}%", (s * 100.0).round() as u32));
    }
    if !r.steps.is_empty() {
        let v: Vec<&str> = r.steps.keys().map(String::as_str).collect();
        parts.push(format!("патерн: {}", v.join(", ")));
    }
    if !r.clear.is_empty() {
        parts.push(format!("очищено: {}", r.clear.join(", ")));
    }
    for (v, m) in &r.mute {
        parts.push(format!("{v} {}", if *m { "🔇" } else { "🔊" }));
    }
    for (v, vol) in &r.volume {
        parts.push(format!("{v} {}%", (vol * 100.0).round() as u32));
    }
    if let Some(m) = r.master_volume {
        parts.push(format!("майстер {}%", (m * 100.0).round() as u32));
    }
    if let Some(e) = &r.export {
        parts.push(format!("експорт {} × {} такт.", e.format, e.bars));
    }
    format!("🥁 Драм-машина: {}", parts.join(", "))
}

fn drums_keyboard(playing: Option<bool>) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:drums:{args}"));
    let transport = if playing == Some(true) {
        b("⏹ Стоп", "stop")
    } else {
        b("▶️ Старт", "start")
    };
    InlineKeyboard {
        rows: vec![
            vec![transport, b("🔄", "")],
            vec![b("−5", "bpm=-5"), b("+5", "bpm=+5")],
        ],
    }
}

/// Build the reply card from the ack (live state) or, without one, the
/// persisted state.
fn drums_card(remote: &DrumsRemote, ack: Option<&Value>, persisted: &DrumsState) -> Reply {
    let mut lines: Vec<String> = Vec::new();
    let playing = ack.and_then(|v| v.get("playing")).and_then(Value::as_bool);
    match ack {
        None if is_status_only(remote) => {}
        None => lines.push("⚠️ Драм-машина не відповіла — відкрий Stash → Valeton → Drums.".into()),
        Some(a) => {
            if let Some(err) = a.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
                lines.push(format!("⚠️ {err}"));
            }
            if !is_status_only(remote) {
                lines.push(format_drums_reply(remote));
            }
        }
    }
    let bpm = ack
        .and_then(|v| v.get("bpm"))
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .unwrap_or(persisted.bpm);
    let preset = match ack {
        Some(a) => a.get("preset_id").and_then(Value::as_str).map(str::to_string),
        None => persisted.preset_id.clone(),
    };
    let icon = if playing == Some(true) { "▶️" } else { "⏹" };
    lines.push(format!(
        "{icon} {bpm} BPM · {}",
        preset.as_deref().unwrap_or("свій патерн")
    ));
    if let Some(path) = ack
        .and_then(|v| v.get("exported_path"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    {
        lines.push(format!("💾 Експортовано: {path}"));
    }
    if ack.is_none() && is_status_only(remote) {
        lines.push("💤 Драм-машина не відкрита — Stash → Valeton → Drums.".into());
    }
    Reply {
        text: lines.join("\n"),
        keyboard: Some(drums_keyboard(playing)),
        ..Default::default()
    }
}

// -------------------- /drums --------------------

pub struct DrumsCmd;

#[async_trait]
impl CommandHandler for DrumsCmd {
    fn name(&self) -> &'static str {
        "drums"
    }
    fn description(&self) -> &'static str {
        "Керувати драм-машиною. Приклади: `start preset=funk bpm=96`, `stop`, `bpm=+5`, \
         `kick=x...x...x...x...`, `mute=ohh`, `export=mp3 export_bars=8`."
    }
    fn usage(&self) -> &'static str {
        "/drums [start|stop|toggle|status] [bpm=N|+N|-N] [preset=<id>] [meter=4/4|3/4|6/8|12/8] \
         [kit=acoustic|rock|electronic] \
         [bars=1|2] [swing=0..60] [<voice>=<pattern>] [clear=<voice|all>[,..]] [mute=<voice>[,..]] \
         [unmute=<voice>[,..]] [vol_<voice>=0..100] [master=0..100] [export=wav|mp3] \
         [export_bars=1|2|4|8|16]\nІнструменти: kick, snare, chh, ohh, clap, tom, rim, crash. \
         Патерн: x = удар, X = акцент, . або - = пауза."
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let persisted = state_path(&ctx.app)
            .as_ref()
            .map(DrumsState::load)
            .unwrap_or_default();
        let remote = match parse_drums_args(args)
            .and_then(|a| build_remote(&a, &persisted, default_export_dir))
        {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        let status_only = is_status_only(&remote);
        if !status_only {
            reveal_tab(&ctx.app, "valeton-editor");
        }
        let window = if remote.export.is_some() {
            std::time::Duration::from_secs(20)
        } else if status_only {
            std::time::Duration::from_millis(400)
        } else {
            std::time::Duration::from_secs(4)
        };
        let payload = serde_json::to_value(&remote).unwrap_or_default();
        let ack = emit_with_ack(&ctx.app, "drums:remote", payload, window).await;
        drums_card(&remote, ack.as_ref(), &persisted)
    }
}

// -------------------- drums_control tool --------------------

pub struct DrumsControl;

fn require_voice(field: &str, v: &str) -> Result<(), String> {
    if is_voice(v) {
        Ok(())
    } else {
        Err(format!("{field}: unknown voice `{v}` (expected one of {})", VOICES.join(", ")))
    }
}

/// Translate the typed `drums_control` payload into `/drums` slash args.
/// Pure so the mapping is unit-testable; validation of values is left to
/// `parse_drums_args` except for voice keys of objects.
fn drums_slash_args(args: &Value) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = args.get("action").and_then(Value::as_str) {
        parts.push(a.to_string());
    }
    if let Some(bpm) = args.get("bpm").and_then(Value::as_u64) {
        parts.push(format!("bpm={bpm}"));
    }
    if let Some(d) = args.get("bpm_delta").and_then(Value::as_i64) {
        if d != 0 {
            parts.push(format!("bpm={d:+}"));
        }
    }
    for (field, key) in [("preset", "preset"), ("meter", "meter"), ("kit", "kit")] {
        if let Some(v) = args.get(field).and_then(Value::as_str) {
            parts.push(format!("{key}={}", v.trim()));
        }
    }
    if let Some(b) = args.get("bars").and_then(Value::as_u64) {
        parts.push(format!("bars={b}"));
    }
    if let Some(s) = args.get("swing_percent").and_then(Value::as_u64) {
        parts.push(format!("swing={s}"));
    }
    if let Some(steps) = args.get("steps").and_then(Value::as_object) {
        for (voice, pat) in steps {
            require_voice("steps", voice)?;
            let pat = pat
                .as_str()
                .ok_or_else(|| format!("steps.{voice} must be a string"))?;
            let compact: String = pat.chars().filter(|c| !c.is_whitespace()).collect();
            if compact.is_empty() {
                return Err(format!("steps.{voice} is empty"));
            }
            parts.push(format!("{voice}={compact}"));
        }
    }
    if let Some(list) = args.get("clear").and_then(Value::as_array) {
        let voices: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
        if !voices.is_empty() {
            parts.push(format!("clear={}", voices.join(",")));
        }
    }
    if let Some(mute) = args.get("mute").and_then(Value::as_object) {
        let (mut on, mut off) = (Vec::new(), Vec::new());
        for (voice, flag) in mute {
            require_voice("mute", voice)?;
            match flag.as_bool() {
                Some(true) => on.push(voice.as_str()),
                Some(false) => off.push(voice.as_str()),
                None => return Err(format!("mute.{voice} must be a boolean")),
            }
        }
        if !on.is_empty() {
            parts.push(format!("mute={}", on.join(",")));
        }
        if !off.is_empty() {
            parts.push(format!("unmute={}", off.join(",")));
        }
    }
    if let Some(vol) = args.get("volume").and_then(Value::as_object) {
        for (voice, v) in vol {
            require_voice("volume", voice)?;
            let n = v
                .as_u64()
                .ok_or_else(|| format!("volume.{voice} must be an integer percent"))?;
            parts.push(format!("vol_{voice}={}", n.min(100)));
        }
    }
    if let Some(m) = args.get("master_volume").and_then(Value::as_u64) {
        parts.push(format!("master={}", m.min(100)));
    }
    if let Some(e) = args.get("export").and_then(Value::as_object) {
        let format = e
            .get("format")
            .and_then(Value::as_str)
            .ok_or("export.format is required (wav|mp3)")?;
        parts.push(format!("export={format}"));
        if let Some(b) = e.get("bars").and_then(Value::as_u64) {
            parts.push(format!("export_bars={b}"));
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
impl Tool for DrumsControl {
    fn name(&self) -> &'static str {
        "drums_control"
    }
    fn description(&self) -> &'static str {
        "Full control of the drum machine (step sequencer in the Valeton tab's Drums view) — \
         playback, BPM (absolute or relative), built-in preset grooves, meter, drum kit (acoustic = recorded jazz/studio, rock = big punchy recorded rock, electronic = synthesized analog drum machine), 1 or 2 bars, \
         swing, per-voice step patterns, clearing rows, per-voice mute and volume, master \
         volume, and audio export (WAV/MP3 into ~/Music/Stash/Drums). Any field you omit is left \
         untouched; `action:\"status\"` returns whether it is playing, the BPM and preset. \
         Voices: kick, snare, chh (closed hi-hat), ohh (open hi-hat), clap, tom, rim, crash. \
         Presets (genre variations — the bare genre id is its basic groove): rock (basic), \
         rock-2 (driving 8ths), rock-3 (open hats), rock-4 (four on the floor), pop (radio), \
         pop-2 (ballad), pop-3 (dance-pop), funk (classic), funk-2 (ghost notes), funk-3 \
         (linear), disco, disco-2 (nu-disco), disco-3 (house), shuffle, shuffle-2 (slow blues), \
         shuffle-3 (texas shuffle), jazz (swing, 12/8), halftime, halftime-2 (trap), halftime-3, \
         metal (double kick), metal-2 (gallop), metal-3 (thrash skank), metal-4 (blast beat), \
         punk (straight 8ths), punk-2 (skate punk), reggae (one drop), reggae-2 (steppers), \
         reggae-3 (rockers), bossa (bossa nova), bossa-2 (samba), bossa-3 (cha-cha), hiphop, \
         hiphop-2 (boom bap), hiphop-3 (lo-fi), waltz, waltz-2 (jazz waltz), ballad68 (6/8 \
         ballad), ballad68-2 (6/8 rock). Step notation: one character per step — `x` = hit, `X` = accented \
         hit, `.` or `-` = rest (`|` may separate beats); 1..32 steps, tiled/truncated to the \
         grid. Grid: 4/4 has 16 steps per bar (sixteenths), 3/4 and 6/8 have 12, 12/8 has 12 \
         (triplet grid). E.g. four-on-the-floor kick in 4/4: \"x...x...x...x...\". A preset is \
         applied first, then explicit fields (so preset + steps edits the preset groove)."
    }
    fn schema(&self) -> Value {
        let voice_props = |item: Value| -> Value {
            let mut m = serde_json::Map::new();
            for v in VOICES {
                m.insert(v.to_string(), item.clone());
            }
            Value::Object(m)
        };
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["start", "stop", "toggle", "status"] },
                "bpm": { "type": "integer", "minimum": BPM_MIN, "maximum": BPM_MAX },
                "bpm_delta": {
                    "type": "integer", "minimum": -200, "maximum": 200,
                    "description": "Relative BPM change, e.g. 5 = faster by 5. Result clamps to 40..240."
                },
                "preset": { "type": "string", "enum": PRESET_IDS.as_slice() },
                "meter": { "type": "string", "enum": METERS },
                "kit": {
                    "type": "string", "enum": KITS,
                    "description": "Drum kit: acoustic (recorded jazz/studio), rock (big recorded rock), electronic (synthesized analog drum machine)."
                },
                "bars": { "type": "integer", "enum": [1, 2], "description": "Pattern length in bars." },
                "swing_percent": {
                    "type": "integer", "minimum": 0, "maximum": SWING_MAX_PERCENT,
                    "description": "Swing amount, percent (0 = straight)."
                },
                "steps": {
                    "type": "object",
                    "description": "Voice -> step string (x hit, X accent, . rest), 1..32 chars.",
                    "properties": voice_props(json!({ "type": "string" })),
                    "additionalProperties": false
                },
                "clear": {
                    "type": "array",
                    "description": "Voices whose rows to clear; \"all\" clears every voice.",
                    "items": { "type": "string", "enum": VOICES.iter().copied().chain(["all"]).collect::<Vec<_>>() }
                },
                "mute": {
                    "type": "object",
                    "description": "Voice -> true to mute, false to unmute.",
                    "properties": voice_props(json!({ "type": "boolean" })),
                    "additionalProperties": false
                },
                "volume": {
                    "type": "object",
                    "description": "Voice -> volume percent 0..100.",
                    "properties": voice_props(json!({ "type": "integer", "minimum": 0, "maximum": 100 })),
                    "additionalProperties": false
                },
                "master_volume": {
                    "type": "integer", "minimum": 0, "maximum": 100,
                    "description": "Master volume, percent."
                },
                "export": {
                    "type": "object",
                    "description": "Render the current pattern to an audio file in ~/Music/Stash/Drums.",
                    "properties": {
                        "format": { "type": "string", "enum": ["wav", "mp3"] },
                        "bars": {
                            "type": "integer", "enum": EXPORT_BARS,
                            "description": "Length of the rendered file in bars (default: last used)."
                        }
                    },
                    "required": ["format"],
                    "additionalProperties": false
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let slash = drums_slash_args(&args)?;
        run_slash(ctx, "drums", &slash).await
    }
}

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(DrumsCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(DrumsControl);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::{
        all_callbacks, assert_fits, tool_ctx as ctx,
    };

    fn no_dir() -> Result<PathBuf, String> {
        Err("export_dir must not be called".into())
    }

    #[test]
    fn parse_actions_and_scalars() {
        let a = parse_drums_args(
            "play bpm=120 preset=FUNK meter=6/8 kit=rock bars=2 swing=25 master=70% export=mp3 export_bars=8",
        )
        .unwrap();
        assert_eq!(a.action.as_deref(), Some("start"));
        assert_eq!(a.bpm, Some(120));
        assert_eq!(a.preset.as_deref(), Some("funk"));
        assert_eq!(a.meter.as_deref(), Some("6/8"));
        assert_eq!(a.kit.as_deref(), Some("rock"));
        assert_eq!(parse_drums_args("kit=electronic").unwrap().kit.as_deref(), Some("electronic"));
        assert_eq!(a.bars, Some(2));
        assert_eq!(a.swing, Some(25));
        assert_eq!(a.master, Some(70));
        assert_eq!(a.export.as_deref(), Some("mp3"));
        assert_eq!(a.export_bars, Some(8));
        assert_eq!(parse_drums_args("pause").unwrap().action.as_deref(), Some("stop"));
        assert_eq!(parse_drums_args("meter=12/8").unwrap().meter.as_deref(), Some("12/8"));
        assert_eq!(parse_drums_args("bpm=+5").unwrap().bpm_delta, Some(5));
        assert_eq!(parse_drums_args("bpm=-10").unwrap().bpm_delta, Some(-10));
        assert_eq!(parse_drums_args("").unwrap(), DrumsArgs::default());
    }

    #[test]
    fn parse_voices_patterns_and_lists() {
        let a = parse_drums_args(
            "kick=x...X...|x-x-x... clear=snare,all mute=ohh,clap unmute=clap vol_snare=40",
        )
        .unwrap();
        assert_eq!(a.steps["kick"], "x...X...x.x.x...");
        assert_eq!(a.clear, VOICES.iter().map(|v| v.to_string()).collect::<Vec<_>>());
        assert_eq!(a.mute.get("ohh"), Some(&true));
        assert_eq!(a.mute.get("clap"), Some(&false), "later unmute wins");
        assert_eq!(a.volume.get("snare"), Some(&40));
    }

    #[test]
    fn parse_rejects_bad_input() {
        let cases = [
            ("cowbell=x...", "cowbell"),
            ("kick=x.o.", "kick"),
            ("kick=", "kick"),
            (&format!("kick={}", "x".repeat(33)), "kick"),
            ("preset=polka", "polka"),
            ("meter=5/4", "meter"),
            ("kit=marimba", "kit"),
            ("bars=3", "bars"),
            ("swing=70", "swing"),
            ("vol_cowbell=50", "cowbell"),
            ("vol_kick=150", "vol_kick"),
            ("mute=bongo", "bongo"),
            ("clear=", "clear"),
            ("export=flac", "export"),
            ("export=wav export_bars=3", "export_bars"),
            ("export_bars=4", "export_bars"),
            ("bpm=999", "bpm"),
            ("foo", "foo"),
        ];
        for (input, needle) in cases {
            let err = parse_drums_args(input).unwrap_err();
            assert!(err.contains(needle), "`{input}` → `{err}` should mention `{needle}`");
        }
    }

    #[test]
    fn pattern_validation() {
        assert_eq!(parse_pattern("kick", "x-X. |x").unwrap(), "x.X.x");
        assert_eq!(parse_pattern("kick", &"x".repeat(32)).unwrap().len(), 32);
        assert!(parse_pattern("kick", "|||").is_err());
        assert!(parse_pattern("kick", "x1").is_err());
    }

    #[test]
    fn build_remote_converts_units_and_defaults_to_status() {
        let st = DrumsState::default();
        let r = build_remote(&DrumsArgs::default(), &st, no_dir).unwrap();
        assert!(is_status_only(&r));

        let a = parse_drums_args("swing=30 vol_kick=50 master=100").unwrap();
        let r = build_remote(&a, &st, no_dir).unwrap();
        assert!(r.action.is_none());
        assert!((r.swing.unwrap() - 0.3).abs() < 1e-6);
        assert!((r.volume["kick"] - 0.5).abs() < 1e-6);
        assert_eq!(r.master_volume, Some(1.0));

        let a = parse_drums_args("export=wav").unwrap();
        let r = build_remote(&a, &st, || Ok(PathBuf::from("/x/Drums"))).unwrap();
        assert_eq!(
            r.export,
            Some(DrumsExport {
                format: "wav".into(),
                bars: st.export_bars,
                dir: "/x/Drums".into()
            })
        );
    }

    #[test]
    fn remote_payload_omits_unchanged_fields() {
        let a = parse_drums_args("start kick=x... ").unwrap();
        let r = build_remote(&a, &DrumsState::default(), no_dir).unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, json!({ "action": "start", "steps": { "kick": "x..." } }));
    }

    #[test]
    fn card_uses_ack_and_falls_back_to_persisted() {
        let st = DrumsState::default();
        let remote = build_remote(&parse_drums_args("export=mp3").unwrap(), &st, || {
            Ok(PathBuf::from("/d"))
        })
        .unwrap();
        let ack = json!({ "ack_id": 1, "playing": true, "bpm": 128, "preset_id": null,
                          "exported_path": "/d/beat.mp3" });
        let reply = drums_card(&remote, Some(&ack), &st);
        assert!(reply.text.contains("▶️ 128 BPM · свій патерн"));
        assert!(reply.text.contains("/d/beat.mp3"));
        let status = build_remote(&DrumsArgs::default(), &st, no_dir).unwrap();
        let reply = drums_card(&status, None, &st);
        assert!(reply.text.contains("⏹ 100 BPM · rock"));
        let reply = drums_card(&remote, None, &st);
        assert!(reply.text.contains("не відповіла"));
        let kb = drums_keyboard(Some(true));
        assert_fits(&kb);
        for d in all_callbacks(&kb) {
            let args = d.strip_prefix("refresh:drums:").unwrap();
            assert!(parse_drums_args(args).is_ok(), "unparseable button arg: {args}");
        }
    }

    #[test]
    fn tool_args_round_trip_through_slash_grammar() {
        let args = json!({
            "action": "start",
            "bpm_delta": -5,
            "preset": "shuffle",
            "meter": "12/8",
            "kit": "electronic",
            "bars": 2,
            "swing_percent": 20,
            "steps": { "kick": "x.. x..", "snare": "...X.." },
            "clear": ["ohh", "crash"],
            "mute": { "clap": true, "rim": false },
            "volume": { "kick": 90 },
            "master_volume": 75,
            "export": { "format": "mp3", "bars": 16 }
        });
        let slash = drums_slash_args(&args).unwrap();
        let parsed = parse_drums_args(&slash).unwrap();
        let expected = DrumsArgs {
            action: Some("start".into()),
            bpm_delta: Some(-5),
            preset: Some("shuffle".into()),
            meter: Some("12/8".into()),
            kit: Some("electronic".into()),
            bars: Some(2),
            swing: Some(20),
            steps: [("kick", "x..x.."), ("snare", "...X..")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            clear: vec!["ohh".into(), "crash".into()],
            mute: [("clap".to_string(), true), ("rim".to_string(), false)].into(),
            volume: [("kick".to_string(), 90)].into(),
            master: Some(75),
            export: Some("mp3".into()),
            export_bars: Some(16),
            ..Default::default()
        };
        assert_eq!(parsed, expected);
        assert_eq!(drums_slash_args(&json!({ "bpm": 90 })).unwrap(), "bpm=90");
    }

    #[test]
    fn tool_args_errors() {
        assert!(drums_slash_args(&json!({})).unwrap_err().contains("at least one"));
        assert!(drums_slash_args(&json!({ "steps": { "cowbell": "x" } }))
            .unwrap_err()
            .contains("cowbell"));
        assert!(drums_slash_args(&json!({ "export": { "bars": 4 } }))
            .unwrap_err()
            .contains("format"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn drums_control_requires_at_least_one_field() {
        let err = DrumsControl.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("at least one"));
    }
}
