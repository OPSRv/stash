use std::process::Command;

/// User-triggered system actions. We do NOT wrap any destructive operation
/// (shutdown/restart) here — the frontend's confirm dialog is the safety net,
/// but we still refuse to skip it by requiring each command to be explicit.

pub fn sleep_now() -> Result<(), String> {
    run("pmset", &["sleepnow"])
}

/// Equivalent of ⌃⌘Q — locks the screen by suspending the login session.
pub fn lock_screen() -> Result<(), String> {
    run(
        "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
        &["-suspend"],
    )
}

pub fn flush_dns() -> Result<(), String> {
    run("dscacheutil", &["-flushcache"])?;
    // killall -HUP mDNSResponder — needs sudo on some macOS versions, so we
    // attempt without and surface the stderr if it fails.
    let out = Command::new("killall")
        .args(["-HUP", "mDNSResponder"])
        .output()
        .map_err(|e| format!("killall: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.contains("permission") || msg.contains("No matching processes") {
            // Best-effort — flushing dscacheutil alone already clears most lookups.
            return Ok(());
        }
        return Err(msg);
    }
    Ok(())
}

/// Ask Spotlight to rebuild the index for the primary volume. Re-indexing
/// is a background job, so this returns immediately.
pub fn reindex_spotlight() -> Result<(), String> {
    run("mdutil", &["-E", "/"])
}

pub fn empty_memory_pressure() -> Result<(), String> {
    // `purge` needs root. Rather than asking the user to open Terminal we
    // delegate to AppleScript's `do shell script … with administrator
    // privileges` — that pops the standard macOS credentials dialog, same
    // UX as CleanMyMac / iStat Menus. The dialog title makes it clear
    // what Stash is about to run. User-cancel returns exit code 1 with
    // "User canceled." in stderr; we translate that to a friendly message.
    let script = "do shell script \"/usr/sbin/purge\" with administrator privileges with prompt \"Stash просить дозвіл очистити неактивну RAM.\"";
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.contains("User canceled") || stderr.contains("-128") {
        return Err("Скасовано".into());
    }
    Err(stderr)
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{cmd}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
