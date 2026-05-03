use crate::modules::media_server::{MediaKind, MediaServerState};
use crate::modules::notes::repo::{
    FolderFilter, Note, NoteAttachment, NoteFolder, NoteSummary, NotesRepo,
};
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

pub(crate) fn audio_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("audio");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

/// Optional fourth allowed root for the inline audio player: the
/// user's stem-separation output dir (`~/Music/Stash Stems`). We
/// don't create it on demand — Stash Stems is owned by the separator
/// module; if the user never installed Demucs there's nothing to
/// expose. Returns `None` when `dirs_next::audio_dir()` is missing
/// (rare on macOS) instead of erroring, so notes still work.
pub(crate) fn stems_root() -> Option<PathBuf> {
    Some(crate::modules::separator::state::output_dir_default())
}

fn sanitize_ext(ext: &str) -> Result<String, String> {
    let lower = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_AUDIO_EXT.contains(&lower.as_str()) {
        return Err(format!("unsupported audio extension: .{lower}"));
    }
    Ok(lower)
}

/// Parse the `folder` parameter sent from the frontend.
/// `None` / `"all"` → no filter, `"unfiled"` → notes without a folder,
/// any numeric string → that folder id. Unknown strings fall back to `All`
/// rather than erroring — keeps the IPC surface forgiving for older clients.
fn parse_folder_filter(folder: Option<String>) -> FolderFilter {
    match folder.as_deref() {
        None | Some("") | Some("all") => FolderFilter::All,
        Some("unfiled") => FolderFilter::Unfiled,
        Some(s) => match s.parse::<i64>() {
            Ok(id) => FolderFilter::Folder(id),
            Err(_) => FolderFilter::All,
        },
    }
}

/// Side-list projection. Returns only title + a short body preview so we
/// don't ship 100s of KB of markdown across IPC every time Notes opens.
/// Full body is loaded on demand via `notes_get`.
#[tauri::command]
pub fn notes_list(
    state: State<'_, NotesState>,
    folder: Option<String>,
) -> Result<Vec<NoteSummary>, String> {
    let filter = parse_folder_filter(folder);
    to_string_err(state.repo.lock().unwrap().list_summaries(filter))
}

#[tauri::command]
pub fn notes_search(
    state: State<'_, NotesState>,
    query: String,
    folder: Option<String>,
) -> Result<Vec<NoteSummary>, String> {
    let filter = parse_folder_filter(folder);
    if query.trim().is_empty() {
        return to_string_err(state.repo.lock().unwrap().list_summaries(filter));
    }
    to_string_err(state.repo.lock().unwrap().search_summaries(&query, filter))
}

// -------------------- folders --------------------

#[tauri::command]
pub fn notes_folders_list(state: State<'_, NotesState>) -> Result<Vec<NoteFolder>, String> {
    to_string_err(state.repo.lock().unwrap().list_folders())
}

#[tauri::command]
pub fn notes_folder_create(state: State<'_, NotesState>, name: String) -> Result<i64, String> {
    to_string_err(state.repo.lock().unwrap().create_folder(name.trim(), now()))
}

#[tauri::command]
pub fn notes_folder_rename(
    state: State<'_, NotesState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().rename_folder(id, name.trim()))
}

#[tauri::command]
pub fn notes_folder_delete(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    id: i64,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().delete_folder(id))?;
    use tauri::Emitter;
    let _ = app.emit("notes:changed", ());
    Ok(())
}

#[tauri::command]
pub fn notes_folders_reorder(
    state: State<'_, NotesState>,
    ids: Vec<i64>,
) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().reorder_folders(&ids))
}

#[tauri::command]
pub fn notes_set_folder(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    note_id: i64,
    folder_id: Option<i64>,
) -> Result<(), String> {
    to_string_err(
        state
            .repo
            .lock()
            .unwrap()
            .set_note_folder(note_id, folder_id),
    )?;
    use tauri::Emitter;
    let _ = app.emit("notes:changed", ());
    Ok(())
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
pub fn notes_set_pinned(state: State<'_, NotesState>, id: i64, pinned: bool) -> Result<(), String> {
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
            let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            if canon.starts_with(&base) {
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
            let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            if canon.starts_with(base) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    // Drop the row. `ON DELETE CASCADE` on note_attachments cleans the
    // DB side; file unlinks above handle the disk side.
    to_string_err(state.repo.lock().unwrap().delete(id))
}

pub(crate) fn attachments_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
            let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            if canon.starts_with(&base) {
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

// Stash is single-user; these caps are speed-bumps against runaway
// drops/pastes (e.g. accidentally embedding a 4 K screen recording),
// not abuse defences. Picked to fit the realistic worst case:
// hour-plus podcast audio + RAW photos / iPhone HEIF bursts.
const MAX_AUDIO_BYTES: usize = 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 100 * 1024 * 1024;
/// 4 GiB ceiling for inline video embeds. Larger than audio/images so a
/// few minutes of phone-camera footage (50–300 MB) lands without fuss,
/// but still bounded — a 10 GB drag-drop is almost certainly a misclick.
const MAX_VIDEO_BYTES: usize = 4 * 1024 * 1024 * 1024;
const ALLOWED_IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif",
];
/// Container extensions accepted by the inline video embed path. Browser
/// `<video>` only reliably plays a subset of these (mp4/m4v/webm/mov),
/// but we still copy mkv/avi into the managed dir so the user can find
/// them — the renderer falls back to a plain link when MIME refuses.
const ALLOWED_VIDEO_EXT: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv", "avi"];

pub(crate) fn image_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("images");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

pub(crate) fn video_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("videos");
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

fn sanitize_video_ext(ext: &str) -> Result<String, String> {
    let lower = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_VIDEO_EXT.contains(&lower.as_str()) {
        return Err(format!("unsupported video extension: .{lower}"));
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
        return Err(format!(
            "audio payload exceeds {} MB limit",
            MAX_AUDIO_BYTES / 1024 / 1024
        ));
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
        return Err(format!(
            "audio file exceeds {} MB limit",
            MAX_AUDIO_BYTES / 1024 / 1024
        ));
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
        return Err(format!(
            "image payload exceeds {} MB limit",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
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
        return Err(format!(
            "image file exceeds {} MB limit",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
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

/// Copy an on-disk video file into the managed videos dir. Mirrors
/// `notes_save_audio_file` — the result is a stable absolute path the
/// frontend embeds as `![caption](…)`, with the inline preview rendered
/// by `MarkdownVideoEmbed` against the loopback `/video` stream URL.
#[tauri::command]
pub fn notes_save_video_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    if (meta.len() as usize) > MAX_VIDEO_BYTES {
        return Err(format!(
            "video file exceeds {} GB limit",
            MAX_VIDEO_BYTES / 1024 / 1024 / 1024
        ));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "file has no extension".to_string())?;
    let ext = sanitize_video_ext(ext)?;
    let dir = video_dir(&app)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = dir.join(format!("vid-{nanos}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Read raw bytes of an image stored under the managed images dir. Used by
/// the inline markdown image embed, which references files by absolute
/// path from `![alt](…)`. Same scope guard as `notes_read_audio_path`.
#[tauri::command]
pub fn notes_read_image_path(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let base = image_dir(&app)?;
    let p = Path::new(&path);
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if !canon.starts_with(&base) {
        return Err("image path is outside the managed images directory".into());
    }
    if !p.is_file() {
        return Err("image file is missing on disk".into());
    }
    std::fs::read(p).map_err(|e| e.to_string())
}

/// Read raw bytes of an audio file managed by the Notes module. Used by
/// the inline markdown audio player to populate a Blob URL when the
/// recording is short enough that one IPC round-trip is fine.
///
/// Prefer `notes_audio_alias_path` for attachments — it sidesteps the
/// IPC `Vec<u8>` JSON-array tax for large files (a 50 MB m4a serialises
/// to ~hundreds of MB of JSON and freezes the main thread).
///
/// Two trusted roots: the inline markdown audio dir (voice recordings)
/// and the per-note attachments tree. Hard scope guard against a
/// tampered note body coaxing the app into reading anything else.
#[tauri::command]
pub fn notes_read_audio_path(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let audio_root = audio_dir(&app)?;
    let attach_root = attachments_root(&app)?;
    let stems = stems_root();
    let p = Path::new(&path);
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let in_scope = canon.starts_with(&audio_root)
        || canon.starts_with(&attach_root)
        || stems.as_ref().is_some_and(|s| canon.starts_with(s));
    if !in_scope {
        return Err("audio path is outside the managed audio directories".into());
    }
    if !p.is_file() {
        return Err("audio file is missing on disk".into());
    }
    std::fs::read(p).map_err(|e| e.to_string())
}

/// Resolve a `http://127.0.0.1:<port>/audio?...` URL the frontend can
/// hand to `<audio src>`. The shared `MediaServerState` boots its
/// accept loop on first call, validates the path against currently
/// registered audio roots (notes audio dir, per-note attachments,
/// stems), and returns a tokenised URL. See
/// `modules/media_server/mod.rs` for why `asset://` cannot be used
/// for AVFoundation-backed playback.
#[tauri::command]
pub fn notes_audio_stream_url(
    media: State<'_, Arc<MediaServerState>>,
    path: String,
) -> Result<String, String> {
    media.stream_url(MediaKind::Audio, &path)
}

/// Resolve a `http://127.0.0.1:<port>/image?...` URL the frontend can hand
/// to `<img src>`. Avoids the IPC `Vec<u8>` JSON-array tax that previously
/// forced `notes_read_image_path` to materialise the whole file into the
/// renderer just to wrap it in a Blob URL — at the 100 MB embed cap that
/// translates to hundreds of MB of JSON parsing on every preview render.
#[tauri::command]
pub fn notes_image_stream_url(
    media: State<'_, Arc<MediaServerState>>,
    path: String,
) -> Result<String, String> {
    media.stream_url(MediaKind::Image, &path)
}

/// Resolve a `http://127.0.0.1:<port>/video?...` URL the frontend hands
/// to `<video src>`. Files staged via `notes_save_video_file` land in
/// `notes/videos/`, plus per-note attachments (so attachments-era
/// videos still play once the inline button replaces the dedicated
/// panel). Downloads land under the downloader's roots, registered
/// separately by that module.
#[tauri::command]
pub fn notes_video_stream_url(
    media: State<'_, Arc<MediaServerState>>,
    path: String,
) -> Result<String, String> {
    media.stream_url(MediaKind::Video, &path)
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

fn exports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notes")
        .join("exports");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

/// Slugify a note title into a filename-safe token. Keeps ASCII letters,
/// digits, and hyphens; collapses runs of other chars to single hyphens;
/// trims leading/trailing hyphens and caps at 48 chars so the resulting
/// path stays short enough for terminal paste.
fn slugify_title(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in title.trim().chars() {
        let keep = c.is_ascii_alphanumeric() || c == '-';
        if keep {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 48 {
        out.truncate(48);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        "note".to_string()
    } else {
        out
    }
}

/// Export the current note body to a stable on-disk markdown file and
/// return its absolute path. Used by "Reveal in Finder" and "Copy path"
/// so external tools (Claude Code, editors) can read the note directly.
///
/// The filename is deterministic per note id (`<id>-<slug>.md`), so
/// repeated exports overwrite in place — consumers get a stable path that
/// follows the note as its title changes. Stale files for the same id
/// with a different slug are removed on each export so the exports dir
/// does not leak copies after renames.
#[tauri::command]
pub fn notes_export_path(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    id: i64,
) -> Result<String, String> {
    let note = to_string_err(state.repo.lock().unwrap().get(id))?
        .ok_or_else(|| format!("note {id} not found"))?;
    let dir = exports_dir(&app)?;
    let slug = slugify_title(&note.title);
    let filename = format!("{id}-{slug}.md");
    let dest = dir.join(&filename);

    // Drop any previous export for this id with a different slug so a
    // renamed note doesn't leave stale `.md` siblings behind.
    let prefix = format!("{id}-");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name == filename {
                continue;
            }
            if !name.starts_with(&prefix) || !name.ends_with(".md") {
                continue;
            }
            let after_prefix = &name[prefix.len()..];
            // Guard against `12-foo.md` matching id `1` — the char right
            // after the id must be the `-` we just matched, nothing else.
            if after_prefix.contains('/') || after_prefix.is_empty() {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }

    let contents = if note.title.trim().is_empty() {
        note.body
    } else {
        format!("# {}\n\n{}", note.title.trim(), note.body)
    };
    std::fs::write(&dest, contents).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Audio MIME prefixes and extensions accepted for attachment transcription.
/// Matches the extensions Whisper can handle.
const AUDIO_MIME_PREFIXES: &[&str] = &["audio/"];
const AUDIO_ATTACH_EXT: &[&str] = &["mp3", "m4a", "wav", "ogg", "opus", "flac", "webm", "aac"];

fn is_audio_attachment(att: &crate::modules::notes::repo::NoteAttachment) -> bool {
    if let Some(ref mime) = att.mime_type {
        if AUDIO_MIME_PREFIXES.iter().any(|p| mime.starts_with(p)) {
            return true;
        }
    }
    // Fall back to extension check.
    let ext = std::path::Path::new(&att.file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    AUDIO_ATTACH_EXT.contains(&ext.as_str())
}

/// Manually set the transcription text for the note's primary audio recording.
/// Pass `null` / empty string to clear it.
#[tauri::command]
pub fn notes_set_audio_transcription(
    state: State<'_, NotesState>,
    note_id: i64,
    transcription: Option<String>,
) -> Result<(), String> {
    to_string_err(
        state
            .repo
            .lock()
            .unwrap()
            .set_note_audio_transcription(note_id, transcription.as_deref()),
    )
}

/// Manually set the transcription text for an audio attachment.
/// Pass `null` / empty string to clear it.
#[tauri::command]
pub fn notes_set_attachment_transcription(
    state: State<'_, NotesState>,
    id: i64,
    transcription: Option<String>,
) -> Result<(), String> {
    to_string_err(
        state
            .repo
            .lock()
            .unwrap()
            .set_attachment_transcription(id, transcription.as_deref()),
    )
}

/// Transcribe the note's primary audio recording (`audio_path`) with
/// the active Whisper model. Returns immediately; the actual work runs
/// in a detached async task and reports progress via events:
///   - `notes:audio_transcribing  { note_id }`  — started
///   - `notes:note_updated        { note_id }`  — succeeded, transcription persisted
///   - `notes:audio_transcribe_failed { note_id, error }` — failed
#[tauri::command]
pub async fn notes_transcribe_note_audio(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    note_id: i64,
) -> Result<(), String> {
    use tauri::Emitter;
    let audio_path = {
        let repo = state.repo.lock().unwrap();
        let note =
            to_string_err(repo.get(note_id))?.ok_or_else(|| format!("note {note_id} not found"))?;
        note.audio_path
            .ok_or_else(|| format!("note {note_id} has no audio_path"))?
    };
    let path = std::path::PathBuf::from(&audio_path);
    if !path.is_file() {
        return Err(format!("audio file missing: {audio_path}"));
    }

    let _ = app.emit(
        "notes:audio_transcribing",
        serde_json::json!({ "note_id": note_id }),
    );

    let state_repo = std::sync::Arc::clone(&state.repo);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::modules::whisper::commands::transcribe_with_active_model(
            &app_clone, path, None,
        )
        .await
        {
            Ok(text) => {
                let trimmed = text.trim().to_string();
                if trimmed.is_empty() {
                    let _ = app_clone.emit(
                        "notes:audio_transcribe_failed",
                        serde_json::json!({ "note_id": note_id, "error": "empty transcription" }),
                    );
                    return;
                }
                if let Ok(mut repo) = state_repo.lock() {
                    let _ = repo.set_note_audio_transcription(note_id, Some(&trimmed));
                }
                let _ = app_clone.emit(
                    "notes:note_updated",
                    serde_json::json!({ "note_id": note_id }),
                );
            }
            Err(e) => {
                tracing::warn!(error = %e, note_id, "notes: whisper transcription failed");
                let _ = app_clone.emit(
                    "notes:audio_transcribe_failed",
                    serde_json::json!({ "note_id": note_id, "error": e }),
                );
            }
        }
    });
    Ok(())
}

/// Transcribe an audio attachment with the active Whisper model.
/// Returns immediately; progress events:
///   - `notes:attachment_transcribing  { id }`          — started
///   - `notes:attachment_updated       { id }`          — succeeded
///   - `notes:attachment_transcribe_failed { id, error }` — failed
#[tauri::command]
pub async fn notes_transcribe_attachment(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    attachment_id: i64,
) -> Result<(), String> {
    use tauri::Emitter;
    let att = {
        let repo = state.repo.lock().unwrap();
        to_string_err(repo.get_attachment(attachment_id))?
            .ok_or_else(|| format!("attachment {attachment_id} not found"))?
    };
    if !is_audio_attachment(&att) {
        return Err(format!(
            "attachment {attachment_id} is not an audio file (mime: {:?})",
            att.mime_type
        ));
    }
    let path = std::path::PathBuf::from(&att.file_path);
    if !path.is_file() {
        return Err(format!("attachment file missing: {}", att.file_path));
    }

    let _ = app.emit(
        "notes:attachment_transcribing",
        serde_json::json!({ "id": attachment_id }),
    );

    let state_repo = std::sync::Arc::clone(&state.repo);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::modules::whisper::commands::transcribe_with_active_model(
            &app_clone, path, None,
        )
        .await
        {
            Ok(text) => {
                let trimmed = text.trim().to_string();
                if trimmed.is_empty() {
                    let _ = app_clone.emit(
                        "notes:attachment_transcribe_failed",
                        serde_json::json!({ "id": attachment_id, "error": "empty transcription" }),
                    );
                    return;
                }
                if let Ok(mut repo) = state_repo.lock() {
                    let _ = repo.set_attachment_transcription(attachment_id, Some(&trimmed));
                }
                let _ = app_clone.emit(
                    "notes:attachment_updated",
                    serde_json::json!({ "id": attachment_id }),
                );
            }
            Err(e) => {
                tracing::warn!(error = %e, attachment_id, "notes: attachment whisper failed");
                let _ = app_clone.emit(
                    "notes:attachment_transcribe_failed",
                    serde_json::json!({ "id": attachment_id, "error": e }),
                );
            }
        }
    });
    Ok(())
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
    fn slugify_strips_punctuation_and_caps_length() {
        assert_eq!(slugify_title("Hello, World!"), "hello-world");
        assert_eq!(slugify_title("  trailing  "), "trailing");
        assert_eq!(slugify_title(""), "note");
        assert_eq!(slugify_title("---"), "note");
        let long = "a".repeat(100);
        assert!(slugify_title(&long).len() <= 48);
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
