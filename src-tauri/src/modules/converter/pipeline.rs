//! ffmpeg orchestration: spawn the binary with a preset's args, watch
//! its stderr for `time=` lines, translate them into 0.0–1.0 progress.
//!
//! Kept in its own module so the high-level "queue / state / commands"
//! file doesn't drown in process-handling glue. The two entry points
//! are:
//!   * `probe_duration` — one-shot ffprobe call, used by the queue to
//!     fill `ConverterJob::duration_sec` so the UI can render a real
//!     progress bar from the first tick.
//!   * `run_convert` — spawns ffmpeg, streams progress through the
//!     supplied closure, returns success / failure with stderr tail.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// Locate the ffmpeg/ffprobe directory. Same resolver the downloader
/// and the stems pipeline use — keeps the "where is ffmpeg installed?"
/// question single-sourced.
pub fn find_ffmpeg_dir(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    crate::modules::downloader::resolver::find_ffmpeg_dir(extra_dirs)
}

/// Read the source's duration in seconds via `ffprobe -show_format`.
/// Returns `None` when ffprobe isn't on disk or the file isn't
/// recognised as a media container — both legitimate cases (image
/// inputs, etc.) where we fall back to indeterminate progress.
pub fn probe_duration(ffprobe: &Path, input: &Path) -> Option<f64> {
    let output = Command::new(ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    s.trim().parse::<f64>().ok().filter(|d| *d > 0.0)
}

/// Parse a ffmpeg `time=HH:MM:SS.ss` token into a float-seconds value.
/// ffmpeg also emits `time=N/A` while it's still parsing the input;
/// we return `None` for that case rather than poisoning the progress
/// calculation with a bogus zero.
pub fn parse_ffmpeg_time(token: &str) -> Option<f64> {
    let t = token.strip_prefix("time=").unwrap_or(token);
    if t.starts_with("N/A") {
        return None;
    }
    let mut parts = t.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Walk a stderr line that may look like
/// `frame=  223 fps= 49 q=24.0 size=…  time=00:00:09.32 …`
/// and pull out the `time=` token. Returns the parsed seconds if any.
pub fn extract_progress_seconds(line: &str) -> Option<f64> {
    line.split_ascii_whitespace()
        .find(|tok| tok.starts_with("time="))
        .and_then(parse_ffmpeg_time)
}

/// Run ffmpeg synchronously with the given input + preset args + output.
/// `on_progress` is called with a clamped 0.0–1.0 ratio every time we
/// see a parseable `time=` token. `pid_holder` is filled with the
/// child's PID for the lifetime of the spawn so the caller's cancel
/// command can deliver SIGTERM without races.
pub fn run_convert(
    ffmpeg: &Path,
    input: &Path,
    preset_args: &[&str],
    output: &Path,
    duration_sec: Option<f64>,
    pid_holder: Arc<Mutex<Option<u32>>>,
    on_progress: impl Fn(f32) + Send + 'static,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel").arg("error")
        .arg("-stats")
        .arg("-i").arg(input);
    for a in preset_args {
        cmd.arg(a);
    }
    cmd.arg(output);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    let pid = child.id();
    *pid_holder.lock().unwrap() = Some(pid);

    // Read stderr in this thread so we don't have to juggle a separate
    // reader thread — `run_convert` is itself called from a worker
    // thread spawned by `pump_queue`, blocking it on stderr is fine.
    let mut stderr_tail: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        // ffmpeg writes progress on the *same* line, terminated with
        // \r. `lines()` only splits on \n, so we hand-roll the read
        // using `read_until('\r' or '\n')`.
        for chunk in StderrChunks::new(reader) {
            let line = chunk.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                continue;
            }
            if let (Some(d), Some(t)) = (duration_sec, extract_progress_seconds(line)) {
                if d > 0.0 {
                    let ratio = (t / d).clamp(0.0, 0.999) as f32;
                    on_progress(ratio);
                }
            }
            // Keep the last 30 lines for the error message in case
            // the process bombs — ffmpeg's actually useful diagnostics
            // tend to be the final few lines.
            if stderr_tail.len() >= 30 {
                stderr_tail.remove(0);
            }
            stderr_tail.push(line.to_string());
        }
    }

    let status = child.wait().map_err(|e| format!("ffmpeg wait: {e}"))?;
    *pid_holder.lock().unwrap() = None;

    if status.success() {
        on_progress(1.0);
        Ok(())
    } else {
        let tail = stderr_tail.join("\n");
        Err(if tail.is_empty() {
            format!("ffmpeg exited with status {status}")
        } else {
            format!("ffmpeg exited with status {status}\n{tail}")
        })
    }
}

/// Iterator that splits a reader on either '\n' or '\r' — ffmpeg
/// rewrites the same progress line by emitting it terminated with
/// '\r', so the standard `lines()` would buffer hundreds of progress
/// updates into one giant string before flushing.
struct StderrChunks<R: BufRead> {
    inner: R,
    buf: Vec<u8>,
}
impl<R: BufRead> StderrChunks<R> {
    fn new(inner: R) -> Self {
        Self { inner, buf: Vec::with_capacity(256) }
    }
}
impl<R: BufRead> Iterator for StderrChunks<R> {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        self.buf.clear();
        loop {
            let available = match self.inner.fill_buf() {
                Ok(b) if b.is_empty() => {
                    if self.buf.is_empty() {
                        return None;
                    }
                    let out = String::from_utf8_lossy(&self.buf).into_owned();
                    self.buf.clear();
                    return Some(out);
                }
                Ok(b) => b,
                Err(_) => return None,
            };
            // Take everything up to (and including) the first \r or \n.
            let mut consumed = 0;
            let mut hit = false;
            for (i, &b) in available.iter().enumerate() {
                consumed = i + 1;
                if b == b'\r' || b == b'\n' {
                    hit = true;
                    self.buf.push(b);
                    break;
                }
                self.buf.push(b);
            }
            self.inner.consume(consumed);
            if hit {
                let out = String::from_utf8_lossy(&self.buf).into_owned();
                return Some(out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ffmpeg_time_handles_hh_mm_ss_ss() {
        assert_eq!(parse_ffmpeg_time("time=00:00:00.00"), Some(0.0));
        let v = parse_ffmpeg_time("time=00:01:30.50").unwrap();
        assert!((v - 90.5).abs() < 1e-9);
        let v2 = parse_ffmpeg_time("time=01:02:03.04").unwrap();
        assert!((v2 - 3723.04).abs() < 1e-6);
    }

    #[test]
    fn parse_ffmpeg_time_returns_none_for_na() {
        assert!(parse_ffmpeg_time("time=N/A").is_none());
    }

    #[test]
    fn parse_ffmpeg_time_returns_none_for_garbage() {
        assert!(parse_ffmpeg_time("time=").is_none());
        assert!(parse_ffmpeg_time("not even close").is_none());
        assert!(parse_ffmpeg_time("time=00:00").is_none());
    }

    #[test]
    fn extract_progress_seconds_finds_token_inside_a_status_line() {
        let line = "frame=  223 fps= 49 q=24.0 size=  512kB time=00:00:09.32 bitrate=448.0kbits/s";
        let v = extract_progress_seconds(line).unwrap();
        assert!((v - 9.32).abs() < 1e-6);
    }

    #[test]
    fn extract_progress_seconds_returns_none_when_missing() {
        assert!(extract_progress_seconds("frame= 5 fps=2.5").is_none());
        assert!(extract_progress_seconds("").is_none());
    }
}
