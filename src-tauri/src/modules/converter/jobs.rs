//! Job records — what the UI sees in its queue / completed list, and
//! what the LLM tool returns over Telegram.
//!
//! State machine: `Queued` → `Running` → `Completed` | `Failed` |
//! `Cancelled`. Jobs do not move backwards; a completed entry stays in
//! the list until the user clears it or the converter tab is destroyed.

use serde::{Deserialize, Serialize};

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
pub enum JobKind {
    /// ffmpeg-driven re-encode using a preset.
    Convert,
    /// whisper-driven transcript written next to the input.
    Transcribe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConverterJob {
    pub id: String,
    pub input_path: String,
    /// Resolved on enqueue. For convert jobs this is the ffmpeg target;
    /// for transcribe jobs this is the .txt path. Stored so the UI can
    /// "Reveal in Finder" without having to recompute the destination.
    pub output_path: String,
    pub kind: JobKind,
    /// Empty for transcribe jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    pub status: JobStatus,
    /// 0.0–1.0. Best-effort: ffmpeg's `time=` divided by the source
    /// duration. Falls back to 0.0 when ffprobe couldn't read the
    /// duration up front.
    pub progress: f32,
    /// Total decoded duration in seconds, as reported by ffprobe.
    /// Mirrors what the UI uses to render the progress bar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Build the output path for a convert job. Same directory the user
/// picked (or the default), filename = input stem + `.ext`. If the
/// candidate collides with an existing file we suffix `-1`, `-2`, …
/// until we find a free slot — overwriting a file the user dropped
/// onto the converter is a one-way trip we'd rather not make on their
/// behalf.
pub fn unique_output_path(out_dir: &std::path::Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let mut candidate = out_dir.join(format!("{stem}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    for i in 1..1000 {
        candidate = out_dir.join(format!("{stem}-{i}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Pathological: thousand collisions in a row. Stamp with a unix
    // timestamp and move on — better than spinning forever.
    out_dir.join(format!("{stem}-{}.{ext}", now_unix()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn unique_output_path_returns_basic_when_free() {
        let tmp = TempDir::new().unwrap();
        let p = unique_output_path(tmp.path(), "song", "mp3");
        assert_eq!(p, tmp.path().join("song.mp3"));
    }

    #[test]
    fn unique_output_path_suffixes_on_collision() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("song.mp3"), b"").unwrap();
        let p = unique_output_path(tmp.path(), "song", "mp3");
        assert_eq!(p, tmp.path().join("song-1.mp3"));

        std::fs::write(tmp.path().join("song-1.mp3"), b"").unwrap();
        let p2 = unique_output_path(tmp.path(), "song", "mp3");
        assert_eq!(p2, tmp.path().join("song-2.mp3"));
    }
}
