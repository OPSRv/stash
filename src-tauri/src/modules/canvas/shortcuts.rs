//! User-rebindable global capture shortcuts. The two accelerators (Capture →
//! Image / Capture → Text) live in this state; the global-shortcut handler in
//! `lib.rs` compares the pressed shortcut against them, and the frontend's
//! Canvas settings re-register them via `canvas_set_capture_shortcuts`.

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const DEFAULT_IMAGE_ACCEL: &str = "CommandOrControl+Shift+S";
pub const DEFAULT_TEXT_ACCEL: &str = "CommandOrControl+Shift+O";

#[derive(Default)]
pub struct CanvasShortcutState {
    pub image: Mutex<Option<Shortcut>>,
    pub text: Mutex<Option<Shortcut>>,
}

fn parse(accel: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accel).map_err(|e| format!("invalid shortcut '{accel}': {e}"))
}

/// (Re)register both capture shortcuts, unregistering whatever was bound before.
/// Best-effort per shortcut so a conflict on one doesn't strand the other.
pub fn apply(app: &AppHandle, image_accel: &str, text_accel: &str) -> Result<(), String> {
    let state = app.state::<CanvasShortcutState>();
    let gs = app.global_shortcut();

    let new_image = parse(image_accel)?;
    {
        let mut slot = state.image.lock().map_err(|e| e.to_string())?;
        if let Some(old) = slot.take() {
            let _ = gs.unregister(old);
        }
        if let Err(e) = gs.register(new_image) {
            tracing::warn!(error = %e, accel = image_accel, "canvas: capture-image shortcut register failed");
        } else {
            *slot = Some(new_image);
        }
    }

    let new_text = parse(text_accel)?;
    {
        let mut slot = state.text.lock().map_err(|e| e.to_string())?;
        if let Some(old) = slot.take() {
            let _ = gs.unregister(old);
        }
        if let Err(e) = gs.register(new_text) {
            tracing::warn!(error = %e, accel = text_accel, "canvas: capture-text shortcut register failed");
        } else {
            *slot = Some(new_text);
        }
    }
    Ok(())
}

/// True when `pressed` is the currently-bound capture-image shortcut.
pub fn is_image(app: &AppHandle, pressed: &Shortcut) -> bool {
    app.state::<CanvasShortcutState>()
        .image
        .lock()
        .map(|s| s.as_ref() == Some(pressed))
        .unwrap_or(false)
}

/// True when `pressed` is the currently-bound capture-text shortcut.
pub fn is_text(app: &AppHandle, pressed: &Shortcut) -> bool {
    app.state::<CanvasShortcutState>()
        .text
        .lock()
        .map(|s| s.as_ref() == Some(pressed))
        .unwrap_or(false)
}

#[tauri::command]
pub fn canvas_set_capture_shortcuts(
    app: AppHandle,
    image: String,
    text: String,
) -> Result<(), String> {
    apply(&app, &image, &text)
}
