//! Slash-command handlers that bridge Telegram to other Stash modules.
//! Each handler captures an `Arc` of the module state it targets and is
//! registered into the `CommandRegistry` from `lib.rs` after all module
//! states exist.

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tauri::{Emitter, Manager};

use super::commands_registry::{CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply};
use super::reminders;
use super::repo::TelegramRepo;
use super::state::TelegramState;
use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::notes::repo::NotesRepo;
use crate::tray::TrayState;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// -------------------- /battery --------------------

pub struct BatteryCmd;

#[async_trait]
impl CommandHandler for BatteryCmd {
    fn name(&self) -> &'static str {
        "battery"
    }
    fn description(&self) -> &'static str {
        "Show battery percentage and charging state"
    }
    fn usage(&self) -> &'static str {
        "/battery"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        match read_battery() {
            BatterySnapshot::Present { percent, charging } => {
                let icon = if charging { "🔌" } else { "🔋" };
                let status = if charging { "charging" } else { "on battery" };
                Reply::text(format!("{icon} {percent}% — {status}"))
            }
            BatterySnapshot::NoBattery => {
                Reply::text("🔌 This Mac has no battery (desktop / plugged in).")
            }
            BatterySnapshot::Unknown => {
                Reply::text("🪫 Battery info unavailable on this system.")
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum BatterySnapshot {
    Present { percent: u32, charging: bool },
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
fn read_battery() -> BatterySnapshot {
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

// -------------------- /clip --------------------

pub struct ClipCmd {
    state: Arc<ClipboardState>,
}

impl ClipCmd {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ClipCmd {
    fn name(&self) -> &'static str {
        "clip"
    }
    fn description(&self) -> &'static str {
        "Return clipboard item N (newest = 1)"
    }
    fn usage(&self) -> &'static str {
        "/clip [N]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let n: usize = args.trim().parse().unwrap_or(1).max(1);
        let items = match self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())
            .and_then(|repo| repo.list(n).map_err(|e| e.to_string()))
        {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ clipboard error: {e}")),
        };
        match items.get(n - 1) {
            Some(item) if item.kind == "text" => {
                let content = truncate_preview(&item.content, 3_500);
                Reply::text(content)
            }
            Some(item) => Reply::text(format!("📎 [{}] {}", item.kind, item.content)),
            None => Reply::text(format!("📭 No clipboard entry at position {n}.")),
        }
    }
}

fn truncate_preview(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

// -------------------- /note --------------------

pub struct NoteCmd {
    repo: Arc<Mutex<NotesRepo>>,
}

impl NoteCmd {
    pub fn new(repo: Arc<Mutex<NotesRepo>>) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl CommandHandler for NoteCmd {
    fn name(&self) -> &'static str {
        "note"
    }
    fn description(&self) -> &'static str {
        "Create a quick note from the text after the command"
    }
    fn usage(&self) -> &'static str {
        "/note <text>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let body = args.trim();
        if body.is_empty() {
            return Reply::text("✍️ Usage: /note <text>");
        }
        let title: String = body.lines().next().unwrap_or("").chars().take(80).collect();
        let title = if title.is_empty() {
            "Untitled".to_string()
        } else {
            title
        };
        let result = match self.repo.lock() {
            Ok(mut repo) => repo.create(&title, body, now_ms()),
            Err(e) => return Reply::text(format!("⚠️ notes error: {e}")),
        };
        match result {
            Ok(id) => {
                // Nudge the Notes panel to refresh — the panel normally
                // reloads on its own writes but has no other signal to
                // notice a cross-module insert.
                let _ = ctx.app.emit("notes:changed", id);
                Reply::text(format!("📝 Saved note #{id}: {title}"))
            }
            Err(e) => Reply::text(format!("⚠️ notes error: {e}")),
        }
    }
}

// -------------------- /remind --------------------

pub struct RemindCmd {
    state: Arc<TelegramState>,
}

impl RemindCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for RemindCmd {
    fn name(&self) -> &'static str {
        "remind"
    }
    fn description(&self) -> &'static str {
        "Schedule a reminder. Formats: `10m text`, `14:30 text`, `tomorrow 9:00 text`, `2026-04-25 14:30 text`"
    }
    fn usage(&self) -> &'static str {
        "/remind <when> <text>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let now = now_secs();
        let Some((due, text)) = reminders::parse_when(args, now) else {
            return Reply::text(
                "✍️ Usage: /remind <when> <text>\n\
                 Examples:\n\
                 • /remind 10m drink water\n\
                 • /remind 1h30m call mom\n\
                 • /remind 14:30 team sync\n\
                 • /remind tomorrow 9:00 gym\n\
                 • /remind 2026-04-25 14:30 doctor",
            );
        };
        let created = now * 1000;
        let mut repo = match self.state.repo.lock() {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ reminders error: {e}")),
        };
        match repo.insert_reminder(&text, due, created) {
            Ok(id) => {
                let mins = ((due - now) as f64 / 60.0).round() as i64;
                let when = if mins < 60 {
                    format!("in ~{mins} min")
                } else if mins < 24 * 60 {
                    format!("in ~{} h {} min", mins / 60, mins % 60)
                } else {
                    format!("in ~{} day(s)", mins / (24 * 60))
                };
                Reply::text(format!(
                    "⏰ #{id} scheduled {when}: {text}\n(Cancel with /forget {id})"
                ))
            }
            Err(e) => Reply::text(format!("⚠️ DB error: {e}")),
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// -------------------- /reminders --------------------

pub struct RemindersCmd {
    state: Arc<TelegramState>,
}

impl RemindersCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for RemindersCmd {
    fn name(&self) -> &'static str {
        "reminders"
    }
    fn description(&self) -> &'static str {
        "List pending reminders"
    }
    fn usage(&self) -> &'static str {
        "/reminders"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let repo = match self.state.repo.lock() {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ reminders error: {e}")),
        };
        let items = match repo.list_active_reminders() {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ DB error: {e}")),
        };
        if items.is_empty() {
            return Reply::text("📭 No pending reminders.");
        }
        let now = now_secs();
        let mut out = String::from("⏰ Pending:\n");
        for r in items.iter().take(20) {
            let delta = r.due_at - now;
            let when = if delta < 0 {
                "(past)".to_string()
            } else if delta < 60 {
                "< 1 min".to_string()
            } else if delta < 3600 {
                format!("{} min", delta / 60)
            } else if delta < 86_400 {
                format!("{} h", delta / 3600)
            } else {
                format!("{} d", delta / 86_400)
            };
            out.push_str(&format!("• #{} ({when}) — {}\n", r.id, r.text));
        }
        if items.len() > 20 {
            out.push_str(&format!("…and {} more\n", items.len() - 20));
        }
        Reply::text(out.trim_end().to_string())
    }
}

// -------------------- /forget --------------------

pub struct ForgetCmd {
    state: Arc<TelegramState>,
}

impl ForgetCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ForgetCmd {
    fn name(&self) -> &'static str {
        "forget"
    }
    fn description(&self) -> &'static str {
        "Cancel a pending reminder by id"
    }
    fn usage(&self) -> &'static str {
        "/forget <id>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let Ok(id): Result<i64, _> = args.trim().parse() else {
            return Reply::text("✍️ Usage: /forget <id> (see /reminders)");
        };
        let mut repo = match self.state.repo.lock() {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ reminders error: {e}")),
        };
        match repo.cancel_reminder(id) {
            Ok(true) => Reply::text(format!("🗑️ Cancelled reminder #{id}.")),
            Ok(false) => Reply::text(format!("❓ No pending reminder #{id}.")),
            Err(e) => Reply::text(format!("⚠️ DB error: {e}")),
        }
    }
}

// unused import silencer while the helper is only used in reminders.rs
#[allow(dead_code)]
fn _keep_import(_: &TelegramRepo) {}

// -------------------- /volume --------------------

pub struct VolumeCmd;

#[async_trait]
impl CommandHandler for VolumeCmd {
    fn name(&self) -> &'static str {
        "volume"
    }
    fn description(&self) -> &'static str {
        "Show or set macOS system output volume (0–100)"
    }
    fn usage(&self) -> &'static str {
        "/volume [N | up | down | mute | unmute]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let raw = args.trim().to_lowercase();
        let action = match raw.as_str() {
            "" | "status" => VolumeAction::Status,
            "up" | "+" => VolumeAction::Step(10),
            "down" | "-" => VolumeAction::Step(-10),
            "mute" => VolumeAction::Mute(true),
            "unmute" => VolumeAction::Mute(false),
            other => match other.parse::<i32>() {
                Ok(n) => VolumeAction::Set(n.clamp(0, 100) as u32),
                Err(_) => {
                    return Reply::text(format!(
                        "✍️ Usage: /volume [N | up | down | mute | unmute]. Got: {other}"
                    ));
                }
            },
        };
        let snap = apply_volume(action);
        Reply {
            text: format_volume(&snap),
            keyboard: Some(volume_keyboard()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum VolumeAction {
    Status,
    Set(u32),
    Step(i32),
    Mute(bool),
}

#[derive(Debug, Clone, Default)]
struct VolumeSnapshot {
    percent: Option<u32>,
    muted: bool,
    error: Option<String>,
}

fn apply_volume(action: VolumeAction) -> VolumeSnapshot {
    // Compute the target percent first so Set/Step flow through the same
    // AppleScript invocation.
    let current = read_volume();
    let target = match action {
        VolumeAction::Status => None,
        VolumeAction::Set(n) => Some(n),
        VolumeAction::Step(delta) => current
            .percent
            .map(|p| (p as i32 + delta).clamp(0, 100) as u32),
        VolumeAction::Mute(_) => None,
    };
    if let Some(t) = target {
        if let Err(e) = set_volume_percent(t) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    if let VolumeAction::Mute(on) = action {
        if let Err(e) = set_mute(on) {
            return VolumeSnapshot {
                error: Some(e),
                ..current
            };
        }
    }
    read_volume()
}

fn read_volume() -> VolumeSnapshot {
    let pct = osascript_output("output volume of (get volume settings)")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let mute_str = osascript_output("output muted of (get volume settings)")
        .unwrap_or_default();
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

fn format_volume(s: &VolumeSnapshot) -> String {
    if let Some(e) = &s.error {
        return format!("⚠️ {e}");
    }
    let Some(p) = s.percent else {
        return "🔇 Could not read system volume.".to_string();
    };
    if s.muted {
        return format!("🔇 Muted (was {p}%)");
    }
    let bar = volume_bar(p);
    format!("🔊 {p}% {bar}")
}

fn volume_bar(percent: u32) -> String {
    let slots = 10usize;
    let filled = ((percent as f32 / 100.0) * slots as f32).round() as usize;
    let filled = filled.min(slots);
    let mut out = String::with_capacity(slots);
    for i in 0..slots {
        out.push(if i < filled { '█' } else { '░' });
    }
    out
}

fn volume_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton {
                text: "➖10".into(),
                callback_data: "volume:down".into(),
            },
            InlineButton {
                text: "🔇".into(),
                callback_data: "volume:mute".into(),
            },
            InlineButton {
                text: "🔊".into(),
                callback_data: "volume:unmute".into(),
            },
            InlineButton {
                text: "➕10".into(),
                callback_data: "volume:up".into(),
            },
        ]],
    }
}

// -------------------- /music --------------------

pub struct MusicCmd;

#[async_trait]
impl CommandHandler for MusicCmd {
    fn name(&self) -> &'static str {
        "music"
    }
    fn description(&self) -> &'static str {
        "Show or control the YouTube Music player"
    }
    fn usage(&self) -> &'static str {
        "/music [play|pause|next|prev]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_lowercase();
        match sub.as_str() {
            "" | "status" => {
                let snapshot = read_now_playing(&ctx.app);
                let text = format_now_playing(&snapshot);
                Reply {
                    text,
                    keyboard: Some(music_keyboard()),
                }
            }
            "play" | "pause" | "toggle" => {
                match crate::modules::music::commands::music_play_pause(ctx.app.clone()) {
                    Ok(()) => Reply {
                        text: format!("⏯️ {}", read_after_action(&ctx.app, "toggled")),
                        keyboard: Some(music_keyboard()),
                    },
                    Err(e) => Reply::text(format!("⚠️ {e}")),
                }
            }
            "next" => match crate::modules::music::commands::music_next(ctx.app.clone()) {
                Ok(()) => Reply {
                    text: format!("⏭️ {}", read_after_action(&ctx.app, "skipped")),
                    keyboard: Some(music_keyboard()),
                },
                Err(e) => Reply::text(format!("⚠️ {e}")),
            },
            "prev" => match crate::modules::music::commands::music_prev(ctx.app.clone()) {
                Ok(()) => Reply {
                    text: format!("⏮️ {}", read_after_action(&ctx.app, "rewound")),
                    keyboard: Some(music_keyboard()),
                },
                Err(e) => Reply::text(format!("⚠️ {e}")),
            },
            _ => Reply::text(format!(
                "✍️ Usage: /music [play|pause|next|prev]. Got: {sub}"
            )),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct NowPlaying {
    playing: bool,
    title: String,
    artist: String,
    attached: bool,
}

fn read_now_playing(app: &tauri::AppHandle) -> NowPlaying {
    let attached = app.webviews().contains_key("music");
    let Some(tray) = app.try_state::<Arc<TrayState>>() else {
        return NowPlaying {
            attached,
            ..NowPlaying::default()
        };
    };
    // Read music snapshot through the Mutex. `tray::music` is private —
    // use the public read helper.
    let snap = crate::tray::read_music_snapshot(&tray);
    NowPlaying {
        playing: snap.playing,
        title: snap.title,
        artist: snap.artist,
        attached,
    }
}

/// Wait a blink for the webview to update its now-playing state after a
/// control click, then format whatever we see — so `/music pause` reports
/// the post-action state rather than the pre-action one.
fn read_after_action(app: &tauri::AppHandle, verb: &str) -> String {
    std::thread::sleep(std::time::Duration::from_millis(400));
    let snap = read_now_playing(app);
    if !snap.attached {
        return format!("{verb} (player not attached)");
    }
    format_now_playing(&snap)
}

fn format_now_playing(snap: &NowPlaying) -> String {
    if !snap.attached {
        return "🎵 Player not attached. Open Stash → Music first.".to_string();
    }
    let title = if snap.title.is_empty() {
        "(nothing)".to_string()
    } else {
        snap.title.clone()
    };
    let who = if snap.artist.is_empty() {
        String::new()
    } else {
        format!(" — {}", snap.artist)
    };
    let icon = if snap.playing { "▶️" } else { "⏸️" };
    format!("{icon} {title}{who}")
}

fn music_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton {
                text: "⏮️".into(),
                callback_data: "music:prev".into(),
            },
            InlineButton {
                text: "⏯️".into(),
                callback_data: "music:toggle".into(),
            },
            InlineButton {
                text: "⏭️".into(),
                callback_data: "music:next".into(),
            },
        ]],
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
        assert_eq!(parse_pmset("Now drawing from 'AC Power'\n"), BatterySnapshot::NoBattery);
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
    fn volume_bar_reflects_percent() {
        assert_eq!(volume_bar(0), "░░░░░░░░░░");
        assert_eq!(volume_bar(50), "█████░░░░░");
        assert_eq!(volume_bar(100), "██████████");
    }

    #[test]
    fn format_volume_renders_percent() {
        let s = VolumeSnapshot {
            percent: Some(42),
            muted: false,
            error: None,
        };
        let out = format_volume(&s);
        assert!(out.contains("42%"));
        assert!(out.starts_with("🔊"));
    }

    #[test]
    fn format_volume_mute_shows_previous_level() {
        let s = VolumeSnapshot {
            percent: Some(60),
            muted: true,
            error: None,
        };
        let out = format_volume(&s);
        assert!(out.contains("60%"));
        assert!(out.starts_with("🔇"));
    }
}
