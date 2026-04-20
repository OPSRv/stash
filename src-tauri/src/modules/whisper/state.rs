use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Persisted configuration for the whisper module — just the id of the model
/// the user has marked active, if any. Lives in
/// `appData/whisper/state.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WhisperConfig {
    pub active_model_id: Option<String>,
}

impl WhisperConfig {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }
}

/// Runtime handle for the whisper module. Holds the on-disk config and a
/// set of in-flight download ids — we refuse to start a duplicate download
/// for the same model.
pub struct WhisperStateHandle {
    pub config: Mutex<WhisperConfig>,
    pub config_path: Mutex<PathBuf>,
    pub in_flight: Mutex<std::collections::HashSet<String>>,
}

impl WhisperStateHandle {
    pub fn new(config_path: PathBuf) -> Self {
        let config = WhisperConfig::load(&config_path);
        Self {
            config: Mutex::new(config),
            config_path: Mutex::new(config_path),
            in_flight: Mutex::new(Default::default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "stash-whisper-cfg-{}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn round_trips_active_id() {
        let p = tmp_path("rt");
        let cfg = WhisperConfig {
            active_model_id: Some("small.en".into()),
        };
        cfg.save(&p).unwrap();
        let loaded = WhisperConfig::load(&p);
        assert_eq!(loaded.active_model_id.as_deref(), Some("small.en"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_returns_default() {
        let p = tmp_path("missing");
        std::fs::remove_file(&p).ok();
        assert_eq!(WhisperConfig::load(&p), WhisperConfig::default());
    }
}
