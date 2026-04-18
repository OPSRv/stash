use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub webpage_url: Option<String>,
    #[serde(default)]
    pub formats: Vec<Format>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Format {
    pub format_id: String,
    pub ext: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub tbr: Option<f64>,
    pub format_note: Option<String>,
}

impl Format {
    pub fn is_video(&self) -> bool {
        self.vcodec.as_deref().is_some_and(|v| v != "none") && self.height.is_some()
    }
    pub fn is_audio_only(&self) -> bool {
        (self.vcodec.as_deref() == Some("none") || self.vcodec.is_none())
            && self.acodec.as_deref().is_some_and(|a| a != "none")
    }
    pub fn best_size(&self) -> Option<u64> {
        self.filesize.or(self.filesize_approx)
    }
}

pub fn parse_info(json: &str) -> serde_json::Result<VideoInfo> {
    serde_json::from_str(json)
}

/// Pick one format per common resolution tier + one best audio-only.
/// Returns a pretty label + format_id for UI display.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QualityOption {
    pub label: String,
    pub format_id: String,
    pub kind: &'static str, // "video" | "audio"
    pub height: Option<u32>,
    pub est_size: Option<u64>,
}

pub fn pick_quality_options(info: &VideoInfo) -> Vec<QualityOption> {
    let tiers = [2160u32, 1440, 1080, 720, 480, 360];
    let mut out: Vec<QualityOption> = Vec::new();
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let videos: Vec<&Format> = info.formats.iter().filter(|f| f.is_video()).collect();
    for tier in tiers {
        // pick best video format with height <= tier that matches this tier best
        let best = videos
            .iter()
            .filter(|f| f.height == Some(tier))
            .max_by_key(|f| f.tbr.unwrap_or(0.0) as u64);
        if let Some(f) = best {
            if seen.insert(tier) {
                out.push(QualityOption {
                    label: format!("{}p", tier),
                    format_id: f.format_id.clone(),
                    kind: "video",
                    height: Some(tier),
                    est_size: f.best_size(),
                });
            }
        }
    }
    // Fallback: if no tiered match, take the single best video
    if out.is_empty() {
        if let Some(f) = videos.iter().max_by_key(|f| f.height.unwrap_or(0)) {
            out.push(QualityOption {
                label: f
                    .height
                    .map(|h| format!("{}p", h))
                    .unwrap_or_else(|| "Video".into()),
                format_id: f.format_id.clone(),
                kind: "video",
                height: f.height,
                est_size: f.best_size(),
            });
        }
    }
    // Best audio-only
    let best_audio = info
        .formats
        .iter()
        .filter(|f| f.is_audio_only())
        .max_by_key(|f| f.tbr.unwrap_or(0.0) as u64);
    if let Some(f) = best_audio {
        out.push(QualityOption {
            label: "Audio".into(),
            format_id: f.format_id.clone(),
            kind: "audio",
            height: None,
            est_size: f.best_size(),
        });
    }
    out
}

pub fn fetch_info(yt_dlp: &Path, url: &str) -> Result<VideoInfo, String> {
    let output = Command::new(yt_dlp)
        .args(["--dump-json", "--no-playlist", "--no-warnings"])
        .arg(url)
        .output()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp failed: {stderr}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_info(stdout.trim()).map_err(|e| format!("parse json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> &'static str {
        r#"{
            "id": "abc123",
            "title": "Hello World",
            "uploader": "someone",
            "thumbnail": "https://i.example/thumb.jpg",
            "duration": 125.4,
            "webpage_url": "https://example.com/v/abc123",
            "formats": [
                {"format_id": "140", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "tbr": 128.0, "filesize": 2000000},
                {"format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus", "tbr": 160.0, "filesize": 2500000},
                {"format_id": "137", "ext": "mp4", "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "width": 1920, "tbr": 4500.0, "filesize": 50000000},
                {"format_id": "136", "ext": "mp4", "vcodec": "avc1.64001f", "acodec": "none", "height": 720, "width": 1280, "tbr": 2500.0, "filesize": 25000000},
                {"format_id": "135", "ext": "mp4", "vcodec": "avc1.4d401e", "acodec": "none", "height": 480, "width": 854, "tbr": 1100.0, "filesize": 12000000}
            ]
        }"#
    }

    #[test]
    fn parse_info_reads_title_and_formats() {
        let info = parse_info(fixture()).unwrap();
        assert_eq!(info.title, "Hello World");
        assert_eq!(info.formats.len(), 5);
    }

    #[test]
    fn pick_quality_returns_video_tiers_and_audio() {
        let info = parse_info(fixture()).unwrap();
        let options = pick_quality_options(&info);
        let labels: Vec<&str> = options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, vec!["1080p", "720p", "480p", "Audio"]);
        assert_eq!(options.last().unwrap().kind, "audio");
    }

    #[test]
    fn pick_quality_picks_best_audio_by_bitrate() {
        let info = parse_info(fixture()).unwrap();
        let options = pick_quality_options(&info);
        let audio = options.iter().find(|o| o.kind == "audio").unwrap();
        // opus 160 should win over m4a 128
        assert_eq!(audio.format_id, "251");
    }

    #[test]
    fn parse_info_survives_missing_optional_fields() {
        let json = r#"{"id":"x","title":"y"}"#;
        let info = parse_info(json).unwrap();
        assert!(info.formats.is_empty());
        assert!(info.duration.is_none());
    }

    #[test]
    fn pick_quality_falls_back_to_best_video_when_no_tier_matches() {
        let json = r#"{
            "id": "x", "title": "y",
            "formats": [
                {"format_id": "99", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "height": 240, "tbr": 400.0}
            ]
        }"#;
        let info = parse_info(json).unwrap();
        let options = pick_quality_options(&info);
        let video = options.iter().find(|o| o.kind == "video").unwrap();
        assert_eq!(video.label, "240p");
    }
}
