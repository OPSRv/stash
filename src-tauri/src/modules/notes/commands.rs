use crate::modules::notes::repo::{Note, NotesRepo};
use std::sync::Mutex;
use tauri::State;

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

#[tauri::command]
pub fn notes_list(state: State<'_, NotesState>) -> Result<Vec<Note>, String> {
    to_string_err(state.repo.lock().unwrap().list())
}

#[tauri::command]
pub fn notes_search(state: State<'_, NotesState>, query: String) -> Result<Vec<Note>, String> {
    if query.trim().is_empty() {
        return to_string_err(state.repo.lock().unwrap().list());
    }
    to_string_err(state.repo.lock().unwrap().search(&query))
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
pub fn notes_delete(state: State<'_, NotesState>, id: i64) -> Result<(), String> {
    to_string_err(state.repo.lock().unwrap().delete(id))
}

/// Read a markdown file from disk. Rejects anything that is not a regular
/// file, is larger than 4 MiB, or does not have a `.md` / `.markdown`
/// extension — those files don't belong in a note editor.
#[tauri::command]
pub fn notes_read_file(path: String) -> Result<ReadFileResult, String> {
    use std::path::Path;
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
}
