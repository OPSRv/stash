//! Tray icon + context menu.
//!
//! The menu has two dynamic sections stitched together on every rebuild:
//!
//!   1. A YT-Music player block at the top — title + prev/play/next — that
//!      appears only while something is playing. Driven by the
//!      `music:nowplaying` pings forwarded from the scheme handler in
//!      `lib.rs`.
//!   2. The module list below it. The webview reports the ordered list of
//!      visible modules via `tray_set_menu` on startup (and whenever the
//!      user later hides or reorders tabs in settings), and we cache it so
//!      player updates don't have to re-consult the frontend.
//!
//! Menu ids follow a simple scheme:
//!   - `show`                — open the popup
//!   - `quit`                — quit the app
//!   - `module:<id>`         — activate that module's tab in the popup
//!   - `player:music:play`   — toggle YT Music play/pause
//!   - `player:music:prev`   — previous track
//!   - `player:music:next`   — next track

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::{position_popup, resolve_popup, toggle_popup, PopupPositionState};

/// Payload for one tray menu entry contributed by the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct TrayModuleItem {
    pub id: String,
    pub title: String,
    /// Accelerator string like `CmdOrCtrl+Alt+1`. Optional — modules without
    /// a `tabShortcutDigit` leave this unset.
    #[serde(default)]
    pub accelerator: Option<String>,
    /// Raw PNG bytes for the item's icon. When absent the entry falls back
    /// to a plain text menu item so the menu always renders even if the
    /// webview failed to rasterise the SVG.
    #[serde(default)]
    pub icon_png: Option<Vec<u8>>,
}

/// Snapshot of the currently-playing YT Music track. `None` when nothing is
/// playing or the user closed the Music tab.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayerSnapshot {
    pub playing: bool,
    pub title: String,
    pub artist: String,
}

impl PlayerSnapshot {
    fn is_active(&self) -> bool {
        // Treat any known title as "active" — paused tracks still merit a
        // transport row so the user can hit Play again from the tray.
        !self.title.is_empty()
    }
}

/// PNG byte payload for the four transport icons. Populated once at popup
/// boot via `tray_set_player_icons` and then reused on every rebuild.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct PlayerIcons {
    #[serde(default)]
    pub prev: Option<Vec<u8>>,
    #[serde(default)]
    pub play: Option<Vec<u8>>,
    #[serde(default)]
    pub pause: Option<Vec<u8>>,
    #[serde(default)]
    pub next: Option<Vec<u8>>,
}

/// Aggregated state driving the tray menu. Held behind an `Arc` in managed
/// state so both the webview command and the scheme-handler music bridge
/// can mutate it without passing it around.
pub struct TrayState {
    modules: Mutex<Vec<TrayModuleItem>>,
    music: Mutex<PlayerSnapshot>,
    player_icons: Mutex<PlayerIcons>,
    /// Raw PNG bytes of the current track's cover art, rasterised by the
    /// webview from `state.artwork` (the YT-Music thumbnail URL). Resets
    /// to `None` whenever nothing is playing.
    artwork: Mutex<Option<Vec<u8>>>,
    /// `true` when the active Pomodoro session is paused — shows "Resume
    /// Pomodoro" in the context menu below the music block.
    pomodoro_paused: Mutex<bool>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            modules: Mutex::new(Vec::new()),
            music: Mutex::new(PlayerSnapshot::default()),
            player_icons: Mutex::new(PlayerIcons::default()),
            artwork: Mutex::new(None),
            pomodoro_paused: Mutex::new(false),
        }
    }
}

/// Cheap snapshot of the current track — used by the Telegram `/music`
/// command so it doesn't have to reach into the YouTube Music webview
/// synchronously.
pub fn read_music_snapshot(state: &TrayState) -> PlayerSnapshot {
    state.music.lock().unwrap().clone()
}

/// Forward a scraped YT-Music status into tray state. Returns `true` when
/// the snapshot actually changed, so the caller can skip rebuilding the
/// native menu on the noisy 2 s polling cadence.
pub fn on_music_nowplaying(
    app: &AppHandle,
    playing: bool,
    title: String,
    artist: String,
) -> bool {
    let state = match app.try_state::<Arc<TrayState>>() {
        Some(s) => s,
        None => return false,
    };
    let next = PlayerSnapshot {
        playing,
        title,
        artist,
    };
    let changed = {
        let mut cur = state.music.lock().unwrap();
        if *cur == next {
            false
        } else {
            *cur = next;
            true
        }
    };
    if changed {
        rebuild(app);
    }
    changed
}

/// Create and install the tray icon with the initial menu. Call once from
/// `setup` after `app.manage(Arc::new(TrayState::new()))`.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Arc<TrayState>>();
    let menu = build_menu(
        app,
        &state.modules.lock().unwrap(),
        &state.music.lock().unwrap(),
        &state.player_icons.lock().unwrap(),
        state.artwork.lock().unwrap().as_deref(),
        false,
    )?;

    let tray_icon = {
        let bytes = include_bytes!("../icons/tray.png");
        Image::from_bytes(bytes)
            .ok()
            .unwrap_or_else(|| app.default_window_icon().expect("tray icon missing from bundle").clone())
    };
    TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            tauri_plugin_positioner::on_tray_event(app, &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(win) = resolve_popup(app) {
                    let pos_state = app.state::<Arc<PopupPositionState>>();
                    toggle_popup(&win, &pos_state);
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the tray context menu from the webview-supplied module list.
#[tauri::command]
pub fn tray_set_menu(app: AppHandle, items: Vec<TrayModuleItem>) -> Result<(), String> {
    let state = app.state::<Arc<TrayState>>();
    {
        let mut cur = state.modules.lock().unwrap();
        *cur = items;
    }
    rebuild(&app);
    Ok(())
}

/// Seed the four transport-icon PNGs once at popup boot. Kept separate from
/// `tray_set_menu` because the icons are static across module-list changes.
#[tauri::command]
pub fn tray_set_player_icons(app: AppHandle, icons: PlayerIcons) -> Result<(), String> {
    let state = app.state::<Arc<TrayState>>();
    *state.player_icons.lock().unwrap() = icons;
    rebuild(&app);
    Ok(())
}

/// Push the current track's cover art (PNG bytes) into tray state. Pass
/// `None` to clear (e.g. when playback stops or the artwork URL vanishes).
#[tauri::command]
pub fn tray_set_player_artwork(app: AppHandle, bytes: Option<Vec<u8>>) -> Result<(), String> {
    let state = app.state::<Arc<TrayState>>();
    {
        let mut cur = state.artwork.lock().unwrap();
        *cur = bytes;
    }
    rebuild(&app);
    Ok(())
}

/// Called from `emit_snapshot` whenever the pomodoro status changes. Updates
/// the `pomodoro_paused` flag in `TrayState` and rebuilds the menu so the
/// "Resume Pomodoro" item appears or disappears immediately.
pub fn notify_pomodoro_changed(app: &AppHandle, is_paused: bool) {
    let state = match app.try_state::<Arc<TrayState>>() {
        Some(s) => s,
        None => return,
    };
    {
        let mut flag = state.pomodoro_paused.lock().unwrap();
        if *flag == is_paused {
            return;
        }
        *flag = is_paused;
    }
    rebuild(app);
}

/// Set (or clear) the text shown *next to* the tray icon in the menubar.
/// Passing `None` removes the label so the icon reverts to bare glyph.
///
/// Used for at-a-glance state that belongs in the menubar rather than
/// inside the popup — pomodoro countdown is the canonical consumer: the
/// user doesn't want to pop the panel every 30 seconds just to see
/// "how much is left". This is the whole point of a menubar app.
pub fn set_title(app: &AppHandle, title: Option<&str>) {
    if let Some(tray) = app.tray_by_id("main") {
        // Workaround for `tray-icon 0.21.3` on macOS: passing `None` to
        // `set_title` is a silent no-op — the crate's `set_title_inner`
        // only touches `NSStatusItem.button.title` on the `Some` branch,
        // so the previous label (e.g. a stale "⏸ 12:34" from a paused
        // pomodoro) lingers even after the session is stopped. Coerce
        // `None` into `Some("")` so AppKit actually resets the label to
        // the empty string.
        let coerced: Option<&str> = Some(title.unwrap_or(""));
        if let Err(err) = tray.set_title(coerced) {
            tracing::warn!(error = %err, "tray: set_title failed");
        }
    }
}

fn rebuild(app: &AppHandle) {
    let state = match app.try_state::<Arc<TrayState>>() {
        Some(s) => s,
        None => return,
    };
    let modules = state.modules.lock().unwrap().clone();
    let music = state.music.lock().unwrap().clone();
    let icons = state.player_icons.lock().unwrap().clone();
    let artwork = state.artwork.lock().unwrap().clone();
    let pomodoro_paused = *state.pomodoro_paused.lock().unwrap();
    let menu = match build_menu(app, &modules, &music, &icons, artwork.as_deref(), pomodoro_paused) {
        Ok(m) => m,
        Err(err) => {
            tracing::warn!(error = %err, "tray: rebuild failed");
            return;
        }
    };
    if let Some(tray) = app.tray_by_id("main") {
        if let Err(err) = tray.set_menu(Some(menu)) {
            tracing::warn!(error = %err, "tray: set_menu failed");
        }
    }
}

fn build_menu(
    app: &AppHandle,
    items: &[TrayModuleItem],
    music: &PlayerSnapshot,
    icons: &PlayerIcons,
    artwork: Option<&[u8]>,
    pomodoro_paused: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;

    if music.is_active() {
        append_music_block(app, &menu, music, icons, artwork)?;
    }

    if pomodoro_paused {
        if music.is_active() {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        let resume = MenuItem::with_id(app, "pomodoro:resume", "Resume Pomodoro", true, None::<&str>)?;
        menu.append(&resume)?;
    }

    if music.is_active() || pomodoro_paused {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    let show = MenuItem::with_id(app, "show", "Open Stash", true, None::<&str>)?;
    menu.append(&show)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    for it in items {
        let id = format!("module:{}", it.id);
        let icon = it
            .icon_png
            .as_deref()
            .and_then(|bytes| Image::from_bytes(bytes).ok());
        if let Some(icon) = icon {
            let item = IconMenuItem::with_id(
                app,
                id,
                &it.title,
                true,
                Some(icon),
                it.accelerator.as_deref(),
            )?;
            menu.append(&item)?;
        } else {
            let item = MenuItem::with_id(app, id, &it.title, true, it.accelerator.as_deref())?;
            menu.append(&item)?;
        }
    }

    if !items.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let quit = MenuItem::with_id(app, "quit", "Quit Stash", true, None::<&str>)?;
    menu.append(&quit)?;
    Ok(menu)
}

fn append_music_block(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    music: &PlayerSnapshot,
    icons: &PlayerIcons,
    artwork: Option<&[u8]>,
) -> tauri::Result<()> {
    let label = format_now_playing_label(music);
    // Disabled label so macOS greys it out — acts as a header, not a target.
    // When we have the album artwork as PNG bytes, render it as the row's
    // leading icon; otherwise fall back to a plain text item.
    let art = artwork.and_then(|b| Image::from_bytes(b).ok());
    if let Some(art) = art {
        let title = IconMenuItem::with_id(
            app,
            "player:music:title",
            label,
            false,
            Some(art),
            None::<&str>,
        )?;
        menu.append(&title)?;
    } else {
        let title = MenuItem::with_id(app, "player:music:title", label, false, None::<&str>)?;
        menu.append(&title)?;
    }

    append_transport(app, menu, "player:music:prev", "Previous Track", &icons.prev)?;
    let (play_id, play_label, play_icon) = if music.playing {
        ("player:music:play", "Pause", &icons.pause)
    } else {
        ("player:music:play", "Play", &icons.play)
    };
    append_transport(app, menu, play_id, play_label, play_icon)?;
    append_transport(app, menu, "player:music:next", "Next Track", &icons.next)?;
    Ok(())
}

fn append_transport(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    id: &str,
    label: &str,
    icon_bytes: &Option<Vec<u8>>,
) -> tauri::Result<()> {
    let icon = icon_bytes
        .as_deref()
        .and_then(|b| Image::from_bytes(b).ok());
    if let Some(icon) = icon {
        let item = IconMenuItem::with_id(app, id, label, true, Some(icon), None::<&str>)?;
        menu.append(&item)?;
    } else {
        let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
        menu.append(&item)?;
    }
    Ok(())
}

/// Produce the greyed-out header line for the music block. Title truncates
/// at 48 visible chars because the macOS tray context menu cuts off longer
/// labels with an ellipsis anyway — doing it ourselves keeps the "by artist"
/// suffix visible even for 12-minute progressive-rock tracks.
pub fn format_now_playing_label(music: &PlayerSnapshot) -> String {
    let title = truncate_chars(&music.title, 48);
    if music.artist.is_empty() {
        title
    } else {
        let artist = truncate_chars(&music.artist, 32);
        format!("{title} — {artist}")
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "show" => show_popup(app),
        "player:music:play" => {
            let _ = crate::modules::music::commands::music_play_pause(app.clone());
        }
        "player:music:next" => {
            let _ = crate::modules::music::commands::music_next(app.clone());
        }
        "player:music:prev" => {
            let _ = crate::modules::music::commands::music_prev(app.clone());
        }
        "player:music:title" => { /* disabled header — unreachable */ }
        "pomodoro:resume" => {
            let _ = crate::modules::pomodoro::commands::pomodoro_resume_from_tray(app.clone());
        }
        other => {
            if let Some(module_id) = other.strip_prefix("module:") {
                show_popup(app);
                let _ = app.emit("nav:activate", module_id.to_string());
            }
        }
    }
}

fn show_popup(app: &AppHandle) {
    if let Some(win) = resolve_popup(app) {
        let pos_state = app.state::<Arc<PopupPositionState>>();
        position_popup(&win, &pos_state);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_uses_title_only_when_artist_empty() {
        let s = PlayerSnapshot {
            playing: true,
            title: "Some Song".into(),
            artist: "".into(),
        };
        assert_eq!(format_now_playing_label(&s), "Some Song");
    }

    #[test]
    fn label_joins_title_and_artist_with_em_dash() {
        let s = PlayerSnapshot {
            playing: true,
            title: "Some Song".into(),
            artist: "Some Artist".into(),
        };
        assert_eq!(format_now_playing_label(&s), "Some Song — Some Artist");
    }

    #[test]
    fn label_truncates_very_long_titles() {
        let s = PlayerSnapshot {
            playing: true,
            title: "X".repeat(80),
            artist: String::new(),
        };
        let label = format_now_playing_label(&s);
        // 48 chars + ellipsis.
        assert_eq!(label.chars().count(), 49);
        assert!(label.ends_with('…'));
    }

    #[test]
    fn snapshot_is_inactive_when_title_is_empty() {
        assert!(!PlayerSnapshot::default().is_active());
        let s = PlayerSnapshot {
            playing: false,
            title: "x".into(),
            artist: String::new(),
        };
        // Paused-but-known tracks still deserve a transport row.
        assert!(s.is_active());
    }
}
