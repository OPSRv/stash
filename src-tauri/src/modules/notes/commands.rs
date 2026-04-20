use crate::modules::notes::repo::{Note, NoteSummary, NotesRepo};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct NotesState {
    pub repo: Mutex<NotesRepo>,
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
const ALLOWED_AUDIO_EXT: &[&str] = &["webm", "ogg", "mp4", "m4a", "mp3", "wav"];

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
pub fn notes_delete(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    id: i64,
) -> Result<(), String> {
    // Fetch first so we can clean up the audio file the row points to. If
    // the row is missing, treat the delete as a no-op rather than an error —
    // the UI has already moved on.
    let maybe = to_string_err(state.repo.lock().unwrap().get(id))?;
    if let Some(note) = maybe {
        if let Some(p) = note.audio_path.as_deref() {
            // Only delete files that live under our audio dir — defence in
            // depth against a corrupted row pointing somewhere unexpected.
            if let Ok(base) = audio_dir(&app) {
                let path = Path::new(p);
                if path.starts_with(&base) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
    to_string_err(state.repo.lock().unwrap().delete(id))
}

/// Create a new note backed by a freshly-recorded audio blob. The blob is
/// written to `appData/notes/audio/<id>.<ext>` and the row stores its path.
#[tauri::command]
pub fn notes_create_audio(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    title: String,
    bytes: Vec<u8>,
    ext: String,
    duration_ms: Option<i64>,
) -> Result<Note, String> {
    // Reject empty payloads — the recorder produced nothing to save.
    if bytes.is_empty() {
        return Err("empty audio payload".into());
    }
    // Guard against runaway blobs. ~25 MiB is plenty for a voice memo.
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("audio payload exceeds 25 MiB limit".into());
    }
    let ext = sanitize_ext(&ext)?;
    let dir = audio_dir(&app)?;
    // Provisional write to a temp path so we have a stable target for the
    // DB insert. After insert we rename to `<id>.<ext>` so the filename is
    // discoverable from the row alone.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".pending-{nanos}.{ext}"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;

    let mut repo = state.repo.lock().unwrap();
    let id = match repo.create_audio(
        &title,
        "",
        tmp.to_string_lossy().as_ref(),
        duration_ms,
        now(),
    ) {
        Ok(id) => id,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    };
    let final_path = dir.join(format!("{id}.{ext}"));
    if let Err(e) = std::fs::rename(&tmp, &final_path) {
        // Roll back the row so we don't leave a stale pointer.
        let _ = repo.delete(id);
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    // Update the row with its final absolute path.
    let final_str = final_path.to_string_lossy().into_owned();
    if let Err(e) = repo.set_audio_path_inline(id, &final_str) {
        let _ = std::fs::remove_file(&final_path);
        let _ = repo.delete(id);
        return Err(e.to_string());
    }
    let note = repo
        .get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "note vanished after insert".to_string())?;
    Ok(note)
}

/// Read a note's audio bytes. Returns raw bytes which the frontend wraps in
/// a Blob — avoids needing filesystem capabilities in the webview.
#[tauri::command]
pub fn notes_read_audio(
    app: tauri::AppHandle,
    state: State<'_, NotesState>,
    id: i64,
) -> Result<Vec<u8>, String> {
    let note = state
        .repo
        .lock()
        .unwrap()
        .get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "note not found".to_string())?;
    let path = note
        .audio_path
        .ok_or_else(|| "note has no audio attachment".to_string())?;
    // Hard-limit reads to files inside our audio dir.
    let base = audio_dir(&app)?;
    let p = Path::new(&path);
    if !p.starts_with(&base) {
        return Err("audio path is outside the managed audio directory".into());
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
