use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Tuning ids understood by the tuner. Kept in sync with the generated
/// `TUNINGS` list in `src/modules/tuner/tuner.constants.ts` (two canonical
/// shapes transposed down a semitone at a time). The Rust side only needs the
/// ids — to validate persisted/assistant-supplied values — not the pitches.
pub const VALID_TUNING_IDS: &[&str] = &[
    // Standard shape, low string E → A.
    "standard-e",
    "standard-dsharp",
    "standard-d",
    "standard-csharp",
    "standard-c",
    "standard-b",
    "standard-asharp",
    "standard-a",
    // Drop shape, low string Drop-D → Drop-A.
    "drop-d",
    "drop-csharp",
    "drop-c",
    "drop-b",
    "drop-asharp",
    "drop-a",
];

pub const DEFAULT_TUNING_ID: &str = "standard-e";

pub fn is_valid_tuning(id: &str) -> bool {
    VALID_TUNING_IDS.contains(&id)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TunerState {
    pub tuning_id: String,
    /// Preferred audio-input device id, or `None` for the system default.
    /// Opaque to Rust (a browser `MediaDeviceInfo.deviceId`) — the frontend
    /// owns validation and falls back to the default if the device is gone.
    #[serde(default)]
    pub device_id: Option<String>,
}

impl Default for TunerState {
    fn default() -> Self {
        Self {
            tuning_id: DEFAULT_TUNING_ID.to_string(),
            device_id: None,
        }
    }
}

impl TunerState {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<TunerState>(&s).ok())
            .map(|mut s| {
                s.normalize();
                s
            })
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    /// Fall back to the default tuning if the stored id is unknown (e.g. a
    /// future tuning that was removed, or a hand-edited file).
    pub fn normalize(&mut self) {
        if !is_valid_tuning(&self.tuning_id) {
            self.tuning_id = DEFAULT_TUNING_ID.to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("stash-tuner-{}-{name}.json", std::process::id()))
    }

    #[test]
    fn defaults_to_standard_e() {
        assert_eq!(TunerState::default().tuning_id, "standard-e");
    }

    #[test]
    fn round_trip_to_disk() {
        let p = tmp_path("rt");
        let s = TunerState {
            tuning_id: "drop-d".into(),
            device_id: Some("mic-abc".into()),
        };
        s.save(&p).unwrap();
        let loaded = TunerState::load(&p);
        assert_eq!(loaded.tuning_id, "drop-d");
        assert_eq!(loaded.device_id.as_deref(), Some("mic-abc"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_returns_default() {
        let p = tmp_path("missing");
        std::fs::remove_file(&p).ok();
        assert_eq!(TunerState::load(&p), TunerState::default());
    }

    #[test]
    fn normalize_rejects_unknown_tuning() {
        let mut s = TunerState {
            tuning_id: "bogus-tuning".into(),
            device_id: None,
        };
        s.normalize();
        assert_eq!(s.tuning_id, "standard-e");
    }

    #[test]
    fn normalize_keeps_valid_tuning() {
        let mut s = TunerState {
            tuning_id: "drop-a".into(),
            device_id: None,
        };
        s.normalize();
        assert_eq!(s.tuning_id, "drop-a");
    }

    #[test]
    fn all_valid_ids_pass_validation() {
        for id in VALID_TUNING_IDS {
            assert!(is_valid_tuning(id), "{id} should be valid");
        }
        assert!(!is_valid_tuning("standard-f"));
    }
}
