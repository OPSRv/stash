use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Default)]
pub struct DockerStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub items: Vec<DockerUsageItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DockerUsageItem {
    pub kind: String,
    pub total: u64,
    pub active: u64,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PruneResult {
    pub reclaimed_bytes: u64,
    pub stdout: String,
}

/// Locate the docker CLI. Homebrew puts it under `/opt/homebrew/bin` on
/// Apple Silicon, `/usr/local/bin` on Intel; Docker Desktop also installs
/// a symlink in `/usr/local/bin`. We scan the common spots before falling
/// back to `which`, which picks up exotic setups like Colima or Rancher.
fn docker_path() -> Option<String> {
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/docker",
        "/usr/local/bin/docker",
        "/usr/bin/docker",
    ];
    for p in CANDIDATES {
        if Path::new(p).exists() {
            return Some((*p).to_string());
        }
    }
    let out = Command::new("/usr/bin/which").arg("docker").output().ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

pub fn status() -> DockerStatus {
    let path = match docker_path() {
        Some(p) => p,
        None => return DockerStatus::default(),
    };
    let running = Command::new(&path)
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);
    let version = Command::new(&path)
        .args(["version", "--format", "{{.Client.Version}}"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                (!v.is_empty()).then_some(v)
            } else {
                None
            }
        });
    let items = if running {
        parse_system_df(&path)
    } else {
        Vec::new()
    };
    DockerStatus {
        installed: true,
        running,
        version,
        items,
    }
}

fn parse_system_df(path: &str) -> Vec<DockerUsageItem> {
    let out = Command::new(path)
        .args(["system", "df", "--format", "{{json .}}"])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|v| DockerUsageItem {
            kind: v["Type"].as_str().unwrap_or("").to_string(),
            total: v["TotalCount"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| v["TotalCount"].as_u64().unwrap_or(0)),
            active: v["Active"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| v["Active"].as_u64().unwrap_or(0)),
            size_bytes: parse_docker_size(v["Size"].as_str().unwrap_or("0")),
            reclaimable_bytes: parse_reclaimable(v["Reclaimable"].as_str().unwrap_or("0")),
        })
        .collect()
}

/// Docker CLI emits "24GB" / "500MB" / "1.2TB" decimal-unit strings.
pub fn parse_docker_size(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    let split = s
        .char_indices()
        .find(|(_, c)| !c.is_ascii_digit() && *c != '.')
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    let (num_str, unit) = s.split_at(split);
    let n: f64 = num_str.parse().unwrap_or(0.0);
    let mult = match unit.trim().to_uppercase().as_str() {
        "B" | "" => 1.0,
        "KB" | "K" => 1_000.0,
        "MB" | "M" => 1_000_000.0,
        "GB" | "G" => 1_000_000_000.0,
        "TB" | "T" => 1_000_000_000_000.0,
        _ => 1.0,
    };
    (n * mult) as u64
}

/// "19GB (79%)" → 19_000_000_000.
fn parse_reclaimable(s: &str) -> u64 {
    parse_docker_size(s.split('(').next().unwrap_or(s).trim())
}

fn extract_reclaimed(stdout: &str) -> u64 {
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("Total reclaimed space:") {
            return parse_docker_size(rest.trim());
        }
    }
    0
}

/// Full system prune + build-cache prune. Issues two commands because
/// `system prune -af --volumes` doesn't touch BuildKit cache — it lives
/// under `builder prune` on modern Docker Desktop.
pub fn prune() -> Result<PruneResult, String> {
    let path = docker_path().ok_or_else(|| "Docker не встановлено".to_string())?;
    let mut reclaimed: u64 = 0;
    let mut combined = String::new();

    let out = Command::new(&path)
        .args(["system", "prune", "-af", "--volumes"])
        .output()
        .map_err(|e| format!("docker system prune: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    reclaimed += extract_reclaimed(&s);
    combined.push_str(&s);

    if let Ok(o) = Command::new(&path)
        .args(["builder", "prune", "-af"])
        .output()
    {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout);
            reclaimed += extract_reclaimed(&s);
            combined.push_str(&s);
        }
    }

    Ok(PruneResult {
        reclaimed_bytes: reclaimed,
        stdout: combined,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_docker_size_handles_decimal_units() {
        assert_eq!(parse_docker_size("24GB"), 24_000_000_000);
        assert_eq!(parse_docker_size("1.5GB"), 1_500_000_000);
        assert_eq!(parse_docker_size("500MB"), 500_000_000);
        assert_eq!(parse_docker_size("0B"), 0);
    }

    #[test]
    fn parse_reclaimable_strips_percent_suffix() {
        assert_eq!(parse_reclaimable("19GB (79%)"), 19_000_000_000);
    }

    #[test]
    fn extract_reclaimed_reads_summary_line() {
        let stdout = "Deleted Images:\n...\nTotal reclaimed space: 4.2GB\n";
        assert_eq!(extract_reclaimed(stdout), 4_200_000_000);
    }
}
