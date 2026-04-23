//! Read the currently-frontmost macOS app via `NSWorkspace`.
//!
//! This is the primitive every context-aware feature in Stash wants to
//! build on: translator targeting the selection in Xcode, AI shell
//! pre-filling "this is from Telegram", auto-switching the popup to the
//! tab most relevant to where the user is (Terminal when in VS Code,
//! Notes when in a chat app). The primitive itself is stateless and
//! cheap — callers fetch on demand, they don't have to subscribe.
//!
//! We deliberately don't run an NSNotificationCenter observer here.
//! `NSWorkspaceDidActivateApplicationNotification` is the idiomatic
//! push-model for activation changes, but hooking it from Rust FFI
//! needs a heap-allocated Objective-C block and a static observer
//! object — dead weight until the first consumer shows up.

#![cfg(target_os = "macos")]

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::NSString;
use serde::Serialize;

/// Snapshot of the frontmost app at call time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrontmostApp {
    /// Reverse-DNS bundle identifier (e.g. `com.apple.dt.Xcode`). `None`
    /// for apps that don't ship a bundle (rare — mostly daemons that
    /// still briefly become frontmost during agent-like activations).
    pub bundle_id: Option<String>,
    /// Localised, user-facing app name (e.g. "Xcode"). Falls back to
    /// an empty string if the runtime returns nil (shouldn't happen in
    /// practice but we don't want a panic on a corner case).
    pub name: String,
    /// Unix process identifier. Useful as a stable handle during a
    /// single session — two launches of the same app have different
    /// pids, so call-sites should re-fetch rather than cache.
    pub pid: i32,
}

/// Fetch the currently-frontmost app. Returns `None` when the system
/// reports no active app (possible during a login-window flash, or
/// very briefly during app-switcher transitions).
pub fn current() -> Option<FrontmostApp> {
    // SAFETY: `sharedWorkspace` returns a singleton that lives for the
    // process lifetime. `frontmostApplication` returns an autoreleased
    // `NSRunningApplication?` — we hold it just long enough to read
    // three attributes before letting it drop out of scope. All values
    // are copied into owned Rust `String`s so the lifetime is fine.
    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let app_opt = workspace.frontmostApplication();
        let app: &NSRunningApplication = app_opt.as_deref()?;

        let pid: i32 = msg_send![app, processIdentifier];

        let name = copy_ns_string(app, "localizedName");
        let bundle_id = copy_ns_string(app, "bundleIdentifier");

        Some(FrontmostApp {
            bundle_id,
            name: name.unwrap_or_default(),
            pid,
        })
    }
}

/// Helper: send `sel` to `obj`, expect an optional `NSString*`, clone
/// its UTF-8 contents into an owned `String`. Returns `None` when the
/// attribute is nil.
unsafe fn copy_ns_string(obj: &NSRunningApplication, sel: &str) -> Option<String> {
    let obj_ptr: *const NSRunningApplication = obj;
    let obj_any: *mut AnyObject = obj_ptr as *mut AnyObject;
    let ns_str_ptr: *const NSString = match sel {
        "localizedName" => msg_send![obj_any, localizedName],
        "bundleIdentifier" => msg_send![obj_any, bundleIdentifier],
        _ => return None,
    };
    if ns_str_ptr.is_null() {
        return None;
    }
    let ns_str: &NSString = &*ns_str_ptr;
    Some(ns_str.to_string())
}
