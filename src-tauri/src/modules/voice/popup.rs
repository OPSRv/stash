//! Show / hide the floating voice capsule (`voice-popup` window).
//!
//! The window is declared in `tauri.conf.json` as hidden; this module
//! is the only place that raises it. Position is recomputed on every
//! show so a screen change between toggles still lands the capsule
//! at the bottom of whichever monitor the cursor is on.
//!
//! Like the main popup, the wry NSWindow gets converted into an
//! NSPanel via `tauri-nspanel` so the capsule can take key-window
//! status (for keyboard input) without yanking foreground focus from
//! the user's editor.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

const VOICE_LABEL: &str = "voice-popup";

/// Pin state for the voice popup. Mirrors the main popup's
/// `PopupAutoHide` flag — when pinned the blur handler skips
/// `win.hide()` so switching to another app leaves the capsule
/// floating on top. Stored as a dedicated state so it survives
/// re-creation of the window between hides.
pub struct VoicePopupAutoHide(pub AtomicBool);

impl Default for VoicePopupAutoHide {
    fn default() -> Self {
        // auto-hide on by default — same UX as the unpinned main popup.
        Self(AtomicBool::new(true))
    }
}
/// Vertical gap between the capsule's bottom edge and the screen
/// bottom. Mirrors macOS Dictation HUD spacing — far enough off the
/// edge to dodge an auto-hidden Dock without floating in the middle
/// of the screen.
const SCREEN_BOTTOM_INSET: f64 = 80.0;

#[tauri::command]
pub fn voice_popup_show(app: AppHandle) -> Result<(), String> {
    show_inner(&app)
}

#[tauri::command]
pub fn voice_popup_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(VOICE_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

/// Pin / unpin the voice popup. Mirrors `set_popup_pinned` in lib.rs
/// for the main popup: bumps the NSPanel level above other windows
/// (NSStatusWindowLevel = 25), turns off auto-hide-on-blur so app
/// switches don't dismiss it, and re-applies `set_hides_on_deactivate`
/// because AppKit can reset that flag when the level changes.
#[tauri::command]
pub fn voice_popup_set_pinned(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<VoicePopupAutoHide>>,
    pinned: bool,
) -> Result<(), String> {
    state.0.store(!pinned, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel(VOICE_LABEL) {
            let level: i64 = if pinned { 25 } else { 3 };
            panel.set_level(level);
            panel.set_hides_on_deactivate(false);
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(win) = app.get_webview_window(VOICE_LABEL) {
        let _ = win.set_always_on_top(pinned);
    }
    Ok(())
}

#[tauri::command]
pub fn voice_popup_get_pinned(
    state: tauri::State<'_, std::sync::Arc<VoicePopupAutoHide>>,
) -> bool {
    !state.0.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn voice_popup_toggle(app: AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window(VOICE_LABEL) else {
        return Err("voice popup window missing".into());
    };
    let visible = win.is_visible().unwrap_or(false);
    if visible {
        let _ = win.hide();
        Ok(())
    } else {
        show_inner(&app)
    }
}

fn show_inner(app: &AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(VOICE_LABEL)
        .ok_or_else(|| "voice popup window missing".to_string())?;

    if let Err(e) = position_bottom_center(&win) {
        tracing::warn!(error = %e, "voice popup: positioning failed, falling back to last spot");
    }

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

fn position_bottom_center(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    let monitor = win
        .current_monitor()?
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let scale = monitor.scale_factor();

    let win_size = win.outer_size()?;
    let win_w = win_size.width as f64 / scale;
    let win_h = win_size.height as f64 / scale;
    let mon_w = mon_size.width as f64 / scale;
    let mon_h = mon_size.height as f64 / scale;
    let x_logical = mon_pos.x as f64 / scale + (mon_w - win_w) / 2.0;
    let y_logical = mon_pos.y as f64 / scale + mon_h - win_h - SCREEN_BOTTOM_INSET;

    win.set_position(tauri::LogicalPosition::new(x_logical, y_logical))?;
    Ok(())
}

/// Convert the wry NSWindow to an NSPanel — same shim the main popup
/// uses, just a separate panel class so each window keeps its own
/// `to_panel` registration. Called once during `setup` after the
/// window object exists.
#[cfg(target_os = "macos")]
pub fn convert_voice_popup(win: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri_nspanel::{
        objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask},
        tauri_panel, WebviewWindowExt,
    };

    tauri_panel! {
        panel!(VoicePanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }

    let panel = win
        .to_panel::<VoicePanel>()
        .map_err(|e| format!("to_panel: {e:?}"))?;

    let style = NSWindowStyleMask::Borderless
        .union(NSWindowStyleMask::FullSizeContentView)
        .union(NSWindowStyleMask::NonactivatingPanel);
    panel.set_style_mask(style);

    let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        .union(NSWindowCollectionBehavior::FullScreenAuxiliary)
        .union(NSWindowCollectionBehavior::Stationary);
    panel.set_collection_behavior(behavior);

    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);

    Ok(())
}
