use crate::modules::drums::state::DrumsState;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::InvokeBody;
use tauri::Manager;

pub struct DrumsStateHandle {
    pub path: Mutex<PathBuf>,
}

impl DrumsStateHandle {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Mutex::new(path),
        }
    }
}

/// `drums.json` in the app-data dir, falling back to the path captured at setup.
pub fn state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let fallback = app
        .try_state::<DrumsStateHandle>()
        .map(|h| h.path.lock().unwrap().clone());
    app.path()
        .app_data_dir()
        .map(|d| d.join("drums.json"))
        .ok()
        .or(fallback)
}

#[tauri::command]
pub fn drums_get_state(app: tauri::AppHandle) -> Result<DrumsState, String> {
    Ok(state_path(&app)
        .as_ref()
        .map(DrumsState::load)
        .unwrap_or_default())
}

#[tauri::command]
pub fn drums_save_state(app: tauri::AppHandle, payload: DrumsState) -> Result<(), String> {
    let path = state_path(&app).ok_or("drums: no app data dir")?;
    let mut next = payload;
    next.normalize();
    next.save(&path)
}

fn ffmpeg_dir() -> Option<PathBuf> {
    crate::modules::downloader::resolver::find_ffmpeg_dir(
        &crate::modules::converter::commands::downloader_extras(),
    )
}

#[tauri::command]
pub fn drums_ffmpeg_available() -> bool {
    ffmpeg_dir().is_some()
}

/// `~/Music/Stash/Drums`, created on demand.
pub fn default_export_dir() -> Result<PathBuf, String> {
    let music = dirs_next::audio_dir()
        .or_else(|| dirs_next::home_dir().map(|h| h.join("Music")))
        .ok_or("cannot resolve the Music folder")?;
    let dir = music.join("Stash").join("Drums");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[tauri::command]
pub fn drums_default_export_dir() -> Result<String, String> {
    default_export_dir().map(|p| p.display().to_string())
}

/// Strict percent-decoder for `encodeURIComponent` output: `%XX` → byte,
/// everything else verbatim (`+` is NOT a space). Malformed escapes or
/// non-UTF-8 results are errors — a mangled path must never be written to.
pub fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| format!("malformed percent escape at byte {i}"))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "decoded path is not valid UTF-8".to_string())
}

/// Validate the target path: absolute, has a file name, and carries the
/// format's extension (appended when missing; a conflicting audio
/// extension is rejected).
pub fn resolve_export_path(raw: &str, format: &str) -> Result<PathBuf, String> {
    if !matches!(format, "wav" | "mp3") {
        return Err(format!("unsupported export format `{format}` (wav|mp3)"));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("export path must be absolute: `{raw}`"));
    }
    if raw.ends_with('/') || path.file_name().is_none() {
        return Err(format!("export path has no file name: `{raw}`"));
    }
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase) {
        Some(ext) if ext == format => Ok(path),
        Some(ext) if ext == "wav" || ext == "mp3" => Err(format!(
            "export path extension `.{ext}` does not match format `{format}`"
        )),
        _ => {
            let mut s = path.into_os_string();
            s.push(format!(".{format}"));
            Ok(PathBuf::from(s))
        }
    }
}

fn is_wav(bytes: &[u8]) -> bool {
    bytes.len() > 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

/// Removes the temp file on every exit path.
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn tail(s: &str, max_chars: usize) -> String {
    let t = s.trim();
    let n = t.chars().count();
    if n <= max_chars {
        t.to_string()
    } else {
        t.chars().skip(n - max_chars).collect()
    }
}

fn write_export(bytes: &[u8], out: &Path, format: &str) -> Result<(), String> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    if format == "wav" {
        return std::fs::write(out, bytes).map_err(|e| format!("write {}: {e}", out.display()));
    }
    let ffmpeg = ffmpeg_dir()
        .map(|d| d.join("ffmpeg"))
        .ok_or("ffmpeg not found — install it in Settings → Downloads")?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = TempFile(std::env::temp_dir().join(format!(
        "stash-drums-{}-{nanos}.wav",
        std::process::id()
    )));
    std::fs::write(&tmp.0, bytes).map_err(|e| format!("write temp wav: {e}"))?;
    let output = Command::new(&ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&tmp.0)
        .args(["-codec:a", "libmp3lame", "-b:a", "320k"])
        .arg(out)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg mp3 encode failed: {}", tail(&stderr, 400)));
    }
    Ok(())
}

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing `{name}` header"))?
        .to_str()
        .map_err(|_| format!("`{name}` header is not ASCII"))
}

/// Raw-binary IPC: body is a complete WAV file; target path and format ride
/// in `x-drums-path` (percent-encoded) and `x-drums-format` headers.
/// Returns the final absolute path.
#[tauri::command]
pub async fn drums_export(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => {
            return Err("drums_export expects a raw WAV body, got JSON".into());
        }
    };
    if !is_wav(&bytes) {
        return Err("drums_export body is not a WAV file".into());
    }
    let format = header(&request, "x-drums-format")?.trim().to_ascii_lowercase();
    let raw_path = percent_decode(header(&request, "x-drums-path")?)?;
    let out = resolve_export_path(&raw_path, &format)?;
    let target = out.clone();
    tauri::async_runtime::spawn_blocking(move || write_export(&bytes, &target, &format))
        .await
        .map_err(|e| format!("export task failed: {e}"))??;
    Ok(out.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_escapes_and_utf8() {
        assert_eq!(
            percent_decode("%2FUsers%2Fme%2FMusic%2Fmy%20beat%2B1.wav").unwrap(),
            "/Users/me/Music/my beat+1.wav"
        );
        assert_eq!(percent_decode("caf%C3%A9").unwrap(), "café");
        assert_eq!(percent_decode("a+b").unwrap(), "a+b", "plus is literal");
        assert_eq!(percent_decode("/plain/path").unwrap(), "/plain/path");
    }

    #[test]
    fn percent_decode_rejects_malformed() {
        assert!(percent_decode("%2").is_err());
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%FF").is_err(), "invalid UTF-8");
    }

    #[test]
    fn resolve_export_path_validates_and_appends_extension() {
        assert_eq!(
            resolve_export_path("/tmp/beat.wav", "wav").unwrap(),
            PathBuf::from("/tmp/beat.wav")
        );
        assert_eq!(
            resolve_export_path("/tmp/beat.MP3", "mp3").unwrap(),
            PathBuf::from("/tmp/beat.MP3")
        );
        assert_eq!(
            resolve_export_path("/tmp/beat", "mp3").unwrap(),
            PathBuf::from("/tmp/beat.mp3")
        );
        assert_eq!(
            resolve_export_path("/tmp/beat.v2", "wav").unwrap(),
            PathBuf::from("/tmp/beat.v2.wav")
        );
        assert!(resolve_export_path("beat.wav", "wav").is_err(), "relative");
        assert!(resolve_export_path("/tmp/beat.mp3", "wav").is_err(), "mismatch");
        assert!(resolve_export_path("/tmp/dir/", "wav").is_err(), "no file name");
        assert!(resolve_export_path("/tmp/beat.flac", "flac").is_err(), "format");
    }

    #[test]
    fn wav_export_writes_bytes_and_creates_parent() {
        let dir = std::env::temp_dir().join(format!("stash-drums-exp-{}", std::process::id()));
        let out = dir.join("nested").join("beat.wav");
        let mut wav = b"RIFF\0\0\0\0WAVE".to_vec();
        wav.resize(64, 0);
        assert!(is_wav(&wav));
        assert!(!is_wav(b"not a wav file"));
        write_export(&wav, &out, "wav").unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), wav);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_keeps_last_chars() {
        assert_eq!(tail("  abcdef \n", 3), "def");
        assert_eq!(tail("ab", 10), "ab");
    }
}
