//! Focus / Do-Not-Disturb control via the macOS `shortcuts` CLI.
//!
//! Apple removed programmatic control of the new Focus modes in
//! Monterey — no public AppleScript, no `defaults write` hook. The
//! only stable path left is to drive pre-built Shortcuts actions,
//! which expose Focus as a first-class step. We expect the user to
//! create two shortcuts named exactly `Stash Focus On` and
//! `Stash Focus Off` (one-time setup); Stash then just invokes
//! `shortcuts run` by name.
//!
//! Why two shortcuts rather than one parametric "toggle": the
//! Shortcuts app's "Set Focus" step is a direct on/off, and wiring
//! a toggle inside a single shortcut is more fiddly than asking the
//! user to duplicate a 1-step shortcut.

use std::process::Command;

const SHORTCUT_ON: &str = "Stash Focus On";
const SHORTCUT_OFF: &str = "Stash Focus Off";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusCheck {
    /// Both shortcuts exist and are runnable.
    Ready,
    /// `shortcuts` binary is absent (pre-Monterey or stripped image).
    CliMissing,
    /// One or both Stash shortcuts haven't been created yet.
    ShortcutsMissing { on: bool, off: bool },
    /// `shortcuts list` itself failed.
    ListFailed(String),
}

pub fn check() -> FocusCheck {
    let out = match Command::new("shortcuts").arg("list").output() {
        Ok(o) => o,
        // `not found` maps to CliMissing. Other errors (permission,
        // ENOMEM) are still "we can't proceed" — fold them in too.
        Err(_) => return FocusCheck::CliMissing,
    };
    if !out.status.success() {
        return FocusCheck::ListFailed(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let has_on = stdout.lines().any(|l| l.trim() == SHORTCUT_ON);
    let has_off = stdout.lines().any(|l| l.trim() == SHORTCUT_OFF);
    if has_on && has_off {
        FocusCheck::Ready
    } else {
        FocusCheck::ShortcutsMissing {
            on: has_on,
            off: has_off,
        }
    }
}

fn run_shortcut(name: &str) -> Result<(), String> {
    let out = Command::new("shortcuts")
        .args(["run", name])
        .output()
        .map_err(|e| format!("shortcuts: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "shortcuts run failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

pub fn enable() -> Result<(), String> {
    run_shortcut(SHORTCUT_ON)
}

pub fn disable() -> Result<(), String> {
    run_shortcut(SHORTCUT_OFF)
}

/// Human-readable hint shown to the user when a shortcut is missing.
/// Centralised so the Telegram / CLI command and any future UI wizard
/// give the same setup instructions.
pub fn setup_instructions() -> &'static str {
    "Щоб Stash міг керувати Focus, створи у Shortcuts.app два ярлики:\n\
     • «Stash Focus On» — один крок: Set Focus → On (обери улюблений режим).\n\
     • «Stash Focus Off» — один крок: Set Focus → Off.\n\
     Назви мають збігатися точно (з пробілами)."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_instructions_mention_both_shortcut_names() {
        let t = setup_instructions();
        assert!(t.contains(SHORTCUT_ON));
        assert!(t.contains(SHORTCUT_OFF));
    }

    #[test]
    fn focus_check_variants_compare_by_flags() {
        let a = FocusCheck::ShortcutsMissing {
            on: true,
            off: false,
        };
        let b = FocusCheck::ShortcutsMissing {
            on: true,
            off: false,
        };
        assert_eq!(a, b);
        let c = FocusCheck::ShortcutsMissing {
            on: false,
            off: true,
        };
        assert_ne!(a, c);
    }
}
