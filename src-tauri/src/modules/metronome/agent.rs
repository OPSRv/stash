//! Agent surface — Metronome: `/metronome` + `metronome_control`.
//!
//! Moved verbatim from `telegram/module_cmds.rs` / `telegram/tools/stash.rs`
//! (G1, see `docs/agent-surface-refactor.md`). Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;

use crate::modules::metronome::commands::MetronomeStateHandle;
use crate::modules::metronome::state::{
    MetronomeState, Preset as MetronomePreset, TrainerConfig as MetronomeTrainer,
};
use crate::modules::telegram::agent_util::{
    emit_with_ack, now_ms, reveal_tab, run_slash, tokenize_quoted,
};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

// -------------------- /metronome --------------------

/// Payload for the `metronome:remote` event. Frontend applies the patch
/// (any `Some` field), then reacts to `action`. Fields are already resolved
/// against the persisted state (relative BPM, presets, trainer merge), so the
/// listener only has to copy them in.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MetronomeRemote {
    pub action: Option<String>,
    pub bpm: Option<u32>,
    pub numerator: Option<u8>,
    pub denominator: Option<u8>,
    pub subdivision: Option<u8>,
    pub sound: Option<String>,
    /// Linear 0..1, same unit as the tab's slider.
    pub click_volume: Option<f32>,
    pub accent_volume: Option<f32>,
    pub beat_accents: Option<Vec<bool>>,
    /// Full trainer config after merging the requested changes.
    pub trainer: Option<MetronomeTrainer>,
    /// Full preset list, sent only when a preset was saved or deleted.
    pub presets: Option<Vec<MetronomePreset>>,
}

/// Parsed `/metronome` arguments — raw user intent before it is resolved
/// against the persisted state (see `resolve_metronome`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetronomeArgs {
    pub action: Option<String>,
    pub bpm: Option<u32>,
    /// Relative BPM change (`bpm=+5` / `bpm=-1`).
    pub bpm_delta: Option<i32>,
    pub numerator: Option<u8>,
    pub denominator: Option<u8>,
    pub subdivision: Option<u8>,
    pub sound: Option<String>,
    /// Percent 0..100.
    pub click_volume: Option<u8>,
    /// Percent 0..100.
    pub accent_volume: Option<u8>,
    pub beat_accents: Option<Vec<bool>>,
    pub trainer_enabled: Option<bool>,
    pub trainer_step: Option<u32>,
    pub trainer_bars: Option<u32>,
    pub trainer_target: Option<u32>,
    /// Apply a saved preset (by id or case-insensitive name).
    pub preset: Option<String>,
    /// Save the resulting state as a preset with this name.
    pub save_preset: Option<String>,
    /// Delete a saved preset (by id or case-insensitive name).
    pub delete_preset: Option<String>,
}

pub struct MetronomeCmd;

#[async_trait]
impl CommandHandler for MetronomeCmd {
    fn name(&self) -> &'static str {
        "metronome"
    }
    fn description(&self) -> &'static str {
        "Керувати метрономом. Приклади: `start bpm=140 sig=6/8`, `stop`, `bpm=+5`, `vol=60`, `trainer=on`, `preset=\"Slow blues\"`."
    }
    fn usage(&self) -> &'static str {
        "/metronome [start|stop|toggle|status] [bpm=N|+N|-N] [sig=N/D] [sub=1..4] [sound=click|wood|beep] \
         [vol=0..100] [accent_vol=0..100] [accents=1000] [trainer=on|off] [trainer_step=N] \
         [trainer_bars=N] [trainer_target=N] [preset=<name>] [save=<name>] [delete=<name>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let parsed = match parse_metronome_args(args) {
            Ok(p) => p,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        let path = metronome_state_path(&ctx.app);
        let current = path
            .as_ref()
            .map(MetronomeState::load)
            .unwrap_or_default();
        let (mut remote, next) = match resolve_metronome(&parsed, &current, now_ms()) {
            Ok(r) => r,
            Err(e) => {
                return metronome_card(&current, None, Some(&format!("⚠️ {e}")));
            }
        };
        // Persist first so the change sticks even when the Valeton tab isn't
        // mounted — the shell hydrates from disk on mount.
        if next != current {
            if let Some(p) = &path {
                if let Err(e) = next.save(p) {
                    tracing::warn!(error = %e, "metronome: persist failed");
                }
            }
        }
        // Bare `/metronome` (and the 🔄 button) is a status probe — ask the
        // shell whether it's playing without touching anything.
        if remote.action.is_none() && parsed == MetronomeArgs::default() {
            remote.action = Some("status".into());
        }
        // Playback needs the audio engine, which lives in the Valeton tab —
        // reveal it and keep re-emitting until the lazy chunk mounts and
        // acks. Pure setting changes are already on disk, so they only need
        // a short ack window (live apply when the shell is mounted).
        let needs_ui = matches!(remote.action.as_deref(), Some("start" | "toggle"));
        if needs_ui {
            reveal_tab(&ctx.app, "valeton-editor");
        }
        let window = if needs_ui {
            std::time::Duration::from_secs(4)
        } else {
            std::time::Duration::from_millis(400)
        };
        let payload = serde_json::to_value(&remote).unwrap_or_default();
        let ack = emit_with_ack(&ctx.app, "metronome:remote", payload, window).await;
        let playing = ack
            .as_ref()
            .and_then(|v| v.get("playing"))
            .and_then(|v| v.as_bool());
        let note = if needs_ui && ack.is_none() {
            Some("⚠️ Метроном не відповів — відкрий Stash → Valeton (вигляд з педалями).".to_string())
        } else if remote.action.as_deref() == Some("status") {
            None
        } else {
            Some(format_metronome_reply(&remote))
        };
        metronome_card(&next, playing, note.as_deref())
    }
}

/// Same path resolution as `metronome::commands` (app-data dir, falling back
/// to the path captured at setup).
fn metronome_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let fallback = app
        .try_state::<MetronomeStateHandle>()
        .map(|h| h.path.lock().unwrap().clone());
    app.path()
        .app_data_dir()
        .map(|d| d.join("metronome.json"))
        .ok()
        .or(fallback)
}

fn parse_percent(key: &str, val: &str) -> Result<u8, String> {
    let n: u32 = val
        .trim_end_matches('%')
        .parse()
        .map_err(|_| format!("{key} має бути числом 0–100, отримано `{val}`"))?;
    if n > 100 {
        return Err(format!("{key} поза межами 0–100: {n}"));
    }
    Ok(n as u8)
}

fn parse_ranged_u32(key: &str, val: &str, min: u32, max: u32) -> Result<u32, String> {
    let n: u32 = val
        .parse()
        .map_err(|_| format!("{key} має бути числом, отримано `{val}`"))?;
    if !(min..=max).contains(&n) {
        return Err(format!("{key} поза межами {min}–{max}: {n}"));
    }
    Ok(n)
}

fn parse_metronome_args(args: &str) -> Result<MetronomeArgs, String> {
    let mut out = MetronomeArgs::default();
    for raw in tokenize_quoted(args) {
        let lower = raw.to_ascii_lowercase();
        match lower.as_str() {
            "start" | "play" => out.action = Some("start".into()),
            "stop" | "pause" => out.action = Some("stop".into()),
            "toggle" => out.action = Some("toggle".into()),
            "status" => out.action = Some("status".into()),
            other => {
                let (key, _) = other
                    .split_once('=')
                    .ok_or_else(|| format!("незрозумілий токен: `{other}`"))?;
                // Keep the original casing for free-text values (preset names).
                let val_raw = raw.split_once('=').map(|(_, v)| v).unwrap_or("");
                let val = val_raw.to_ascii_lowercase();
                let val = val.as_str();
                match key {
                    "bpm" => {
                        if let Some(rest) = val.strip_prefix('+') {
                            let n: i32 = rest
                                .parse()
                                .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                            out.bpm_delta = Some(n.clamp(0, 200));
                        } else if val.starts_with('-') {
                            let n: i32 = val
                                .parse()
                                .map_err(|_| format!("bpm має бути числом, отримано `{val}`"))?;
                            out.bpm_delta = Some(n.clamp(-200, 0));
                        } else {
                            out.bpm = Some(parse_ranged_u32("bpm", val, 40, 240)?);
                        }
                    }
                    "sig" | "time" => {
                        let (num, den) = val
                            .split_once('/')
                            .ok_or_else(|| format!("sig очікує N/D, отримано `{val}`"))?;
                        let n: u8 = num
                            .parse()
                            .map_err(|_| format!("numerator не число: `{num}`"))?;
                        let d: u8 = den
                            .parse()
                            .map_err(|_| format!("denominator не число: `{den}`"))?;
                        if !(1..=16).contains(&n) {
                            return Err(format!("numerator поза 1–16: {n}"));
                        }
                        if !matches!(d, 2 | 4 | 8) {
                            return Err(format!("denominator має бути 2/4/8, отримано {d}"));
                        }
                        out.numerator = Some(n);
                        out.denominator = Some(d);
                    }
                    "sub" | "subdivision" => {
                        let n: u8 = val.parse().map_err(|_| format!("sub не число: `{val}`"))?;
                        if !(1..=4).contains(&n) {
                            return Err(format!("sub поза 1–4: {n}"));
                        }
                        out.subdivision = Some(n);
                    }
                    "sound" => {
                        if !matches!(val, "click" | "wood" | "beep") {
                            return Err(format!(
                                "sound має бути click|wood|beep, отримано `{val}`"
                            ));
                        }
                        out.sound = Some(val.to_string());
                    }
                    "vol" | "volume" | "click_vol" | "click_volume" => {
                        out.click_volume = Some(parse_percent("vol", val)?);
                    }
                    "accent_vol" | "accentvol" | "accent_volume" => {
                        out.accent_volume = Some(parse_percent("accent_vol", val)?);
                    }
                    "accents" => {
                        let pattern: Result<Vec<bool>, String> = val
                            .chars()
                            .filter(|c| !matches!(c, ',' | ' '))
                            .map(|c| match c {
                                '1' | 'x' | '>' => Ok(true),
                                '0' | '.' | '-' => Ok(false),
                                other => Err(format!(
                                    "accents: незрозумілий символ `{other}` (1/x = акцент, 0/. = ні)"
                                )),
                            })
                            .collect();
                        let pattern = pattern?;
                        if pattern.is_empty() || pattern.len() > 16 {
                            return Err("accents: від 1 до 16 долей".into());
                        }
                        out.beat_accents = Some(pattern);
                    }
                    "trainer" => {
                        out.trainer_enabled = Some(match val {
                            "on" | "1" | "true" | "yes" => true,
                            "off" | "0" | "false" | "no" => false,
                            other => return Err(format!("trainer має бути on|off, отримано `{other}`")),
                        });
                    }
                    "trainer_step" | "step" => {
                        out.trainer_step = Some(parse_ranged_u32("trainer_step", val, 1, 50)?);
                    }
                    "trainer_bars" | "bars" => {
                        out.trainer_bars = Some(parse_ranged_u32("trainer_bars", val, 1, 64)?);
                    }
                    "trainer_target" | "target" => {
                        out.trainer_target = Some(parse_ranged_u32("trainer_target", val, 40, 240)?);
                    }
                    "preset" | "load" => out.preset = Some(non_empty("preset", val_raw)?),
                    "save" | "save_preset" => out.save_preset = Some(non_empty("save", val_raw)?),
                    "delete" | "delete_preset" => {
                        out.delete_preset = Some(non_empty("delete", val_raw)?)
                    }
                    _ => return Err(format!("невідомий параметр: `{key}`")),
                }
            }
        }
    }
    Ok(out)
}

fn non_empty(key: &str, v: &str) -> Result<String, String> {
    let t = v.trim();
    if t.is_empty() {
        return Err(format!("{key}: порожнє значення"));
    }
    Ok(t.chars().take(60).collect())
}

fn find_metronome_preset<'a>(presets: &'a [MetronomePreset], key: &str) -> Option<&'a MetronomePreset> {
    presets
        .iter()
        .find(|p| p.id == key)
        .or_else(|| presets.iter().find(|p| p.name.eq_ignore_ascii_case(key)))
}

/// Resolve parsed args against the persisted state. Returns the payload to
/// emit (only changed fields) and the full next state to persist. Order:
/// preset → explicit fields → save/delete, so `preset=x bpm=+5 save=y`
/// does what it reads like.
fn resolve_metronome(
    args: &MetronomeArgs,
    cur: &MetronomeState,
    id_seed: i64,
) -> Result<(MetronomeRemote, MetronomeState), String> {
    let mut next = cur.clone();
    let mut remote = MetronomeRemote {
        action: args.action.clone(),
        ..Default::default()
    };

    if let Some(key) = &args.preset {
        let p = find_metronome_preset(&cur.presets, key)
            .ok_or_else(|| format!("пресет `{key}` не знайдено"))?
            .clone();
        next.bpm = p.bpm;
        next.numerator = p.numerator;
        next.denominator = p.denominator;
        next.subdivision = p.subdivision;
        next.sound = p.sound.clone();
        next.beat_accents = p.beat_accents.clone();
        remote.bpm = Some(p.bpm);
        remote.numerator = Some(p.numerator);
        remote.denominator = Some(p.denominator);
        remote.subdivision = Some(p.subdivision);
        remote.sound = Some(p.sound);
        remote.beat_accents = Some(p.beat_accents);
    }

    if let Some(bpm) = args.bpm {
        next.bpm = bpm;
        remote.bpm = Some(bpm);
    }
    if let Some(delta) = args.bpm_delta {
        let bpm = (next.bpm as i32 + delta).clamp(40, 240) as u32;
        next.bpm = bpm;
        remote.bpm = Some(bpm);
    }
    if let (Some(n), Some(d)) = (args.numerator, args.denominator) {
        if n != next.numerator {
            // Same reshape rule as the tab: keep the prefix, pad with downbeat.
            next.beat_accents = (0..n as usize)
                .map(|i| next.beat_accents.get(i).copied().unwrap_or(i == 0))
                .collect();
        }
        next.numerator = n;
        next.denominator = d;
        remote.numerator = Some(n);
        remote.denominator = Some(d);
    }
    if let Some(s) = args.subdivision {
        next.subdivision = s;
        remote.subdivision = Some(s);
    }
    if let Some(s) = &args.sound {
        next.sound = s.clone();
        remote.sound = Some(s.clone());
    }
    if let Some(v) = args.click_volume {
        next.click_volume = v as f32 / 100.0;
        remote.click_volume = Some(next.click_volume);
    }
    if let Some(v) = args.accent_volume {
        next.accent_volume = v as f32 / 100.0;
        remote.accent_volume = Some(next.accent_volume);
    }
    if let Some(acc) = &args.beat_accents {
        if acc.len() != next.numerator as usize {
            return Err(format!(
                "accents має {} долей, а розмір {}/{} — потрібно {}",
                acc.len(),
                next.numerator,
                next.denominator,
                next.numerator
            ));
        }
        next.beat_accents = acc.clone();
        remote.beat_accents = Some(acc.clone());
    }
    let trainer_touched = args.trainer_enabled.is_some()
        || args.trainer_step.is_some()
        || args.trainer_bars.is_some()
        || args.trainer_target.is_some();
    if trainer_touched {
        if let Some(v) = args.trainer_enabled {
            next.trainer.enabled = v;
        }
        if let Some(v) = args.trainer_step {
            next.trainer.step_bpm = v;
        }
        if let Some(v) = args.trainer_bars {
            next.trainer.every_bars = v;
        }
        if let Some(v) = args.trainer_target {
            next.trainer.target_bpm = v;
        }
        remote.trainer = Some(next.trainer.clone());
    }

    let mut presets_changed = false;
    if let Some(key) = &args.delete_preset {
        let id = find_metronome_preset(&next.presets, key)
            .map(|p| p.id.clone())
            .ok_or_else(|| format!("пресет `{key}` не знайдено"))?;
        next.presets.retain(|p| p.id != id);
        presets_changed = true;
    }
    if let Some(name) = &args.save_preset {
        let snapshot = |id: String| MetronomePreset {
            id,
            name: name.clone(),
            bpm: next.bpm,
            numerator: next.numerator,
            denominator: next.denominator,
            subdivision: next.subdivision,
            sound: next.sound.clone(),
            beat_accents: next.beat_accents.clone(),
        };
        // Re-using a name overwrites that preset in place (keeps its id).
        let existing = next
            .presets
            .iter()
            .position(|p| p.name.eq_ignore_ascii_case(name));
        match existing {
            Some(i) => {
                let id = next.presets[i].id.clone();
                next.presets[i] = snapshot(id);
            }
            None => {
                let id = format!("p_tg{}", id_seed.rem_euclid(36_i64.pow(8)));
                let p = snapshot(id);
                next.presets.push(p);
            }
        }
        presets_changed = true;
    }
    if presets_changed {
        remote.presets = Some(next.presets.clone());
    }
    next.normalize();
    Ok((remote, next))
}

fn format_metronome_reply(r: &MetronomeRemote) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = &r.action {
        parts.push(match a.as_str() {
            "start" => "▶️ старт".into(),
            "stop" => "⏸ стоп".into(),
            "toggle" => "⏯ перемкнуто".into(),
            "status" => "ℹ️ статус".into(),
            other => other.into(),
        });
    }
    if let Some(bpm) = r.bpm {
        parts.push(format!("{bpm} BPM"));
    }
    if let (Some(n), Some(d)) = (r.numerator, r.denominator) {
        parts.push(format!("{n}/{d}"));
    }
    if let Some(sub) = r.subdivision {
        parts.push(format!("sub={sub}"));
    }
    if let Some(sound) = &r.sound {
        parts.push(format!("звук={sound}"));
    }
    if let Some(v) = r.click_volume {
        parts.push(format!("гучність {}%", (v * 100.0).round() as u32));
    }
    if let Some(v) = r.accent_volume {
        parts.push(format!("акцент {}%", (v * 100.0).round() as u32));
    }
    if r.beat_accents.is_some() {
        parts.push("акценти".into());
    }
    if let Some(t) = &r.trainer {
        parts.push(format!("тренер {}", if t.enabled { "on" } else { "off" }));
    }
    if r.presets.is_some() {
        parts.push("пресети оновлено".into());
    }
    if parts.is_empty() {
        "🥁 Метроном без змін.".to_string()
    } else {
        format!("🥁 Метроном: {}", parts.join(", "))
    }
}

fn subdivision_glyph(sub: u8) -> &'static str {
    match sub {
        2 => "♪♪",
        3 => "♪♪♪",
        4 => "♬",
        _ => "♩",
    }
}

/// Live card text: state line first so taps visibly change it.
fn format_metronome_card(st: &MetronomeState, playing: Option<bool>) -> String {
    let icon = if playing == Some(true) { "▶️" } else { "⏹" };
    let mut lines = vec![format!(
        "{icon} {} BPM · {}/{} · {} · {}",
        st.bpm,
        st.numerator,
        st.denominator,
        subdivision_glyph(st.subdivision),
        st.sound
    )];
    lines.push(format!(
        "🔊 клік {}% · акцент {}%",
        (st.click_volume * 100.0).round() as u32,
        (st.accent_volume * 100.0).round() as u32
    ));
    let accents: String = st
        .beat_accents
        .iter()
        .map(|a| if *a { '●' } else { '○' })
        .collect();
    lines.push(format!("🥁 {accents}"));
    if st.trainer.enabled {
        lines.push(format!(
            "🎯 тренер: +{} BPM кожні {} такт. → {}",
            st.trainer.step_bpm, st.trainer.every_bars, st.trainer.target_bpm
        ));
    }
    if !st.presets.is_empty() {
        let names: Vec<&str> = st.presets.iter().map(|p| p.name.as_str()).collect();
        lines.push(format!("🎼 пресети: {}", names.join(", ")));
    }
    if playing.is_none() {
        lines.push("💤 Вкладка Valeton не відкрита — зміни збережено й застосуються при відкритті.".into());
    }
    lines.join("\n")
}

fn metronome_keyboard(st: &MetronomeState, playing: Option<bool>) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:metronome:{args}"));
    let transport = if playing == Some(true) {
        b("⏹ Стоп", "stop")
    } else {
        b("▶️ Старт", "start")
    };
    let mut rows = vec![
        vec![transport, b("🔄", "")],
        vec![
            b("−5", "bpm=-5"),
            b("−1", "bpm=-1"),
            b("+1", "bpm=+1"),
            b("+5", "bpm=+5"),
        ],
        [(2u8, 4u8), (3, 4), (4, 4), (6, 8)]
            .iter()
            .map(|&(n, d)| {
                let label = if st.numerator == n && st.denominator == d {
                    format!("• {n}/{d}")
                } else {
                    format!("{n}/{d}")
                };
                b(&label, &format!("sig={n}/{d}"))
            })
            .collect(),
        (1u8..=4)
            .map(|s| {
                let glyph = subdivision_glyph(s);
                let label = if st.subdivision == s {
                    format!("• {glyph}")
                } else {
                    glyph.to_string()
                };
                b(&label, &format!("sub={s}"))
            })
            .collect(),
        vec![if st.trainer.enabled {
            b("🎯 Тренер: on", "trainer=off")
        } else {
            b("🎯 Тренер: off", "trainer=on")
        }],
    ];
    // Presets by id — names may be long or contain spaces; ids are short.
    let presets: Vec<InlineButton> = st
        .presets
        .iter()
        .map(|p| {
            let name: String = p.name.chars().take(16).collect();
            b(&format!("🎼 {name}"), &format!("preset={}", p.id))
        })
        .filter(|btn| btn.callback_data.len() <= 64)
        .take(4)
        .collect();
    for chunk in presets.chunks(2) {
        rows.push(chunk.to_vec());
    }
    InlineKeyboard { rows }
}

fn metronome_card(st: &MetronomeState, playing: Option<bool>, note: Option<&str>) -> Reply {
    let body = format_metronome_card(st, playing);
    let text = match note {
        Some(n) => format!("{n}\n\n{body}"),
        None => body,
    };
    Reply {
        text,
        keyboard: Some(metronome_keyboard(st, playing)),
        ..Default::default()
    }
}

// -------------------- metronome_control tool --------------------

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

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(MetronomeCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(MetronomeControl);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::{
        all_callbacks, assert_fits, tool_ctx as ctx,
    };

    #[test]
    fn parse_metronome_start_with_full_params() {
        let r = parse_metronome_args("start bpm=140 sig=6/8 sub=2 sound=wood").unwrap();
        assert_eq!(r.action.as_deref(), Some("start"));
        assert_eq!(r.bpm, Some(140));
        assert_eq!(r.numerator, Some(6));
        assert_eq!(r.denominator, Some(8));
        assert_eq!(r.subdivision, Some(2));
        assert_eq!(r.sound.as_deref(), Some("wood"));
    }

    #[test]
    fn parse_metronome_bare_bpm_change_has_no_action() {
        let r = parse_metronome_args("bpm=100").unwrap();
        assert!(r.action.is_none());
        assert_eq!(r.bpm, Some(100));
    }

    #[test]
    fn parse_metronome_rejects_out_of_range_bpm() {
        let err = parse_metronome_args("bpm=999").unwrap_err();
        assert!(err.to_lowercase().contains("bpm"));
    }

    #[test]
    fn parse_metronome_rejects_bad_denominator() {
        let err = parse_metronome_args("sig=4/3").unwrap_err();
        assert!(err.contains("denominator"));
    }

    #[test]
    fn parse_metronome_rejects_unknown_key() {
        let err = parse_metronome_args("foo=1").unwrap_err();
        assert!(err.contains("foo"));
    }

    #[test]
    fn parse_metronome_accepts_play_alias_as_start() {
        let r = parse_metronome_args("play").unwrap();
        assert_eq!(r.action.as_deref(), Some("start"));
    }

    #[test]
    fn parse_metronome_rejects_bad_sound() {
        let err = parse_metronome_args("sound=gong").unwrap_err();
        assert!(err.contains("sound"));
    }

    #[test]
    fn format_metronome_reply_summarises_action_and_params() {
        let r = MetronomeRemote {
            action: Some("start".into()),
            bpm: Some(140),
            numerator: Some(6),
            denominator: Some(8),
            ..Default::default()
        };
        let out = format_metronome_reply(&r);
        assert!(out.contains("140"));
        assert!(out.contains("6/8"));
        assert!(out.contains("старт"));
    }

    fn preset(id: &str, name: &str, n: u8) -> MetronomePreset {
        MetronomePreset {
            id: id.into(),
            name: name.into(),
            bpm: 90,
            numerator: n,
            denominator: 4,
            subdivision: 2,
            sound: "wood".into(),
            beat_accents: (0..n).map(|i| i == 0).collect(),
        }
    }

    // ---- metronome ----

    #[test]
    fn metronome_parses_relative_bpm_and_new_knobs() {
        let r = parse_metronome_args(
            "bpm=+5 vol=60 accent_vol=85% accents=x.x. trainer=on trainer_step=2 trainer_bars=8 trainer_target=180",
        )
        .unwrap();
        assert_eq!(r.bpm, None);
        assert_eq!(r.bpm_delta, Some(5));
        assert_eq!(r.click_volume, Some(60));
        assert_eq!(r.accent_volume, Some(85));
        assert_eq!(r.beat_accents, Some(vec![true, false, true, false]));
        assert_eq!(r.trainer_enabled, Some(true));
        assert_eq!(r.trainer_step, Some(2));
        assert_eq!(r.trainer_bars, Some(8));
        assert_eq!(r.trainer_target, Some(180));
        assert_eq!(parse_metronome_args("bpm=-1").unwrap().bpm_delta, Some(-1));
    }

    #[test]
    fn metronome_rejects_bad_new_knobs() {
        assert!(parse_metronome_args("vol=150").unwrap_err().contains("vol"));
        assert!(parse_metronome_args("accents=1z0").unwrap_err().contains("accents"));
        assert!(parse_metronome_args("trainer=maybe").unwrap_err().contains("trainer"));
        assert!(parse_metronome_args("trainer_step=99").unwrap_err().contains("trainer_step"));
        assert!(parse_metronome_args("save=").unwrap_err().contains("save"));
    }

    #[test]
    fn metronome_quoted_preset_names_keep_case_and_spaces() {
        assert_eq!(
            tokenize_quoted(r#"start save="Slow Blues" bpm=80"#),
            vec!["start", "save=Slow Blues", "bpm=80"]
        );
        let r = parse_metronome_args(r#"preset="Slow Blues""#).unwrap();
        assert_eq!(r.preset.as_deref(), Some("Slow Blues"));
    }

    #[test]
    fn metronome_resolve_relative_bpm_clamps() {
        let cur = MetronomeState {
            bpm: 238,
            ..Default::default()
        };
        let args = parse_metronome_args("bpm=+5").unwrap();
        let (remote, next) = resolve_metronome(&args, &cur, 1).unwrap();
        assert_eq!(remote.bpm, Some(240));
        assert_eq!(next.bpm, 240);
        assert!(remote.numerator.is_none(), "untouched fields stay None");
    }

    #[test]
    fn metronome_resolve_applies_preset_then_explicit_fields() {
        let mut cur = MetronomeState::default();
        cur.presets.push(preset("p_a", "Waltz", 3));
        let args = parse_metronome_args("preset=waltz bpm=+10").unwrap();
        let (remote, next) = resolve_metronome(&args, &cur, 1).unwrap();
        assert_eq!(next.bpm, 100);
        assert_eq!(next.numerator, 3);
        assert_eq!(next.sound, "wood");
        assert_eq!(remote.beat_accents, Some(vec![true, false, false]));
        assert!(resolve_metronome(&parse_metronome_args("preset=nope").unwrap(), &cur, 1).is_err());
    }

    #[test]
    fn metronome_resolve_saves_overwrites_and_deletes_presets() {
        let cur = MetronomeState::default();
        let (remote, next) =
            resolve_metronome(&parse_metronome_args("bpm=120 save=Mine").unwrap(), &cur, 42).unwrap();
        assert_eq!(next.presets.len(), 1);
        assert_eq!(next.presets[0].bpm, 120);
        assert_eq!(remote.presets.as_ref().map(|p| p.len()), Some(1));
        let id = next.presets[0].id.clone();
        // Same name (different case) overwrites in place, keeping the id.
        let (_, next2) =
            resolve_metronome(&parse_metronome_args("bpm=130 save=mine").unwrap(), &next, 43).unwrap();
        assert_eq!(next2.presets.len(), 1);
        assert_eq!(next2.presets[0].id, id);
        assert_eq!(next2.presets[0].bpm, 130);
        let (remote3, next3) =
            resolve_metronome(&parse_metronome_args(&format!("delete={id}")).unwrap(), &next2, 44)
                .unwrap();
        assert!(next3.presets.is_empty());
        assert_eq!(remote3.presets, Some(vec![]));
    }

    #[test]
    fn metronome_resolve_validates_accents_against_resulting_numerator() {
        let cur = MetronomeState::default(); // 4/4
        let err = resolve_metronome(&parse_metronome_args("accents=101").unwrap(), &cur, 1)
            .unwrap_err();
        assert!(err.contains("accents"));
        let (_, next) =
            resolve_metronome(&parse_metronome_args("sig=3/4 accents=101").unwrap(), &cur, 1)
                .unwrap();
        assert_eq!(next.beat_accents, vec![true, false, true]);
        // Signature change alone reshapes like the tab does.
        let (_, next) =
            resolve_metronome(&parse_metronome_args("sig=6/8").unwrap(), &cur, 1).unwrap();
        assert_eq!(next.beat_accents.len(), 6);
        assert!(next.beat_accents[0]);
    }

    #[test]
    fn metronome_resolve_merges_trainer_and_volumes() {
        let cur = MetronomeState::default();
        let (remote, next) =
            resolve_metronome(&parse_metronome_args("trainer=on vol=50").unwrap(), &cur, 1).unwrap();
        let t = remote.trainer.unwrap();
        assert!(t.enabled);
        assert_eq!(t.step_bpm, cur.trainer.step_bpm, "unset trainer fields preserved");
        assert!((next.click_volume - 0.5).abs() < 1e-6);
        assert_eq!(remote.click_volume, Some(0.5));
    }

    #[test]
    fn metronome_card_reflects_state_and_buttons_fit() {
        let mut st = MetronomeState::default();
        st.presets
            .push(preset("p_lzx9k2q1_ab12", "A very long preset name indeed", 4));
        st.presets.push(preset(&"x".repeat(60), "Too long id", 4));
        let text = format_metronome_card(&st, Some(true));
        assert!(text.starts_with("▶️ 100 BPM · 4/4"));
        let kb = metronome_keyboard(&st, Some(true));
        assert_fits(&kb);
        let data = all_callbacks(&kb);
        assert!(data.contains(&"refresh:metronome:stop".to_string()));
        assert!(data.contains(&"refresh:metronome:bpm=+5".to_string()));
        assert!(data.contains(&"refresh:metronome:preset=p_lzx9k2q1_ab12".to_string()));
        // Over-long preset ids are dropped rather than sent as broken buttons.
        assert!(!data.iter().any(|d| d.contains(&"x".repeat(60))));
        let idle = metronome_keyboard(&st, None);
        assert!(all_callbacks(&idle).contains(&"refresh:metronome:start".to_string()));
        // Every metronome button arg must parse back through the slash grammar.
        for d in data {
            let args = d.strip_prefix("refresh:metronome:").unwrap();
            assert!(parse_metronome_args(args).is_ok(), "unparseable button arg: {args}");
        }
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
