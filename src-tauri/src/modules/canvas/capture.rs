//! Screen capture + OCR for Canvas. Capture uses the macOS `screencapture`
//! CLI in interactive mode (`-i`) — the same native crosshair selection the
//! system screenshot uses, with no ScreenCaptureKit FFI or extra entitlement.
//! OCR reuses the app's existing Apple Vision path (`ocr::vision`).
//!
//! Two flows:
//!   * image → returns base64 PNG so the caller can open it in the editor.
//!   * text  → OCRs the capture, writes the text to the clipboard, emits
//!     `canvas:ocr-text`, and returns the text.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{AppHandle, Emitter};

/// Recognised OCR text plus how many lines were detected — payload for the
/// `canvas:ocr-text` event the Capture→Text popup listens to.
#[derive(Clone, serde::Serialize)]
pub struct OcrResult {
    pub text: String,
}

#[cfg(target_os = "macos")]
fn unique_temp() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("stash-canvas-{}-{}.png", std::process::id(), nanos))
}

/// Run interactive region capture to a temp PNG. Returns the path on success,
/// or `None` when the user pressed Esc (screencapture writes no file then).
#[cfg(target_os = "macos")]
fn capture_region_to_temp() -> Result<Option<PathBuf>, String> {
    let path = unique_temp();
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-i") // interactive selection
        .arg("-x") // no capture sound
        .arg(&path)
        .status()
        .map_err(|e| format!("screencapture failed to launch: {e}"))?;
    if !status.success() {
        return Ok(None);
    }
    match std::fs::metadata(&path) {
        Ok(m) if m.len() > 0 => Ok(Some(path)),
        // Esc / empty selection — no file or a zero-byte file.
        _ => Ok(None),
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_region_to_temp() -> Result<Option<PathBuf>, String> {
    Err("screen capture is macOS-only".into())
}

/// Capture a region and return it as base64 PNG (None if cancelled).
pub fn capture_for_image(_app: &AppHandle) -> Result<Option<String>, String> {
    let Some(path) = capture_region_to_temp()? else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(Some(STANDARD.encode(bytes)))
}

/// Capture a region, OCR it, write the text to the clipboard, emit
/// `canvas:ocr-text`, and return the recognised text (None if cancelled).
pub fn capture_and_ocr(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(path) = capture_region_to_temp()? else {
        return Ok(None);
    };
    let text = crate::modules::ocr::vision::recognize_text(&path);
    let _ = std::fs::remove_file(&path);
    let text = text?;
    if !text.is_empty() {
        write_clipboard(app, &text);
    }
    let _ = app.emit("canvas:ocr-text", OcrResult { text: text.clone() });
    Ok(Some(text))
}

/// OCR an existing image file (used by the agent tool when handed a path).
pub fn ocr_file(path: &std::path::Path) -> Result<String, String> {
    crate::modules::ocr::vision::recognize_text(path)
}

fn write_clipboard(app: &AppHandle, text: &str) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    if let Err(e) = app.clipboard().write_text(text.to_string()) {
        tracing::warn!(error = %e, "canvas: clipboard write failed");
    }
}

// ---- frontend-facing commands -----------------------------------------------

#[tauri::command]
pub fn canvas_capture_image(app: AppHandle) -> Result<Option<String>, String> {
    capture_for_image(&app)
}

#[tauri::command]
pub fn canvas_capture_text(app: AppHandle) -> Result<Option<String>, String> {
    capture_and_ocr(&app)
}
