//! Agent surface — Pomodoro: `/pomodoro` slash command + pomodoro LLM tools.
//! `lib.rs` / `telegram::assistant` call `register_commands` / `register_tools`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::commands::{
    edit_blocks_session, pause_session, resume_session, skip_to_session, start_session,
    stop_session,
};
use super::engine::{SessionSnapshot, SessionStatus};
use super::model::{Block, Posture, PresetKind};
use super::state::PomodoroState;
use crate::modules::telegram::agent_util::{
    format_pomodoro_status, now_ms, now_secs, require_app, reveal_tab,
};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, app: &AppHandle) {
    if let Some(pomo) = app.try_state::<Arc<PomodoroState>>() {
        tg.register_command(PomodoroCmd::new(pomo.inner().clone()));
    }
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, app: &AppHandle) {
    if let Some(pomo) = app.try_state::<Arc<PomodoroState>>() {
        tools.register(PomodoroStatus::new(pomo.inner().clone()));
        tools.register(PomodoroStart::new(pomo.inner().clone()));
        tools.register(PomodoroStop::new(pomo.inner().clone()));
        tools.register(PomodoroSavePreset::new(pomo.inner().clone()));
        tools.register(PomodoroControl::new(pomo.inner().clone()));
        tools.register(PomodoroEditBlocks::new(pomo.inner().clone()));
        tools.register(PomodoroPresets::new(pomo.inner().clone()));
        tools.register(PomodoroHistory::new(pomo.inner().clone()));
    }
}

// -------------------- /pomodoro --------------------

pub struct PomodoroCmd {
    state: Arc<PomodoroState>,
}

impl PomodoroCmd {
    pub fn new(state: Arc<PomodoroState>) -> Self {
        Self { state }
    }
}

/// Parsed `/pomodoro` sub-command. Typed slash args and inline-button
/// callbacks share this grammar.
#[derive(Debug, Clone, PartialEq)]
enum PomodoroAction {
    Status,
    /// Raw block spec, e.g. `25/sit 5/walk`.
    Start(String),
    /// Start a saved preset by id.
    Preset(i64),
    Pause,
    Resume,
    /// Pause when running, resume when paused.
    Toggle,
    /// `None` = next block; `Some(n)` = 1-based block number.
    Skip(Option<usize>),
    Stop,
    Presets,
    Delete { id: i64, confirmed: bool },
    History(u32),
    /// Replace the blocks of the running session.
    Edit(String),
}

fn parse_pomodoro_action(args: &str) -> Result<PomodoroAction, String> {
    let sub = args.trim();
    let mut parts = sub.splitn(2, char::is_whitespace);
    let verb = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("").trim();
    let parse_id = |s: &str| -> Result<i64, String> {
        s.trim_start_matches('#')
            .parse::<i64>()
            .map_err(|_| format!("очікую id пресета (число), отримано `{s}`"))
    };
    Ok(match verb.as_str() {
        "" | "status" => PomodoroAction::Status,
        "start" | "begin" | "go" => PomodoroAction::Start(rest.to_string()),
        "preset" | "run" => PomodoroAction::Preset(parse_id(rest)?),
        "pause" => PomodoroAction::Pause,
        "resume" | "continue" => PomodoroAction::Resume,
        "toggle" => PomodoroAction::Toggle,
        "skip" | "next" => {
            if rest.is_empty() {
                PomodoroAction::Skip(None)
            } else {
                let n: usize = rest
                    .parse()
                    .map_err(|_| format!("skip очікує номер блоку, отримано `{rest}`"))?;
                if n == 0 {
                    return Err("номер блоку починається з 1".into());
                }
                PomodoroAction::Skip(Some(n))
            }
        }
        "stop" | "cancel" | "end" => PomodoroAction::Stop,
        "presets" | "list" => PomodoroAction::Presets,
        "delete" | "del" | "rm" => {
            let mut it = rest.split_whitespace();
            let id = parse_id(it.next().unwrap_or(""))?;
            let confirmed = it
                .next()
                .is_some_and(|t| matches!(t.to_ascii_lowercase().as_str(), "yes" | "y" | "confirm" | "так"));
            PomodoroAction::Delete { id, confirmed }
        }
        "history" | "log" => {
            let n = if rest.is_empty() {
                10
            } else {
                rest.parse::<u32>()
                    .map_err(|_| format!("history очікує число, отримано `{rest}`"))?
            };
            PomodoroAction::History(n.clamp(1, 30))
        }
        "edit" => PomodoroAction::Edit(rest.to_string()),
        other => return Err(format!("невідома підкоманда `{other}`")),
    })
}

/// Carry block ids over by position so the engine's id-based cursor
/// preservation (`edit_blocks`) keeps the current block and its remaining
/// time when the user edits a running session.
pub(crate) fn reuse_block_ids(mut new_blocks: Vec<Block>, old: &[Block]) -> Vec<Block> {
    for (nb, ob) in new_blocks.iter_mut().zip(old.iter()) {
        nb.id = ob.id.clone();
    }
    new_blocks
}

/// Skip to the block after the current one (finishes the session when the
/// current block is the last).
pub(crate) fn pomodoro_skip_next(app: &tauri::AppHandle, state: &Arc<PomodoroState>) -> SessionSnapshot {
    let idx = state
        .core
        .lock()
        .map(|c| c.snapshot().current_idx)
        .unwrap_or(0);
    skip_to_session(app, state, idx + 1)
}

fn pomodoro_snapshot(state: &Arc<PomodoroState>) -> Option<SessionSnapshot> {
    state.core.lock().ok().map(|c| c.snapshot())
}

#[async_trait]
impl CommandHandler for PomodoroCmd {
    fn name(&self) -> &'static str {
        "pomodoro"
    }
    fn description(&self) -> &'static str {
        "Керувати таймером Pomodoro. Приклади: `start 25/sit 5/walk`, `pause`, `resume`, `skip`, `stop`, `presets`, `history`."
    }
    fn usage(&self) -> &'static str {
        "/pomodoro [status|start <min>/<posture> …|preset <id>|pause|resume|toggle|skip [n]|stop|edit <blocks>|presets|delete <id>|history [n]]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let action = match parse_pomodoro_action(args) {
            Ok(a) => a,
            Err(e) => return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage())),
        };
        let st = &self.state;
        let status = pomodoro_snapshot(st).map(|s| s.status);
        let is_idle = matches!(status, None | Some(SessionStatus::Idle));
        match action {
            PomodoroAction::Status => pomodoro_card(st, None),
            PomodoroAction::Stop => {
                if is_idle {
                    return pomodoro_card(st, Some("ℹ️ Pomodoro не запущено."));
                }
                let _ = stop_session(&ctx.app, st);
                pomodoro_card(st, Some("⏹ Pomodoro зупинено."))
            }
            PomodoroAction::Pause => {
                if status != Some(SessionStatus::Running) {
                    return pomodoro_card(st, Some("ℹ️ Нема що ставити на паузу."));
                }
                let _ = pause_session(&ctx.app, st);
                pomodoro_card(st, Some("⏸ Пауза."))
            }
            PomodoroAction::Resume => {
                if status != Some(SessionStatus::Paused) {
                    return pomodoro_card(st, Some("ℹ️ Pomodoro не на паузі."));
                }
                let _ = resume_session(&ctx.app, st);
                pomodoro_card(st, Some("▶️ Продовжуємо."))
            }
            PomodoroAction::Toggle => match status {
                Some(SessionStatus::Running) => {
                    let _ = pause_session(&ctx.app, st);
                    pomodoro_card(st, Some("⏸ Пауза."))
                }
                Some(SessionStatus::Paused) => {
                    let _ = resume_session(&ctx.app, st);
                    pomodoro_card(st, Some("▶️ Продовжуємо."))
                }
                _ => pomodoro_card(st, Some("ℹ️ Pomodoro не запущено.")),
            },
            PomodoroAction::Skip(target) => {
                if is_idle {
                    return pomodoro_card(st, Some("ℹ️ Pomodoro не запущено."));
                }
                let snap = match target {
                    None => pomodoro_skip_next(&ctx.app, st),
                    Some(n) => {
                        let len = pomodoro_snapshot(st).map(|s| s.blocks.len()).unwrap_or(0);
                        if n > len {
                            return pomodoro_card(
                                st,
                                Some(&format!("⚠️ У сесії лише {len} блок(ів).")),
                            );
                        }
                        skip_to_session(&ctx.app, st, n - 1)
                    }
                };
                let note = if snap.status == SessionStatus::Idle {
                    "🏁 Сесію завершено.".to_string()
                } else {
                    let name = snap
                        .blocks
                        .get(snap.current_idx)
                        .map(|b| b.name.clone())
                        .unwrap_or_default();
                    format!("⏭ Перейшли до «{name}».")
                };
                pomodoro_card(st, Some(&note))
            }
            PomodoroAction::Start(spec) => {
                let blocks = match parse_pomodoro_blocks(&spec, now_ms()) {
                    Ok(b) => b,
                    Err(e) => {
                        return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage()))
                    }
                };
                reveal_tab(&ctx.app, "pomodoro");
                match start_session(&ctx.app, st, blocks, None) {
                    Ok(snap) => {
                        let total_min: u32 = snap.blocks.iter().map(|b| b.duration_sec / 60).sum();
                        let summary = snap
                            .blocks
                            .iter()
                            .map(|b| {
                                format!("{}/{}", b.duration_sec / 60, posture_word(&b.posture))
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        pomodoro_card(
                            st,
                            Some(&format!("🍅 Стартував Pomodoro ({total_min} хв): {summary}")),
                        )
                    }
                    Err(e) => Reply::text(format!("⚠️ pomodoro: {e}")),
                }
            }
            PomodoroAction::Preset(id) => {
                let preset = st.repo.lock().ok().and_then(|r| r.get_preset(id).ok().flatten());
                let Some(preset) = preset else {
                    return pomodoro_card(st, Some(&format!("⚠️ Пресет #{id} не знайдено.")));
                };
                reveal_tab(&ctx.app, "pomodoro");
                match start_session(&ctx.app, st, preset.blocks.clone(), Some(preset.id)) {
                    Ok(_) => pomodoro_card(st, Some(&format!("🍅 Стартував пресет «{}».", preset.name))),
                    Err(e) => Reply::text(format!("⚠️ pomodoro: {e}")),
                }
            }
            PomodoroAction::Edit(spec) => {
                if is_idle {
                    return pomodoro_card(
                        st,
                        Some("ℹ️ Pomodoro не запущено — використай `start`."),
                    );
                }
                let blocks = match parse_pomodoro_blocks(&spec, now_ms()) {
                    Ok(b) => b,
                    Err(e) => {
                        return Reply::text(format!("⚠️ {e}\nВикористання: {}", self.usage()))
                    }
                };
                let old = pomodoro_snapshot(st).map(|s| s.blocks).unwrap_or_default();
                let _ = edit_blocks_session(&ctx.app, st, reuse_block_ids(blocks, &old));
                pomodoro_card(st, Some("✏️ Блоки оновлено."))
            }
            PomodoroAction::Presets => pomodoro_presets_card(st, None),
            PomodoroAction::Delete { id, confirmed } => {
                let preset = st.repo.lock().ok().and_then(|r| r.get_preset(id).ok().flatten());
                let Some(preset) = preset else {
                    return pomodoro_presets_card(st, Some(&format!("⚠️ Пресет #{id} не знайдено.")));
                };
                if !confirmed {
                    return Reply {
                        text: format!("🗑 Видалити пресет «{}» (#{id})?", preset.name),
                        keyboard: Some(InlineKeyboard {
                            rows: vec![vec![
                                InlineButton::new(
                                    "✅ Так, видалити",
                                    format!("refresh:pomodoro:delete {id} yes"),
                                ),
                                InlineButton::new("↩️ Скасувати", "refresh:pomodoro:presets"),
                            ]],
                        }),
                        ..Default::default()
                    };
                }
                let res = st
                    .repo
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|mut r| r.delete_preset(id).map_err(|e| e.to_string()));
                match res {
                    Ok(()) => {
                        let _ = ctx.app.emit("pomodoro:presets_changed", id);
                        pomodoro_presets_card(st, Some(&format!("🗑 Пресет «{}» видалено.", preset.name)))
                    }
                    Err(e) => pomodoro_presets_card(st, Some(&format!("⚠️ {e}"))),
                }
            }
            PomodoroAction::History(limit) => pomodoro_history_card(st, limit),
        }
    }
}

/// Quick-start presets offered on the idle card (label, block spec).
const POMODORO_QUICK_STARTS: &[(&str, &str)] = &[
    ("⚡ 25/5", "25/sit 5/walk"),
    ("⚡ 50/10", "50/sit 10/walk"),
    ("⚡ 3×25", "25/sit 5/walk 25/sit 5/walk 25/sit 5/walk"),
];

/// Live control card. Buttons use `refresh:` so taps edit this message.
fn pomodoro_keyboard(status: SessionStatus, presets: &[(i64, String)]) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:pomodoro:{args}"));
    let rows = match status {
        SessionStatus::Running | SessionStatus::Paused => {
            let transport = if status == SessionStatus::Running {
                b("⏸ Пауза", "pause")
            } else {
                b("▶️ Далі", "resume")
            };
            vec![
                vec![transport, b("⏭ Skip", "skip"), b("⏹ Стоп", "stop")],
                vec![b("🔄", "status")],
            ]
        }
        SessionStatus::Idle => {
            let mut rows: Vec<Vec<InlineButton>> = Vec::new();
            let preset_btns: Vec<InlineButton> = presets
                .iter()
                .take(6)
                .map(|(id, name)| {
                    let short: String = name.chars().take(18).collect();
                    b(&format!("🍅 {short}"), &format!("preset {id}"))
                })
                .collect();
            for chunk in preset_btns.chunks(2) {
                rows.push(chunk.to_vec());
            }
            rows.push(
                POMODORO_QUICK_STARTS
                    .iter()
                    .map(|(label, spec)| b(label, &format!("start {spec}")))
                    .filter(|btn| btn.callback_data.len() <= 64)
                    .collect(),
            );
            rows.push(vec![
                b("📚 Пресети", "presets"),
                b("📜 Історія", "history"),
                b("🔄", "status"),
            ]);
            rows
        }
    };
    InlineKeyboard { rows }
}

fn pomodoro_card(state: &Arc<PomodoroState>, note: Option<&str>) -> Reply {
    let snap = pomodoro_snapshot(state);
    let status = snap.as_ref().map(|s| s.status).unwrap_or(SessionStatus::Idle);
    let mut text = format_pomodoro_status(state);
    if let Some(s) = &snap {
        if status != SessionStatus::Idle {
            if let Some(nb) = s.blocks.get(s.current_idx + 1) {
                text.push_str(&format!(
                    "\n⏭ Далі: {} · {} хв",
                    nb.name,
                    (nb.duration_sec + 59) / 60
                ));
            } else {
                text.push_str("\n🏁 Останній блок");
            }
            if status == SessionStatus::Paused {
                text.push_str("\n⏸ На паузі");
            }
        } else {
            text.push_str("\nОбери пресет або швидкий старт:");
        }
    }
    let presets = pomodoro_preset_names(state);
    let text = match note {
        Some(n) => format!("{n}\n\n{text}"),
        None => text,
    };
    Reply {
        text,
        keyboard: Some(pomodoro_keyboard(status, &presets)),
        ..Default::default()
    }
}

fn pomodoro_preset_names(state: &Arc<PomodoroState>) -> Vec<(i64, String)> {
    state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_presets().ok())
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.id, p.name))
        .collect()
}

fn pomodoro_presets_card(state: &Arc<PomodoroState>, note: Option<&str>) -> Reply {
    let presets = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_presets().ok())
        .unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    if let Some(n) = note {
        lines.push(n.to_string());
        lines.push(String::new());
    }
    if presets.is_empty() {
        lines.push("📚 Збережених пресетів нема. Створи у вкладці Pomodoro або попроси асистента.".into());
    } else {
        lines.push("📚 Пресети Pomodoro:".into());
    }
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    for p in presets.iter().take(10) {
        let total_min: u32 = p.blocks.iter().map(|b| b.duration_sec).sum::<u32>() / 60;
        let spec = p
            .blocks
            .iter()
            .map(|b| format!("{}/{}", (b.duration_sec + 59) / 60, posture_word(&b.posture)))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("#{} {} — {total_min} хв · {spec}", p.id, p.name));
        let short: String = p.name.chars().take(20).collect();
        rows.push(vec![
            InlineButton::new(format!("▶️ {short}"), format!("refresh:pomodoro:preset {}", p.id)),
            InlineButton::new("🗑", format!("refresh:pomodoro:delete {}", p.id)),
        ]);
    }
    rows.push(vec![InlineButton::new("⬅️ Назад", "refresh:pomodoro:status")]);
    Reply {
        text: lines.join("\n"),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

/// "5 хв тому" / "3 год тому" / "2 дн тому" — no chrono in the tree.
fn format_ago(secs: i64) -> String {
    let s = secs.max(0);
    if s < 3600 {
        format!("{} хв тому", s / 60)
    } else if s < 86_400 {
        format!("{} год тому", s / 3600)
    } else {
        format!("{} дн тому", s / 86_400)
    }
}

fn pomodoro_history_card(state: &Arc<PomodoroState>, limit: u32) -> Reply {
    let rows = state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.list_sessions(limit).ok())
        .unwrap_or_default();
    let now = now_secs();
    let mut lines = vec![format!("📜 Останні сесії ({}):", rows.len())];
    if rows.is_empty() {
        lines = vec!["📜 Історія порожня.".into()];
    }
    for r in &rows {
        let total = r.blocks.len();
        let done = r.completed_idx.min(total);
        let focus_min: u32 = r
            .blocks
            .iter()
            .take(done)
            .map(|b| b.duration_sec)
            .sum::<u32>()
            / 60;
        let state_icon = if r.ended_at.is_none() {
            "▶️"
        } else if done >= total {
            "✅"
        } else {
            "⏹"
        };
        lines.push(format!(
            "{state_icon} {} — {done}/{total} блоків · {focus_min} хв",
            format_ago(now - r.started_at)
        ));
    }
    Reply {
        text: lines.join("\n"),
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![
                InlineButton::new("⬅️ Назад", "refresh:pomodoro:status"),
                InlineButton::new("🔄", format!("refresh:pomodoro:history {limit}")),
            ]],
        }),
        ..Default::default()
    }
}

/// Parse `25/sit 5/walk 25/sit 10/walk` (minutes by default). Accepts
/// explicit unit suffixes (`s`, `m`, `h`) so `90s/sit 25m/stand` works.
pub(crate) fn parse_pomodoro_blocks(s: &str, now_ms: i64) -> Result<Vec<Block>, String> {
    let tokens: Vec<&str> = s.split_whitespace().collect();
    if tokens.is_empty() {
        return Err("вкажи хоча б один блок у форматі `<тривалість>/<postura>`".into());
    }
    if tokens.len() > 20 {
        return Err(format!("забагато блоків ({}), максимум 20", tokens.len()));
    }
    let mut blocks = Vec::with_capacity(tokens.len());
    for (i, tok) in tokens.iter().enumerate() {
        let (dur_str, posture_str) = tok.split_once('/').ok_or_else(|| {
            format!("блок {i} має бути `<тривалість>/<posture>`, отримано `{tok}`")
        })?;
        let duration_sec = parse_duration_to_sec(dur_str).map_err(|e| format!("блок {i}: {e}"))?;
        if duration_sec == 0 {
            return Err(format!("блок {i}: тривалість має бути > 0"));
        }
        if duration_sec > 4 * 60 * 60 {
            return Err(format!("блок {i}: тривалість перевищує 4 год"));
        }
        let posture = match posture_str.to_ascii_lowercase().as_str() {
            "sit" => Posture::Sit,
            "stand" => Posture::Stand,
            "walk" => Posture::Walk,
            other => {
                return Err(format!(
                    "блок {i}: невідома posture `{other}` (sit|stand|walk)"
                ))
            }
        };
        let name = match posture {
            Posture::Sit => "Focus".to_string(),
            Posture::Stand => "Stand".to_string(),
            Posture::Walk => "Walk".to_string(),
        };
        blocks.push(Block {
            id: format!("cli-{now_ms}-{i}"),
            name,
            duration_sec,
            posture,
            mid_nudge_sec: None,
        });
    }
    Ok(blocks)
}

fn parse_duration_to_sec(s: &str) -> Result<u32, String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err("порожня тривалість".into());
    }
    let (num_str, mul) = if let Some(stripped) = trimmed.strip_suffix('s') {
        (stripped, 1u32)
    } else if let Some(stripped) = trimmed.strip_suffix('m') {
        (stripped, 60u32)
    } else if let Some(stripped) = trimmed.strip_suffix('h') {
        (stripped, 3600u32)
    } else {
        // bare number → minutes (the common pomodoro mental model)
        (trimmed, 60u32)
    };
    let n: u32 = num_str
        .parse()
        .map_err(|_| format!("тривалість `{s}` не число"))?;
    n.checked_mul(mul)
        .ok_or_else(|| format!("тривалість `{s}` перевищує припустимий діапазон"))
}

fn posture_word(p: &Posture) -> &'static str {
    match p {
        Posture::Sit => "sit",
        Posture::Stand => "stand",
        Posture::Walk => "walk",
    }
}

// -------------------- LLM tools --------------------

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
            "skip" => pomodoro_skip_next(&app, &self.state),
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
        let blocks = reuse_block_ids(blocks, &snap.blocks);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pomodoro::repo::PomodoroRepo;
    use crate::modules::telegram::agent_util::test_support::{
        all_callbacks, assert_fits, tool_ctx as ctx,
    };
    use rusqlite::Connection;

    #[test]
    fn parse_pomodoro_blocks_accepts_bare_minutes() {
        let blocks = parse_pomodoro_blocks("25/sit 5/walk", 1000).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].duration_sec, 25 * 60);
        assert_eq!(blocks[0].posture, Posture::Sit);
        assert_eq!(blocks[1].duration_sec, 5 * 60);
        assert_eq!(blocks[1].posture, Posture::Walk);
    }

    #[test]
    fn parse_pomodoro_blocks_honours_unit_suffixes() {
        let blocks = parse_pomodoro_blocks("90s/sit 1h/walk", 0).unwrap();
        assert_eq!(blocks[0].duration_sec, 90);
        assert_eq!(blocks[1].duration_sec, 3600);
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_missing_slash() {
        let err = parse_pomodoro_blocks("25sit", 0).unwrap_err();
        assert!(err.contains("посture") || err.contains("posture") || err.contains("/"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_unknown_posture() {
        let err = parse_pomodoro_blocks("25/fly", 0).unwrap_err();
        assert!(err.to_lowercase().contains("posture"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_zero_duration() {
        let err = parse_pomodoro_blocks("0/sit", 0).unwrap_err();
        assert!(err.contains("> 0"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_too_many() {
        let tokens = (0..21).map(|_| "1/sit").collect::<Vec<_>>().join(" ");
        let err = parse_pomodoro_blocks(&tokens, 0).unwrap_err();
        assert!(err.contains("максимум"));
    }

    #[test]
    fn parse_pomodoro_blocks_rejects_empty_input() {
        let err = parse_pomodoro_blocks("", 0).unwrap_err();
        assert!(err.contains("хоча б"));
    }

    #[test]
    fn pomodoro_action_parser_covers_all_verbs() {
        use PomodoroAction::*;
        assert_eq!(parse_pomodoro_action("").unwrap(), Status);
        assert_eq!(parse_pomodoro_action("pause").unwrap(), Pause);
        assert_eq!(parse_pomodoro_action("resume").unwrap(), Resume);
        assert_eq!(parse_pomodoro_action("toggle").unwrap(), Toggle);
        assert_eq!(parse_pomodoro_action("skip").unwrap(), Skip(None));
        assert_eq!(parse_pomodoro_action("skip 3").unwrap(), Skip(Some(3)));
        assert!(parse_pomodoro_action("skip 0").is_err());
        assert_eq!(parse_pomodoro_action("stop").unwrap(), Stop);
        assert_eq!(parse_pomodoro_action("preset 7").unwrap(), Preset(7));
        assert_eq!(parse_pomodoro_action("preset #7").unwrap(), Preset(7));
        assert_eq!(parse_pomodoro_action("presets").unwrap(), Presets);
        assert_eq!(
            parse_pomodoro_action("delete 4").unwrap(),
            Delete { id: 4, confirmed: false }
        );
        assert_eq!(
            parse_pomodoro_action("delete 4 yes").unwrap(),
            Delete { id: 4, confirmed: true }
        );
        assert_eq!(parse_pomodoro_action("history").unwrap(), History(10));
        assert_eq!(parse_pomodoro_action("history 99").unwrap(), History(30));
        assert_eq!(
            parse_pomodoro_action("start 25/sit 5/walk").unwrap(),
            Start("25/sit 5/walk".into())
        );
        assert_eq!(
            parse_pomodoro_action("edit 30/sit").unwrap(),
            Edit("30/sit".into())
        );
        assert!(parse_pomodoro_action("fly").is_err());
        assert!(parse_pomodoro_action("preset abc").is_err());
    }

    #[test]
    fn pomodoro_reuse_block_ids_preserves_cursor_ids_by_position() {
        let old = parse_pomodoro_blocks("25/sit 5/walk", 1).unwrap();
        let new = parse_pomodoro_blocks("30/sit 5/walk 10/stand", 2).unwrap();
        let merged = reuse_block_ids(new, &old);
        assert_eq!(merged[0].id, old[0].id);
        assert_eq!(merged[1].id, old[1].id);
        assert_eq!(merged[2].id, "cli-2-2");
        assert_eq!(merged[0].duration_sec, 1800);
    }

    #[test]
    fn pomodoro_keyboards_fit_and_parse_back() {
        let presets = vec![
            (i64::MAX, "Very long preset name that goes on".to_string()),
            (2, "Deep work".to_string()),
        ];
        for status in [SessionStatus::Idle, SessionStatus::Running, SessionStatus::Paused] {
            let kb = pomodoro_keyboard(status, &presets);
            assert_fits(&kb);
            for d in all_callbacks(&kb) {
                let args = d.strip_prefix("refresh:pomodoro:").unwrap();
                assert!(parse_pomodoro_action(args).is_ok(), "unparseable: {args}");
            }
        }
        // All quick starts survive the 64-byte filter and parse as blocks.
        let idle = all_callbacks(&pomodoro_keyboard(SessionStatus::Idle, &[]));
        for (_, spec) in POMODORO_QUICK_STARTS {
            assert!(idle.contains(&format!("refresh:pomodoro:start {spec}")));
            assert!(parse_pomodoro_blocks(spec, 0).is_ok());
        }
        let running = all_callbacks(&pomodoro_keyboard(SessionStatus::Running, &[]));
        assert!(running.contains(&"refresh:pomodoro:pause".to_string()));
        let paused = all_callbacks(&pomodoro_keyboard(SessionStatus::Paused, &[]));
        assert!(paused.contains(&"refresh:pomodoro:resume".to_string()));
        assert!(format!("refresh:pomodoro:delete {} yes", i64::MAX).len() <= 64);
    }

    #[test]
    fn format_ago_buckets() {
        assert_eq!(format_ago(120), "2 хв тому");
        assert_eq!(format_ago(7200), "2 год тому");
        assert_eq!(format_ago(2 * 86_400), "2 дн тому");
        assert_eq!(format_ago(-5), "0 хв тому");
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
}
