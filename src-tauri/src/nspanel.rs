//! Convert the popup `NSWindow` into an `NSPanel` with the
//! `.nonactivatingPanel` style — the behaviour every first-class macOS
//! menubar utility uses (Raycast, Alfred, Paste, Bartender).
//!
//! Why this matters:
//!
//! * A regular `NSWindow` **activates the owning app** when it becomes
//!   key. Our popup is a menubar drop-down; if you're mid-edit in Figma
//!   / Xcode / a terminal and hit ⌘⇧V to peek at the clipboard, Stash
//!   yanking focus away from the active app breaks your workflow —
//!   caret disappears, IME resets, the active app redraws its title
//!   bar. With `.nonactivatingPanel` the popup takes keystrokes but
//!   the foreground app stays foreground.
//! * Plus, as a floating panel we get three quality-of-life bits for
//!   free: visible on every Space, visible over fullscreen apps, never
//!   shows up in ⌘Tab or Mission Control.
//!
//! Implementation notes:
//!
//! * We can't just OR `NSWindowStyleMaskNonactivatingPanel` into a
//!   regular `NSWindow` — that bit is only respected when the object
//!   is (or subclasses) `NSPanel`. The canonical trick is
//!   `object_setClass(nsWindow, [NSPanel class])` at runtime: Obj-C
//!   isa-swizzling is cheap, safe, and preserves the existing window's
//!   view hierarchy and state.
//! * We run this once, right after Tauri has finished creating the
//!   underlying `NSWindow`. The re-classed object keeps the same
//!   pointer so every `win.show()` / `win.hide()` / `win.set_focus()`
//!   call in the existing code keeps working.

#![cfg(target_os = "macos")]

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSPanel, NSWindowCollectionBehavior, NSWindowStyleMask};

/// Convert a Tauri WebviewWindow's underlying `NSWindow` into an
/// `NSPanel` configured as a non-activating floating panel.
///
/// Safe to call once during `setup()` after `get_webview_window("popup")`
/// resolves. Calling a second time is a no-op on style-mask (the
/// NonactivatingPanel bit is idempotent) but re-`object_setClass` to
/// the same class is also harmless.
pub fn convert_to_nonactivating_panel(win: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = win
        .ns_window()
        .map_err(|e| format!("ns_window: {e}"))?;
    if ns_window.is_null() {
        return Err("ns_window returned null".into());
    }

    // SAFETY: `ns_window()` hands us the live `NSWindow*` that Tauri
    // owns. We don't retain/release it; we only re-class it and mutate
    // properties via `msg_send!`. The pointer lives for the lifetime of
    // the popup window, which outlives this function.
    unsafe {
        let obj = &*(ns_window as *const AnyObject);

        // Isa-swizzle: NSWindow → NSPanel. Subsequent msg_sends to
        // NSPanel-only selectors (`setFloatingPanel:`, etc.) become
        // valid. `AnyObject::set_class` returns the old class; we
        // ignore it.
        let panel_cls = <NSPanel as objc2::ClassType>::class();
        let _old = AnyObject::set_class(obj, panel_cls);

        // Turn on `.nonactivatingPanel`. ORing preserves whatever mask
        // Tauri applied (Borderless | Resizable | FullSizeContentView).
        let mask: NSWindowStyleMask = msg_send![obj, styleMask];
        let new_mask = NSWindowStyleMask(mask.0 | NSWindowStyleMask::NonactivatingPanel.0);
        let _: () = msg_send![obj, setStyleMask: new_mask];

        // `floatingPanel` keeps the panel above normal windows in its
        // level. We deliberately *don't* set `becomesKeyOnlyIfNeeded`:
        // Stash relies on arrow-key navigation in lists (clipboard
        // history, global search) right after ⌘⇧V, before the user
        // clicks into any text field. With `.nonactivatingPanel` the
        // panel still becomes key on show — but crucially, that no
        // longer also activates the parent app, so the foreground
        // app's caret/IME stay where they were.
        let _: () = msg_send![obj, setFloatingPanel: true];

        // Collection behavior:
        // * CanJoinAllSpaces — popup is visible on whichever Space the
        //   user is on when they press ⌘⇧V, no Space-switch.
        // * FullScreenAuxiliary — shows over fullscreen apps instead of
        //   being hidden behind them.
        // * Stationary — don't animate across Spaces when swiping.
        let beh = NSWindowCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces.0
                | NSWindowCollectionBehavior::FullScreenAuxiliary.0
                | NSWindowCollectionBehavior::Stationary.0,
        );
        let _: () = msg_send![obj, setCollectionBehavior: beh];

        // Hide from the ⌘Tab app switcher / Mission Control Windows
        // list — the popup is a transient UI, not a document window.
        let _: () = msg_send![obj, setHidesOnDeactivate: false];
    }

    Ok(())
}
