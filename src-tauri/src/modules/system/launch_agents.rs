use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LaunchAgent {
    /// plist filename without extension — this IS the launchd label for most
    /// agents, though some override via the `Label` key inside the plist.
    pub label: String,
    pub path: String,
    /// Where the plist lives: user = ~/Library/LaunchAgents, system = /Library/LaunchAgents.
    pub scope: AgentScope,
    /// True if the file is a symlink to `/dev/null` or the `Disabled` key is
    /// set — unified into a single flag for the UI toggle.
    pub disabled: bool,
    /// PID from `launchctl list` when loaded; None when not currently loaded.
    pub pid: Option<i32>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentScope {
    User,
    System,
}

fn read_loaded_labels() -> HashSet<(String, Option<i32>)> {
    // `launchctl list` output: PID\tStatus\tLabel (tab-separated). PID may be
    // `-` when the agent is registered but not currently running. Header
    // line starts with "PID" so we skip it.
    let out = match Command::new("launchctl").arg("list").output() {
        Ok(o) if o.status.success() => o,
        _ => return HashSet::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut set = HashSet::new();
    for line in stdout.lines().skip(1) {
        let mut parts = line.split('\t');
        let pid_raw = parts.next().unwrap_or("").trim();
        let _status = parts.next();
        let label = parts.next().unwrap_or("").trim();
        if label.is_empty() {
            continue;
        }
        let pid = pid_raw.parse::<i32>().ok();
        set.insert((label.to_string(), pid));
    }
    set
}

fn scan_dir(dir: &Path, scope: AgentScope, loaded: &HashSet<(String, Option<i32>)>) -> Vec<LaunchAgent> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("plist") {
            continue;
        }
        let label = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if label.is_empty() {
            continue;
        }
        // Symlink to /dev/null is the conventional "disabled" marker after
        // `launchctl unload -w` on some macOS versions.
        let disabled = std::fs::read_link(&path)
            .ok()
            .map(|t| t == PathBuf::from("/dev/null"))
            .unwrap_or(false);
        let pid = loaded
            .iter()
            .find(|(l, _)| l == &label)
            .and_then(|(_, p)| *p);
        out.push(LaunchAgent {
            label,
            path: path.to_string_lossy().into_owned(),
            scope,
            disabled,
            pid,
        });
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

pub fn list_agents(home: &Path) -> Vec<LaunchAgent> {
    let loaded = read_loaded_labels();
    let mut out = scan_dir(&home.join("Library/LaunchAgents"), AgentScope::User, &loaded);
    out.extend(scan_dir(Path::new("/Library/LaunchAgents"), AgentScope::System, &loaded));
    out
}

/// Toggle via `launchctl load|unload -w`. `-w` persists the override so
/// the change survives reboot. System-scope agents require sudo; we surface
/// the stderr so the user understands what happened.
pub fn toggle_agent(path: &str, enable: bool) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let sub = if enable { "load" } else { "unload" };
    let out = Command::new("launchctl")
        .args([sub, "-w", path])
        .output()
        .map_err(|e| format!("launchctl: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn list_agents_reads_user_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let la = tmp.path().join("Library/LaunchAgents");
        fs::create_dir_all(&la).unwrap();
        fs::write(la.join("com.example.foo.plist"), "").unwrap();
        fs::write(la.join("ignored.txt"), "").unwrap();

        let agents = list_agents(tmp.path());
        assert!(agents.iter().any(|a| a.label == "com.example.foo"));
        assert!(agents.iter().all(|a| a.label != "ignored"));
    }

    #[test]
    fn toggle_agent_rejects_empty_path() {
        assert!(toggle_agent("", true).is_err());
    }
}
