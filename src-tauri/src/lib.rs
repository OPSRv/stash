mod modules;

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
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use modules::clipboard::{
    commands::{
        clipboard_clear, clipboard_copy_only, clipboard_delete, clipboard_link_preview,
        clipboard_list, clipboard_paste, clipboard_search, clipboard_toggle_pin, ClipboardState,
        LinkPreviewState,
    },
    monitor::{ArboardReader, Monitor},
    repo::ClipboardRepo,
};
use modules::downloader::{
    commands::{
        dl_cancel, dl_clear_completed, dl_delete, dl_detect, dl_list, dl_pause, dl_purge_cookies,
        dl_detect_quick, dl_prune_history, dl_resume, dl_retry, dl_set_cookies_browser,
        dl_set_downloads_dir, dl_set_max_parallel, dl_set_rate_limit, dl_start,
        dl_update_binary, dl_ytdlp_version,
    },
    jobs::JobRepo,
    runner::RunnerState,
};
use modules::metronome::commands::{
    metronome_get_state, metronome_save_state, MetronomeStateHandle,
};
use modules::notes::{
    commands::{
        notes_create, notes_delete, notes_list, notes_read_file, notes_search, notes_update,
        notes_write_file, NotesState,
    },
    repo::NotesRepo,
};
use modules::recorder::commands::{
    cam_pip_hide, cam_pip_show, rec_delete, rec_list, rec_list_devices, rec_probe_permissions,
    rec_set_output_dir, rec_start, rec_status, rec_stop, rec_trim, RecorderState,
};
use modules::music::commands::{
    music_close, music_embed, music_hide, music_next, music_play_pause, music_prev, music_reload,
    music_show, music_status,
};
use modules::search::commands::global_search;
use modules::terminal::commands::{pty_close, pty_open, pty_resize, pty_write};
use modules::terminal::state::TerminalState;
use modules::translator::{
    commands::{
        translator_clear, translator_delete, translator_list, translator_run, translator_search,
        translator_set_settings, TranslatorState,
    },
    repo::TranslationsRepo,
};

use rusqlite::Connection;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

const CLIPBOARD_POLL_MS: u64 = 500;
const CLIPBOARD_MAX_UNPINNED: usize = 1000;
const CLIPBOARD_TRIM_EVERY_N_POLLS: u32 = 120; // ~once per minute at 500ms poll

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
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
                for pair in q.split('&') {
                    let mut it = pair.splitn(2, '=');
                    let key = it.next().unwrap_or("");
                    let val = it.next().unwrap_or("");
                    let decoded = percent_decode(val);
                    match key {
                        "playing" => playing = decoded == "1",
                        "title" => title = decoded,
                        "artist" => artist = decoded,
                        "artwork" => artwork = decoded,
                        _ => {}
                    }
                }
                let _ = ctx.app_handle().emit(
                    "music:nowplaying",
                    serde_json::json!({
                        "playing": playing,
                        "title": title,
                        "artist": artist,
                        "artwork": artwork,
                    }),
                );
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
        .plugin(tauri_plugin_dialog::init());

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
                    if shortcut
                        .matches(mods, tauri_plugin_global_shortcut::Code::KeyV)
                    {
                        if let Some(win) = resolve_popup(app) {
                            toggle_popup(&win);
                        }
                    } else if shortcut
                        .matches(mods, tauri_plugin_global_shortcut::Code::KeyN)
                    {
                        // Quick-open Notes module and focus the editor.
                        if let Some(win) = resolve_popup(app) {
                            // `emit` stays on the AppHandle so child webviews
                            // also receive it. Pass the tab payload first.
                            let _ = app.emit("nav:activate", "notes");
                            use tauri_plugin_positioner::{Position, WindowExt};
                            let _ = win.move_window(Position::TrayCenter);
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
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
            clipboard_link_preview,
            dl_detect,
            dl_detect_quick,
            dl_start,
            dl_cancel,
            dl_list,
            dl_delete,
            dl_clear_completed,
            dl_set_downloads_dir,
            dl_set_cookies_browser,
            dl_set_max_parallel,
            dl_set_rate_limit,
            dl_prune_history,
            dl_pause,
            dl_resume,
            dl_retry,
            dl_ytdlp_version,
            dl_update_binary,
            dl_purge_cookies,
            open_data_folder,
            collect_logs,
            set_popup_vibrancy,
            set_popup_appearance,
            set_popup_auto_hide,
            open_system_settings,
            rec_start,
            rec_stop,
            rec_status,
            rec_probe_permissions,
            rec_set_output_dir,
            rec_list,
            rec_list_devices,
            rec_delete,
            rec_trim,
            cam_pip_show,
            cam_pip_hide,
            notes_list,
            notes_search,
            notes_create,
            notes_update,
            notes_delete,
            notes_read_file,
            notes_write_file,
            global_search,
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

            // Downloader runtime
            let downloads_dir = dirs_next::video_dir()
                .unwrap_or_else(|| data_dir.join("Downloads"))
                .join("Stash");
            std::fs::create_dir_all(&downloads_dir).ok();
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

            // Warm-up yt-dlp in the background so the first Detect doesn't
            // include an install round-trip.
            // Recorder runtime — shares the Movies/Stash folder with downloads.
            let recorder_dir = dirs_next::video_dir()
                .unwrap_or_else(|| data_dir.join("Recordings"))
                .join("Stash");
            std::fs::create_dir_all(&recorder_dir).ok();
            let recorder_state = Arc::new(RecorderState::new(recorder_dir));
            app.manage(Arc::clone(&recorder_state));

            // Notes
            let notes_db = data_dir.join("notes.sqlite");
            let notes_repo = NotesRepo::new(Connection::open(&notes_db)?)?;
            app.manage(NotesState {
                repo: Mutex::new(notes_repo),
            });

            // Metronome — single JSON blob in app data dir.
            let metronome_path = data_dir.join("metronome.json");
            app.manage(MetronomeStateHandle::new(metronome_path));

            // Terminal — PTY session lazily opened by the first `pty_open`
            // call from the frontend (once the xterm fit addon knows the
            // actual cell grid).
            app.manage(Arc::new(TerminalState::new()));

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

            let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Stash", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // Custom monochrome template tray icon. Falls back to the window
            // icon if the file cannot be found (dev before first `tauri build`).
            let tray_icon = {
                let bytes = include_bytes!("../icons/tray.png");
                tauri::image::Image::from_bytes(bytes)
                    .ok()
                    .unwrap_or_else(|| app.default_window_icon().unwrap().clone())
            };
            let tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(win) = resolve_popup(app) {
                            let _ = win.move_window(Position::TrayCenter);
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
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
                            toggle_popup(&win);
                        }
                    }
                })
                .build(app)?;
            // Hand the tray off to the monitor thread so it can refresh the
            // menubar label whenever the clipboard changes.
            app.manage(TrayHandle(Mutex::new(Some(tray))));

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let mods = Some(Modifiers::SUPER | Modifiers::SHIFT);
                let toggle = Shortcut::new(mods, Code::KeyV);
                let notes = Shortcut::new(mods, Code::KeyN);
                app.global_shortcut().register(toggle)?;
                app.global_shortcut().register(notes)?;
            }

            let auto_hide = Arc::new(PopupAutoHide(AtomicBool::new(true)));
            app.manage(Arc::clone(&auto_hide));

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
                }

                let win_clone = win.clone();
                let auto_hide_clone = Arc::clone(&auto_hide);
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        if auto_hide_clone.0.load(Ordering::SeqCst) {
                            let _ = win_clone.hide();
                        }
                    }
                });
            }


            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        let file_appender =
            tracing_appender::rolling::daily(&logs_dir, "stash.log");
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
        win.set_theme(theme).map_err(|e| format!("set_theme: {e}"))?;
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

pub struct TrayHandle(pub Mutex<Option<tauri::tray::TrayIcon>>);

/// Keep the menubar label tight so it fits alongside the icon even when the
/// user copies a long paragraph. Strip newlines and ellipsize past 30 chars.
fn tray_label_from_clip(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    const MAX: usize = 30;
    if trimmed.chars().count() <= MAX {
        format!(" {}", trimmed)
    } else {
        let short: String = trimmed.chars().take(MAX).collect();
        format!(" {}…", short)
    }
}

fn run_monitor(
    state: Arc<ClipboardState>,
    images_dir: std::path::PathBuf,
    app: tauri::AppHandle,
    translator: Arc<TranslatorState>,
) {
    use tauri::Emitter;
    let reader = match ArboardReader::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[clipboard] failed to init arboard: {e}");
            return;
        }
    };
    let mut monitor = Monitor::with_images_dir(reader, images_dir);
    let mut tick: u32 = 0;
    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let inserted = if let Ok(mut repo) = state.repo.lock() {
            let id = match monitor.poll_once(&mut repo, now) {
                Ok(id) => id,
                Err(e) => {
                    eprintln!("[clipboard] poll error: {e}");
                    None
                }
            };
            if tick % CLIPBOARD_TRIM_EVERY_N_POLLS == 0 {
                if let Err(e) = repo.trim_to_cap(CLIPBOARD_MAX_UNPINNED) {
                    eprintln!("[clipboard] trim error: {e}");
                }
            }
            id
        } else {
            None
        };
        if let Some(id) = inserted {
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

            if let Some(ref content) = text_content {
                let label = tray_label_from_clip(content);
                if let Some(handle) = app.try_state::<TrayHandle>() {
                    if let Some(tray) = handle.0.lock().unwrap().as_ref() {
                        let _ = tray.set_title(Some(label));
                    }
                }

                // Auto-translate in a background thread so a slow network
                // round-trip doesn't stall the 500ms clipboard poll.
                let translator_bg = Arc::clone(&translator);
                let app_bg = app.clone();
                let text_bg = content.clone();
                thread::spawn(move || {
                    if let Some(t) = translator_bg.auto_translate(&text_bg) {
                        let _ = app_bg.emit(
                            "clipboard:translated",
                            serde_json::json!({
                                "id": id,
                                "original": t.original,
                                "translated": t.translated,
                                "from": t.from,
                                "to": t.to,
                            }),
                        );
                    }
                });
            }
        }
        tick = tick.wrapping_add(1);
        thread::sleep(Duration::from_millis(CLIPBOARD_POLL_MS));
    }
}

fn toggle_popup(win: &tauri::Window) {
    match win.is_visible() {
        Ok(true) => {
            let _ = win.hide();
        }
        _ => {
            let _ = win.move_window(Position::TrayCenter);
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
