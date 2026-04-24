//! Convert the popup WebviewWindow into a non-activating `NSPanel`.
//!
//! Why an NSPanel and not an NSWindow: a regular window, when made
//! key, activates its owning app. For a menubar popup that's a
//! workflow-breaker — ⌘⇧V from inside Xcode would pull focus out of
//! Xcode, kill the caret, reset IME, redraw the app title bar. Every
//! first-class macOS menubar utility (Raycast, Alfred, Paste,
//! Bartender) is an `NSPanel` with `.nonactivatingPanel` for exactly
//! this reason. The popup still accepts keyboard input; the parent
//! app stays foreground.
//!
//! Why we use `tauri-nspanel` instead of rolling our own
//! `object_setClass` swizzle: wry's NSWindow subclass is 464 bytes
//! (carries extra ivars for event callbacks); stock `NSPanel` is
//! 456 bytes. `object_setClass` across mismatched instance sizes is
//! genuine UB and objc2 aborts at runtime when it sees it (that was
//! the crash in commit `ade94c3`). `tauri-nspanel` builds a custom
//! `NSPanel` subclass whose ivar layout matches wry's, making the
//! swizzle safe.

#![cfg(target_os = "macos")]

use tauri::Manager;
use tauri_nspanel::{
    objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask},
    tauri_panel, WebviewWindowExt,
};

tauri_panel! {
    // Popup panel config:
    // * `can_become_key_window: true` — we rely on arrow-key list
    //   navigation (clipboard history, global search) right after
    //   ⌘⇧V, so the panel has to accept key-window status.
    // * `can_become_main_window: false` — the popup is auxiliary,
    //   never the document-scoped "main" window.
    // * `is_floating_panel: true` — stays above regular windows in
    //   the window-level stack.
    panel!(StashPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

/// Convert the popup window into an `NSPanel` and apply the
/// non-activating / floating / all-Spaces configuration. Safe to call
/// once at setup; subsequent calls would fail because the window is
/// already registered in the panel-manager store (tauri-nspanel
/// enforces unique labels).
pub fn convert_popup(win: &tauri::WebviewWindow) -> Result<(), String> {
    let panel = win
        .to_panel::<StashPanel>()
        .map_err(|e| format!("to_panel: {e:?}"))?;

    // Style mask: keep the borderless + resizable pair Tauri's config
    // asked for (popup has `decorations: false`, `resizable: true`)
    // and OR in `NonactivatingPanel` — the bit that tells AppKit
    // "becoming key should not activate the owning app".
    //
    // Borderless is `0` so the `.union` with it is a no-op; we keep
    // it explicit for readability. Full-size content view gives the
    // webview room without a decoration strip.
    let style = NSWindowStyleMask::Borderless
        .union(NSWindowStyleMask::Resizable)
        .union(NSWindowStyleMask::FullSizeContentView)
        .union(NSWindowStyleMask::NonactivatingPanel);
    panel.set_style_mask(style);

    // Collection behavior:
    // * `CanJoinAllSpaces` — the popup appears on whichever Space the
    //   user is on when they hit ⌘⇧V; no Space-switch animation.
    // * `FullScreenAuxiliary` — visible over fullscreen apps instead
    //   of being hidden behind them.
    // * `Stationary` — don't animate across Spaces when the user
    //   three-finger-swipes; the popup stays put on the current
    //   Space until dismissed.
    let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        .union(NSWindowCollectionBehavior::FullScreenAuxiliary)
        .union(NSWindowCollectionBehavior::Stationary);
    panel.set_collection_behavior(behavior);

    // Extra belt-and-braces configuration that the panel macro's
    // `is_floating_panel: true` already implies; kept explicit so
    // future reviewers see the full picture without chasing macro
    // expansions.
    panel.set_floating_panel(true);
    // We want the window-blur auto-hide path (see `WindowEvent::
    // Focused(false)` handler in lib.rs) to keep firing; leaving
    // `hidesOnDeactivate` at false means the panel stays visible
    // when the user switches apps — we dismiss explicitly on blur
    // instead.
    panel.set_hides_on_deactivate(false);

    Ok(())
}
