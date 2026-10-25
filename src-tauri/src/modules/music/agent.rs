//! Agent surface — Music tab: `/music` + `music_control`.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::modules::telegram::agent_util::{
    apply_volume, read_volume, run_slash, volume_bar, VolumeAction,
};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};
use crate::tray::TrayState;

// -------------------- /music --------------------

pub struct MusicCmd;

#[async_trait]
impl CommandHandler for MusicCmd {
    fn name(&self) -> &'static str {
        "music"
    }
    fn description(&self) -> &'static str {
        "Показати або керувати плеєром YouTube Music"
    }
    fn usage(&self) -> &'static str {
        "/music [play|pause|toggle|next|prev|volup|voldown|open]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_lowercase();
        match sub.as_str() {
            "" | "status" => music_card(&ctx.app, None),
            "volup" | "vol+" | "volumeup" => {
                let snap = apply_volume(VolumeAction::Step(10));
                music_card(&ctx.app, snap.error.as_deref().map(|e| format!("⚠️ {e}")))
            }
            "voldown" | "vol-" | "volumedown" => {
                let snap = apply_volume(VolumeAction::Step(-10));
                music_card(&ctx.app, snap.error.as_deref().map(|e| format!("⚠️ {e}")))
            }
            "open" => {
                reveal_music_tab(&ctx.app);
                Reply {
                    text: "📻 Відкриваю YouTube Music у Stash. Коли плеєр завантажиться, керуй кнопками нижче."
                        .to_string(),
                    keyboard: Some(music_keyboard()),
                    ..Default::default()
                }
            }
            "play" | "pause" | "toggle" => {
                run_music_action(
                    &ctx,
                    crate::modules::music::commands::music_play_pause,
                    "⏯️",
                    "перемкнуто",
                )
                .await
            }
            "next" => {
                run_music_action(
                    &ctx,
                    crate::modules::music::commands::music_next,
                    "⏭️",
                    "далі",
                )
                .await
            }
            "prev" => {
                run_music_action(
                    &ctx,
                    crate::modules::music::commands::music_prev,
                    "⏮️",
                    "назад",
                )
                .await
            }
            _ => Reply::text(format!(
                "✍️ Використання: {}. Отримано: {sub}",
                self.usage()
            )),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct NowPlaying {
    playing: bool,
    title: String,
    artist: String,
    attached: bool,
}

fn read_now_playing(app: &tauri::AppHandle) -> NowPlaying {
    let attached = app.webviews().contains_key("music");
    let Some(tray) = app.try_state::<Arc<TrayState>>() else {
        return NowPlaying {
            attached,
            ..NowPlaying::default()
        };
    };
    // Read music snapshot through the Mutex. `tray::music` is private —
    // use the public read helper.
    let snap = crate::tray::read_music_snapshot(&tray);
    NowPlaying {
        playing: snap.playing,
        title: snap.title,
        artist: snap.artist,
        attached,
    }
}

/// Wait a blink for the webview to update its now-playing state after a
/// control click, then format whatever we see — so `/music pause` reports
/// the post-action state rather than the pre-action one.
fn read_after_action(app: &tauri::AppHandle, verb: &str) -> String {
    std::thread::sleep(std::time::Duration::from_millis(400));
    let snap = read_now_playing(app);
    if !snap.attached {
        return format!("{verb} (плеєр не підключено)");
    }
    format_now_playing(&snap)
}

fn format_now_playing(snap: &NowPlaying) -> String {
    if !snap.attached {
        return "🎵 Плеєр не підключено. Спочатку відкрий Stash → Music.".to_string();
    }
    let title = if snap.title.is_empty() {
        "(нічого)".to_string()
    } else {
        snap.title.clone()
    };
    let who = if snap.artist.is_empty() {
        String::new()
    } else {
        format!(" — {}", snap.artist)
    };
    let icon = if snap.playing { "▶️" } else { "⏸️" };
    format!("{icon} {title}{who}")
}

/// Dispatch a music-player click and shape the Reply uniformly. On
/// first call per session the YouTube-Music webview isn't attached
/// yet — instead of bouncing the request back to the user with a
/// manual "open Music" button, we auto-reveal the tab and poll for the
/// webview to mount (takes ~5 s cold). The keyboard stays in play on
/// every outcome so the user isn't stranded after a transient failure.
async fn run_music_action(
    ctx: &Ctx,
    action: fn(tauri::AppHandle) -> Result<(), String>,
    emoji: &str,
    verb: &str,
) -> Reply {
    // Fast path — if the webview is already attached the action just
    // works without any UI jump.
    match action(ctx.app.clone()) {
        Ok(()) => {
            return Reply {
                text: format!("{emoji} {}", read_after_action(&ctx.app, verb)),
                keyboard: Some(music_keyboard()),
                ..Default::default()
            };
        }
        Err(e) if !e.contains("not attached") => {
            return Reply {
                text: format!("⚠️ {e}"),
                keyboard: Some(music_keyboard()),
                ..Default::default()
            };
        }
        Err(_) => {}
    }

    // Cold path — open the tab and wait for the child webview. 8 s
    // covers first-launch YTM loads (~5 s empirically) with headroom;
    // bail back to the manual prompt if we still don't see it so the
    // user isn't silently left hanging.
    reveal_music_tab(&ctx.app);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut attached = false;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if ctx.app.webviews().contains_key("music") {
            attached = true;
            break;
        }
    }
    if !attached {
        return Reply {
            text: "📻 Плеєр не встиг відкритись. Спробуй ще раз за пару секунд.".into(),
            keyboard: Some(music_open_keyboard()),
            ..Default::default()
        };
    }
    // Webview exists, but YTM's player-bar buttons render a beat later —
    // give the DOM 600 ms to paint #play-pause-button before the first
    // click. Empirical; without this the click lands on an empty doc
    // and nothing happens.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;

    match action(ctx.app.clone()) {
        Ok(()) => Reply {
            text: format!("{emoji} {}", read_after_action(&ctx.app, verb)),
            keyboard: Some(music_keyboard()),
            ..Default::default()
        },
        Err(e) if e.contains("not attached") => Reply {
            text: "📻 Плеєр ще відкривається — повтори через секунду.".into(),
            keyboard: Some(music_keyboard()),
            ..Default::default()
        },
        Err(e) => Reply {
            text: format!("⚠️ {e}"),
            keyboard: Some(music_keyboard()),
            ..Default::default()
        },
    }
}

/// Mirror of the `⌘⇧J` shortcut for Notes: show the popup, focus it,
/// and tell the frontend to jump to the Music tab so `MusicShell`
/// mounts and attaches the YouTube-Music child webview.
fn reveal_music_tab(app: &tauri::AppHandle) {
    let _ = app.emit("nav:activate", "music");
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Single-button keyboard shown when the Music webview isn't attached
/// yet. Tapping it routes to `MusicCmd` with arg `"open"`, which calls
/// `reveal_music_tab` and swaps back to the full playback keyboard.
fn music_open_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![InlineButton::new("📻 Відкрити Music", "refresh:music:open")]],
    }
}

/// Player card: now-playing + system volume, with the live keyboard.
fn music_card(app: &tauri::AppHandle, note: Option<String>) -> Reply {
    let mut text = format_now_playing(&read_now_playing(app));
    let vol = read_volume();
    if let Some(p) = vol.percent {
        let icon = if vol.muted { "🔇" } else { "🔊" };
        text.push_str(&format!("\n{icon} {p}% {}", volume_bar(p)));
    }
    if let Some(n) = note {
        text = format!("{n}\n\n{text}");
    }
    Reply {
        text,
        keyboard: Some(music_keyboard()),
        ..Default::default()
    }
}

/// Live player keyboard — `refresh:` so taps edit the card in place.
fn music_keyboard() -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:music:{args}"));
    InlineKeyboard {
        rows: vec![
            vec![b("⏮️", "prev"), b("⏯️", "toggle"), b("⏭️", "next")],
            vec![b("🔉", "voldown"), b("🔊", "volup")],
            vec![b("🔄", "status")],
        ],
    }
}

// -------------------- music_control tool --------------------

pub struct MusicControl;

#[async_trait]
impl Tool for MusicControl {
    fn name(&self) -> &'static str {
        "music_control"
    }
    fn description(&self) -> &'static str {
        "Control the YouTube Music webview inside Stash. `status` returns \
         the current track and system volume; `play` / `pause` / `toggle` / \
         `next` / `prev` drive playback; `volup` / `voldown` nudge the system \
         volume by 10. `open` reveals the tab without touching playback."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "play", "pause", "toggle", "next", "prev", "volup", "voldown", "open"]
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: action".to_string())?;
        let slash_arg = if matches!(action, "status") {
            ""
        } else {
            action
        };
        run_slash(ctx, "music", slash_arg).await
    }
}

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(MusicCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(MusicControl);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::{
        all_callbacks, assert_fits, tool_ctx as ctx,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn music_control_requires_action_field() {
        let err = MusicControl.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("action"));
    }

    #[test]
    fn music_keyboards_fit() {
        for kb in [music_keyboard(), music_open_keyboard()] {
            assert_fits(&kb);
            assert!(all_callbacks(&kb).iter().all(|d| d.starts_with("refresh:")));
        }
    }
}
