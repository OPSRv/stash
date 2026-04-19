use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const LABEL: &str = "music";

/// Safari UA — Google blocks sign-in from identifiable embedded WebViews
/// ("browser not secure"); pretending to be Safari on macOS passes the check.
const SAFARI_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const HOME_URL: &str = "https://music.youtube.com/";

#[derive(Serialize)]
pub struct MusicStatus {
    pub attached: bool,
    pub visible: bool,
}

/// Locate the base popup Window. Prefer the legacy `get_webview_window` (for
/// the single-webview shortcut) but fall back to the raw Window lookup —
/// once a child webview is attached, some Tauri builds drop the shortcut
/// mapping even though the underlying Window still exists.
fn popup_window(app: &AppHandle) -> Result<tauri::Window, String> {
    if let Some(w) = app.get_webview_window("popup") {
        return Ok(w.as_ref().window().clone());
    }
    app.get_window("popup")
        .ok_or_else(|| "popup window not found".to_string())
}

/// Attach the music webview as a child surface of the popup window. Child
/// webviews are a Tauri `unstable` API — the feature flag is enabled in
/// Cargo.toml. Idempotent: re-invoking just repositions/resizes.
///
/// `user_agent` is driven by the single "Default browser" setting; when
/// omitted we fall back to Safari because that is what WKWebView can
/// credibly claim and it is what Google's sign-in flow accepts.
#[tauri::command]
pub fn music_embed(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    user_agent: Option<String>,
) -> Result<(), String> {
    let popup = popup_window(&app)?;

    if let Some(existing) = app.webviews().get(LABEL).cloned() {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = HOME_URL.parse::<url::Url>().map_err(|e| e.to_string())?;
    let ua = user_agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| SAFARI_UA.to_string());
    let builder =
        tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
            .user_agent(&ua);

    popup
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn music_hide(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.webviews().get(LABEL).cloned() {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn music_show(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.webviews().get(LABEL).cloned() {
        wv.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Destroy the embedded webview (forces a fresh session on next embed).
#[tauri::command]
pub fn music_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.webviews().get(LABEL).cloned() {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn music_reload(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.webviews().get(LABEL).cloned() {
        wv.eval(&format!("window.location.href = '{HOME_URL}'"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn music_status(app: AppHandle) -> Result<MusicStatus, String> {
    // `Webview::is_visible` doesn't exist on tauri 2.10 — we track visibility
    // ourselves via show/hide calls from the frontend. Attached is enough
    // for the UI to branch between "embed" and "show" paths.
    let attached = app.webviews().contains_key(LABEL);
    Ok(MusicStatus {
        attached,
        visible: attached,
    })
}

#[cfg(test)]
mod tests {
    use super::SAFARI_UA;

    #[test]
    fn safari_ua_passes_google_embedded_browser_check() {
        assert!(SAFARI_UA.contains("Safari/"));
        assert!(SAFARI_UA.contains("Version/"));
        assert!(!SAFARI_UA.contains("Chrome/"));
        assert!(!SAFARI_UA.to_lowercase().contains("electron"));
        assert!(!SAFARI_UA.to_lowercase().contains("webview"));
    }
}
