use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProcessInfo {
    pub pid: i32,
    /// Resident set size in bytes.
    pub rss_bytes: u64,
    pub cpu_percent: f32,
    pub user: String,
    /// Short process name (comm).
    pub name: String,
    /// Full command line (may be long).
    pub command: String,
}

/// Parse a single line of our custom `ps` output. Format (whitespace-separated):
/// `PID RSS_KB CPU USER COMMAND...`.
/// COMMAND is the remainder of the line (may contain spaces) — we derive
/// `name` from the basename of its first path component. We deliberately do
/// NOT use the `comm` field: macOS truncates it to 16 chars, so e.g.
/// `/Applications/Acrobat.app/…` becomes `/Applications/Ac`, producing a
/// basename of "Ac".
pub fn parse_ps_line(line: &str) -> Option<ProcessInfo> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    // Columns are whitespace-separated; we pick off the first 5 tokens then
    // take the rest verbatim as COMMAND (which may itself contain spaces).
    let mut cursor = trimmed;
    fn take_token<'a>(s: &mut &'a str) -> Option<&'a str> {
        let s_trim = s.trim_start();
        if s_trim.is_empty() {
            return None;
        }
        let end = s_trim
            .char_indices()
            .find(|(_, c)| c.is_whitespace())
            .map(|(i, _)| i)
            .unwrap_or(s_trim.len());
        let (tok, rest) = s_trim.split_at(end);
        *s = rest;
        Some(tok)
    }
    let pid = take_token(&mut cursor)?.parse::<i32>().ok()?;
    let rss_kb = take_token(&mut cursor)?.parse::<u64>().ok()?;
    let cpu = take_token(&mut cursor)?.parse::<f32>().ok()?;
    let user = take_token(&mut cursor)?.to_string();
    let command = cursor.trim().to_string();
    if command.is_empty() {
        return None;
    }
    let exe = command.split_whitespace().next().unwrap_or(&command);
    Some(ProcessInfo {
        pid,
        rss_bytes: rss_kb.saturating_mul(1024),
        cpu_percent: cpu,
        user,
        name: basename(exe),
        command,
    })
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// Shell out to `ps` (ships with macOS) and return one entry per process.
/// We ask for pid, rss in KB, cpu%, user, short name, full command — the
/// trailing `=` on each column suppresses the header row so parsing starts
/// on the first process line.
pub fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,rss=,%cpu=,user=,command="])
        .output()
        .map_err(|e| format!("ps: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ps exit {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout.lines().filter_map(parse_ps_line).collect())
}

fn current_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| {
        Command::new("whoami")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    })
}

/// Send SIGTERM (polite, default) or SIGKILL (force) to `pid`. We refuse
/// PIDs ≤ 1 so a stray invocation cannot target init or the whole process
/// group.
pub fn kill_process(pid: i32, force: bool) -> Result<(), String> {
    if pid <= 1 {
        return Err("refusing to kill pid <= 1".into());
    }
    // Verify the process is owned by the current user before signalling.
    let me = current_user();
    if !me.is_empty() {
        if let Ok(out) = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "user="])
            .output()
        {
            let owner = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !owner.is_empty() && owner != me {
                return Err(format!("refusing to kill pid {pid}: not owned by current user"));
            }
        }
    }
    let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
    let rc = unsafe { libc::kill(pid, sig) };
    if rc == 0 {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        Err(format!("kill({pid}, {sig}): {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_ps_line() {
        let line = "  1234   524288   3.4 alice    /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --arg";
        let p = parse_ps_line(line).unwrap();
        assert_eq!(p.pid, 1234);
        assert_eq!(p.rss_bytes, 524288 * 1024);
        assert!((p.cpu_percent - 3.4).abs() < 0.01);
        assert_eq!(p.user, "alice");
        // Name comes from basename of the first path token — not the truncated
        // 16-char `comm` field that macOS emits (which would give "Ac" for
        // "/Applications/Ac…").
        // A path containing spaces is inherently ambiguous in ps output
        // (no quoting), so we take the first whitespace-delimited token and
        // accept "Google" here. The full command is preserved for display.
        assert_eq!(p.name, "Google");
        assert!(p.command.contains("Google Chrome --arg"));
    }

    #[test]
    fn derives_name_from_unpathed_command() {
        let line = "42 1024 0.0 root launchd";
        let p = parse_ps_line(line).unwrap();
        assert_eq!(p.name, "launchd");
        assert_eq!(p.command, "launchd");
    }

    #[test]
    fn derives_name_from_acrobat_path() {
        // Regression for the "Acr → Ac" bug: when the executable lives under
        // a directory whose name itself has a long basename, we must still
        // surface the final filename, not the directory.
        let line = "77 900000 0.1 alice /Applications/Acrobat.app/Contents/MacOS/AdobeAcrobat";
        let p = parse_ps_line(line).unwrap();
        assert_eq!(p.name, "AdobeAcrobat");
    }

    #[test]
    fn basename_strips_path() {
        assert_eq!(basename("/usr/bin/top"), "top");
        assert_eq!(basename("node"), "node");
    }

    #[test]
    fn skips_malformed_lines() {
        assert!(parse_ps_line("").is_none());
        assert!(parse_ps_line("notanumber 12 0.0 u cmd").is_none());
    }

    #[test]
    fn refuses_low_pid() {
        assert!(kill_process(0, false).is_err());
        assert!(kill_process(1, true).is_err());
    }

    #[test]
    fn list_processes_returns_nonempty_on_host() {
        // Sanity check — on any macOS dev box `ps` must list at least one
        // process (this process itself). Guard with cfg(target_os) so CI on
        // other platforms doesn't trip.
        #[cfg(target_os = "macos")]
        {
            let list = list_processes().unwrap();
            assert!(!list.is_empty());
            assert!(list.iter().any(|p| p.pid > 0));
        }
    }
}
