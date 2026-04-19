use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetronomeState {
    pub bpm: u32,
    pub numerator: u8,
    pub denominator: u8,
    pub subdivision: u8,
    pub sound: String,
    pub click_volume: f32,
    pub accent_volume: f32,
    pub track_volume: f32,
    pub beat_accents: Vec<bool>,
}

impl Default for MetronomeState {
    fn default() -> Self {
        Self {
            bpm: 100,
            numerator: 4,
            denominator: 4,
            subdivision: 1,
            sound: "click".into(),
            click_volume: 0.7,
            accent_volume: 0.9,
            track_volume: 0.8,
            beat_accents: vec![true, false, false, false],
        }
    }
}

impl MetronomeState {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<MetronomeState>(&s).ok())
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

    /// Clamp values into safe ranges and reshape `beat_accents` so its length
    /// matches `numerator` (preserving prefix, padding new beats with `false`).
    pub fn normalize(&mut self) {
        self.bpm = self.bpm.clamp(40, 240);
        self.numerator = self.numerator.clamp(1, 16);
        if !matches!(self.denominator, 2 | 4 | 8) {
            self.denominator = 4;
        }
        self.subdivision = self.subdivision.clamp(1, 4);
        self.click_volume = self.click_volume.clamp(0.0, 1.0);
        self.accent_volume = self.accent_volume.clamp(0.0, 1.0);
        self.track_volume = self.track_volume.clamp(0.0, 1.0);
        let n = self.numerator as usize;
        if self.beat_accents.len() != n {
            let mut next = vec![false; n];
            for (i, slot) in next.iter_mut().enumerate() {
                *slot = self.beat_accents.get(i).copied().unwrap_or(i == 0);
            }
            self.beat_accents = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "stash-metronome-{}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn defaults_are_sane() {
        let s = MetronomeState::default();
        assert_eq!(s.bpm, 100);
        assert_eq!(s.numerator, 4);
        assert_eq!(s.beat_accents, vec![true, false, false, false]);
    }

    #[test]
    fn round_trip_to_disk() {
        let p = tmp_path("rt");
        let mut s = MetronomeState::default();
        s.bpm = 142;
        s.beat_accents = vec![true, false, true];
        s.numerator = 3;
        s.save(&p).unwrap();
        let loaded = MetronomeState::load(&p);
        assert_eq!(loaded.bpm, 142);
        assert_eq!(loaded.numerator, 3);
        assert_eq!(loaded.beat_accents, vec![true, false, true]);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_returns_default() {
        let p = tmp_path("missing");
        std::fs::remove_file(&p).ok();
        let loaded = MetronomeState::load(&p);
        assert_eq!(loaded, MetronomeState::default());
    }

    #[test]
    fn normalize_clamps_bpm_and_resizes_accents() {
        let mut s = MetronomeState::default();
        s.bpm = 9999;
        s.numerator = 6;
        s.beat_accents = vec![true, false];
        s.normalize();
        assert_eq!(s.bpm, 240);
        assert_eq!(s.beat_accents.len(), 6);
        assert_eq!(s.beat_accents[0], true);
        assert_eq!(s.beat_accents[2], false);
    }

    #[test]
    fn normalize_truncates_when_numerator_shrinks() {
        let mut s = MetronomeState::default();
        s.numerator = 2;
        s.beat_accents = vec![true, false, true, true];
        s.normalize();
        assert_eq!(s.beat_accents, vec![true, false]);
    }
}
