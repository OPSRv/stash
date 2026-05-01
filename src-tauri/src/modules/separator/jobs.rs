//! Job records — what the UI sees in its queue / completed list, and
//! what the LLM tool returns over Telegram. Pure data + tiny helpers,
//! no spawn / IO logic (lives in `commands.rs`).
//!
//! State machine: `Queued` → `Running` → `Completed` | `Failed` |
//! `Cancelled`. Jobs do not move backwards; a completed entry stays in
//! the list until the user clears it.

use serde::{Deserialize, Serialize};

use super::pipeline::SeparatorAnalysis;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobMode {
    Analyze,
    Separate,
    Bpm,
}

impl JobMode {
    /// Value passed to the sidecar via `--mode <…>`.
    pub fn as_arg(&self) -> &'static str {
        match self {
            JobMode::Analyze => "analyze",
            JobMode::Separate => "separate",
            JobMode::Bpm => "bpm",
        }
    }

    /// Lenient mapper used by the Tauri command + the Telegram tool:
    /// we accept a few synonyms because the LLM and the Settings UI
    /// don't necessarily speak the canonical name. Unknown values fall
    /// back to `Analyze` (the most useful default — both stems + BPM
    /// in one decode pass).
    pub fn from_str_lossy(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "separate" | "stems" | "split" => JobMode::Separate,
            "bpm" | "tempo" | "beats" => JobMode::Bpm,
            _ => JobMode::Analyze,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeparatorJob {
    pub id: String,
    pub input_path: String,
    pub model: String,
    pub mode: JobMode,
    /// Subset of stems to keep, or `None` for "all". The sidecar always
    /// produces the full set; this just trims what we write to disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stems: Option<Vec<String>>,
    pub output_dir: String,
    pub status: JobStatus,
    pub progress: f32,
    pub phase: String,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<SeparatorAnalysis>,
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Stem of the input filename, sanitised for use as a directory name
/// under the user's output dir. Strips parent path and extension; falls
/// back to `"track"` when the input has no usable stem.
pub fn source_dir_name(input_path: &str) -> String {
    use std::path::Path;
    Path::new(input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "track".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_from_str_lossy_accepts_common_synonyms() {
        assert_eq!(JobMode::from_str_lossy("analyze"), JobMode::Analyze);
        assert_eq!(JobMode::from_str_lossy("ANALYZE"), JobMode::Analyze);
        assert_eq!(JobMode::from_str_lossy("separate"), JobMode::Separate);
        assert_eq!(JobMode::from_str_lossy("stems"), JobMode::Separate);
        assert_eq!(JobMode::from_str_lossy("split"), JobMode::Separate);
        assert_eq!(JobMode::from_str_lossy("bpm"), JobMode::Bpm);
        assert_eq!(JobMode::from_str_lossy("tempo"), JobMode::Bpm);
        assert_eq!(JobMode::from_str_lossy("beats"), JobMode::Bpm);
        // Unknown → Analyze (most useful default).
        assert_eq!(JobMode::from_str_lossy("???"), JobMode::Analyze);
    }

    #[test]
    fn source_dir_name_handles_paths_and_extensions() {
        assert_eq!(source_dir_name("/Users/u/Music/Song.mp3"), "Song");
        assert_eq!(source_dir_name("song.flac"), "song");
        assert_eq!(source_dir_name("track.no.ext"), "track.no");
        assert_eq!(source_dir_name(""), "track");
        // Trailing slash: Path::file_stem returns the last component
        // ("dir"), which is the right behaviour — falling back to
        // "track" only when there's truly nothing to use.
        assert_eq!(source_dir_name("/path/to/dir/"), "dir");
    }
}
