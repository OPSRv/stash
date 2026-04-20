use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrainerConfig {
    pub enabled: bool,
    pub step_bpm: u32,
    pub every_bars: u32,
    pub target_bpm: u32,
}

impl Default for TrainerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            step_bpm: 4,
            every_bars: 4,
            target_bpm: 160,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub bpm: u32,
    pub numerator: u8,
    pub denominator: u8,
    pub subdivision: u8,
    pub sound: String,
    pub beat_accents: Vec<bool>,
}

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
    #[serde(default)]
    pub trainer: TrainerConfig,
    #[serde(default)]
    pub presets: Vec<Preset>,
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
            trainer: TrainerConfig::default(),
            presets: Vec::new(),
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
        self.trainer.step_bpm = self.trainer.step_bpm.clamp(1, 50);
        self.trainer.every_bars = self.trainer.every_bars.clamp(1, 64);
        self.trainer.target_bpm = self.trainer.target_bpm.clamp(40, 240);
        // Drop obviously malformed presets rather than trying to "fix" them —
        // keeps storage honest and avoids surprising resurrections.
        self.presets.retain(|p| {
            !p.id.is_empty()
                && !p.name.is_empty()
                && (40..=240).contains(&p.bpm)
                && (1..=16).contains(&p.numerator)
                && matches!(p.denominator, 2 | 4 | 8)
                && (1..=4).contains(&p.subdivision)
                && p.beat_accents.len() == p.numerator as usize
        });
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
        assert!(!s.trainer.enabled);
        assert!(s.presets.is_empty());
    }

    #[test]
    fn round_trip_to_disk() {
        let p = tmp_path("rt");
        let mut s = MetronomeState::default();
        s.bpm = 142;
        s.beat_accents = vec![true, false, true];
        s.numerator = 3;
        s.trainer.enabled = true;
        s.trainer.step_bpm = 8;
        s.presets.push(Preset {
            id: "a".into(),
            name: "Fast".into(),
            bpm: 180,
            numerator: 4,
            denominator: 4,
            subdivision: 2,
            sound: "wood".into(),
            beat_accents: vec![true, false, false, false],
        });
        s.save(&p).unwrap();
        let loaded = MetronomeState::load(&p);
        assert_eq!(loaded.bpm, 142);
        assert_eq!(loaded.numerator, 3);
        assert_eq!(loaded.beat_accents, vec![true, false, true]);
        assert!(loaded.trainer.enabled);
        assert_eq!(loaded.trainer.step_bpm, 8);
        assert_eq!(loaded.presets.len(), 1);
        assert_eq!(loaded.presets[0].name, "Fast");
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
    fn legacy_state_without_trainer_or_presets_loads() {
        let p = tmp_path("legacy");
        let legacy = r#"{
            "bpm": 120,
            "numerator": 4,
            "denominator": 4,
            "subdivision": 1,
            "sound": "click",
            "click_volume": 0.7,
            "accent_volume": 0.9,
            "track_volume": 0.8,
            "beat_accents": [true, false, false, false]
        }"#;
        std::fs::write(&p, legacy).unwrap();
        let loaded = MetronomeState::load(&p);
        assert_eq!(loaded.bpm, 120);
        assert_eq!(loaded.trainer, TrainerConfig::default());
        assert!(loaded.presets.is_empty());
        std::fs::remove_file(&p).ok();
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

    #[test]
    fn normalize_clamps_trainer_ranges() {
        let mut s = MetronomeState::default();
        s.trainer = TrainerConfig {
            enabled: true,
            step_bpm: 500,
            every_bars: 0,
            target_bpm: 5,
        };
        s.normalize();
        assert_eq!(s.trainer.step_bpm, 50);
        assert_eq!(s.trainer.every_bars, 1);
        assert_eq!(s.trainer.target_bpm, 40);
    }

    #[test]
    fn normalize_drops_malformed_presets() {
        let mut s = MetronomeState::default();
        s.presets = vec![
            Preset {
                id: "".into(),
                name: "No id".into(),
                bpm: 120,
                numerator: 4,
                denominator: 4,
                subdivision: 1,
                sound: "click".into(),
                beat_accents: vec![true, false, false, false],
            },
            Preset {
                id: "ok".into(),
                name: "Valid".into(),
                bpm: 120,
                numerator: 4,
                denominator: 4,
                subdivision: 1,
                sound: "click".into(),
                beat_accents: vec![true, false, false, false],
            },
            Preset {
                id: "bad".into(),
                name: "Accent len mismatch".into(),
                bpm: 120,
                numerator: 4,
                denominator: 4,
                subdivision: 1,
                sound: "click".into(),
                beat_accents: vec![true],
            },
        ];
        s.normalize();
        assert_eq!(s.presets.len(), 1);
        assert_eq!(s.presets[0].id, "ok");
    }
}
