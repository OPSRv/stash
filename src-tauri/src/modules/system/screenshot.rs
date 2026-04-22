//! Thin wrapper around macOS `screencapture`.
//!
//! `capture_all_displays` snaps every connected screen in one invocation
//! — `screencapture` accepts N output paths and assigns screens 1..=N
//! to them, which is the cheapest way to cover multi-monitor setups
//! without pulling in CoreGraphics capture APIs.
//!
//! Files land in the OS temp directory with a millisecond-precise stem
//! so repeated captures don't clobber each other and `screencapture`
//! never silently refuses to overwrite a read-only path.

use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Where the PNGs are written. Exposed so handlers can mention the
/// directory in their reply text for CLI users.
fn output_dir() -> PathBuf {
    std::env::temp_dir()
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Build filename for screen index `idx` (1-based). `total` is included
/// only when >1 so a single-screen grab has a tidy `-1` suffix elided.
fn file_for(idx: usize, total: usize, ts: u128) -> PathBuf {
    let stem = if total > 1 {
        format!("stash-shot-{ts}-{idx}.png")
    } else {
        format!("stash-shot-{ts}.png")
    };
    output_dir().join(stem)
}

#[cfg(target_os = "macos")]
fn display_count() -> usize {
    // CoreGraphics already knows how many displays are attached — avoid
    // re-discovering via shell commands. Falls back to 1 when the list
    // is empty (headless CI runners, simulator environments).
    let count = crate::modules::system::displays::list_hardware_displays().len();
    count.max(1)
}

#[cfg(not(target_os = "macos"))]
fn display_count() -> usize {
    1
}

/// Capture every attached screen. Returns one PNG path per display in
/// the order `screencapture` assigned to them.
pub fn capture_all_displays() -> Result<Vec<PathBuf>, String> {
    let total = display_count();
    let ts = epoch_ms();
    let files: Vec<PathBuf> = (1..=total).map(|i| file_for(i, total, ts)).collect();
    run_screencapture(&files, None)?;
    keep_existing(files)
}

/// Capture just the main display. Cheaper path for one-screen setups or
/// when the caller explicitly asks for it.
pub fn capture_main_display() -> Result<PathBuf, String> {
    let ts = epoch_ms();
    let path = file_for(1, 1, ts);
    // `-D 1` targets the main display regardless of how many are
    // attached. Passing a single file without `-D` would do the same on
    // modern macOS, but being explicit guards against future changes.
    run_screencapture(std::slice::from_ref(&path), Some(1))?;
    if !path.exists() {
        return Err(format!("screencapture produced no file at {}", path.display()));
    }
    Ok(path)
}

fn run_screencapture(files: &[PathBuf], display: Option<u32>) -> Result<(), String> {
    let mut cmd = Command::new("screencapture");
    // `-x`  no shutter sound, `-o` no drop-shadow on windowed captures
    // (doesn't hurt full-screen grabs), `-t png` to pin the format.
    cmd.args(["-x", "-t", "png"]);
    if let Some(d) = display {
        cmd.args(["-D", &d.to_string()]);
    }
    for f in files {
        cmd.arg(f);
    }
    let status = cmd
        .status()
        .map_err(|e| format!("spawn screencapture: {e}"))?;
    if !status.success() {
        return Err(format!(
            "screencapture exited with {}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        ));
    }
    Ok(())
}

/// Filter to only the files `screencapture` actually wrote. On some
/// multi-head configurations mirrored displays are skipped, so the
/// planned output list is an upper bound, not a guarantee.
fn keep_existing(files: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    let existing: Vec<PathBuf> = files.into_iter().filter(|p| p.exists()).collect();
    if existing.is_empty() {
        return Err("screencapture produced no files (permission denied?)".into());
    }
    Ok(existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_for_single_display_omits_index_suffix() {
        let p = file_for(1, 1, 1_700_000_000_000);
        assert!(p.to_string_lossy().ends_with("stash-shot-1700000000000.png"));
    }

    #[test]
    fn file_for_multi_display_includes_index() {
        let p = file_for(2, 3, 1_700_000_000_000);
        assert!(p.to_string_lossy().ends_with("stash-shot-1700000000000-2.png"));
    }
}
