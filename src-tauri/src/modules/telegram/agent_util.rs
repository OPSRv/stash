//! Helpers shared by the agent surface of more than one module — slash
//! commands (`CommandHandler`) and LLM tools (`Tool`) alike.
//!
//! Each module owns its own `src-tauri/src/modules/<m>/agent.rs` (see
//! `docs/agent-surface-refactor.md`). Anything two or more of those files
//! need lives here instead of being copied, so module agents never import
//! from each other: popup navigation (`reveal_tab`, `KNOWN_TABS`), the
//! frontend round-trip (`emit_with_ack`), slash-syntax parsing
//! (`tokenize_quoted`), tool → slash delegation (`run_slash`), and the
//! small read-only probes the dashboard / digest reuse (battery, volume,
//! pomodoro status, separator jobs).

use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::commands_registry::Reply;
use super::tools::ToolCtx;
use crate::modules::pomodoro::engine::SessionStatus;
use crate::modules::pomodoro::state::PomodoroState;
use crate::modules::separator;

// ───────────────────────── time ─────────────────────────

/// Wall-clock milliseconds since the Unix epoch (0 if the clock is broken).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Wall-clock seconds since the Unix epoch (0 if the clock is broken).
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ───────────────────────── text ─────────────────────────

/// Cut `s` to at most `max` chars, appending `…` when anything was dropped.
pub fn truncate_preview(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

/// Split on whitespace but keep `key="quoted value"` together (quotes
/// stripped) so preset names with spaces survive the slash syntax.
pub fn tokenize_quoted(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in s.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ───────────────────────── popup navigation ─────────────────────────

/// Tab IDs the frontend's module registry currently recognises. Kept in
/// sync manually with `src/modules/*/index.tsx` + `src/settings/index.tsx`
/// — the `known_tabs_cover_every_frontend_module` test fails when a
/// frontend tab is missing here (see CLAUDE.md "Agent surface").
pub const KNOWN_TABS: &[&str] = &[
    "clipboard",
    "translator",
    "notes",
    "ai",
    "telegram",
    "valeton-editor",
    "music",
    "downloads",
    "pomodoro",
    "terminal",
    "web",
    "system",
    "canvas",
    "converter",
    "separator",
    "reminders",
    "dev",
    "settings",
];

/// Emit `nav:activate` + show/focus the popup. The frontend shell listens
/// and mounts the requested lazy tab inside `<Suspense>`; this is the
/// same path used by `reveal_music_tab` and the `⌘⇧J` Notes shortcut.
pub fn reveal_tab(app: &tauri::AppHandle, tab_id: &str) {
    let _ = app.emit("nav:activate", tab_id);
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

static REMOTE_ACK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Emit `event` tagged with a fresh `ack_id` and wait for the frontend to
/// echo it on `<event>:ack`. Re-emits every 250 ms until `window` elapses so
/// a lazy tab that mounts mid-wait still receives the payload (replaces the
/// old blind "sleep 350 ms then emit"). The listener dedupes by `ack_id`, so
/// a re-emit never applies the same command twice. Returns the ack payload,
/// or `None` when nothing answered in time.
pub async fn emit_with_ack(
    app: &tauri::AppHandle,
    event: &str,
    mut payload: serde_json::Value,
    window: std::time::Duration,
) -> Option<serde_json::Value> {
    use tauri::Listener;
    let ack_id = REMOTE_ACK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("ack_id".into(), serde_json::json!(ack_id));
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let listener = app.listen(format!("{event}:ack"), move |e| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
            if v.get("ack_id").and_then(|x| x.as_u64()) == Some(ack_id) {
                let _ = tx.send(v);
            }
        }
    });
    let deadline = std::time::Instant::now() + window;
    let mut result = None;
    loop {
        let _ = app.emit(event, &payload);
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let wait = (deadline - now).min(std::time::Duration::from_millis(250));
        if let Ok(Some(v)) = tokio::time::timeout(wait, rx.recv()).await {
            result = Some(v);
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    app.unlisten(listener);
    result
}

// ───────────────────────── LLM tool plumbing ─────────────────────────

/// The tool's `AppHandle`, or an error naming `tool` when running without
/// one (unit tests).
pub fn require_app(ctx: &ToolCtx, tool: &str) -> Result<tauri::AppHandle, String> {
    ctx.app
        .clone()
        .ok_or_else(|| format!("{tool} requires a Tauri AppHandle (not in test)"))
}

/// Delegate a typed tool to its slash-command twin so we don't reimplement
/// the business logic. Runs the registered handler with the stringified
/// args and returns its text reply. Required by every tool that isn't
/// side-effect-free (needs an `AppHandle` for `emit` / tauri state).
pub async fn run_slash(ctx: &ToolCtx, cmd: &str, slash_args: &str) -> Result<Value, String> {
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

// ───────────────────────── battery ─────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum BatterySnapshot {
    Present {
        percent: u32,
        charging: bool,
    },
    /// pmset succeeded but produced no battery line — desktop Mac / server.
    NoBattery,
    /// pmset absent, failed, or returned garbage.
    Unknown,
}

/// Parse `pmset -g batt` output — shape on laptops:
///   `  -InternalBattery-0 (id=...) 87%; charging; 2:31 remaining present: true`
/// On desktop Macs (Mac Mini / Studio / Pro) the output is only
/// `Now drawing from 'AC Power'` with no battery line — we report that
/// distinctly so the user gets a useful reply instead of "unavailable".
pub fn read_battery() -> BatterySnapshot {
    let Ok(out) = Command::new("pmset").args(["-g", "batt"]).output() else {
        return BatterySnapshot::Unknown;
    };
    if !out.status.success() {
        return BatterySnapshot::Unknown;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_pmset(&text)
}

fn parse_pmset(s: &str) -> BatterySnapshot {
    // Look for "NN%" on any line.
    let Some(pct_idx) = s.find('%') else {
        // No percent sign at all — desktop Mac has no battery line.
        return BatterySnapshot::NoBattery;
    };
    let prefix = &s[..pct_idx];
    let pct_start = prefix
        .rfind(|c: char| !c.is_ascii_digit())
        .map(|i| i + 1)
        .unwrap_or(0);
    let Ok(percent) = prefix[pct_start..].parse::<u32>() else {
        return BatterySnapshot::Unknown;
    };
    let rest = &s[pct_idx + 1..];
    let charging = rest
        .split(';')
        .nth(1)
        .map(|s| {
            let w = s.trim().to_lowercase();
            w == "charging" || w.starts_with("ac")
        })
        .unwrap_or(false);
    BatterySnapshot::Present { percent, charging }
}

// ───────────────────────── system volume ─────────────────────────
// Shared by `/volume` (system) and the `/music` player card.

#[derive(Debug, Clone, Copy)]
pub enum VolumeAction {
    Status,
    Set(u32),
    Step(i32),
    Mute(bool),
    ToggleMute,
}

#[derive(Debug, Clone, Default)]
pub struct VolumeSnapshot {
    pub percent: Option<u32>,
    pub muted: bool,
    pub error: Option<String>,
}

/// Apply `action` to the macOS output volume and return the fresh state
/// (or the pre-action state with `error` set when AppleScript failed).
pub fn apply_volume(action: VolumeAction) -> VolumeSnapshot {
    // Compute the target percent first so Set/Step flow through the same
    // AppleScript invocation.
    let current = read_volume();
    let target = match action {
        VolumeAction::Status => None,
        VolumeAction::Set(n) => Some(n),
        VolumeAction::Step(delta) => current
            .percent
            .map(|p| (p as i32 + delta).clamp(0, 100) as u32),
        VolumeAction::Mute(_) | VolumeAction::ToggleMute => None,
    };
    if let Some(t) = target {
        if let Err(e) = set_volume_percent(t) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    let mute_target = match action {
        VolumeAction::Mute(on) => Some(on),
        VolumeAction::ToggleMute => Some(!current.muted),
        _ => None,
    };
    if let Some(on) = mute_target {
        if let Err(e) = set_mute(on) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    read_volume()
}

/// Current macOS output volume + mute flag.
pub fn read_volume() -> VolumeSnapshot {
    let pct = osascript_output("output volume of (get volume settings)")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let mute_str = osascript_output("output muted of (get volume settings)").unwrap_or_default();
    let muted = mute_str.trim() == "true";
    VolumeSnapshot {
        percent: pct,
        muted,
        error: None,
    }
}

fn set_volume_percent(n: u32) -> Result<(), String> {
    osascript_run(&format!("set volume output volume {n}"))
}

fn set_mute(on: bool) -> Result<(), String> {
    osascript_run(&format!(
        "set volume output muted {}",
        if on { "true" } else { "false" }
    ))
}

fn osascript_output(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn osascript_run(script: &str) -> Result<(), String> {
    osascript_output(script).map(|_| ())
}

/// Ten-slot `█░` bar for a 0–100 level.
pub fn volume_bar(percent: u32) -> String {
    let slots = 10usize;
    let filled = ((percent as f32 / 100.0) * slots as f32).round() as usize;
    let filled = filled.min(slots);
    let mut out = String::with_capacity(slots);
    for i in 0..slots {
        out.push(if i < filled { '█' } else { '░' });
    }
    out
}

// ───────────────────────── pomodoro ─────────────────────────

/// One-line pomodoro status — used by `/pomodoro` and the `/dashboard`.
pub fn format_pomodoro_status(state: &Arc<PomodoroState>) -> String {
    let core = match state.core.lock() {
        Ok(c) => c,
        Err(e) => return format!("⚠️ pomodoro: {e}"),
    };
    let snap = core.snapshot();
    match snap.status {
        SessionStatus::Idle => "🍅 Pomodoro не активний.".to_string(),
        status => {
            let remaining_sec = (snap.remaining_ms / 1000).max(0);
            let mins = remaining_sec / 60;
            let secs = remaining_sec % 60;
            let phase = snap
                .blocks
                .get(snap.current_idx)
                .map(|b| {
                    format!(
                        "{} ({}/{})",
                        b.name,
                        snap.current_idx + 1,
                        snap.blocks.len()
                    )
                })
                .unwrap_or_else(|| "-".into());
            let verb = match status {
                SessionStatus::Running => "▶️",
                SessionStatus::Paused => "⏸",
                SessionStatus::Idle => "🍅",
            };
            format!("{verb} {phase} — лишилось {mins:02}:{secs:02}")
        }
    }
}

// ───────────────────────── separator jobs ─────────────────────────
// Shared by `/stems` + `/bpm` and the downloader's "stems" buttons.

/// Queue a Demucs/BeatNet job. Returns the separator state + job id to
/// hand to `await_separator_job`. Shared with the downloader's buttons.
pub fn enqueue_separator(
    app: &tauri::AppHandle,
    spec: separator::SeparatorRunArgs,
) -> Result<(Arc<separator::SeparatorState>, String), String> {
    let state = app
        .try_state::<Arc<separator::SeparatorState>>()
        .map(|s| Arc::clone(&s))
        .ok_or("модуль Stems не ініціалізовано")?;
    let job_id = separator::enqueue_job(app, &state, spec)?;
    Ok((state, job_id))
}

/// Wait for a separator job to settle and render the result card.
pub async fn await_separator_job(state: &Arc<separator::SeparatorState>, job_id: &str) -> Reply {
    // The sidecar is single-job, so we poll the in-memory state every
    // 500ms; this matches the cadence of the UI's progress events without
    // overloading the lock. Hard cap of 30 minutes per job — stems
    // separation on CPU averages 2-5× realtime, and a 30-minute cap
    // covers any realistic input.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30 * 60);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if std::time::Instant::now() > deadline {
            return Reply::text("⚠️ Stems: таймаут (30 хв)");
        }
        let snapshot = state
            .jobs
            .lock()
            .unwrap()
            .iter()
            .find(|j| j.id == job_id)
            .cloned();
        let Some(job) = snapshot else {
            return Reply::text("⚠️ Stems: задачу втрачено");
        };
        match job.status {
            separator::JobStatus::Completed => return reply_for_completed_job(&job),
            separator::JobStatus::Failed => {
                let err = job.error.unwrap_or_else(|| "unknown".into());
                let head = err.lines().next().unwrap_or(&err).to_string();
                return Reply::text(format!("⚠️ Stems: {head}"));
            }
            separator::JobStatus::Cancelled => {
                return Reply::text("✖ Stems: скасовано");
            }
            _ => continue,
        }
    }
}

fn reply_for_completed_job(job: &separator::SeparatorJob) -> Reply {
    let result = job.result.as_ref();
    let bpm_line = result
        .and_then(|r| r.bpm)
        .map(|b| format!("BPM: {b:.1}"))
        .unwrap_or_default();
    let stems_map = result.and_then(|r| r.stems.as_ref());

    let mut text = String::new();
    if let Some(stems) = stems_map {
        text.push_str(&format!("🎚 Стеми готові ({})\n", stems.len()));
    } else {
        text.push_str("🎚 Готово\n");
    }
    if !bpm_line.is_empty() {
        text.push_str(&bpm_line);
        text.push('\n');
    }
    if let Some(stems) = stems_map {
        for name in [
            "vocals", "drums", "bass", "guitar", "piano", "other",
        ] {
            if let Some(p) = stems.get(name) {
                text.push_str(&format!("• {name}: {p}\n"));
            }
        }
    }

    let documents = stems_map
        .map(|m| {
            let order = ["vocals", "drums", "bass", "guitar", "piano", "other"];
            let mut paths: Vec<std::path::PathBuf> = order
                .iter()
                .filter_map(|k| m.get(*k))
                .map(std::path::PathBuf::from)
                .collect();
            // Anything the model emits that isn't in our preferred order
            // (future stems, custom subsets) still gets attached.
            for (k, v) in m {
                if !order.contains(&k.as_str()) {
                    paths.push(std::path::PathBuf::from(v));
                }
            }
            paths
        })
        .unwrap_or_default();
    // Telegram rejects bot uploads over 50 MB — keep those on disk only.
    let limit = crate::modules::downloader::agent::TELEGRAM_UPLOAD_LIMIT;
    let (documents, big): (Vec<_>, Vec<_>) = documents
        .into_iter()
        .partition(|p| std::fs::metadata(p).is_ok_and(|m| m.len() < limit));
    if !big.is_empty() {
        text.push_str(&format!(
            "{} файл(и) завеликі для Telegram — див. вкладку Stems\n",
            big.len()
        ));
    }

    Reply {
        text: text.trim_end().to_string(),
        documents,
        keyboard: None,
    }
}

// ───────────────────────── test support ─────────────────────────

/// Fixtures shared by every module agent's tests.
#[cfg(test)]
pub mod test_support {
    use std::sync::Arc;

    use rusqlite::Connection;

    use crate::modules::telegram::commands_registry::InlineKeyboard;
    use crate::modules::telegram::keyring::MemStore;
    use crate::modules::telegram::repo::TelegramRepo;
    use crate::modules::telegram::state::TelegramState;
    use crate::modules::telegram::tools::ToolCtx;

    /// Every `callback_data` on the keyboard, row-major.
    pub fn all_callbacks(kb: &InlineKeyboard) -> Vec<String> {
        kb.rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.clone())
            .collect()
    }

    /// Telegram rejects callback payloads over 64 bytes.
    pub fn assert_fits(kb: &InlineKeyboard) {
        for data in all_callbacks(kb) {
            assert!(data.len() <= 64, "callback too long ({}): {data}", data.len());
        }
    }

    /// Tool context over an in-memory Telegram repo, with no `AppHandle`.
    pub fn tool_ctx() -> ToolCtx {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn crate::modules::telegram::keyring::SecretStore> =
            Arc::new(MemStore::new());
        ToolCtx {
            state: Arc::new(TelegramState::new(repo, secrets)),
            app: None,
            now_ms: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmset_parses_typical_output() {
        let s = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123) 87%; discharging; 2:31 remaining present: true\n";
        assert_eq!(
            parse_pmset(s),
            BatterySnapshot::Present {
                percent: 87,
                charging: false,
            }
        );
    }

    #[test]
    fn pmset_parses_charging() {
        let s = " -InternalBattery-0 (id=1) 42%; charging; 1:10 present: true\n";
        assert_eq!(
            parse_pmset(s),
            BatterySnapshot::Present {
                percent: 42,
                charging: true,
            }
        );
    }

    #[test]
    fn pmset_parses_ac_attached() {
        let s = " -InternalBattery-0 (id=1) 100%; AC attached; not charging present: true\n";
        assert_eq!(
            parse_pmset(s),
            BatterySnapshot::Present {
                percent: 100,
                charging: true,
            }
        );
    }

    #[test]
    fn pmset_desktop_mac_without_battery() {
        assert_eq!(
            parse_pmset("Now drawing from 'AC Power'\n"),
            BatterySnapshot::NoBattery
        );
    }

    #[test]
    fn pmset_garbled_returns_unknown() {
        // A percent sign but no parsable number nearby → Unknown, not
        // NoBattery, because we did see a %.
        assert_eq!(parse_pmset("abc%def"), BatterySnapshot::Unknown);
    }

    #[test]
    fn truncate_preview_keeps_short() {
        assert_eq!(truncate_preview("hello", 10), "hello");
    }

    #[test]
    fn truncate_preview_adds_ellipsis() {
        let long = "a".repeat(20);
        let out = truncate_preview(&long, 10);
        assert_eq!(out.chars().count(), 11);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn tokenize_quoted_keeps_quoted_values_together() {
        assert_eq!(
            tokenize_quoted(r#"start save="Slow Blues" bpm=80"#),
            vec!["start", "save=Slow Blues", "bpm=80"]
        );
    }

    #[test]
    fn volume_bar_reflects_percent() {
        assert_eq!(volume_bar(0), "░░░░░░░░░░");
        assert_eq!(volume_bar(50), "█████░░░░░");
        assert_eq!(volume_bar(100), "██████████");
    }

    #[test]
    fn known_tabs_cover_every_frontend_module() {
        // Every `id: '…'` declared by a frontend module wired into
        // `registry.ts` (plus Settings, which lives outside src/modules)
        // must be navigable from Telegram / the assistant.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let registry = std::fs::read_to_string(root.join("src/modules/registry.ts"))
            .expect("read registry.ts");
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(root.join("src/modules"))
            .expect("read src/modules")
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("index.tsx"))
            .filter(|p| p.exists())
            .collect();
        files.push(root.join("src/settings/index.tsx"));
        let mut checked = 0;
        for file in files {
            let src = std::fs::read_to_string(&file).unwrap();
            let Some(export) = src
                .split("export const ")
                .nth(1)
                .and_then(|r| r.split(':').next())
                .map(str::trim)
            else {
                continue;
            };
            if !registry.contains(export) {
                continue;
            }
            let Some(id) = src
                .lines()
                .find_map(|l| l.trim().strip_prefix("id: '"))
                .and_then(|r| r.split('\'').next())
            else {
                continue;
            };
            assert!(
                KNOWN_TABS.contains(&id),
                "KNOWN_TABS is missing frontend tab `{id}` ({})",
                file.display()
            );
            checked += 1;
        }
        assert!(checked >= 15, "parsed only {checked} frontend tab ids");
    }

    #[test]
    fn known_tabs_include_valeton_and_pomodoro() {
        // The metronome no longer has its own tab — it lives inside the
        // Valeton editor — so `/metronome` reveals `valeton-editor`.
        assert!(KNOWN_TABS.contains(&"valeton-editor"));
        assert!(KNOWN_TABS.contains(&"pomodoro"));
        assert!(!KNOWN_TABS.contains(&"metronome"));
    }
}
