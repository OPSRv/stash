//! Archive manifest.
//!
//! `manifest.json` sits at the root of every backup ZIP. It describes
//! the app version that produced the backup, the backup format version
//! (bumped when the core archive layout changes), and a per-module entry
//! listing which artifacts that module contributed. The manifest is the
//! only thing the import inspector reads before showing the preview,
//! so it's deliberately small and cheap to parse.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Bumped when the core archive layout changes in a non-backwards-compatible
/// way. Providers don't contribute to this number — per-module schema
/// migrations live inside each repo's `PRAGMA user_version` handling.
pub const BACKUP_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModuleEntry {
    pub label: String,
    /// Archive path of the module's SQLite file, when present.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub db: Option<String>,
    /// Archive path of the module's JSON/state file, when present.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub json: Option<String>,
    /// Archive prefix under which media lives. Used as a filter during
    /// restore — any entry in the archive starting with this prefix is
    /// copied into the module's media dir.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub media_prefix: Option<String>,
    /// Approximate size of this module's payload in the archive. Purely
    /// informational — the restore path doesn't trust it.
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub app_version: String,
    pub backup_format_version: u32,
    /// ISO-8601 UTC.
    pub created_at: String,
    pub include_media: bool,
    pub include_settings: bool,
    pub modules: BTreeMap<String, ModuleEntry>,
}

impl Manifest {
    pub fn new(include_media: bool, include_settings: bool) -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            backup_format_version: BACKUP_FORMAT_VERSION,
            created_at: chrono_now_iso(),
            include_media,
            include_settings,
            modules: BTreeMap::new(),
        }
    }
}

/// Minimal ISO-8601 UTC timestamp without pulling in `chrono`. Precision
/// is to the second, which is fine for backup filenames / display.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Break seconds into Y-M-D H:M:S using a calendar routine. We use the
    // Howard Hinnant "days_from_civil" inverse so we can stay dependency-free.
    let (y, mo, d, h, mi, s) = break_unix_secs(secs as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

fn break_unix_secs(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u32;
    let h = tod / 3600;
    let mi = (tod % 3600) / 60;
    let s = tod % 60;
    // Hinnant: civil_from_days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrips_through_json() {
        let mut m = Manifest::new(true, true);
        m.modules.insert(
            "notes".into(),
            ModuleEntry {
                label: "Notes".into(),
                db: Some("db/notes.sqlite".into()),
                json: None,
                media_prefix: Some("media/notes/".into()),
                size_bytes: 1234,
            },
        );
        let s = serde_json::to_string(&m).unwrap();
        let back: Manifest = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn iso_timestamp_has_reasonable_shape() {
        let ts = chrono_now_iso();
        // e.g. 2026-04-21T10:00:00Z
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert!(ts.chars().nth(4) == Some('-'));
        assert!(ts.chars().nth(10) == Some('T'));
    }

    #[test]
    fn known_epoch_renders_correctly() {
        // 2024-02-29T12:34:56Z (leap day) = 1709210096
        let (y, mo, d, h, mi, s) = break_unix_secs(1_709_210_096);
        assert_eq!((y, mo, d, h, mi, s), (2024, 2, 29, 12, 34, 56));
        // 1970-01-01T00:00:00Z
        let e0 = break_unix_secs(0);
        assert_eq!(e0, (1970, 1, 1, 0, 0, 0));
    }
}
