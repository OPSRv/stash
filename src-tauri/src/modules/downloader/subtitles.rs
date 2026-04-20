//! Subtitle extraction for a previously-downloaded job.
//!
//! `yt-dlp` happily writes just the subtitle track when called with
//! `--skip-download --write-subs --write-auto-subs`. We point it at a scratch
//! directory, collect whatever `.vtt` files it produced, and convert them to
//! plain text suitable for pasting into a note.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// Run yt-dlp to fetch subtitle files for `url` into `scratch`, preferring the
/// given language codes. Returns the list of `.vtt` files that landed on disk.
pub fn fetch_vtt_files(
    yt_dlp: &Path,
    url: &str,
    scratch: &Path,
    langs: &[String],
    cookies_browser: Option<&str>,
) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(scratch).map_err(|e| format!("create scratch: {e}"))?;
    let lang_list = if langs.is_empty() {
        "en.*,uk.*".to_string()
    } else {
        langs.join(",")
    };
    let output_template = scratch
        .join("%(id)s.%(ext)s")
        .to_string_lossy()
        .to_string();

    let mut cmd = Command::new(yt_dlp);
    cmd.args([
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-format",
        "vtt",
        "--sub-langs",
        &lang_list,
        "--no-warnings",
        "--no-playlist",
        "-o",
        &output_template,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    if let Some(browser) = cookies_browser {
        if let Some(file) = browser.strip_prefix("file:") {
            cmd.args(["--cookies", file]);
        } else {
            cmd.args(["--cookies-from-browser", browser]);
        }
    }
    cmd.arg(url);

    let mut child = cmd.spawn().map_err(|e| format!("spawn yt-dlp: {e}"))?;
    // Drain stdout/stderr so the pipes don't stall. We don't inspect the
    // output line-by-line — exit status and on-disk files are the real truth.
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for _ in BufReader::new(out).lines().map_while(Result::ok) {}
        });
    }
    let stderr_lines: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    if let Some(err) = child.stderr.take() {
        let sink = std::sync::Arc::clone(&stderr_lines);
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut buf = sink.lock().unwrap();
                if buf.len() < 32 {
                    buf.push(line);
                }
            }
        });
    }
    let status = child.wait().map_err(|e| format!("wait yt-dlp: {e}"))?;
    if !status.success() {
        let tail = stderr_lines.lock().unwrap().join("\n");
        return Err(if tail.is_empty() {
            "yt-dlp exited with a non-zero status".into()
        } else {
            tail
        });
    }

    let mut out = Vec::new();
    let entries = std::fs::read_dir(scratch).map_err(|e| format!("read scratch: {e}"))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("vtt") {
            out.push(p);
        }
    }
    Ok(out)
}

/// A fresh scratch path under `base_dir` — nanosecond suffix so parallel
/// extractions don't collide, even when called back-to-back.
pub fn new_scratch(base_dir: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    base_dir.join(format!("subs-{nanos}"))
}

/// Convert a single WebVTT document to plain text. Drops timing cues, cue
/// identifiers, HTML/SSA tags, and collapses runs of duplicate lines (YouTube
/// auto-subs like to re-emit the same phrase as each word appears).
pub fn vtt_to_plain_text(vtt: &str) -> String {
    let mut out: Vec<String> = Vec::with_capacity(128);
    let mut last: Option<String> = None;
    for raw in vtt.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line == "WEBVTT" || line.starts_with("NOTE") {
            continue;
        }
        // Timing cues carry `-->` and optionally layout settings. Skip both
        // the timing line itself and the numeric/identifier-only line that
        // may precede it.
        if line.contains("-->") {
            if matches!(last.as_deref(), Some(prev) if is_cue_identifier(prev)) {
                out.pop();
                last = out.last().cloned();
            }
            continue;
        }
        // Strip inline tags (<c.colorXXX>, <00:00:01.000>, <b>, <i>, ...).
        let stripped = strip_tags(line);
        let stripped = stripped.trim();
        if stripped.is_empty() {
            continue;
        }
        if last.as_deref() == Some(stripped) {
            continue;
        }
        out.push(stripped.to_string());
        last = Some(stripped.to_string());
    }
    out.join("\n")
}

fn is_cue_identifier(line: &str) -> bool {
    !line.is_empty()
        && line
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == '.' || c == '_')
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
            continue;
        }
        if c == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vtt_to_plain_text_strips_cues_and_tags() {
        let vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Speaker>Hello <c.yellow>world</c>\n\n2\n00:00:04.000 --> 00:00:06.000\nHow are you?";
        let txt = vtt_to_plain_text(vtt);
        assert_eq!(txt, "Hello world\nHow are you?");
    }

    #[test]
    fn vtt_to_plain_text_collapses_duplicate_lines() {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n\n00:00:02.000 --> 00:00:03.000\nhello\n\n00:00:03.000 --> 00:00:04.000\nworld";
        assert_eq!(vtt_to_plain_text(vtt), "hello\nworld");
    }

    #[test]
    fn vtt_to_plain_text_ignores_note_and_empty_sections() {
        let vtt = "WEBVTT\n\nNOTE this is a comment\n\n00:00:01.000 --> 00:00:02.000\nok";
        assert_eq!(vtt_to_plain_text(vtt), "ok");
    }

    #[test]
    fn is_cue_identifier_matches_numeric_ids() {
        assert!(is_cue_identifier("1"));
        assert!(is_cue_identifier("42"));
        assert!(!is_cue_identifier("hello"));
        assert!(!is_cue_identifier(""));
    }
}
