//! Slash-command handlers that bridge Telegram to other Stash modules.
//! Each handler captures an `Arc` of the module state it targets and is
//! registered into the `CommandRegistry` from `lib.rs` after all module
//! states exist.

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use super::commands_registry::{CommandHandler, Ctx, Reply};
use crate::modules::clipboard::commands::ClipboardState;
use crate::modules::notes::repo::NotesRepo;

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
            Some((percent, charging)) => {
                let icon = if charging { "🔌" } else { "🔋" };
                let status = if charging { "charging" } else { "on battery" };
                Reply::text(format!("{icon} {percent}% — {status}"))
            }
            None => Reply::text("🪫 Battery info unavailable on this system."),
        }
    }
}

/// Parse `pmset -g batt` output — shape:
///   `  -InternalBattery-0 (id=...) 87%; charging; 2:31 remaining present: true`
fn read_battery() -> Option<(u32, bool)> {
    let out = Command::new("pmset").args(["-g", "batt"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_pmset(&text)
}

fn parse_pmset(s: &str) -> Option<(u32, bool)> {
    // Find "NN%" and read the word after the semicolon.
    let pct_idx = s.find('%')?;
    let prefix = &s[..pct_idx];
    let pct_start = prefix
        .rfind(|c: char| !c.is_ascii_digit())
        .map(|i| i + 1)
        .unwrap_or(0);
    let percent: u32 = prefix[pct_start..].parse().ok()?;
    let rest = &s[pct_idx + 1..];
    let charging = rest
        .split(';')
        .nth(1)
        .map(|s| {
            let w = s.trim().to_lowercase();
            w == "charging" || w == "AC attached".to_lowercase() || w.starts_with("ac")
        })
        .unwrap_or(false);
    Some((percent, charging))
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
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
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
        let mut repo = match self.repo.lock() {
            Ok(r) => r,
            Err(e) => return Reply::text(format!("⚠️ notes error: {e}")),
        };
        match repo.create(&title, body, now_ms()) {
            Ok(id) => Reply::text(format!("📝 Saved note #{id}: {title}")),
            Err(e) => Reply::text(format!("⚠️ notes error: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmset_parses_typical_output() {
        let s = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123) 87%; discharging; 2:31 remaining present: true\n";
        assert_eq!(parse_pmset(s), Some((87, false)));
    }

    #[test]
    fn pmset_parses_charging() {
        let s = " -InternalBattery-0 (id=1) 42%; charging; 1:10 present: true\n";
        assert_eq!(parse_pmset(s), Some((42, true)));
    }

    #[test]
    fn pmset_parses_ac_attached() {
        let s = " -InternalBattery-0 (id=1) 100%; AC attached; not charging present: true\n";
        assert_eq!(parse_pmset(s), Some((100, true)));
    }

    #[test]
    fn pmset_nonsense_returns_none() {
        assert_eq!(parse_pmset("nothing useful here"), None);
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
}
