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

/// Lightweight metadata from an oEmbed provider. Renders instantly so the UI
/// can show a preview card while the full `fetch_info` round-trip is still in
/// flight.
#[derive(Debug, Clone, Serialize)]
pub struct QuickPreview {
    pub title: String,
    pub uploader: Option<String>,
    pub thumbnail: Option<String>,
}

/// Best-effort oEmbed fetch. Supports the handful of providers that expose a
/// public endpoint without auth: YouTube, Vimeo. Returns None for everything
/// else so callers fall back to yt-dlp.
pub fn fetch_oembed(url: &str) -> Option<QuickPreview> {
    let endpoint = oembed_endpoint(url)?;
    let out = Command::new("curl")
        .args(["-sSL", "--max-time", "4"])
        .arg(&endpoint)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let body = String::from_utf8(out.stdout).ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(QuickPreview {
        title: v
            .get("title")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        uploader: v
            .get("author_name")
            .and_then(|s| s.as_str())
            .map(str::to_string),
        thumbnail: v
            .get("thumbnail_url")
            .and_then(|s| s.as_str())
            .map(str::to_string),
    })
}

fn oembed_endpoint(url: &str) -> Option<String> {
    let encoded = url_encode(url);
    let host = url_host_lower(url)?;
    if host.ends_with("youtube.com") || host.ends_with("youtu.be") {
        Some(format!(
            "https://www.youtube.com/oembed?url={encoded}&format=json"
        ))
    } else if host.ends_with("vimeo.com") {
        Some(format!("https://vimeo.com/api/oembed.json?url={encoded}"))
    } else {
        None
    }
}

fn url_host_lower(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    let host_and_rest = after_scheme.split('/').next()?;
    Some(host_and_rest.trim_start_matches("www.").to_lowercase())
}

fn url_encode(s: &str) -> String {
    // Minimal percent-encoding — good enough for URLs we already trust.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn fetch_info(
    yt_dlp: &Path,
    url: &str,
    cookies_browser: Option<&str>,
) -> Result<VideoInfo, String> {
    let result = run_dump_json(yt_dlp, url, cookies_browser);
    // Stale browser cookies make YouTube serve a degraded response (often
    // only storyboards), which yt-dlp reports as "Requested format is not
    // available". Retry once without cookies so public videos still work.
    if let Err(stderr) = &result {
        if cookies_browser.is_some() && is_cookies_format_failure(stderr) {
            return run_dump_json(yt_dlp, url, None).map_err(|e| friendly_error(&e));
        }
    }
    result.map_err(|e| friendly_error(&e))
}

/// Single attempt at `yt-dlp --dump-json`. Returns raw stderr on failure so
/// the caller can decide whether to retry without cookies before wrapping the
/// error in a user-friendly message.
fn run_dump_json(
    yt_dlp: &Path,
    url: &str,
    cookies_browser: Option<&str>,
) -> Result<VideoInfo, String> {
    let mut cmd = Command::new(yt_dlp);
    cmd.args([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        // 10 s per request — without this a stalled YouTube endpoint can hang
        // the detect for the full TCP timeout (~75 s) per player_client.
        "--socket-timeout",
        "10",
        // Cap yt-dlp's own retry loop so a flaky endpoint can't turn a single
        // detect into minutes of dead wait.
        "--extractor-retries",
        "1",
    ]);
    if url.contains("youtube.com") || url.contains("youtu.be") {
        // Single client: `default` (web) currently returns the full adaptive
        // format ladder (144p–1080p+) in ~20 s. Older combos like
        // `mweb,android,web_safari` now return only the combined 360p format
        // (format 18) because of YouTube's PO-token requirement — that's
        // what caused "1 quality options" in the UI. Adding more clients
        // roughly doubles detect time because yt-dlp queries each one
        // sequentially and merges the results, so stick to a single client.
        cmd.args(["--extractor-args", "youtube:player_client=default"]);
    }
    if let Some(browser) = cookies_browser {
        if let Some(file) = browser.strip_prefix("file:") {
            cmd.args(["--cookies", file]);
        } else {
            cmd.args(["--cookies-from-browser", browser]);
        }
    }
    let output = cmd
        .arg(url)
        .output()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_info(stdout.trim()).map_err(|e| format!("parse json: {e}"))
}

/// True when yt-dlp's stderr signals the "no usable formats" failure that we
/// can plausibly recover from by dropping browser cookies. Lives here so both
/// the detector and the runner share one definition.
pub fn is_cookies_format_failure(stderr: &str) -> bool {
    stderr
        .to_lowercase()
        .contains("requested format is not available")
}

/// Map yt-dlp stderr to a user-friendly message with an actionable hint.
/// Everything unknown falls through unchanged so we never hide diagnostic
/// info behind a generic string.
fn friendly_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("requested format is not available") {
        return format!(
            "Stale browser cookies — YouTube returned no downloadable formats. \
             Open Settings → Downloads → Forget cookies (or pick a different \
             browser) and try again.\n\n{stderr}"
        );
    }
    if lower.contains("sign in to confirm") || lower.contains("login required") {
        return format!(
            "This video requires authentication. Pick a browser under \
             Settings → Downloads → Auth cookies from browser.\n\n{stderr}"
        );
    }
    if lower.contains("no video formats found") {
        let hint = if lower.contains("[instagram]") {
            "Instagram now requires a logged-in session to download reels and \
             posts. Open Settings → Downloads → Auth cookies from browser and \
             pick the browser you're logged in to Instagram with."
        } else {
            "This host returned no downloadable formats. Try Settings → \
             Downloads → Auth cookies from browser, or run yt-dlp -U to update."
        };
        return format!("{hint}\n\n{stderr}");
    }
    format!("yt-dlp failed: {stderr}")
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
    fn url_host_lower_strips_www_and_scheme() {
        assert_eq!(
            url_host_lower("https://www.YouTube.com/watch?v=abc"),
            Some("youtube.com".into())
        );
        assert_eq!(
            url_host_lower("https://youtu.be/abc"),
            Some("youtu.be".into())
        );
        assert_eq!(url_host_lower("not a url"), None);
    }

    #[test]
    fn url_encode_preserves_unreserved_and_escapes_the_rest() {
        assert_eq!(url_encode("abc-_.~"), "abc-_.~");
        assert_eq!(url_encode("a b"), "a%20b");
        assert_eq!(url_encode("?="), "%3F%3D");
    }

    #[test]
    fn friendly_error_blames_cookies_for_format_errors() {
        let msg = friendly_error("ERROR: [youtube] abc: Requested format is not available");
        // Stale browser cookies are the dominant cause now; the wording must
        // point users to the Forget cookies button rather than yt-dlp updates.
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("cookies"),
            "msg should mention cookies: {msg}"
        );
        // Original stderr is preserved so power users still see the raw message.
        assert!(msg.contains("Requested format is not available"));
    }

    #[test]
    fn friendly_error_hints_cookies_on_auth_failures() {
        let msg = friendly_error("ERROR: Sign in to confirm you're not a bot");
        assert!(msg.to_lowercase().contains("cookies"));
    }

    #[test]
    fn friendly_error_passes_unknown_messages_through() {
        let msg = friendly_error("ERROR: Network unreachable");
        assert!(msg.contains("Network unreachable"));
    }

    #[test]
    fn friendly_error_flags_instagram_no_formats() {
        let msg = friendly_error("ERROR: [Instagram] DXUqwFBDJvI: No video formats found!");
        let lower = msg.to_lowercase();
        assert!(lower.contains("instagram"));
        assert!(lower.contains("cookies"));
        assert!(msg.contains("No video formats found"));
    }

    #[test]
    fn friendly_error_flags_generic_no_formats() {
        let msg = friendly_error("ERROR: [Foo] id: No video formats found!");
        let lower = msg.to_lowercase();
        assert!(lower.contains("cookies") || lower.contains("yt-dlp -u"));
    }

    #[test]
    fn cookies_format_failure_detects_only_format_error() {
        assert!(is_cookies_format_failure(
            "ERROR: [youtube] abc: Requested format is not available"
        ));
        assert!(is_cookies_format_failure(
            "WARNING: ...\nERROR: requested format IS NOT available."
        ));
        assert!(!is_cookies_format_failure("ERROR: HTTP 503"));
        assert!(!is_cookies_format_failure(""));
    }

    #[test]
    fn oembed_endpoint_picks_youtube_and_vimeo() {
        let yt = oembed_endpoint("https://www.youtube.com/watch?v=x").unwrap();
        assert!(yt.contains("youtube.com/oembed"));
        let vim = oembed_endpoint("https://vimeo.com/12345").unwrap();
        assert!(vim.contains("vimeo.com/api/oembed.json"));
        assert!(oembed_endpoint("https://tiktok.com/@x/video/1").is_none());
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
