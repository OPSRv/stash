use crate::modules::notes::repo::{Note, NoteAttachment, NoteSummary, NotesRepo};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct NotesState {
    /// `Arc` so cross-module integrations (Telegram /note command) can
    /// clone a handle without duplicating the SQLite connection. Existing
    /// callers still `.lock()` through transparent `Arc` deref.
    pub repo: Arc<Mutex<NotesRepo>>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn to_string_err<T, E: std::fmt::Display>(r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

/// Allowed audio container extensions. Anything else is rejected so a
/// compromised frontend can't coax the app into writing arbitrary files.
const ALLOWED_AUDIO_EXT: &[&str] = &[
    "webm", "ogg", "mp4", "m4a", "mp3", "wav", "aac", "flac", "opus", "aiff", "aif",
];

fn audio_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("audio");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn sanitize_ext(ext: &str) -> Result<String, String> {
    let lower = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_AUDIO_EXT.contains(&lower.as_str()) {
        return Err(format!("unsupported audio extension: .{lower}"));
    }
    Ok(lower)
}

/// Side-list projection. Returns only title + a short body preview so we
/// don't ship 100s of KB of markdown across IPC every time Notes opens.
/// Full body is loaded on demand via `notes_get`.
#[tauri::command]
pub fn notes_list(state: State<'_, NotesState>) -> Result<Vec<NoteSummary>, String> {
    to_string_err(state.repo.lock().unwrap().list_summaries())
}

#[tauri::command]
pub fn notes_search(
    state: State<'_, NotesState>,
    query: String,
) -> Result<Vec<NoteSummary>, String> {
    if query.trim().is_empty() {
        return to_string_err(state.repo.lock().unwrap().list_summaries());
    }
    to_string_err(state.repo.lock().unwrap().search_summaries(&query))
}

/// Fetch a single full note (with body). Called when the user activates a
/// row in the side-list — the list itself only carries summaries.
#[tauri::command]
pub fn notes_get(state: State<'_, NotesState>, id: i64) -> Result<Option<Note>, String> {
    to_string_err(state.repo.lock().unwrap().get(id))
}

#[tauri::command]
pub fn notes_create(
    state: State<'_, NotesState>,
    title: String,
    body: String,
) -> Result<i64, String> {
    to_string_err(state.repo.lock().unwrap().create(&title, &body, now()))
}

#[tauri::command]
pub fn notes_update(
    state: State<'_, NotesState>,
    id: i64,
    title: String,
    body: String,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().update(id, &title, &body, now()))
}

#[tauri::command]
pub fn notes_set_pinned(
    state: State<'_, NotesState>,
    id: i64,
    pinned: bool,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().set_pinned(id, pinned))
}

#[tauri::command]
pub fn notes_delete(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    id: i64,
) -> Result<(), String> {
    // Fetch first so we can clean up the audio file the row points to. If
    // the row is missing, treat the delete as a no-op rather than an error —
    // the UI has already moved on.
    let (maybe_audio, attachments) = {
        let repo = state.repo.lock().unwrap();
        let note = to_string_err(repo.get(id))?;
        let attach = to_string_err(repo.list_attachments(id))?;
        (note.and_then(|n| n.audio_path), attach)
    };
    if let Some(p) = maybe_audio {
        // Only delete files that live under our audio dir — defence in
        // depth against a corrupted row pointing somewhere unexpected.
        if let Ok(base) = audio_dir(&app) {
            let path = Path::new(&p);
            if path.starts_with(&base) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    // Attachments are always owned copies under `notes/attachments/`,
    // so unlink unconditionally. Missing file is not an error.
    let attach_base = attachments_root(&app).ok();
    for a in attachments {
        let path = Path::new(&a.file_path);
        if let Some(ref base) = attach_base {
            if path.starts_with(base) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    // Drop the row. `ON DELETE CASCADE` on note_attachments cleans the
    // DB side; file unlinks above handle the disk side.
    to_string_err(state.repo.lock().unwrap().delete(id))
}

fn attachments_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("attachments");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn attachments_dir(app: &tauri::AppHandle, note_id: i64) -> Result<PathBuf, String> {
    let dir = attachments_root(app)?.join(note_id.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Sanitise a filename down to portable ASCII-safe form. We keep the
/// original extension verbatim so mime-detection works on the copy,
/// but strip separators and weird chars that could let a malicious
/// name escape the attachments directory.
fn sanitize_filename(input: &str) -> String {
    let name = input.rsplit(['/', '\\']).next().unwrap_or(input);
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub fn notes_list_attachments(
    state: State<'_, NotesState>,
    note_id: i64,
) -> Result<Vec<NoteAttachment>, String> {
    to_string_err(state.repo.lock().unwrap().list_attachments(note_id))
}

/// Copy `source_path` into the note's attachments dir and record a
/// row. Callers pass the absolute path the user selected (drag-drop
/// target or picker result); we never read from arbitrary locations
/// silently — the file is *copied*, so removing the attachment never
/// touches the original.
#[tauri::command]
pub fn notes_add_attachment(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    note_id: i64,
    source_path: String,
) -> Result<NoteAttachment, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("source is not a file: {source_path}"));
    }
    let original_name = src
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let safe = sanitize_filename(&original_name);
    let dir = attachments_dir(&app, note_id)?;
    // Prefix with an 8-char hex suffix to avoid collisions when the same
    // filename appears twice on one note.
    let suffix = {
        let mut t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        t ^= (note_id as u64).rotate_left(13);
        format!("{:08x}", t & 0xFFFF_FFFF)
    };
    let dest_name = format!("{suffix}_{safe}");
    let dest = dir.join(&dest_name);
    std::fs::copy(&src, &dest).map_err(|e| format!("copy failed: {e}"))?;

    let size_bytes = std::fs::metadata(&dest).ok().map(|m| m.len() as i64);
    let mime_type = mime_from_extension(&dest);

    let abs = dest
        .to_str()
        .ok_or_else(|| "attachment path is not valid UTF-8".to_string())?
        .to_string();

    let id = to_string_err(state.repo.lock().unwrap().add_attachment(
        note_id,
        &abs,
        &original_name,
        mime_type.as_deref(),
        size_bytes,
        now(),
    ))?;
    let att = to_string_err(state.repo.lock().unwrap().get_attachment(id))?
        .ok_or_else(|| "attachment vanished immediately after insert".to_string())?;
    use tauri::Emitter;
    let _ = app.emit("notes:attachments_changed", note_id);
    Ok(att)
}

#[tauri::command]
pub fn notes_remove_attachment(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    id: i64,
) -> Result<(), String> {
    let removed_path = to_string_err(state.repo.lock().unwrap().delete_attachment(id))?;
    if let Some(p) = removed_path {
        // Only unlink files under our attachments root, guarding against
        // poisoned rows pointing outside the sandbox.
        if let Ok(base) = attachments_root(&app) {
            let path = Path::new(&p);
            if path.starts_with(&base) {
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => tracing::warn!(%p, error = %e, "notes: failed to unlink attachment"),
                }
            }
        }
    }
    use tauri::Emitter;
    let _ = app.emit("notes:attachments_changed", id);
    Ok(())
}

/// Best-effort mime-type guess from extension. Accurate enough for UI
/// dispatch (image/video/audio vs. doc); anything unknown becomes
/// `None` and the frontend renders a generic file chip.
fn mime_from_extension(p: &Path) -> Option<String> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    let m = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        _ => return None,
    };
    Some(m.to_string())
}

const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const ALLOWED_IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif",
];

fn image_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("images");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn sanitize_image_ext(ext: &str) -> Result<String, String> {
    let lower = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_IMAGE_EXT.contains(&lower.as_str()) {
        return Err(format!("unsupported image extension: .{lower}"));
    }
    Ok(lower)
}

/// Write raw audio bytes into the managed audio dir and return the absolute
/// path of the new file. Unlike `notes_create_audio`, this does NOT create
/// a DB row — the frontend embeds the returned path into the active note's
/// markdown body via `![](…)` syntax, keeping a single note type that can
/// hold text and N audio embeds together.
#[tauri::command]
pub fn notes_save_audio_bytes(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("empty audio payload".into());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("audio payload exceeds 25 MiB limit".into());
    }
    let ext = sanitize_ext(&ext)?;
    let dir = audio_dir(&app)?;
    // Nanos-based filename keeps collision odds vanishingly small across
    // rapid-fire recordings and drops, without needing a DB round-trip to
    // reserve an id.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("emb-{nanos}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy an on-disk audio file into the managed audio dir (leaving the
/// original where the user had it) and return the new absolute path. Same
/// embed-into-body flow as `notes_save_audio_bytes`.
#[tauri::command]
pub fn notes_save_audio_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    if (meta.len() as usize) > MAX_AUDIO_BYTES {
        return Err("audio file exceeds 25 MiB limit".into());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "file has no extension".to_string())?;
    let ext = sanitize_ext(ext)?;
    let dir = audio_dir(&app)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = dir.join(format!("emb-{nanos}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Write raw image bytes into the managed images dir and return the
/// absolute path. Mirrors `notes_save_audio_bytes` for the drag-from-
/// screenshot / paste-from-clipboard path. No DB row — the frontend embeds
/// the path into the active note via `![alt](…)` markdown syntax.
#[tauri::command]
pub fn notes_save_image_bytes(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("empty image payload".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image payload exceeds 15 MiB limit".into());
    }
    let ext = sanitize_image_ext(&ext)?;
    let dir = image_dir(&app)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("img-{nanos}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy an on-disk image file into the managed images dir. Source is left
/// untouched so Finder's original stays put.
#[tauri::command]
pub fn notes_save_image_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    if (meta.len() as usize) > MAX_IMAGE_BYTES {
        return Err("image file exceeds 15 MiB limit".into());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "file has no extension".to_string())?;
    let ext = sanitize_image_ext(ext)?;
    let dir = image_dir(&app)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = dir.join(format!("img-{nanos}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Read raw bytes of an image stored under the managed images dir. Used by
/// the inline markdown image embed, which references files by absolute
/// path from `![alt](…)`. Same scope guard as `notes_read_audio_path`.
#[tauri::command]
pub fn notes_read_image_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<u8>, String> {
    let base = image_dir(&app)?;
    let p = Path::new(&path);
    if !p.starts_with(&base) {
        return Err("image path is outside the managed images directory".into());
    }
    if !p.is_file() {
        return Err("image file is missing on disk".into());
    }
    std::fs::read(p).map_err(|e| e.to_string())
}

/// Read raw bytes of an audio file stored under the managed audio dir. Used
/// by the inline markdown audio player, which references files by absolute
/// path rather than by note id. Path must live under the audio dir — a hard
/// guard against a tampered note body coaxing the app into reading other
/// locations on disk.
#[tauri::command]
pub fn notes_read_audio_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<u8>, String> {
    let base = audio_dir(&app)?;
    let p = Path::new(&path);
    if !p.starts_with(&base) {
        return Err("audio path is outside the managed audio directory".into());
    }
    if !p.is_file() {
        return Err("audio file is missing on disk".into());
    }
    std::fs::read(p).map_err(|e| e.to_string())
}

/// Read a markdown file from disk. Rejects anything that is not a regular
/// file, is larger than 4 MiB, or does not have a `.md` / `.markdown`
/// extension — those files don't belong in a note editor.
#[tauri::command]
pub fn notes_read_file(path: String) -> Result<ReadFileResult, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "md" && ext != "markdown" && ext != "txt" {
        return Err(format!("unsupported extension: .{ext}"));
    }
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 4 * 1024 * 1024 {
        return Err("file is larger than 4 MiB".into());
    }
    let contents = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    let name = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported")
        .to_string();
    Ok(ReadFileResult { name, contents })
}

#[tauri::command]
pub fn notes_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
pub struct ReadFileResult {
    pub name: String,
    pub contents: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_file_accepts_md_and_returns_stem() {
        let dir = std::env::temp_dir().join(format!("stash-note-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("hello.md");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(f, "# Hello\n- item").unwrap();
        drop(f);
        let result = notes_read_file(p.to_string_lossy().into()).unwrap();
        assert_eq!(result.name, "hello");
        assert!(result.contents.contains("# Hello"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_file_rejects_non_md() {
        let dir = std::env::temp_dir().join(format!("stash-note-reject-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("nope.png");
        std::fs::write(&p, b"x").unwrap();
        let err = notes_read_file(p.to_string_lossy().into()).unwrap_err();
        assert!(err.contains("unsupported"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_file_roundtrip() {
        let dir = std::env::temp_dir().join(format!("stash-note-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("out.md");
        notes_write_file(p.to_string_lossy().into(), "# ok".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "# ok");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sanitize_ext_accepts_known_audio_formats() {
        assert_eq!(sanitize_ext("webm").unwrap(), "webm");
        assert_eq!(sanitize_ext(".m4a").unwrap(), "m4a");
        assert_eq!(sanitize_ext("MP3").unwrap(), "mp3");
        assert!(sanitize_ext("exe").is_err());
        assert!(sanitize_ext("..").is_err());
    }
}
