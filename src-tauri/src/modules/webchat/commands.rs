use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Every child webview we own is labelled `webchat-<service-id>` so we can
/// find/hide/close them without needing to know their URLs at cleanup time.
const LABEL_PREFIX: &str = "webchat-";

fn label_for(service: &str) -> Result<String, String> {
    let trimmed = service.trim();
    if trimmed.is_empty() {
        return Err("service id must not be empty".into());
    }
    // Guard against labels that could collide with other Tauri surfaces or
    // break window lookups (the full label must be a stable, ASCII-ish slug).
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(format!("invalid service id: {trimmed:?}"));
    }
    Ok(format!("{LABEL_PREFIX}{trimmed}"))
}

/// Safari UA — Google's "secure browser" check refuses anything that
/// identifies as Chrome/Electron/WebView, but it accepts Safari on macOS.
/// ChatGPT and Claude also serve cleaner pages to Safari-signed UAs.
const SAFARI_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

fn popup_window(app: &AppHandle) -> Result<tauri::Window, String> {
    if let Some(w) = app.get_webview_window("popup") {
        return Ok(w.as_ref().window().clone());
    }
    app.get_window("popup")
        .ok_or_else(|| "popup window not found".to_string())
}

/// Attach (or reposition/show) the child webview for the given service. The
/// caller supplies pixel coordinates of a sizer <div> in the popup — the
/// child webview rides over that rect. Idempotent: re-invoking with new
/// coords just moves/resizes, it does not navigate or lose session state.
///
/// `service` is a short slug (claude/gpt/gemini/custom-foo) the frontend
/// manages; `url` is the corresponding home URL from settings. We do not
/// hardcode services here so users can add their own from Settings → AI.
#[tauri::command]
pub fn webchat_embed(
    app: AppHandle,
    service: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    user_agent: Option<String>,
) -> Result<(), String> {
    let label = label_for(&service)?;
    let popup = popup_window(&app)?;

    if let Some(existing) = app.webviews().get(&label).cloned() {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
    let ua = user_agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| SAFARI_UA.to_string());
    let mut builder =
        tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
            .user_agent(&ua);
    #[cfg(debug_assertions)]
    {
        builder = builder.devtools(true);
    }

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
pub fn webchat_hide(app: AppHandle, service: String) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide every attached webchat surface. Called when the user leaves the AI
/// tab so a signed-in pane does not bleed through onto another module. We
/// enumerate by label prefix so we don't need to know which services exist.
#[tauri::command]
pub fn webchat_hide_all(app: AppHandle) -> Result<(), String> {
    let labels: Vec<String> = app
        .webviews()
        .keys()
        .filter(|k| k.starts_with(LABEL_PREFIX))
        .cloned()
        .collect();
    for label in labels {
        if let Some(wv) = app.webviews().get(&label).cloned() {
            let _ = wv.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn webchat_reload(app: AppHandle, service: String, url: String) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        // Sanity-check the URL before eval to avoid injecting a bad string.
        let _parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        let escaped = url.replace('\\', "\\\\").replace('\'', "\\'");
        wv.eval(&format!("window.location.href = '{escaped}'"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Destroy the webview entirely. Next embed creates a fresh session — used
/// by the Reset button when a user wants to sign out / clear state.
#[tauri::command]
pub fn webchat_close(app: AppHandle, service: String) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{label_for, SAFARI_UA};

    #[test]
    fn label_format_is_stable() {
        assert_eq!(label_for("claude").unwrap(), "webchat-claude");
        assert_eq!(label_for("gpt").unwrap(), "webchat-gpt");
        assert_eq!(label_for("my-service_2").unwrap(), "webchat-my-service_2");
    }

    #[test]
    fn label_rejects_empty_and_nonascii_and_punctuation() {
        assert!(label_for("").is_err());
        assert!(label_for("   ").is_err());
        assert!(label_for("has space").is_err());
        assert!(label_for("unicode·here").is_err());
        assert!(label_for("../evil").is_err());
    }

    #[test]
    fn safari_ua_passes_google_embedded_browser_check() {
        assert!(SAFARI_UA.contains("Safari/"));
        assert!(!SAFARI_UA.contains("Chrome/"));
        assert!(!SAFARI_UA.to_lowercase().contains("webview"));
    }
}
