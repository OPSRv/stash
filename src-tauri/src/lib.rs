mod modules;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use modules::clipboard::{
    commands::{
        clipboard_clear, clipboard_copy_only, clipboard_delete, clipboard_list, clipboard_paste,
        clipboard_search, clipboard_toggle_pin, ClipboardState,
    },
    monitor::{ArboardReader, Monitor},
    repo::ClipboardRepo,
};

use rusqlite::Connection;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

const CLIPBOARD_POLL_MS: u64 = 500;
const CLIPBOARD_MAX_UNPINNED: usize = 1000;
const CLIPBOARD_TRIM_EVERY_N_POLLS: u32 = 120; // ~once per minute at 500ms poll

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() == ShortcutState::Pressed {
                        if shortcut.matches(
                            tauri_plugin_global_shortcut::Modifiers::SUPER
                                | tauri_plugin_global_shortcut::Modifiers::SHIFT,
                            tauri_plugin_global_shortcut::Code::KeyV,
                        ) {
                            if let Some(win) = app.get_webview_window("popup") {
                                toggle_popup(&win);
                            }
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

            let state_for_thread = Arc::clone(&shared_repo);
            let images_dir_thread = images_dir.clone();
            let handle_for_thread = app.handle().clone();
            thread::spawn(move || run_monitor(state_for_thread, images_dir_thread, handle_for_thread));

            let quit = MenuItem::with_id(app, "quit", "Quit Stash", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(win) = app.get_webview_window("popup") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("popup") {
                            toggle_popup(&win);
                        }
                    }
                })
                .build(app)?;

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let toggle = Shortcut::new(
                    Some(Modifiers::SUPER | Modifiers::SHIFT),
                    Code::KeyV,
                );
                app.global_shortcut().register(toggle)?;
            }

            if let Some(win) = app.get_webview_window("popup") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let _ = win_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn run_monitor(
    state: Arc<ClipboardState>,
    images_dir: std::path::PathBuf,
    app: tauri::AppHandle,
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
        }
        tick = tick.wrapping_add(1);
        thread::sleep(Duration::from_millis(CLIPBOARD_POLL_MS));
    }
}

fn toggle_popup(win: &tauri::WebviewWindow) {
    match win.is_visible() {
        Ok(true) => {
            let _ = win.hide();
        }
        _ => {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
