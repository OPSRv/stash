use super::caches::dir_size;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Screenshot {
    pub path: String,
    pub size_bytes: u64,
    pub created_secs: i64,
}

/// Enumerate screenshots stashed on Desktop. macOS names them
/// "Screenshot YYYY-MM-DD at HH.MM.SS.png" (locale-dependent) plus the older
/// "Screen Shot …" pattern. We also honour a custom screenshot location via
/// `defaults read com.apple.screencapture location`.
pub fn list_screenshots(home: &Path) -> Vec<Screenshot> {
    let mut roots: Vec<std::path::PathBuf> = vec![home.join("Desktop")];
    if let Ok(out) = Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
    {
        if out.status.success() {
            let custom = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !custom.is_empty() && custom != roots[0].to_string_lossy() {
                roots.push(std::path::PathBuf::from(custom));
            }
        }
    }
    let mut out = Vec::new();
    for root in roots {
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for ent in entries.flatten() {
            let path = ent.path();
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            let is_ss = (name.starts_with("Screenshot ") || name.starts_with("Screen Shot "))
                && path.extension().and_then(|s| s.to_str()) == Some("png");
            if !is_ss {
                continue;
            }
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let created = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(Screenshot {
                path: path.to_string_lossy().into_owned(),
                size_bytes: meta.len(),
                created_secs: created,
            });
        }
    }
    out.sort_by(|a, b| b.created_secs.cmp(&a.created_secs));
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IosBackup {
    pub path: String,
    /// Backup UUID (folder name).
    pub uuid: String,
    pub device_name: Option<String>,
    pub size_bytes: u64,
    pub last_modified: i64,
}

/// ~/Library/Application Support/MobileSync/Backup/<uuid>/Info.plist has
/// a `<key>Device Name</key><string>...</string>` pair — we grep it via
/// `plutil -extract` instead of parsing the whole plist.
fn read_device_name(plist: &Path) -> Option<String> {
    if !plist.exists() {
        return None;
    }
    let out = Command::new("plutil")
        .args(["-extract", "Device Name", "raw", "-o", "-"])
        .arg(plist)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn list_ios_backups(home: &Path) -> Vec<IosBackup> {
    let root = home.join("Library/Application Support/MobileSync/Backup");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let uuid = ent.file_name().to_string_lossy().into_owned();
        let info = path.join("Info.plist");
        let device_name = read_device_name(&info);
        let size_bytes = dir_size(&path);
        let last_modified = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(IosBackup {
            path: path.to_string_lossy().into_owned(),
            uuid,
            device_name,
            size_bytes,
            last_modified,
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MailAttachmentsBucket {
    /// e.g. V10, V9 (macOS Mail version directories).
    pub version: String,
    pub path: String,
    pub size_bytes: u64,
}

pub fn list_mail_attachments(home: &Path) -> Vec<MailAttachmentsBucket> {
    let mail_root = home.join("Library/Mail");
    let entries = match std::fs::read_dir(&mail_root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().into_owned();
        if !name.starts_with('V') || !path.is_dir() {
            continue;
        }
        // Attachments live deep: Vxx/<UUID>/<account>/…/Attachments/.
        // Rather than walking every imap folder we sum dir_size and let the
        // user trash the version root when space is critical (Mail rebuilds).
        let size = dir_size(&path);
        out.push(MailAttachmentsBucket {
            version: name,
            path: path.to_string_lossy().into_owned(),
            size_bytes: size,
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct XcodeSimulator {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub available: bool,
}

/// Read `xcrun simctl list devices -j` for the names + availability flags.
/// Falls back to folder listing when simctl isn't installed.
pub fn list_xcode_simulators(home: &Path) -> Vec<XcodeSimulator> {
    let root = home.join("Library/Developer/CoreSimulator/Devices");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    // Build udid → (name, available) from simctl output.
    let mut meta: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    if let Ok(out) = Command::new("xcrun")
        .args(["simctl", "list", "devices", "-j"])
        .output()
    {
        if out.status.success() {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                if let Some(by_runtime) = json.get("devices").and_then(|v| v.as_object()) {
                    for devices in by_runtime.values() {
                        if let Some(arr) = devices.as_array() {
                            for d in arr {
                                let udid = d.get("udid").and_then(|v| v.as_str()).unwrap_or("");
                                let name = d.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                let available =
                                    d.get("isAvailable").and_then(|v| v.as_bool()).unwrap_or(true);
                                if !udid.is_empty() {
                                    meta.insert(udid.to_string(), (name.to_string(), available));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut out = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let udid = ent.file_name().to_string_lossy().into_owned();
        let (name, available) = meta
            .get(&udid)
            .cloned()
            .unwrap_or_else(|| (udid.clone(), false));
        out.push(XcodeSimulator {
            path: path.to_string_lossy().into_owned(),
            name,
            size_bytes: dir_size(&path),
            available,
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

/// Runs `xcrun simctl delete unavailable` — removes runtimes whose SDK is
/// no longer installed. Frees tens of gigabytes typical for Xcode users.
pub fn delete_unavailable_simulators() -> Result<(), String> {
    let out = Command::new("xcrun")
        .args(["simctl", "delete", "unavailable"])
        .output()
        .map_err(|e| format!("xcrun: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TmSnapshot {
    pub name: String,
    /// ISO-8601 timestamp derived from the snapshot id.
    pub created_at: String,
}

/// `tmutil listlocalsnapshots /` emits:
///   Snapshots for disk /:
///   com.apple.TimeMachine.2025-04-21-013012.local
///   com.apple.TimeMachine.2025-04-20-120012.local
pub fn list_tm_snapshots() -> Vec<TmSnapshot> {
    let out = match Command::new("tmutil")
        .args(["listlocalsnapshots", "/"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut res = Vec::new();
    for line in stdout.lines() {
        let l = line.trim();
        if !l.starts_with("com.apple.TimeMachine.") {
            continue;
        }
        // Extract YYYY-MM-DD-HHMMSS and reformat.
        let stamp = l
            .trim_start_matches("com.apple.TimeMachine.")
            .trim_end_matches(".local")
            .to_string();
        res.push(TmSnapshot {
            name: l.to_string(),
            created_at: stamp,
        });
    }
    res
}

pub fn delete_tm_snapshot(name: &str) -> Result<(), String> {
    // `tmutil deletelocalsnapshots` wants the date portion, not the full
    // "com.apple.TimeMachine.…local" name.
    let stamp = name
        .trim_start_matches("com.apple.TimeMachine.")
        .trim_end_matches(".local");
    if stamp.is_empty() {
        return Err("empty snapshot id".into());
    }
    let out = Command::new("tmutil")
        .args(["deletelocalsnapshots", stamp])
        .output()
        .map_err(|e| format!("tmutil: {e}"))?;
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
    fn list_screenshots_finds_macos_naming() {
        let tmp = tempfile::tempdir().unwrap();
        let desk = tmp.path().join("Desktop");
        fs::create_dir_all(&desk).unwrap();
        fs::write(desk.join("Screenshot 2025-01-02 at 10.11.12.png"), vec![0u8; 100]).unwrap();
        fs::write(desk.join("unrelated.txt"), b"hi").unwrap();
        let list = list_screenshots(tmp.path());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn delete_tm_snapshot_rejects_empty() {
        assert!(delete_tm_snapshot("").is_err());
    }
}
