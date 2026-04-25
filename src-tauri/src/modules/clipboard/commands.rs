use crate::modules::clipboard::og::{self, LinkPreview};
use crate::modules::clipboard::pasteboard;
use crate::modules::clipboard::repo::{ClipboardItem, ClipboardRepo};
use lru::LruCache;
use rusqlite::Result;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// In-memory cache for LinkPreview lookups. Keyed by URL. Stores both hits
/// (Some) and misses (None) so the UI never re-hammers a URL that doesn't
/// expose og metadata. Backed by an LRU so the hot set survives eviction
/// while stale entries at the tail are the ones that get dropped.
pub struct LinkPreviewState {
    cache: Mutex<LruCache<String, Option<LinkPreview>>>,
}

const LINK_PREVIEW_CACHE_CAP: usize = 500;

impl LinkPreviewState {
    pub fn new() -> Self {
        // SAFETY: cap is a compile-time non-zero constant.
        let cap = NonZeroUsize::new(LINK_PREVIEW_CACHE_CAP).unwrap();
        Self {
            cache: Mutex::new(LruCache::new(cap)),
        }
    }

    fn get(&self, url: &str) -> Option<Option<LinkPreview>> {
        self.cache.lock().unwrap().get(url).cloned()
    }

    fn put(&self, url: String, value: Option<LinkPreview>) {
        self.cache.lock().unwrap().put(url, value);
    }
}

pub struct ClipboardState {
    pub repo: Mutex<ClipboardRepo>,
    pub images_dir: PathBuf,
}

/// Best-effort delete of a captured-image file pointed at by a row's meta
/// JSON. Only files inside the configured `images_dir` are touched — defence
/// against a stale or tampered row pointing at something unrelated. Failures
/// are swallowed because the row removal must succeed regardless.
fn purge_image_file(meta: &str, images_dir: &Path) {
    let parsed: serde_json::Value = match serde_json::from_str(meta) {
        Ok(v) => v,
        Err(_) => return,
    };
    let path = match parsed.get("path").and_then(|v| v.as_str()) {
        Some(p) => Path::new(p),
        None => return,
    };
    if path.starts_with(images_dir) {
        let _ = std::fs::remove_file(path);
    }
}

const DEFAULT_LIMIT: usize = 200;

pub fn list_items(state: &ClipboardState, limit: usize) -> Result<Vec<ClipboardItem>> {
    state.repo.lock().unwrap().list(limit)
}

pub fn search_items(
    state: &ClipboardState,
    query: &str,
    limit: usize,
) -> Result<Vec<ClipboardItem>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return state.repo.lock().unwrap().list(limit);
    }
    state.repo.lock().unwrap().search(trimmed, limit)
}

pub fn toggle_pin(state: &ClipboardState, id: i64) -> Result<()> {
    state.repo.lock().unwrap().toggle_pin(id)
}

pub fn delete_item(state: &ClipboardState, id: i64) -> Result<()> {
    state.repo.lock().unwrap().delete(id)
}

pub fn clear_all(state: &ClipboardState) -> Result<usize> {
    state.repo.lock().unwrap().clear_all()
}

#[allow(dead_code)]
pub fn trim_to_cap(state: &ClipboardState, cap: usize) -> Result<usize> {
    state.repo.lock().unwrap().trim_to_cap(cap)
}

pub fn paste_prepare(state: &ClipboardState, id: i64, now: i64) -> Result<ClipboardItem> {
    let mut repo = state.repo.lock().unwrap();
    let item = repo
        .get(id)?
        .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
    repo.touch(id, now)?;
    Ok(item)
}

fn to_string_err<T, E: std::fmt::Display>(
    r: std::result::Result<T, E>,
) -> std::result::Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_list(
    state: State<'_, Arc<ClipboardState>>,
) -> std::result::Result<Vec<ClipboardItem>, String> {
    to_string_err(list_items(&state, DEFAULT_LIMIT))
}

#[tauri::command]
pub fn clipboard_search(
    state: State<'_, Arc<ClipboardState>>,
    query: String,
) -> std::result::Result<Vec<ClipboardItem>, String> {
    to_string_err(search_items(&state, &query, DEFAULT_LIMIT))
}

#[tauri::command]
pub fn clipboard_toggle_pin(
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    to_string_err(toggle_pin(&state, id))
}

/// Sweep `kind='file'` rows whose files no longer exist or never
/// pointed at user-visible content. Called once at startup to clean
/// up rows inserted before we added the pasteboard promise-ID filter
/// (`id=6571367.14836106`-style entries are the canonical offender).
/// Returns how many rows were dropped.
pub fn prune_orphan_file_rows(state: &ClipboardState) -> Result<usize> {
    let pairs = {
        let repo = state.repo.lock().unwrap();
        repo.file_rows_with_meta()?
    };
    let mut removed = 0usize;
    for (id, meta) in pairs {
        let parsed: serde_json::Value = match serde_json::from_str(&meta) {
            Ok(v) => v,
            Err(_) => {
                let _ = state.repo.lock().unwrap().delete(id);
                removed += 1;
                continue;
            }
        };
        let files = parsed.get("files").and_then(|v| v.as_array());
        let any_actionable = files.map_or(false, |arr| {
            arr.iter().any(|f| {
                f.get("path")
                    .and_then(|p| p.as_str())
                    .map(std::path::Path::new)
                    .map_or(
                        false,
                        crate::modules::clipboard::pasteboard::is_user_visible_path,
                    )
            })
        });
        if !any_actionable {
            let _ = state.repo.lock().unwrap().delete(id);
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn clipboard_prune_files(
    state: State<'_, Arc<ClipboardState>>,
) -> std::result::Result<usize, String> {
    to_string_err(prune_orphan_file_rows(&state))
}

#[tauri::command]
pub fn clipboard_clear(
    state: State<'_, Arc<ClipboardState>>,
) -> std::result::Result<usize, String> {
    // Gather the unpinned image rows' meta first so we can purge the backing
    // PNGs from `images_dir` before the rows that point at them disappear.
    let metas = to_string_err(state.repo.lock().unwrap().unpinned_image_metas())?;
    for meta in &metas {
        purge_image_file(meta, &state.images_dir);
    }
    to_string_err(clear_all(&state))
}

#[tauri::command]
pub fn clipboard_copy_only(
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let item = to_string_err(paste_prepare(&state, id, now))?;
    match item.kind.as_str() {
        "text" => {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard
                .set_text(item.content)
                .map_err(|e| e.to_string())?;
        }
        "image" => {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            let meta = item.meta.unwrap_or_default();
            let parsed: serde_json::Value =
                serde_json::from_str(&meta).map_err(|e| e.to_string())?;
            let path = parsed
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "image meta.path missing".to_string())?;
            let img = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
            let (w, h) = img.dimensions();
            let data = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(img.into_raw()),
            };
            clipboard.set_image(data).map_err(|e| e.to_string())?;
        }
        "file" => {
            let paths = file_paths_from_meta(item.meta.as_deref())?;
            pasteboard::write_file_urls(&paths)?;
        }
        _ => {}
    }
    Ok(())
}

/// Decode a `kind='file'` item's meta JSON into a flat Vec<PathBuf>.
/// Kept as a free fn because both `clipboard_copy_only` and
/// `clipboard_paste` need the same extraction and failure modes.
fn file_paths_from_meta(meta: Option<&str>) -> std::result::Result<Vec<PathBuf>, String> {
    let meta = meta.ok_or_else(|| "file meta missing".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(meta).map_err(|e| e.to_string())?;
    let arr = parsed
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "file meta.files missing or not an array".to_string())?;
    let paths: Vec<PathBuf> = arr
        .iter()
        .filter_map(|v| v.get("path").and_then(|p| p.as_str()).map(PathBuf::from))
        .collect();
    if paths.is_empty() {
        return Err("file meta.files contained no usable paths".into());
    }
    Ok(paths)
}

/// Resolve and cache a link preview for the given URL. Returns None when
/// the page has no usable og/twitter metadata (the miss is also cached).
#[tauri::command]
pub async fn clipboard_link_preview(
    state: State<'_, Arc<LinkPreviewState>>,
    url: String,
) -> std::result::Result<Option<LinkPreview>, String> {
    let url = url.trim().to_string();
    if url.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(None);
    }
    if let Some(cached) = state.get(&url) {
        return Ok(cached);
    }
    let url_for_fetch = url.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || og::fetch_preview(&url_for_fetch))
        .await
        .map_err(|e| e.to_string())?;
    state.put(url, preview.clone());
    Ok(preview)
}

#[tauri::command]
pub fn clipboard_delete(
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    // For image rows, remove the captured PNG from disk before dropping the
    // row — otherwise repeated screenshot copies leak into `images_dir`
    // forever. Lookup is best-effort: a missing row falls through to the
    // delete (no-op), and a non-image row skips the file step.
    if let Ok(Some(item)) = state.repo.lock().unwrap().get(id) {
        if item.kind == "image" {
            if let Some(meta) = item.meta.as_deref() {
                purge_image_file(meta, &state.images_dir);
            }
        }
    }
    to_string_err(delete_item(&state, id))
}

#[tauri::command]
pub fn clipboard_paste(
    app: tauri::AppHandle,
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let item = to_string_err(paste_prepare(&state, id, now))?;

    if let Some(win) = tauri::Manager::get_webview_window(&app, "popup") {
        let _ = win.hide();
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;

    match item.kind.as_str() {
        "text" => {
            clipboard
                .set_text(item.content)
                .map_err(|e| e.to_string())?;
        }
        "image" => {
            let meta = item.meta.unwrap_or_default();
            let parsed: serde_json::Value =
                serde_json::from_str(&meta).map_err(|e| e.to_string())?;
            let path = parsed
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "image meta.path missing".to_string())?;
            let img = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
            let (w, h) = img.dimensions();
            let data = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(img.into_raw()),
            };
            clipboard.set_image(data).map_err(|e| e.to_string())?;
        }
        "file" => {
            // Drop the arboard clipboard first — it will re-open as
            // soon as it's needed. Keeping it alive here is fine but
            // unnecessary; the actual pasteboard write goes through
            // our NSPasteboard helper which owns a different handle.
            drop(clipboard);
            let paths = file_paths_from_meta(item.meta.as_deref())?;
            pasteboard::write_file_urls(&paths)?;
        }
        other => return Err(format!("unknown kind: {other}")),
    }

    #[cfg(target_os = "macos")]
    simulate_cmd_v()?;

    Ok(())
}

/// Manually set (or clear) the stored transcription for a clipboard item.
/// Pass `None` (null from JS) to clear.
#[tauri::command]
pub fn clipboard_set_transcription(
    app: AppHandle,
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
    transcription: Option<String>,
) -> std::result::Result<(), String> {
    state
        .repo
        .lock()
        .unwrap()
        .set_transcription(id, transcription.as_deref())
        .map_err(|e| e.to_string())?;
    let _ = app.emit("clipboard:item_updated", id);
    Ok(())
}

/// Resolve the single audio file path from a clipboard item's `meta` JSON.
/// Returns `Err` if the item doesn't exist, has no meta, or doesn't contain
/// exactly one audio file (MIME starts with `audio/`).
fn single_audio_path(
    state: &ClipboardState,
    id: i64,
) -> std::result::Result<PathBuf, String> {
    let item = state
        .repo
        .lock()
        .unwrap()
        .get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("clipboard item {id} not found"))?;
    let meta_str = item
        .meta
        .ok_or_else(|| "no single audio file".to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&meta_str).map_err(|_| "no single audio file".to_string())?;
    let files = parsed
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "no single audio file".to_string())?;
    // Collect files whose MIME type is audio/* (or whose extension is an
    // audio extension as a fallback when mime is absent).
    let audio_files: Vec<&serde_json::Value> = files
        .iter()
        .filter(|f| {
            // Primary: MIME starts with "audio/"
            if let Some(mime) = f.get("mime").and_then(|m| m.as_str()) {
                return mime.starts_with("audio/");
            }
            // Fallback: check the file extension
            if let Some(name) = f.get("name").and_then(|n| n.as_str()) {
                let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                return matches!(
                    ext.as_str(),
                    "m4a" | "mp3" | "wav" | "ogg" | "opus" | "flac" | "aac"
                );
            }
            false
        })
        .collect();
    if audio_files.len() != 1 {
        return Err("no single audio file".to_string());
    }
    let path = audio_files[0]
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "no single audio file".to_string())?;
    Ok(PathBuf::from(path))
}

/// Kick off background transcription for a clipboard audio item.
/// Returns immediately after spawning. Progress is signalled via events:
/// - `clipboard:transcribing`  `{id}` — job started
/// - `clipboard:item_updated`  `{id}` — transcription saved successfully
/// - `clipboard:transcribe_failed` `{id, error}` — Whisper returned an error
#[tauri::command]
pub async fn clipboard_transcribe_item(
    app: AppHandle,
    state: State<'_, Arc<ClipboardState>>,
    id: i64,
) -> std::result::Result<(), String> {
    let audio_path = single_audio_path(&state, id)?;

    let _ = app.emit("clipboard:transcribing", id);

    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::modules::whisper::commands::transcribe_with_active_model(
            &app_clone,
            audio_path,
            None,
        )
        .await
        {
            Ok(text) => {
                let trimmed = text.trim().to_string();
                if trimmed.is_empty() {
                    let _ = app_clone.emit(
                        "clipboard:transcribe_failed",
                        serde_json::json!({ "id": id, "error": "empty transcription" }),
                    );
                    return;
                }
                if let Ok(mut repo) = state_clone.repo.lock() {
                    let _ = repo.set_transcription(id, Some(&trimmed));
                }
                let _ = app_clone.emit("clipboard:item_updated", id);
            }
            Err(e) => {
                tracing::warn!(error = %e, "clipboard transcription failed");
                let _ = app_clone.emit(
                    "clipboard:transcribe_failed",
                    serde_json::json!({ "id": id, "error": e }),
                );
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn simulate_cmd_v() -> std::result::Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    std::thread::sleep(std::time::Duration::from_millis(80));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Meta, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Meta, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_state() -> ClipboardState {
        let repo = ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        ClipboardState {
            repo: Mutex::new(repo),
            images_dir: PathBuf::from("/tmp/stash-test"),
        }
    }

    #[test]
    fn list_returns_inserted_items_newest_first() {
        let state = fresh_state();
        state
            .repo
            .lock()
            .unwrap()
            .insert_text("older", 100)
            .unwrap();
        state
            .repo
            .lock()
            .unwrap()
            .insert_text("newer", 200)
            .unwrap();

        let items = list_items(&state, 10).unwrap();

        assert_eq!(items[0].content, "newer");
        assert_eq!(items[1].content, "older");
    }

    #[test]
    fn search_filters_items_by_substring() {
        let state = fresh_state();
        state.repo.lock().unwrap().insert_text("apple", 1).unwrap();
        state.repo.lock().unwrap().insert_text("banana", 2).unwrap();

        let items = search_items(&state, "ban", 10).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content, "banana");
    }

    #[test]
    fn empty_search_query_returns_list() {
        let state = fresh_state();
        state.repo.lock().unwrap().insert_text("only", 1).unwrap();

        let items = search_items(&state, "", 10).unwrap();

        assert_eq!(items.len(), 1);
    }

    #[test]
    fn toggle_pin_flips_flag() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("pin", 1).unwrap();

        toggle_pin(&state, id).unwrap();

        let items = list_items(&state, 10).unwrap();
        assert!(items[0].pinned);
    }

    #[test]
    fn paste_prepare_returns_item_and_touches_timestamp() {
        let state = fresh_state();
        let id = state
            .repo
            .lock()
            .unwrap()
            .insert_text("paste me", 100)
            .unwrap();

        let item = paste_prepare(&state, id, 999).unwrap();

        assert_eq!(item.content, "paste me");
        assert_eq!(item.kind, "text");
        let reloaded = state.repo.lock().unwrap().get(id).unwrap().unwrap();
        assert_eq!(reloaded.created_at, 999);
    }

    #[test]
    fn link_preview_cache_evicts_least_recently_used_first() {
        let state = LinkPreviewState::new();
        // Fill beyond capacity and verify the oldest untouched entry is the
        // one that gets evicted, while a recently touched entry survives.
        let cap = LINK_PREVIEW_CACHE_CAP;
        for i in 0..cap {
            state.put(format!("https://example.com/{i}"), None);
        }
        // Touch entry 0 — it becomes most-recently-used.
        let _ = state.get("https://example.com/0");
        // One more insert forces a single eviction.
        state.put("https://example.com/new".into(), None);

        assert!(
            state.get("https://example.com/0").is_some(),
            "touched entry must survive eviction"
        );
        assert!(
            state.get("https://example.com/1").is_none(),
            "oldest untouched entry must be evicted"
        );
        assert!(state.get("https://example.com/new").is_some());
    }

    #[test]
    fn paste_prepare_errors_for_unknown_id() {
        let state = fresh_state();
        let result = paste_prepare(&state, 9999, 0);
        assert!(result.is_err());
    }

    #[test]
    fn link_preview_state_caches_hits_and_misses() {
        let state = LinkPreviewState::new();
        let url = "https://example.com/page".to_string();
        assert!(state.get(&url).is_none());
        state.put(url.clone(), None);
        assert_eq!(state.get(&url), Some(None));
        let hit = LinkPreview {
            url: url.clone(),
            image: Some("https://cdn/og.png".into()),
            title: Some("T".into()),
            description: None,
            site_name: None,
        };
        state.put(url.clone(), Some(hit.clone()));
        assert_eq!(state.get(&url), Some(Some(hit)));
    }

    #[test]
    fn delete_item_removes_it() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("bye", 1).unwrap();

        delete_item(&state, id).unwrap();

        assert!(list_items(&state, 10).unwrap().is_empty());
    }

    #[test]
    fn single_audio_path_returns_path_for_single_audio_file() {
        let state = fresh_state();
        let id = state
            .repo
            .lock()
            .unwrap()
            .insert_files(
                "files:audio1",
                r#"{"files":[{"path":"/tmp/rec.m4a","name":"rec.m4a","mime":"audio/mp4"}]}"#,
                1,
            )
            .unwrap();
        let path = single_audio_path(&state, id).unwrap();
        assert_eq!(path, PathBuf::from("/tmp/rec.m4a"));
    }

    #[test]
    fn single_audio_path_errors_for_multi_file_item() {
        let state = fresh_state();
        let id = state
            .repo
            .lock()
            .unwrap()
            .insert_files(
                "files:multi",
                r#"{"files":[
                    {"path":"/tmp/a.m4a","name":"a.m4a","mime":"audio/mp4"},
                    {"path":"/tmp/b.m4a","name":"b.m4a","mime":"audio/mp4"}
                ]}"#,
                2,
            )
            .unwrap();
        assert!(single_audio_path(&state, id).is_err());
    }

    #[test]
    fn single_audio_path_errors_for_non_audio_file() {
        let state = fresh_state();
        let id = state
            .repo
            .lock()
            .unwrap()
            .insert_files(
                "files:pdf",
                r#"{"files":[{"path":"/tmp/doc.pdf","name":"doc.pdf","mime":"application/pdf"}]}"#,
                3,
            )
            .unwrap();
        assert!(single_audio_path(&state, id).is_err());
    }

    #[test]
    fn single_audio_path_errors_for_text_item() {
        let state = fresh_state();
        let id = state.repo.lock().unwrap().insert_text("plain text", 4).unwrap();
        assert!(single_audio_path(&state, id).is_err());
    }

    #[test]
    fn single_audio_path_falls_back_to_extension_when_mime_absent() {
        let state = fresh_state();
        let id = state
            .repo
            .lock()
            .unwrap()
            .insert_files(
                "files:nomine",
                r#"{"files":[{"path":"/tmp/voice.wav","name":"voice.wav"}]}"#,
                5,
            )
            .unwrap();
        let path = single_audio_path(&state, id).unwrap();
        assert_eq!(path, PathBuf::from("/tmp/voice.wav"));
    }
}
