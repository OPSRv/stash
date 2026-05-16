mod backup;
mod modules;
#[cfg(target_os = "macos")]
mod nspanel;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Popup auto-hide suppression flag. When `true`, the window's blur handler
/// will NOT hide the popup — used while a native modal (e.g. folder picker)
/// is open so taking focus from the popup does not dismiss the modal.
pub struct PopupAutoHide(pub AtomicBool);

#[tauri::command]
fn set_popup_auto_hide(state: tauri::State<'_, Arc<PopupAutoHide>>, enabled: bool) {
    state.0.store(enabled, Ordering::SeqCst);
}

/// Persisted popup window position. While `user_moved == false`, the popup
/// re-anchors under the tray icon on every show (legacy behaviour). Once the
/// user drags it, we remember the spot and restore it on subsequent shows
/// until they call `popup_position_reset`.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct PopupPositionData {
    pub user_moved: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

pub struct PopupPositionState {
    pub path: std::path::PathBuf,
    pub data: Mutex<PopupPositionData>,
    /// Set right before any programmatic `set_position`/`move_window` so the
    /// resulting `WindowEvent::Moved` does not get attributed to the user.
    pub suppress_next_moved: AtomicBool,
}

impl PopupPositionState {
    fn load(path: std::path::PathBuf) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            data: Mutex::new(data),
            suppress_next_moved: AtomicBool::new(false),
        }
    }

    fn save(&self) {
        let snapshot = self.data.lock().unwrap().clone();
        if let Ok(s) = serde_json::to_string_pretty(&snapshot) {
            let _ = std::fs::write(&self.path, s);
        }
    }
}

/// Anchor the popup. Restores the user-chosen spot when present, otherwise
/// snaps under the tray icon. Always sets `suppress_next_moved` so the move
/// we just performed isn't mistaken for a user drag.
fn position_popup(win: &tauri::Window, state: &PopupPositionState) {
    let snapshot = state.data.lock().unwrap().clone();
    state.suppress_next_moved.store(true, Ordering::SeqCst);
    if snapshot.user_moved {
        if let (Some(x), Some(y)) = (snapshot.x, snapshot.y) {
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            return;
        }
    }
    let _ = win.move_window(Position::TrayCenter);
}

#[tauri::command]
fn popup_position_reset(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<PopupPositionState>>,
) -> Result<(), String> {
    {
        let mut d = state.data.lock().unwrap();
        d.user_moved = false;
        d.x = None;
        d.y = None;
    }
    state.save();
    if let Some(win) = resolve_popup(&app) {
        state.suppress_next_moved.store(true, Ordering::SeqCst);
        let _ = win.move_window(Position::TrayCenter);
    }
    let _ = app.emit("popup:position_changed", false);
    Ok(())
}

#[tauri::command]
fn popup_position_status(state: tauri::State<'_, Arc<PopupPositionState>>) -> bool {
    state.data.lock().unwrap().user_moved
}

/// Hide the popup — the same path the tray/⌘⇧V toggle uses. Exposed so the
/// frontend Esc handler can minimise to tray reliably regardless of which
/// child webview currently holds focus.
#[tauri::command]
fn hide_popup(app: tauri::AppHandle) {
    if let Some(win) = resolve_popup(&app) {
        let _ = win.hide();
    }
}

/// Toggle the popup's "always on top" pin. Bundles three things that have
/// to move together: the NSPanel window level (so the popup stays above
/// other apps' windows and fullscreen apps), `hidesOnDeactivate` (so
/// switching to another app doesn't make AppKit auto-hide the panel),
/// and the blur auto-hide flag the Tauri-side handler reads.
///
/// On macOS we deliberately do NOT also call `set_always_on_top` —
/// Tauri's implementation calls `NSWindow.setLevel(NSFloatingWindowLevel=3)`
/// which would silently clobber the higher level we just set, leaving the
/// pinned popup sitting *below* other floating windows even though the
/// pin button looks active.
#[tauri::command]
fn set_popup_pinned(app: tauri::AppHandle, pinned: bool) {
    if let Some(auto_hide) = app.try_state::<Arc<PopupAutoHide>>() {
        auto_hide.0.store(!pinned, Ordering::SeqCst);
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("popup") {
            // NSStatusWindowLevel = 25, above normal windows (0), floating
            // panels (3) and the menu bar (24). Combined with the
            // `FullScreenAuxiliary` collection behaviour set at panel
            // creation, the popup stays above fullscreen apps too. When
            // unpinned we drop back to NSFloatingWindowLevel = 3 (the
            // floating-panel default).
            let level: i64 = if pinned { 25 } else { 3 };
            panel.set_level(level);
            // Re-pin "stay visible when this app deactivates". We set it
            // once at panel creation, but AppKit can reset the flag when
            // the level changes, and missing this is why a pinned popup
            // would disappear the moment the user clicked into Xcode /
            // Chrome / Finder. Explicit re-apply keeps the contract.
            panel.set_hides_on_deactivate(false);
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(win) = resolve_popup(&app) {
        let _ = win.set_always_on_top(pinned);
    }
}
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use modules::ai::{
    commands::{
        ai_append_message, ai_chat_send, ai_create_session, ai_delete_api_key, ai_delete_session,
        ai_find_session_by_context, ai_get_api_key, ai_has_api_key, ai_list_messages,
        ai_list_sessions, ai_rename_session, ai_set_api_key,
    },
    keyring::{KeyringStore, SecretStore},
    repo::AiRepo,
    state::{AiState, KEYRING_SERVICE},
};
use modules::clipboard::{
    commands::{
        clipboard_clear, clipboard_copy_image_from_path, clipboard_copy_only, clipboard_delete,
        clipboard_link_preview, clipboard_list, clipboard_paste, clipboard_prune_files,
        clipboard_search, clipboard_set_transcription, clipboard_toggle_pin,
        clipboard_transcribe_item, prune_orphan_file_rows, save_file_to, ClipboardState,
        LinkPreviewState,
    },
    monitor::{ArboardReader, Monitor},
    repo::ClipboardRepo,
};
use modules::diarization::{
    diarization_delete, diarization_download, diarization_status, DiarizationState,
};
use modules::separator::{
    separator_cancel, separator_clear_completed, separator_delete, separator_download,
    separator_list_jobs, separator_remove_job, separator_run, separator_scan_disk,
    separator_status, SeparatorState,
};
use modules::downloader::{
    commands::{
        dl_cancel, dl_clear_completed, dl_delete, dl_detect, dl_detect_quick, dl_extract_subtitles,
        dl_ffmpeg_status, dl_install_ffmpeg, dl_list, dl_media_stream_url, dl_pause,
        dl_prune_history, dl_purge_cookies, dl_resume, dl_retry, dl_set_cookies_browser,
        dl_set_downloads_dir, dl_set_max_parallel, dl_set_rate_limit, dl_set_transcription,
        dl_start, dl_transcribe_job, dl_update_binary, dl_ytdlp_version,
    },
    jobs::JobRepo,
    runner::RunnerState,
};
use modules::media_server::{media_stream_url, MediaKind, MediaServerState};
use modules::metronome::commands::{
    metronome_get_state, metronome_save_state, MetronomeStateHandle,
};
use modules::music::commands::{
    music_close, music_embed, music_hide, music_next, music_play_pause, music_prev, music_reload,
    music_show, music_status,
};
use modules::notes::{
    commands::{
        notes_add_attachment, notes_audio_stream_url, notes_create, notes_delete,
        notes_export_path, notes_folder_create, notes_folder_delete, notes_folder_rename,
        notes_folders_list, notes_folders_reorder, notes_get, notes_image_stream_url,
        notes_list, notes_list_attachments, notes_read_audio_path, notes_read_file,
        notes_read_image_path, notes_remove_attachment, notes_save_audio_bytes,
        notes_save_audio_file, notes_save_image_bytes, notes_save_image_file,
        notes_save_video_file, notes_search, notes_set_attachment_transcription,
        notes_set_audio_transcription, notes_set_folder, notes_set_pinned,
        notes_transcribe_attachment, notes_transcribe_note_audio, notes_update,
        notes_video_stream_url, notes_write_file, NotesState,
    },
    repo::NotesRepo,
};
use modules::pomodoro::{
    commands::{
        pomodoro_delete_preset, pomodoro_edit_blocks, pomodoro_get_state, pomodoro_list_history,
        pomodoro_list_presets, pomodoro_pause, pomodoro_resume, pomodoro_save_preset,
        pomodoro_skip_to, pomodoro_start, pomodoro_stop,
    },
    driver::spawn as spawn_pomodoro_driver,
    repo::PomodoroRepo,
    state::PomodoroState,
};
use modules::search::commands::global_search;
use modules::system::commands::{
    system_adjust_brightness, system_battery_health, system_cancel_scan, system_dashboard_metrics,
    system_delete_tm_snapshot, system_delete_unavailable_simulators, system_docker_prune,
    system_docker_status, system_empty_memory_pressure, system_empty_trash, system_find_duplicates,
    system_find_leftovers, system_flush_dns, system_frontmost_app, system_kill_process,
    system_list_apps, system_list_caches, system_list_connections, system_list_displays,
    system_list_hardware_displays, system_list_ios_backups, system_list_launch_agents,
    system_list_mail_attachments, system_list_privacy, system_list_processes,
    system_list_screenshots, system_list_tm_snapshots, system_list_trash_bins,
    system_list_xcode_simulators, system_lock_screen, system_power_off_display,
    system_power_on_display, system_reindex_spotlight, system_scan_large_files,
    system_scan_node_modules, system_set_display_brightness, system_set_display_hidden,
    system_sleep_displays, system_sleep_now, system_toggle_launch_agent, system_trash_path,
};
use modules::telegram::commands::{
    telegram_cancel_pairing, telegram_clear_inbox, telegram_clear_token,
    telegram_delete_inbox_item, telegram_delete_memory, telegram_get_ai_settings,
    telegram_get_inbox_limits, telegram_get_notification_settings, telegram_has_token,
    telegram_list_inbox, telegram_list_memory, telegram_mark_inbox_routed,
    telegram_retry_transcribe, telegram_reveal_inbox_file, telegram_send_inbox_to_notes,
    telegram_send_text, telegram_set_ai_settings, telegram_set_inbox_limits,
    telegram_set_inbox_transcript, telegram_set_notification_settings, telegram_set_token,
    telegram_start_pairing, telegram_status, telegram_sweep_inbox, telegram_unpair,
};
use modules::terminal::commands::{
    pty_close, pty_get_cwd, pty_open, pty_resize, pty_set_cwd, pty_write, terminal_save_paste_blob,
};
use modules::terminal::state::TerminalState;
use modules::translator::{
    commands::{
        translator_clear, translator_delete, translator_list, translator_run, translator_search,
        translator_set_settings, TranslatorState,
    },
    repo::TranslationsRepo,
};
use modules::voice::commands::{
    voice_ask, voice_get_settings, voice_set_settings, voice_transcribe,
};
use modules::voice::popup::{voice_popup_hide, voice_popup_show, voice_popup_toggle};
use modules::webchat::commands::{
    webchat_back, webchat_close, webchat_close_all, webchat_current_url, webchat_embed,
    webchat_forward, webchat_hide, webchat_hide_all, webchat_reload, webchat_set_zoom,
    webchat_toggle_play,
};
use modules::whisper::{
    commands::{
        whisper_delete_model, whisper_download_model, whisper_get_active, whisper_list_models,
        whisper_set_active, whisper_transcribe_path,
    },
    state::WhisperStateHandle,
};

use rusqlite::Connection;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt};

/// Fast poll applied for ~30s after the last observed change. Keeps the
/// typical "copy, paste, copy again" burst feeling instant.
const CLIPBOARD_POLL_FAST_MS: u64 = 400;
/// Steady-state poll used when the pasteboard is quiet. Drops idle CPU to
/// ~0.5% on macOS versus a constant 500ms cadence, and the user never
/// notices because they're not copying anything.
const CLIPBOARD_POLL_IDLE_MS: u64 = 1_500;
/// Window after the last detected change during which we stay in fast mode.
const CLIPBOARD_FAST_WINDOW_MS: u128 = 30_000;
const CLIPBOARD_MAX_UNPINNED: usize = 1000;
/// Trim roughly every 60s of wall-clock regardless of current cadence.
const CLIPBOARD_TRIM_EVERY_MS: u128 = 60_000;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // `tauri-plugin-single-instance` MUST be the first plugin —
        // per its docs, later plugins may spawn background tasks or
        // acquire OS resources that we'd rather not duplicate if a
        // second launch is about to hand off to us.
        //
        // Runs in the *first* (already-live) process when a duplicate
        // launch is detected (Finder double-click, `open -a Stash`,
        // relaunch after update). Without this, each relaunch would
        // create a second tray icon, fight for the ⌘⇧V global shortcut,
        // and open a second SQLite connection to the same db file.
        // Auto-update plumbing. Requires:
        //   1. `./scripts/setup-updater.sh` once locally — generates the
        //      keypair, patches plugins.updater.pubkey in tauri.conf.json,
        //      prints the GitHub secrets to add.
        //   2. `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
        //      secrets set in the repo so release.yml signs each .app.tar.gz.
        //   3. release.yml produces `latest.json` and uploads it alongside
        //      the bundle; the in-app `UpdateCheckRow` calls the plugin to
        //      fetch + verify + install + relaunch.
        // The plugin reads pubkey from tauri.conf.json at startup; an empty
        // pubkey is a hard panic, which is fine: it means setup-updater.sh
        // hasn't been run yet and there'd be nothing to verify anyway.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(win) = resolve_popup(app) {
                let pos_state = app.state::<Arc<PopupPositionState>>();
                position_popup(&win, &pos_state);
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .register_uri_scheme_protocol("stashnp", |ctx, request| {
            // One-way channel used by the injected YouTube Music poller to
            // report the now-playing state. We only care about the URL query
            // string; emit the parsed payload as `music:nowplaying` so the
            // popup shell can render its compact bar. Always respond 204 so
            // the WKWebView scheme handler completes cleanly.
            let uri = request.uri().to_string();
            if let Some(q) = uri.split('?').nth(1) {
                let mut playing = false;
                let mut title = String::new();
                let mut artist = String::new();
                let mut artwork = String::new();
                let mut service = String::new();
                let mut kind = String::new();
                let mut state = String::new();
                let mut key = String::new();
                let mut shift = false;
                let mut nav_url = String::new();
                for pair in q.split('&') {
                    let mut it = pair.splitn(2, '=');
                    let k = it.next().unwrap_or("");
                    let val = it.next().unwrap_or("");
                    let decoded = percent_decode(val);
                    match k {
                        "playing" => playing = decoded == "1",
                        "title" => title = decoded,
                        "artist" => artist = decoded,
                        "artwork" => artwork = decoded,
                        "service" => service = decoded,
                        "kind" => kind = decoded,
                        "state" => state = decoded,
                        "key" => key = decoded,
                        "shift" => shift = decoded == "1",
                        "url" => nav_url = decoded,
                        _ => {}
                    }
                }
                let app = ctx.app_handle();
                match kind.as_str() {
                    // Loading ticks — frontend shows a thin progress bar per
                    // service. `state` is "start"|"end".
                    "loading" => {
                        let _ = app.emit(
                            "webchat:loading",
                            serde_json::json!({ "service": service, "state": state }),
                        );
                    }
                    // Esc inside a child webview → hide popup, same path as the
                    // tray / ⌘⇧V toggle / parent's Esc handler.
                    "hide" => {
                        if let Some(win) = resolve_popup(app) {
                            let _ = win.hide();
                        }
                    }
                    // Meta-chorded keys captured inside the child webview and
                    // bubbled up so the React shell can react (nav, zoom, URL
                    // bar focus, close tab).
                    "shortcut" => {
                        let _ = app.emit(
                            "webchat:shortcut",
                            serde_json::json!({
                                "service": service,
                                "key": key,
                                "shift": shift,
                            }),
                        );
                    }
                    // Live navigation ticks — URL + document title. Powers
                    // the address bar + favicon so they match the actual
                    // page the user is on rather than the home URL.
                    "nav" => {
                        let _ = app.emit(
                            "webchat:nav",
                            serde_json::json!({
                                "service": service,
                                "url": nav_url,
                                "title": title.clone(),
                            }),
                        );
                    }
                    // Default (missing or "np") — now-playing, same as before.
                    // `service` distinguishes a webchat report from the YT
                    // Music report; we fan them out on different events so
                    // the shell renders independent now-playing bars.
                    _ => {
                        let event = if service.is_empty() {
                            "music:nowplaying"
                        } else {
                            "webchat:nowplaying"
                        };
                        let _ = app.emit(
                            event,
                            serde_json::json!({
                                "service": service,
                                "playing": playing,
                                "title": title.clone(),
                                "artist": artist.clone(),
                                "artwork": artwork,
                            }),
                        );
                        if service.is_empty() {
                            tray::on_music_nowplaying(app, playing, title, artist);
                        }
                    }
                }
            }
            tauri::http::Response::builder()
                .status(204)
                .header("Access-Control-Allow-Origin", "*")
                .body(Vec::new())
                .unwrap()
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri::Emitter;
                    use tauri_plugin_global_shortcut::{Modifiers, ShortcutState};
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let mods = Modifiers::SUPER | Modifiers::SHIFT;
                    if shortcut.matches(mods, tauri_plugin_global_shortcut::Code::KeyV) {
                        if let Some(win) = resolve_popup(app) {
                            let pos_state = app.state::<Arc<PopupPositionState>>();
                            toggle_popup(&win, &pos_state);
                        }
                    } else if shortcut.matches(mods, tauri_plugin_global_shortcut::Code::KeyJ) {
                        // Quick-open Notes module and focus the editor. KeyJ
                        // ("Jot") avoids ⌘⇧N which Finder owns for New Folder.
                        if let Some(win) = resolve_popup(app) {
                            // `emit` stays on the AppHandle so child webviews
                            // also receive it. Pass the tab payload first.
                            let _ = app.emit("nav:activate", "notes");
                            let pos_state = app.state::<Arc<PopupPositionState>>();
                            position_popup(&win, &pos_state);
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    } else if shortcut.matches(mods, tauri_plugin_global_shortcut::Code::KeyA) {
                        // Toggle the floating Claude-style voice
                        // capsule (separate `voice-popup` window).
                        // The previous behaviour — open the main
                        // popup on the AI tab — is gone; the dedicated
                        // capsule fits the "talk anywhere, no app
                        // switch" feel a lot better than redirecting
                        // through a tab.
                        let _ = modules::voice::popup::voice_popup_toggle(app.clone());
                    }
                })
                .build(),
        );
    }

    builder
        .invoke_handler(tauri::generate_handler![
            clipboard_list,
            clipboard_search,
            clipboard_toggle_pin,
            clipboard_delete,
            clipboard_paste,
            clipboard_copy_only,
            clipboard_clear,
            clipboard_prune_files,
            clipboard_link_preview,
            clipboard_set_transcription,
            clipboard_transcribe_item,
            clipboard_copy_image_from_path,
            save_file_to,
            dl_detect,
            dl_detect_quick,
            dl_start,
            dl_cancel,
            dl_list,
            dl_delete,
            dl_extract_subtitles,
            dl_clear_completed,
            dl_set_downloads_dir,
            dl_set_cookies_browser,
            dl_set_max_parallel,
            dl_set_rate_limit,
            dl_prune_history,
            dl_pause,
            dl_resume,
            dl_retry,
            dl_set_transcription,
            dl_transcribe_job,
            dl_ytdlp_version,
            dl_update_binary,
            dl_ffmpeg_status,
            dl_install_ffmpeg,
            dl_purge_cookies,
            dl_media_stream_url,
            media_stream_url,
            open_data_folder,
            collect_logs,
            set_popup_vibrancy,
            set_popup_appearance,
            set_popup_auto_hide,
            popup_position_reset,
            popup_position_status,
            hide_popup,
            set_popup_pinned,
            open_system_settings,
            notes_list,
            notes_search,
            notes_get,
            notes_create,
            notes_update,
            notes_delete,
            notes_read_file,
            notes_write_file,
            notes_save_audio_bytes,
            notes_save_audio_file,
            notes_read_audio_path,
            notes_audio_stream_url,
            notes_save_image_bytes,
            notes_save_image_file,
            notes_read_image_path,
            notes_image_stream_url,
            notes_save_video_file,
            notes_video_stream_url,
            notes_list_attachments,
            notes_add_attachment,
            notes_remove_attachment,
            notes_set_pinned,
            notes_export_path,
            notes_set_audio_transcription,
            notes_set_attachment_transcription,
            notes_transcribe_note_audio,
            notes_transcribe_attachment,
            notes_folders_list,
            notes_folder_create,
            notes_folder_rename,
            notes_folder_delete,
            notes_folders_reorder,
            notes_set_folder,
            pomodoro_list_presets,
            pomodoro_save_preset,
            pomodoro_delete_preset,
            pomodoro_list_history,
            pomodoro_get_state,
            pomodoro_start,
            pomodoro_pause,
            pomodoro_resume,
            pomodoro_stop,
            pomodoro_skip_to,
            pomodoro_edit_blocks,
            whisper_list_models,
            whisper_download_model,
            whisper_delete_model,
            whisper_set_active,
            whisper_get_active,
            whisper_transcribe_path,
            voice_transcribe,
            voice_ask,
            voice_get_settings,
            voice_set_settings,
            voice_popup_show,
            voice_popup_hide,
            voice_popup_toggle,
            global_search,
            system_list_processes,
            system_kill_process,
            system_frontmost_app,
            system_list_displays,
            system_sleep_displays,
            system_adjust_brightness,
            system_scan_large_files,
            system_trash_path,
            system_list_caches,
            system_list_launch_agents,
            system_toggle_launch_agent,
            system_list_apps,
            system_find_leftovers,
            system_dashboard_metrics,
            system_list_trash_bins,
            system_empty_trash,
            system_scan_node_modules,
            system_list_screenshots,
            system_list_ios_backups,
            system_list_mail_attachments,
            system_list_xcode_simulators,
            system_delete_unavailable_simulators,
            system_list_tm_snapshots,
            system_delete_tm_snapshot,
            system_find_duplicates,
            system_battery_health,
            system_sleep_now,
            system_lock_screen,
            system_flush_dns,
            system_reindex_spotlight,
            system_empty_memory_pressure,
            system_list_privacy,
            system_list_connections,
            system_cancel_scan,
            system_list_hardware_displays,
            system_set_display_brightness,
            system_set_display_hidden,
            system_power_off_display,
            system_power_on_display,
            system_docker_status,
            system_docker_prune,
            music_status,
            music_embed,
            music_show,
            music_hide,
            music_close,
            music_reload,
            music_play_pause,
            music_next,
            music_prev,
            translator_run,
            translator_set_settings,
            translator_list,
            translator_search,
            translator_delete,
            translator_clear,
            metronome_get_state,
            metronome_save_state,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_set_cwd,
            pty_get_cwd,
            terminal_save_paste_blob,
            ai_list_sessions,
            ai_create_session,
            ai_find_session_by_context,
            ai_rename_session,
            ai_delete_session,
            ai_list_messages,
            ai_append_message,
            ai_get_api_key,
            ai_set_api_key,
            ai_delete_api_key,
            ai_has_api_key,
            ai_chat_send,
            telegram_set_token,
            telegram_clear_token,
            telegram_has_token,
            telegram_status,
            telegram_start_pairing,
            telegram_cancel_pairing,
            telegram_unpair,
            telegram_list_inbox,
            telegram_delete_inbox_item,
            telegram_mark_inbox_routed,
            telegram_send_inbox_to_notes,
            telegram_retry_transcribe,
            telegram_send_text,
            telegram_set_inbox_transcript,
            telegram_reveal_inbox_file,
            telegram_get_notification_settings,
            telegram_set_notification_settings,
            telegram_get_ai_settings,
            telegram_set_ai_settings,
            telegram_get_inbox_limits,
            telegram_set_inbox_limits,
            telegram_clear_inbox,
            telegram_sweep_inbox,
            telegram_list_memory,
            telegram_delete_memory,
            diarization_status,
            diarization_download,
            diarization_delete,
            separator_status,
            separator_download,
            separator_delete,
            separator_run,
            separator_cancel,
            separator_list_jobs,
            separator_clear_completed,
            separator_remove_job,
            separator_scan_disk,
            modules::ipc::install::stash_cli_status,
            modules::ipc::install::stash_cli_install,
            modules::ipc::install::stash_cli_uninstall,
            webchat_embed,
            webchat_hide,
            webchat_hide_all,
            webchat_reload,
            webchat_close,
            webchat_close_all,
            webchat_toggle_play,
            webchat_current_url,
            webchat_back,
            webchat_forward,
            webchat_set_zoom,
            tray::tray_set_menu,
            tray::tray_set_player_icons,
            tray::tray_set_player_artwork,
            backup::commands::backup_describe,
            backup::commands::backup_export,
            backup::commands::backup_suggest_filename,
            backup::commands::backup_inspect,
            backup::commands::backup_import,
            backup::commands::backup_last_error,
            backup::commands::backup_dismiss_error,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let trusted = macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
                if !trusted {
                    eprintln!(
                        "[stash] Accessibility permission not granted — paste will not work. \
                         Enable Stash in System Settings → Privacy & Security → Accessibility."
                    );
                }
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&data_dir).ok();
            init_tracing(&data_dir);
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                "stash starting"
            );
            // Apply any pending backup import *before* any repo opens its
            // SQLite connection — otherwise the replace-on-disk would race
            // with live connections and produce "malformed" errors.
            backup::import::apply_pending_if_any(&data_dir);
            let db_path = data_dir.join("stash.sqlite");
            let images_dir = data_dir.join("clipboard-images");
            std::fs::create_dir_all(&images_dir).ok();
            let repo = ClipboardRepo::new(Connection::open(&db_path)?)?;
            let state = ClipboardState {
                repo: Mutex::new(repo),
                images_dir: images_dir.clone(),
            };
            let shared_repo = Arc::new(state);
            app.manage(Arc::clone(&shared_repo));

            // Prune any leftover `kind='file'` rows that predate the
            // pasteboard promise-ID filter — WebKit drops like
            // `id=6571367.14836106` don't exist on disk and can't be
            // pasted anyway. Best-effort; errors don't abort startup.
            if let Err(e) = prune_orphan_file_rows(&shared_repo) {
                tracing::warn!("clipboard: prune_orphan_file_rows failed: {e}");
            }

            // Link-preview cache for clipboard URLs (og:image / og:title).
            app.manage(Arc::new(LinkPreviewState::new()));

            // Translator (shared state: settings + cache + history DB). Created
            // before the monitor thread so it can auto-translate new clips.
            let translations_db = data_dir.join("translations.sqlite");
            let translations_repo =
                TranslationsRepo::new(Connection::open(&translations_db)?)?;
            let translator_state =
                Arc::new(TranslatorState::new().with_repo(translations_repo));
            app.manage(Arc::clone(&translator_state));

            let state_for_thread = Arc::clone(&shared_repo);
            let images_dir_thread = images_dir.clone();
            let handle_for_thread = app.handle().clone();
            let translator_for_thread = Arc::clone(&translator_state);
            thread::spawn(move || {
                run_monitor(
                    state_for_thread,
                    images_dir_thread,
                    handle_for_thread,
                    translator_for_thread,
                )
            });

            // Shared loopback media server. One process-wide instance,
            // every module registers its own permitted roots. Boot the
            // accept loop is lazy — managing the state here only sets
            // up the dynamic root registry. See
            // `modules/media_server/mod.rs`.
            let media_server = Arc::new(MediaServerState::new());
            app.manage(Arc::clone(&media_server));

            // Downloader runtime
            let downloads_dir = dirs_next::video_dir()
                .unwrap_or_else(|| data_dir.join("Downloads"))
                .join("Stash");
            std::fs::create_dir_all(&downloads_dir).ok();
            // Downloads land in this dir as either audio or video — let
            // the media server stream both kinds from it. Re-pointed in
            // `dl_set_downloads_dir` when the user picks a new folder.
            media_server.register(MediaKind::Audio, downloads_dir.clone());
            media_server.register(MediaKind::Video, downloads_dir.clone());
            let dl_db_path = data_dir.join("downloads.sqlite");
            let mut dl_repo = JobRepo::new(Connection::open(&dl_db_path)?)?;
            // Prune completed/failed/cancelled rows older than 60 days on
            // startup so the Downloads list does not balloon over months.
            let prune_cutoff = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
                - 60 * 86_400;
            if let Err(e) = dl_repo.prune_completed_older_than(prune_cutoff) {
                eprintln!("[downloader] startup prune failed: {e}");
            }
            let runner_state = Arc::new(RunnerState::new(dl_repo, downloads_dir));
            app.manage(Arc::clone(&runner_state));

            // Notes
            let notes_db = data_dir.join("notes.sqlite");
            let notes_repo = NotesRepo::new(Connection::open(&notes_db)?)?;
            let notes_repo = Arc::new(Mutex::new(notes_repo));
            let notes_repo_for_telegram = Arc::clone(&notes_repo);
            app.manage(NotesState { repo: notes_repo });

            // Register the notes-managed roots with the shared media
            // server. Audio = inline voice memos + per-note attachments
            // + (optional) Stash Stems. Image = managed images +
            // attachments. Video = managed videos + attachments.
            if let Ok(audio_root) = modules::notes::commands::audio_dir(app.handle()) {
                media_server.register(MediaKind::Audio, audio_root);
            }
            if let Ok(attach_root) = modules::notes::commands::attachments_root(app.handle()) {
                media_server.register(MediaKind::Audio, attach_root.clone());
                media_server.register(MediaKind::Image, attach_root.clone());
                media_server.register(MediaKind::Video, attach_root);
            }
            if let Ok(image_root) = modules::notes::commands::image_dir(app.handle()) {
                media_server.register(MediaKind::Image, image_root);
            }
            if let Ok(video_root) = modules::notes::commands::video_dir(app.handle()) {
                media_server.register(MediaKind::Video, video_root);
            }
            if let Some(stems) = modules::notes::commands::stems_root() {
                media_server.register(MediaKind::Audio, stems);
            }

            // Pomodoro — timer engine runs in a std::thread so it survives
            // popup hide / webview unload. Frontend is only a projection.
            let pomodoro_db = data_dir.join("pomodoro.sqlite");
            let pomodoro_repo = PomodoroRepo::new(Connection::open(&pomodoro_db)?)?;
            let pomodoro_state = Arc::new(PomodoroState::new(pomodoro_repo));
            app.manage(Arc::clone(&pomodoro_state));
            spawn_pomodoro_driver(Arc::clone(&pomodoro_state), app.handle().clone());

            // Metronome — single JSON blob in app data dir.
            let metronome_path = data_dir.join("metronome.json");
            app.manage(MetronomeStateHandle::new(metronome_path));

            // Whisper — model files live in appData/whisper, config blob
            // tracks the active model id.
            let whisper_cfg = data_dir.join("whisper").join("state.json");
            app.manage(WhisperStateHandle::new(whisper_cfg));
            app.manage(DiarizationState::new());
            // Separator (Demucs + BeatNet sidecar). Wrapped in Arc so the
            // worker thread (`commands::run_worker`) can hold a reference
            // without juggling lifetimes through the Tauri state plumbing.
            app.manage(Arc::new(SeparatorState::new()));

            // Terminal — PTY session lazily opened by the first `pty_open`
            // call from the frontend (once the xterm fit addon knows the
            // actual cell grid).
            app.manage(Arc::new(TerminalState::new()));

            // AI — sessions/messages in dedicated SQLite, API keys in OS keychain
            // with the same probe-and-file-fallback the Telegram module uses
            // (see below). Without it, ad-hoc-signed release DMGs (no Apple
            // Developer ID) silently lose every `set_password` and the Telegram
            // assistant ends up with `LlmError::Auth` after a "successful" Save
            // in Settings → AI. The encrypted file at `<data>/ai/.secrets.bin`
            // keeps the flow working until the bundle ships with proper
            // codesigning.
            let ai_db = data_dir.join("ai.sqlite");
            let ai_repo = AiRepo::new(Connection::open(&ai_db)?)?;
            let ai_secrets: Arc<dyn SecretStore> =
                if modules::telegram::file_secrets::keyring_roundtrip_ok(KEYRING_SERVICE) {
                    tracing::info!("ai: OS keyring available, using Keychain");
                    Arc::new(KeyringStore::new(KEYRING_SERVICE))
                } else {
                    let secrets_dir = data_dir.join("ai");
                    std::fs::create_dir_all(&secrets_dir).ok();
                    let secrets_path = secrets_dir.join(".secrets.bin");
                    tracing::warn!(
                        path = %secrets_path.display(),
                        "ai: OS keyring unavailable (likely an unsigned build); falling back to encrypted file"
                    );
                    Arc::new(modules::telegram::file_secrets::FileSecretStore::new(
                        secrets_path,
                    )?)
                };
            app.manage(AiState::new(ai_repo, ai_secrets));

            // Telegram — own SQLite + own Keychain service. Wrapped in Arc so
            // the long-polling transport can clone a handle into its spawned
            // tokio task.
            //
            // Keychain requires a signed macOS binary to persist entries;
            // unsigned `tauri dev` builds silently succeed on set and then
            // return NoEntry on get. We probe at startup with a canary
            // value — if the round-trip fails we fall back to an encrypted
            // file in app data dir so the flow works end-to-end. Signed
            // release builds always pass the probe and use Keychain.
            let telegram_db = data_dir.join("telegram.sqlite");
            let telegram_repo = modules::telegram::repo::TelegramRepo::new(
                Connection::open(&telegram_db)?,
            )?;
            let telegram_secrets: Arc<dyn modules::telegram::keyring::SecretStore> =
                if modules::telegram::file_secrets::keyring_roundtrip_ok(
                    modules::telegram::keyring::KEYRING_SERVICE,
                ) {
                    tracing::info!("telegram: OS keyring available, using Keychain");
                    Arc::new(modules::telegram::keyring::KeyringStore::new(
                        modules::telegram::keyring::KEYRING_SERVICE,
                    ))
                } else {
                    let secrets_dir = data_dir.join("telegram");
                    std::fs::create_dir_all(&secrets_dir).ok();
                    let secrets_path = secrets_dir.join(".secrets.bin");
                    tracing::warn!(
                        path = %secrets_path.display(),
                        "telegram: OS keyring unavailable (unsigned dev build?), using file fallback"
                    );
                    Arc::new(modules::telegram::file_secrets::FileSecretStore::new(
                        secrets_path,
                    )?)
                };
            let telegram_state = Arc::new(modules::telegram::state::TelegramState::new(
                telegram_repo,
                telegram_secrets,
            ));
            // Cross-module slash commands. Registering here (rather than in
            // TelegramState::new) keeps the telegram module independent of
            // the order in which other module states are constructed.
            telegram_state.register_command(
                modules::telegram::module_cmds::BatteryCmd,
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::ClipCmd::new(Arc::clone(&shared_repo)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::NoteCmd::new(Arc::clone(&notes_repo_for_telegram)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::NotesListCmd::new(notes_repo_for_telegram),
            );
            telegram_state.register_command(modules::telegram::module_cmds::MusicCmd);
            telegram_state.register_command(modules::telegram::module_cmds::VolumeCmd);
            telegram_state.register_command(
                modules::telegram::module_cmds::RemindCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::VoiceActionCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::RemindersCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::ForgetCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::RememberCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::MemoryCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::SummarizeCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::ForgetFactCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::ScreenshotCmd,
            );
            let power_timers = Arc::new(modules::system::power::PowerTimers::new());
            telegram_state.register_command(
                modules::telegram::module_cmds::DisplayCmd,
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::SleepCmd::new(Arc::clone(&power_timers)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::ShutdownCmd::new(Arc::clone(&power_timers)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::DashboardCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(modules::telegram::module_cmds::AppCmd);
            telegram_state.register_command(modules::telegram::module_cmds::FocusCmd);
            telegram_state.register_command(
                modules::telegram::module_cmds::WeatherCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(modules::telegram::module_cmds::NavigateCmd);
            telegram_state.register_command(modules::telegram::module_cmds::MetronomeCmd);
            telegram_state.register_command(
                modules::telegram::module_cmds::PomodoroCmd::new(Arc::clone(&pomodoro_state)),
            );
            telegram_state.register_command(
                modules::telegram::module_cmds::AiCmd::new(Arc::clone(&telegram_state)),
            );
            telegram_state.register_command(modules::telegram::module_cmds::SeparateStemsCmd);
            telegram_state.register_command(modules::telegram::module_cmds::DetectBpmCmd);

            // Outbound watchers — battery + calendar + reminders ticker.
            modules::telegram::battery_watcher::spawn(app.handle().clone());
            modules::telegram::calendar::spawn(app.handle().clone());
            modules::telegram::reminders::spawn(
                app.handle().clone(),
                Arc::clone(&telegram_state),
            );

            // Rehydrate paired state from secrets. Without this every app
            // restart left the bot offline even though bot_token + chat_id
            // were still on disk — the in-memory pairing state defaulted
            // back to Unconfigured, so the transport never auto-started.
            let rehydrate_token = telegram_state
                .secrets
                .get(modules::telegram::keyring::ACCOUNT_BOT_TOKEN)
                .ok()
                .flatten();
            let rehydrate_chat = telegram_state
                .secrets
                .get(modules::telegram::keyring::ACCOUNT_CHAT_ID)
                .ok()
                .flatten()
                .and_then(|s| s.parse::<i64>().ok());
            if let (Some(token), Some(chat_id)) = (rehydrate_token, rehydrate_chat) {
                use modules::telegram::pairing::PairingState;
                *telegram_state.pairing.lock().unwrap() =
                    PairingState::Paired { chat_id };
                let app_handle = app.handle().clone();
                let arc_state = Arc::clone(&telegram_state);
                tracing::info!(chat_id, "telegram: rehydrated paired state");
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = arc_state
                        .transport
                        .start(token.clone(), app_handle, Arc::clone(&arc_state))
                        .await
                    {
                        tracing::warn!(error = %e, "auto-start transport failed");
                    }
                    if let Err(e) = arc_state.sender.start(token) {
                        tracing::warn!(error = %e, "auto-start sender failed");
                    }
                });
            }

            let telegram_for_ipc = Arc::clone(&telegram_state);
            // Inbox retention sweeper. Runs once at startup so today's
            // launch already collects yesterday's expired bytes, then
            // every hour after that — picking up slider changes
            // without a restart.
            {
                let app_for_sweep = app.handle().clone();
                let state_for_sweep = Arc::clone(&telegram_state);
                tauri::async_runtime::spawn(async move {
                    loop {
                        let days = modules::telegram::settings::InboxLimits::load(&state_for_sweep)
                            .retention_days;
                        modules::telegram::inbox::sweep_old(
                            &app_for_sweep,
                            &state_for_sweep,
                            days,
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
                    }
                });
            }
            app.manage(telegram_state);

            // Local IPC transport for the `stash` CLI. Shares the
            // telegram CommandRegistry so commands added once are
            // reachable from both Telegram and the terminal.
            modules::ipc::spawn(app.handle().clone(), telegram_for_ipc);

            let warmup_state = Arc::clone(&runner_state);
            std::thread::spawn(move || {
                let bin_dir = warmup_state.default_downloads_dir.join("bin");
                match modules::downloader::installer::resolve(&bin_dir) {
                    Ok(path) => {
                        *warmup_state.yt_dlp_path.lock().unwrap() = Some(path);
                    }
                    Err(e) => eprintln!("[downloader] warmup failed: {e}"),
                }
            });

            app.manage(Arc::new(tray::TrayState::new()));
            tray::install(app.handle())?;

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let mods = Some(Modifiers::SUPER | Modifiers::SHIFT);
                let toggle = Shortcut::new(mods, Code::KeyV);
                // KeyJ ("Jot") instead of KeyN — ⌘⇧N is the standard macOS
                // Finder shortcut for "New Folder", and stealing it system-wide
                // breaks the user's muscle memory outside Stash.
                let notes = Shortcut::new(mods, Code::KeyJ);
                let voice = Shortcut::new(mods, Code::KeyA);
                app.global_shortcut().register(toggle)?;
                app.global_shortcut().register(notes)?;
                app.global_shortcut().register(voice)?;
            }

            let auto_hide = Arc::new(PopupAutoHide(AtomicBool::new(true)));
            app.manage(Arc::clone(&auto_hide));

            let popup_pos_state = Arc::new(PopupPositionState::load(
                data_dir.join("popup_position.json"),
            ));
            app.manage(Arc::clone(&popup_pos_state));

            if let Some(win) = app.get_webview_window("popup") {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectState};
                    if let Err(e) = apply_vibrancy(
                        &win,
                        material_for_strength(0),
                        Some(NSVisualEffectState::Active),
                        Some(14.0),
                    ) {
                        eprintln!("[stash] apply_vibrancy failed: {e}");
                    }
                    // Subclass the popup NSWindow to a non-activating
                    // NSPanel so toggling the popup doesn't pull focus
                    // out of the user's current app. See `nspanel.rs`
                    // for the full rationale. Must run after Tauri has
                    // created the NSWindow (we're inside the `Some(win)`
                    // branch) and before the blur-hide handler is
                    // attached — conversion swaps the isa pointer,
                    // and we want the subsequent `on_window_event`
                    // closure to see the panel behaviour.
                    if let Err(e) = nspanel::convert_popup(&win) {
                        tracing::warn!(error = %e, "nspanel: convert_popup failed");
                    }
                }

                let win_clone = win.clone();
                let auto_hide_clone = Arc::clone(&auto_hide);
                let pos_state_clone = Arc::clone(&popup_pos_state);
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        if auto_hide_clone.0.load(Ordering::SeqCst) {
                            let _ = win_clone.hide();
                        }
                    }
                    WindowEvent::Moved(pos) => {
                        // Skip the move that we just performed ourselves.
                        if pos_state_clone
                            .suppress_next_moved
                            .swap(false, Ordering::SeqCst)
                        {
                            return;
                        }
                        {
                            let mut d = pos_state_clone.data.lock().unwrap();
                            d.user_moved = true;
                            d.x = Some(pos.x);
                            d.y = Some(pos.y);
                        }
                        pos_state_clone.save();
                        let _ = app_handle.emit("popup:position_changed", true);
                    }
                    _ => {}
                });
            }

            // Mirror the convert + auto-hide-on-blur dance for the
            // floating voice capsule. Lives in its own NSPanel class
            // so the two windows don't compete for the panel-manager
            // registration in tauri-nspanel.
            if let Some(voice_win) = app.get_webview_window("voice-popup") {
                #[cfg(target_os = "macos")]
                {
                    if let Err(e) = modules::voice::popup::convert_voice_popup(&voice_win) {
                        tracing::warn!(error = %e, "nspanel: convert_voice_popup failed");
                    }
                }
                let voice_clone = voice_win.clone();
                voice_win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        // Mic-permission and a few system-level
                        // pickers blur the capsule briefly; we
                        // tolerate that — hide is best-effort and
                        // the user can re-summon with ⌘⇧A.
                        let _ = voice_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean up long-lived background services on app exit. The
            // OS would reap them anyway, but doing it explicitly means a
            // future hot-restart (or test harness) does not leak ports
            // / file handles between runs.
            if let tauri::RunEvent::Exit = event {
                if let Some(media) = app_handle.try_state::<Arc<MediaServerState>>() {
                    media.stop();
                }
            }
        });
}

/// Initialise the tracing subscriber with a rolling daily file in the app
/// data dir and a stderr layer filtered by RUST_LOG (default `stash=info`).
/// Called once from `setup`; a second call is a no-op.
fn init_tracing(data_dir: &std::path::Path) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    static INIT: std::sync::Once = std::sync::Once::new();
    let data_dir = data_dir.to_path_buf();
    INIT.call_once(|| {
        let logs_dir = data_dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        let file_appender = tracing_appender::rolling::daily(&logs_dir, "stash.log");
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("stash=info,stash_app=info,stash_app_lib=info"));
        let file_layer = fmt::layer()
            .with_ansi(false)
            .with_writer(file_appender)
            .with_target(true);
        let stderr_layer = fmt::layer().with_writer(std::io::stderr);
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(stderr_layer)
            .try_init();
    });
}

/// macOS vibrancy material for the popup. UnderWindowBackground is the same
/// frosted glass macOS Notification/Control Centers use — it's the most
/// "see-through with blur" material rather than HudWindow (which is dark grey
/// and reads as solid black/white when the pane background is translucent).
#[cfg(target_os = "macos")]
fn material_for_strength(_strength: u32) -> window_vibrancy::NSVisualEffectMaterial {
    window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground
}

/// Re-apply the vibrancy effect with a material derived from `strength`.
/// Called from the frontend whenever the user drags the blur slider.
#[tauri::command]
fn set_popup_vibrancy(app: tauri::AppHandle, strength: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectState};
        let Some(win) = app.get_webview_window("popup") else {
            return Err("popup window not found".into());
        };
        if strength == 0 {
            // Strength 0 means "no vibrancy" — clear the effect view so the window
            // is actually transparent and `paneOpacity = 0` can let the desktop show.
            clear_vibrancy(&win).map_err(|e| format!("clear_vibrancy: {e}"))?;
        } else {
            let material = material_for_strength(strength);
            apply_vibrancy(
                &win,
                material,
                Some(NSVisualEffectState::Active),
                Some(14.0),
            )
            .map_err(|e| format!("apply_vibrancy: {e}"))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, strength);
    }
    Ok(())
}

/// Set the popup window's macOS appearance so the NSVisualEffectView (vibrancy)
/// follows the in-app theme rather than the system theme. Without this, a user
/// running macOS in Light mode but Stash in Dark mode would see a light frosted
/// glass behind the popup — which reads as "translucency makes everything
/// lighter" instead of "more see-through".
#[tauri::command]
fn set_popup_appearance(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let Some(win) = app.get_webview_window("popup") else {
            return Err("popup window not found".into());
        };
        let theme = match mode.as_str() {
            "light" => Some(tauri::Theme::Light),
            "dark" => Some(tauri::Theme::Dark),
            _ => None, // "auto" → follow system
        };
        win.set_theme(theme)
            .map_err(|e| format!("set_theme: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, mode);
    }
    Ok(())
}

/// Open a macOS Privacy & Security pane by name. Accepts:
/// "screen-recording", "accessibility", "camera", "microphone",
/// "automation". Falls back to the general Privacy root.
#[tauri::command]
fn open_system_settings(pane: Option<String>) -> Result<(), String> {
    let url = match pane.as_deref() {
        Some("screen-recording") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        Some("accessibility") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        Some("camera") => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        Some("microphone") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        Some("automation") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy",
    };
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).ok();
    std::process::Command::new("open")
        .arg(&data_dir)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

/// Write a small text file with app/yt-dlp versions + OS info so users can
/// attach it to a bug report. Returns the path.
#[tauri::command]
async fn collect_logs(
    app: tauri::AppHandle,
    dl_state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).ok();
    let yt_dlp_version = dl_state
        .yt_dlp_path
        .lock()
        .unwrap()
        .clone()
        .and_then(|p| modules::downloader::installer::installed_version(&p).ok())
        .unwrap_or_else(|| "unknown".into());
    let uname = std::process::Command::new("uname")
        .arg("-a")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let content = format!(
        "Stash diagnostic report\n\
         app version: {}\n\
         yt-dlp: {}\n\
         uname: {}\n\
         data_dir: {}\n",
        env!("CARGO_PKG_VERSION"),
        yt_dlp_version,
        uname.trim(),
        data_dir.display()
    );
    let out = data_dir.join("stash-report.txt");
    std::fs::write(&out, content).map_err(|e| format!("write: {e}"))?;
    std::process::Command::new("open")
        .args(["-R"])
        .arg(&out)
        .spawn()
        .ok();
    Ok(out.display().to_string())
}

/// Minimal percent-decoder — our payloads are small URL-encoded form fields
/// from `URLSearchParams`, so we decode %XX → byte and `+` → space, then
/// interpret the bytes as UTF-8. Anything invalid falls back to the raw
/// input so a malformed field never drops the whole now-playing update.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push(((h << 4) | l) as u8);
                    i += 3;
                }
                _ => {
                    out.push(b);
                    i += 1;
                }
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Keep the menubar label tight so it fits alongside the icon even when the
/// user copies a long paragraph. Strip newlines and ellipsize past 30 chars.
fn run_monitor(
    state: Arc<ClipboardState>,
    images_dir: std::path::PathBuf,
    app: tauri::AppHandle,
    translator: Arc<TranslatorState>,
) {
    use std::sync::mpsc;
    use std::time::Instant;
    use tauri::Emitter;
    let reader = match ArboardReader::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[clipboard] failed to init arboard: {e}");
            return;
        }
    };
    let mut monitor = Monitor::with_images_dir(reader, images_dir);

    // Dedicated translate worker — one thread, bounded by a single-slot
    // queue. If the user copies a dozen items in quick succession we keep
    // only the newest (stale translations are dropped before they reach
    // the network). Previously we spawned one OS thread per change, which
    // could explode under a paste-spam workload.
    struct TranslateJob {
        id: i64,
        text: String,
    }
    let (tx, rx) = mpsc::channel::<TranslateJob>();
    {
        let translator_w = Arc::clone(&translator);
        let app_w = app.clone();
        thread::spawn(move || {
            while let Ok(mut job) = rx.recv() {
                // Drain: if more jobs piled up while the worker was busy,
                // jump straight to the freshest one.
                while let Ok(next) = rx.try_recv() {
                    job = next;
                }
                if let Some(t) = translator_w.auto_translate(&job.text) {
                    let _ = app_w.emit(
                        "clipboard:translated",
                        serde_json::json!({
                            "id": job.id,
                            "original": t.original,
                            "translated": t.translated,
                            "from": t.from,
                            "to": t.to,
                        }),
                    );
                }
            }
        });
    }

    let mut last_change = Instant::now() - Duration::from_millis(CLIPBOARD_FAST_WINDOW_MS as u64);
    let mut last_trim = Instant::now();
    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let mut inserted: Option<i64> = None;
        if let Ok(mut repo) = state.repo.lock() {
            match monitor.poll_once(&mut repo, now) {
                Ok(id) => inserted = id,
                Err(e) => eprintln!("[clipboard] poll error: {e}"),
            }
            if last_trim.elapsed().as_millis() >= CLIPBOARD_TRIM_EVERY_MS {
                if let Err(e) = repo.trim_to_cap(CLIPBOARD_MAX_UNPINNED) {
                    eprintln!("[clipboard] trim error: {e}");
                }
                last_trim = Instant::now();
            }
        }
        if let Some(id) = inserted {
            last_change = Instant::now();
            let _ = app.emit("clipboard:changed", id);
            // Fetch the new item once so menubar label + translator share
            // the lookup. Text-only; image clips have no preview string.
            let text_content: Option<String> = state
                .repo
                .lock()
                .ok()
                .and_then(|repo| repo.get(id).ok().flatten())
                .filter(|it| it.kind == "text")
                .map(|it| it.content);

            if let Some(content) = text_content {
                let _ = tx.send(TranslateJob { id, text: content });
            }
        }
        // Adaptive cadence: fast for a short window after any change, then
        // fall back to an idle cadence that's much gentler on the battery.
        let sleep_ms = if last_change.elapsed().as_millis() <= CLIPBOARD_FAST_WINDOW_MS {
            CLIPBOARD_POLL_FAST_MS
        } else {
            CLIPBOARD_POLL_IDLE_MS
        };
        thread::sleep(Duration::from_millis(sleep_ms));
    }
}

fn toggle_popup(win: &tauri::Window, pos_state: &PopupPositionState) {
    match win.is_visible() {
        Ok(true) => {
            let _ = win.hide();
        }
        _ => {
            position_popup(win, pos_state);
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Robust lookup for the popup Window. After a child webview is attached,
/// `get_webview_window("popup")` returns None even though the underlying
/// Window is still alive — so we fall back to the raw Window registry.
fn resolve_popup(app: &tauri::AppHandle) -> Option<tauri::Window> {
    if let Some(w) = app.get_webview_window("popup") {
        return Some(w.as_ref().window().clone());
    }
    app.get_window("popup")
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn percent_decode_handles_plus_and_hex() {
        assert_eq!(percent_decode("hello+world"), "hello world");
        assert_eq!(percent_decode("%D0%9F%D1%96%D1%81%D0%BD%D1%8F"), "Пісня");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
    }

    #[test]
    fn percent_decode_preserves_malformed_percent() {
        // A stray `%` with no hex pair should not eat surrounding bytes.
        assert_eq!(percent_decode("50%"), "50%");
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
    }
}
