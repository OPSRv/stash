use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Fixed voice order — the frontend grid renders rows in this order.
pub const VOICES: [&str; 8] = ["kick", "snare", "chh", "ohh", "clap", "tom", "rim", "crash"];

/// Supported meters. Steps per bar: 16 for 4/4 (sixteenths), 12 for 3/4
/// (sixteenths), 6/8 (sixteenths) and 12/8 (triplet-eighth grid).
pub const METERS: [&str; 4] = ["4/4", "3/4", "6/8", "12/8"];

/// Drum kits (sample sets): recorded jazz/studio, big recorded rock, synthesized
/// analog drum machine.
pub const KITS: [&str; 3] = ["acoustic", "rock", "electronic"];

/// Built-in pattern ids (genre variations; variation 1 keeps the bare genre
/// id). The frontend owns the actual patterns (`src/modules/drums/lib/presets.ts`);
/// Rust only validates ids and lists them in the agent tool description.
pub const PRESET_IDS: [&str; 39] = [
    "rock", "rock-2", "rock-3", "rock-4", "pop", "pop-2", "pop-3", "funk", "funk-2", "funk-3",
    "disco", "disco-2", "disco-3", "shuffle", "shuffle-2", "shuffle-3", "jazz", "halftime",
    "halftime-2", "halftime-3", "metal", "metal-2", "metal-3", "metal-4", "punk", "punk-2",
    "reggae", "reggae-2", "reggae-3", "bossa", "bossa-2", "bossa-3", "hiphop", "hiphop-2",
    "hiphop-3", "waltz", "waltz-2", "ballad68", "ballad68-2",
];

/// Allowed export lengths, in bars.
pub const EXPORT_BARS: [u8; 5] = [1, 2, 4, 8, 16];

pub const EXPORT_FORMATS: [&str; 2] = ["wav", "mp3"];

pub const BPM_MIN: u32 = 40;
pub const BPM_MAX: u32 = 240;
pub const SWING_MAX: f32 = 0.6;

pub fn steps_per_bar(meter: &str) -> usize {
    match meter {
        "3/4" | "6/8" | "12/8" => 12,
        _ => 16,
    }
}

pub fn is_voice(v: &str) -> bool {
    VOICES.contains(&v)
}

pub fn is_preset(id: &str) -> bool {
    PRESET_IDS.contains(&id)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct VoiceMix {
    pub volume: f32,
    pub muted: bool,
}

impl Default for VoiceMix {
    fn default() -> Self {
        Self {
            volume: 0.8,
            muted: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DrumsState {
    pub bpm: u32,
    pub meter: String,
    pub kit: String,
    pub bars: u8,
    /// Swing amount as a fraction, 0.0..=0.6.
    pub swing: f32,
    /// Voice -> per-step value: 0 off, 1 hit, 2 accent.
    pub steps: BTreeMap<String, Vec<u8>>,
    pub mix: BTreeMap<String, VoiceMix>,
    pub master_volume: f32,
    pub preset_id: Option<String>,
    pub export_bars: u8,
    pub export_format: String,
}

/// Basic rock beat in 4/4: kick on 1 & 3, snare on 2 & 4, closed hat on eighths.
fn default_steps() -> BTreeMap<String, Vec<u8>> {
    VOICES
        .iter()
        .map(|&v| {
            let row: Vec<u8> = (0..16)
                .map(|i| {
                    let hit = match v {
                        "kick" => i == 0 || i == 8,
                        "snare" => i == 4 || i == 12,
                        "chh" => i % 2 == 0,
                        _ => false,
                    };
                    u8::from(hit)
                })
                .collect();
            (v.to_string(), row)
        })
        .collect()
}

impl Default for DrumsState {
    fn default() -> Self {
        Self {
            bpm: 100,
            meter: "4/4".into(),
            kit: "acoustic".into(),
            bars: 1,
            swing: 0.0,
            steps: default_steps(),
            mix: VOICES
                .iter()
                .map(|&v| (v.to_string(), VoiceMix::default()))
                .collect(),
            master_volume: 0.8,
            preset_id: Some("rock".into()),
            export_bars: 4,
            export_format: "wav".into(),
        }
    }
}

/// Clamp a unit-range float, mapping NaN/inf to `fallback`.
fn clamp_unit(v: f32, max: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, max)
    } else {
        fallback
    }
}

/// Nearest allowed export length; ties resolve to the shorter one.
pub fn snap_export_bars(n: u8) -> u8 {
    EXPORT_BARS
        .iter()
        .copied()
        .min_by_key(|&b| (b as i16 - n as i16).abs())
        .unwrap_or(4)
}

impl DrumsState {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<DrumsState>(&s).ok())
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

    /// Clamp every field into its valid range and reshape `steps` so each
    /// voice row has exactly `bars * steps_per_bar(meter)` cells.
    pub fn normalize(&mut self) {
        self.bpm = self.bpm.clamp(BPM_MIN, BPM_MAX);
        if !METERS.contains(&self.meter.as_str()) {
            self.meter = "4/4".into();
        }
        if !KITS.contains(&self.kit.as_str()) {
            self.kit = "acoustic".into();
        }
        if !matches!(self.bars, 1 | 2) {
            self.bars = 1;
        }
        self.swing = clamp_unit(self.swing, SWING_MAX, 0.0);
        self.master_volume = clamp_unit(self.master_volume, 1.0, 0.8);

        let len = self.bars as usize * steps_per_bar(&self.meter);
        self.steps.retain(|k, _| is_voice(k));
        for v in VOICES {
            let row = self.steps.entry(v.to_string()).or_default();
            row.resize(len, 0);
            for cell in row.iter_mut() {
                *cell = (*cell).min(2);
            }
        }

        self.mix.retain(|k, _| is_voice(k));
        for v in VOICES {
            let m = self.mix.entry(v.to_string()).or_default();
            m.volume = clamp_unit(m.volume, 1.0, 0.8);
        }

        if self.preset_id.as_deref().is_some_and(|id| !is_preset(id)) {
            self.preset_id = None;
        }
        self.export_bars = snap_export_bars(self.export_bars);
        if !EXPORT_FORMATS.contains(&self.export_format.as_str()) {
            self.export_format = "wav".into();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("stash-drums-{}-{name}.json", std::process::id()))
    }

    #[test]
    fn defaults_are_normalized_rock_beat() {
        let s = DrumsState::default();
        let mut n = s.clone();
        n.normalize();
        assert_eq!(s, n, "default state must already be normalized");
        assert_eq!(s.steps["kick"][0], 1);
        assert_eq!(s.steps["kick"][8], 1);
        assert_eq!(s.steps["snare"][4], 1);
        assert_eq!(s.steps["snare"][12], 1);
        assert_eq!(s.steps["chh"].iter().filter(|&&c| c == 1).count(), 8);
        assert_eq!(s.steps.len(), 8);
        assert_eq!(s.mix.len(), 8);
    }

    #[test]
    fn normalize_pads_when_bars_grow_and_truncates_on_meter_change() {
        let mut s = DrumsState::default();
        s.bars = 2;
        s.normalize();
        assert_eq!(s.steps["kick"].len(), 32);
        assert_eq!(s.steps["kick"][0], 1);
        assert!(s.steps["kick"][16..].iter().all(|&c| c == 0));

        s.meter = "6/8".into();
        s.bars = 1;
        s.normalize();
        assert_eq!(s.steps["kick"].len(), 12);
        assert_eq!(s.steps["snare"][4], 1, "prefix preserved");

        s.meter = "12/8".into();
        s.bars = 2;
        s.normalize();
        assert_eq!(s.meter, "12/8");
        assert_eq!(s.steps["kick"].len(), 24);
    }

    #[test]
    fn normalize_clamps_and_drops_unknown() {
        let mut s = DrumsState::default();
        s.bpm = 999;
        s.meter = "7/8".into();
        s.kit = "marimba".into();
        s.bars = 5;
        s.swing = 0.9;
        s.master_volume = f32::NAN;
        s.steps.insert("cowbell".into(), vec![1; 16]);
        s.steps.insert("kick".into(), vec![7, 2, 1]);
        s.steps.remove("rim");
        s.mix.insert("cowbell".into(), VoiceMix::default());
        s.mix.insert(
            "snare".into(),
            VoiceMix {
                volume: 3.0,
                muted: true,
            },
        );
        s.mix.remove("tom");
        s.preset_id = Some("polka".into());
        s.export_bars = 3;
        s.export_format = "flac".into();
        s.normalize();
        assert_eq!(s.bpm, 240);
        assert_eq!(s.meter, "4/4");
        assert_eq!(s.kit, "acoustic");
        assert_eq!(s.bars, 1);
        assert!((s.swing - 0.6).abs() < 1e-6);
        assert!((s.master_volume - 0.8).abs() < 1e-6);
        assert!(!s.steps.contains_key("cowbell"));
        assert!(!s.mix.contains_key("cowbell"));
        assert_eq!(&s.steps["kick"][..3], &[2, 2, 1]);
        assert_eq!(s.steps["kick"].len(), 16);
        assert_eq!(s.steps["rim"], vec![0; 16]);
        assert_eq!(s.mix["snare"].volume, 1.0);
        assert!(s.mix["snare"].muted);
        assert_eq!(s.mix["tom"], VoiceMix::default());
        assert_eq!(s.preset_id, None);
        assert_eq!(s.export_bars, 2);
        assert_eq!(s.export_format, "wav");
        let mut low = DrumsState {
            bpm: 1,
            ..Default::default()
        };
        low.normalize();
        assert_eq!(low.bpm, 40);
    }

    #[test]
    fn snap_export_bars_picks_nearest() {
        assert_eq!(snap_export_bars(0), 1);
        assert_eq!(snap_export_bars(5), 4);
        assert_eq!(snap_export_bars(7), 8);
        assert_eq!(snap_export_bars(12), 8);
        assert_eq!(snap_export_bars(200), 16);
    }

    #[test]
    fn partial_json_loads_with_defaults() {
        let p = tmp_path("partial");
        std::fs::write(&p, r#"{"bpm": 130, "meter": "3/4", "mix": {"kick": {"muted": true}}}"#)
            .unwrap();
        let s = DrumsState::load(&p);
        assert_eq!(s.bpm, 130);
        assert_eq!(s.meter, "3/4");
        assert_eq!(s.kit, "acoustic", "missing kit defaults to acoustic");
        assert_eq!(s.steps["kick"].len(), 12);
        assert!(s.mix["kick"].muted);
        assert!((s.mix["kick"].volume - 0.8).abs() < 1e-6);
        assert_eq!(s.export_bars, 4);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn round_trip_to_disk() {
        let p = tmp_path("rt");
        let mut s = DrumsState {
            bpm: 92,
            swing: 0.25,
            preset_id: Some("funk".into()),
            export_format: "mp3".into(),
            ..Default::default()
        };
        s.steps.get_mut("clap").unwrap()[3] = 2;
        s.save(&p).unwrap();
        assert_eq!(DrumsState::load(&p), s);
        std::fs::remove_file(&p).ok();
    }
}
