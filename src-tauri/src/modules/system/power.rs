//! Power actions: display-off, sleep, shutdown — plus a tiny scheduler
//! that lets the Telegram/CLI `/sleep <dur>` and `/shutdown <dur>`
//! commands fire once after a delay and be cancelled.
//!
//! Design notes:
//! - `pmset displaysleepnow` and `pmset sleepnow` don't need sudo on
//!   macOS, so the display-off and sleep paths shell straight out.
//! - Shutdown goes through AppleScript (`tell application "System
//!   Events" to shut down`) — also sudo-free, but macOS will refuse if
//!   unsaved documents block it. We report the exit code verbatim so
//!   the user can see that case.
//! - The scheduler is intentionally in-process and per-kind: one
//!   pending sleep + one pending shutdown. Rescheduling replaces the
//!   previous timer; `cancel` aborts it. There's no persistence — if
//!   the app dies or the user quits Stash, the pending action dies
//!   with it, which matches the "ad-hoc remote nudge" use case.

use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerKind {
    Sleep,
    Shutdown,
}

impl PowerKind {
    fn label(self) -> &'static str {
        match self {
            PowerKind::Sleep => "sleep",
            PowerKind::Shutdown => "shutdown",
        }
    }
}

/// Put the displays to sleep while leaving CPU / background work
/// untouched. Useful when you want Claude, a build, or a download to
/// keep running but don't want the screens on.
pub fn display_off() -> Result<(), String> {
    run("pmset", &["displaysleepnow"])
}

pub fn sleep_now() -> Result<(), String> {
    run("pmset", &["sleepnow"])
}

pub fn shutdown_now() -> Result<(), String> {
    // AppleScript via System Events — works without sudo. Any blocking
    // dialog from an unsaved document will cause a non-zero exit; we
    // surface that as an error so the caller can tell the user.
    run(
        "osascript",
        &["-e", "tell application \"System Events\" to shut down"],
    )
}

fn run(bin: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(bin)
        .args(args)
        .status()
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    if !status.success() {
        return Err(format!(
            "{bin} exited with {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into())
        ));
    }
    Ok(())
}

/// Parse user-facing duration strings. Default unit is *minutes* —
/// matches macOS `pmset schedule` conventions and the colloquial
/// "вимкни через 30" = 30 minutes. Explicit suffixes:
///
/// - `s` / `sec` — seconds
/// - `m` / `min` — minutes (default when no suffix)
/// - `h` / `hr`  — hours
pub fn parse_duration(input: &str) -> Result<Duration, String> {
    let s = input.trim().to_ascii_lowercase();
    if s.is_empty() {
        return Err("empty duration".into());
    }
    let (num_part, unit_part) = s
        .find(|c: char| c.is_alphabetic())
        .map(|i| s.split_at(i))
        .unwrap_or((s.as_str(), ""));
    let n: u64 = num_part
        .trim()
        .parse()
        .map_err(|_| format!("bad number in duration: {input}"))?;
    let secs = match unit_part.trim() {
        "" | "m" | "min" | "mins" | "minute" | "minutes" => n.saturating_mul(60),
        "s" | "sec" | "secs" | "second" | "seconds" => n,
        "h" | "hr" | "hrs" | "hour" | "hours" => n.saturating_mul(3_600),
        other => return Err(format!("unknown duration unit: {other}")),
    };
    Ok(Duration::from_secs(secs))
}

/// Humanise a Duration as "Nh Mm" / "Nm Ss" / "Ns" for reply text.
pub fn format_duration(d: Duration) -> String {
    let total = d.as_secs();
    if total >= 3_600 {
        let h = total / 3_600;
        let m = (total % 3_600) / 60;
        if m == 0 {
            format!("{h}h")
        } else {
            format!("{h}h {m}m")
        }
    } else if total >= 60 {
        let m = total / 60;
        let s = total % 60;
        if s == 0 {
            format!("{m}m")
        } else {
            format!("{m}m {s}s")
        }
    } else {
        format!("{total}s")
    }
}

struct Pending {
    /// Epoch millis when the action will fire. Used by `/sleep status`.
    fire_at_ms: i64,
    handle: JoinHandle<()>,
}

/// Per-kind single-slot scheduler. Replacing overrides; cancel aborts
/// the pending task if any.
pub struct PowerTimers {
    sleep: Mutex<Option<Pending>>,
    shutdown: Mutex<Option<Pending>>,
}

impl PowerTimers {
    pub fn new() -> Self {
        Self {
            sleep: Mutex::new(None),
            shutdown: Mutex::new(None),
        }
    }

    fn slot(&self, kind: PowerKind) -> &Mutex<Option<Pending>> {
        match kind {
            PowerKind::Sleep => &self.sleep,
            PowerKind::Shutdown => &self.shutdown,
        }
    }

    /// Schedule `kind` to fire after `delay`. Returns the epoch-ms at
    /// which it will fire so callers can echo it back to the user.
    /// Any previously scheduled timer of the same kind is cancelled.
    pub fn schedule(&self, kind: PowerKind, delay: Duration) -> i64 {
        let fire_at_ms = now_ms().saturating_add(delay.as_millis() as i64);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let result = match kind {
                PowerKind::Sleep => sleep_now(),
                PowerKind::Shutdown => shutdown_now(),
            };
            if let Err(e) = result {
                tracing::warn!(error = %e, kind = kind.label(), "scheduled power action failed");
            }
        });
        let prev = self
            .slot(kind)
            .lock()
            .unwrap()
            .replace(Pending { fire_at_ms, handle });
        if let Some(p) = prev {
            p.handle.abort();
        }
        fire_at_ms
    }

    /// Cancel the pending timer for `kind`. Returns `true` if anything
    /// was actually pending.
    pub fn cancel(&self, kind: PowerKind) -> bool {
        if let Some(p) = self.slot(kind).lock().unwrap().take() {
            p.handle.abort();
            true
        } else {
            false
        }
    }

    /// Epoch-ms at which the pending action will fire, or `None` if
    /// idle. Cleans up completed handles as a side effect so a long
    /// session doesn't accumulate dead slots.
    pub fn pending_fire_at(&self, kind: PowerKind) -> Option<i64> {
        let mut guard = self.slot(kind).lock().unwrap();
        if let Some(p) = guard.as_ref() {
            if p.handle.is_finished() {
                guard.take();
                return None;
            }
            return Some(p.fire_at_ms);
        }
        None
    }
}

impl Default for PowerTimers {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_minutes_is_default() {
        assert_eq!(parse_duration("15").unwrap(), Duration::from_secs(15 * 60));
    }

    #[test]
    fn parse_duration_accepts_seconds_minutes_hours() {
        assert_eq!(parse_duration("30s").unwrap(), Duration::from_secs(30));
        assert_eq!(parse_duration("2m").unwrap(), Duration::from_secs(120));
        assert_eq!(parse_duration("1h").unwrap(), Duration::from_secs(3_600));
        assert_eq!(parse_duration("1 min").unwrap(), Duration::from_secs(60));
    }

    #[test]
    fn parse_duration_rejects_junk() {
        assert!(parse_duration("").is_err());
        assert!(parse_duration("abc").is_err());
        assert!(parse_duration("10x").is_err());
    }

    #[test]
    fn format_duration_rounds_to_biggest_unit() {
        assert_eq!(format_duration(Duration::from_secs(45)), "45s");
        assert_eq!(format_duration(Duration::from_secs(120)), "2m");
        assert_eq!(format_duration(Duration::from_secs(125)), "2m 5s");
        assert_eq!(format_duration(Duration::from_secs(3_600)), "1h");
        assert_eq!(format_duration(Duration::from_secs(3_660)), "1h 1m");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_reports_pending_and_cancels() {
        let t = PowerTimers::new();
        // Far-future delay so the task never fires during the test.
        t.schedule(PowerKind::Sleep, Duration::from_secs(3_600));
        assert!(t.pending_fire_at(PowerKind::Sleep).is_some());
        assert!(t.pending_fire_at(PowerKind::Shutdown).is_none());
        assert!(t.cancel(PowerKind::Sleep));
        assert!(!t.cancel(PowerKind::Sleep));
        assert!(t.pending_fire_at(PowerKind::Sleep).is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_replaces_previous_timer_of_same_kind() {
        let t = PowerTimers::new();
        t.schedule(PowerKind::Sleep, Duration::from_secs(3_600));
        let second = t.schedule(PowerKind::Sleep, Duration::from_secs(7_200));
        // Only one slot, holding the newer fire time.
        assert_eq!(t.pending_fire_at(PowerKind::Sleep), Some(second));
        t.cancel(PowerKind::Sleep);
    }
}
