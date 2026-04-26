use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Injected into every webchat page before any site script runs. Goal is to
/// look as un-WebView-y as we can so Google's embedded-browser detector
/// ("There was an error logging you in") falls through. What it does:
///
/// 1. Drops `window.webkit.messageHandlers` — the most reliable WKWebView
///    tell. Many scripts probe `!!window.webkit` as a first check.
/// 2. Installs a minimal `window.chrome` so feature-sniffers that look for
///    "am I running in Chrome?" get a plausible answer instead of undefined.
/// 3. Pins `navigator.webdriver` to `false` — some bot-detection scripts
///    take its presence as a decisive signal.
/// 4. Installs a now-playing poller that reports `<video>`/`mediaSession`
///    state back through the `stashnp://` scheme with a `service` param,
///    so the shell can surface a NowPlayingBar for any chat that happens
///    to be hosting a video (YouTube, Gemini's video answers, …).
///
/// We do NOT strip Tauri's own IPC bridge — the host page is a trusted
/// external chat UI and never calls Tauri APIs. Runs once, idempotent.
/// `{SERVICE_ID}` and `{INITIAL_ZOOM}` are substituted at embed time.
const WEBVIEW_DISGUISE_TEMPLATE: &str = r#"
(function(){
  try {
    if (typeof window.webkit === 'object' && window.webkit && 'messageHandlers' in window.webkit) {
      try { delete window.webkit; } catch(_) { window.webkit = undefined; }
    }
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { runtime: {}, app: { isInstalled: false } },
      });
    }
    try {
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        get: function() { return false; },
      });
    } catch(_) {}
  } catch(_) {}

  // Now-playing reporter — same pattern as the Music webview. Reports to
  // stashnp://report/np with a `service` param so the shell can attribute
  // the playback to this webchat instead of YouTube Music.
  if (window.__stashWebchatNpInstalled) return;
  window.__stashWebchatNpInstalled = true;
  var SERVICE_ID = "{SERVICE_ID}";
  var INITIAL_ZOOM = {INITIAL_ZOOM};

  // --- zoom -------------------------------------------------------------
  // Applied on every (re)load so SPA route changes that swap <body> don't
  // reset the user's preferred zoom. Re-applied commands from Rust evaluate
  // the same assignment; we expose a tiny hook so those evals have a single
  // place to look up the current value.
  function applyZoom(z){
    try {
      var v = (typeof z === 'number' && isFinite(z)) ? z : INITIAL_ZOOM;
      if (document.body) document.body.style.zoom = String(v);
      INITIAL_ZOOM = v;
    } catch(_) {}
  }
  window.__stashWebchatApplyZoom = applyZoom;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ applyZoom(INITIAL_ZOOM); }, { once: true });
  } else {
    applyZoom(INITIAL_ZOOM);
  }

  // --- shortcut forwarder ----------------------------------------------
  // Native child webviews receive key events before our React tree does.
  // Capture ⌘-chorded keys we care about at the document level, forward
  // them to the host via the stashnp:// bus, and prevent the webview's
  // default so (e.g.) ⌘R doesn't bypass our progress bar wiring.
  var SHORTCUT_KEYS = { 'r':1, '[':1, ']':1, 'l':1, 'w':1, '=':1, '+':1, '-':1, '0':1 };
  document.addEventListener('keydown', function(e){
    if (!e.metaKey) return;
    var k = (e.key || '').toLowerCase();
    if (!SHORTCUT_KEYS[k]) return;
    try {
      var qs = new URLSearchParams({
        kind: 'shortcut',
        service: SERVICE_ID,
        key: k,
        shift: e.shiftKey ? '1' : '0'
      });
      new Image().src = 'stashnp://report/shortcut?' + qs.toString();
      e.preventDefault();
      e.stopPropagation();
    } catch(_) {}
  }, true);

  // --- loading reporter ------------------------------------------------
  // readystatechange is the broadest signal available without a
  // WKNavigationDelegate. SPA pushState/popstate nudges cover the cases
  // where readyState stays 'complete' across in-page navigations.
  function reportLoading(state){
    try {
      var qs = new URLSearchParams({ kind: 'loading', service: SERVICE_ID, state: state });
      new Image().src = 'stashnp://report/loading?' + qs.toString();
    } catch(_) {}
  }

  // --- navigation reporter --------------------------------------------
  // Emits the live URL + document title so the host toolbar/sidebar can
  // reflect the real page the user is on (not the home URL pinned at
  // embed time). Deduped to avoid flooding when the page keeps touching
  // document.title or pushes the same state twice.
  var lastNav = '';
  function reportNav(){
    try {
      var url = String(location.href || '');
      var title = String(document.title || '');
      var key = url + '' + title;
      if (key === lastNav) return;
      lastNav = key;
      var qs = new URLSearchParams({
        kind: 'nav',
        service: SERVICE_ID,
        url: url,
        title: title,
      });
      new Image().src = 'stashnp://report/nav?' + qs.toString();
    } catch(_) {}
  }
  document.addEventListener('readystatechange', function(){
    if (document.readyState === 'loading') reportLoading('start');
    else if (document.readyState === 'complete') {
      reportLoading('end');
      applyZoom(INITIAL_ZOOM);
      reportNav();
    }
  });
  window.addEventListener('load', function(){
    reportLoading('end');
    applyZoom(INITIAL_ZOOM);
    reportNav();
  });
  try {
    var _push = history.pushState;
    history.pushState = function(){
      reportLoading('start');
      var r = _push.apply(this, arguments);
      setTimeout(function(){ reportLoading('end'); reportNav(); }, 400);
      return r;
    };
    var _replace = history.replaceState;
    history.replaceState = function(){
      var r = _replace.apply(this, arguments);
      setTimeout(reportNav, 0);
      return r;
    };
    window.addEventListener('popstate', function(){
      reportLoading('start');
      setTimeout(function(){ reportLoading('end'); reportNav(); }, 400);
    });
    window.addEventListener('hashchange', reportNav);
  } catch(_) {}
  // Title can change without a URL change (chat renames itself, unread
  // counter, etc.) — observe <title> mutations and re-emit.
  try {
    var titleEl = document.querySelector('title');
    if (titleEl && 'MutationObserver' in window) {
      new MutationObserver(reportNav).observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  } catch(_) {}
  setTimeout(reportNav, 300);

  var last = '';
  function pickArtwork(m){
    try {
      if (!m || !m.artwork || !m.artwork.length) return '';
      var best = m.artwork[0];
      for (var i = 1; i < m.artwork.length; i++) {
        var cur = m.artwork[i];
        if ((cur.sizes || '').length > (best.sizes || '').length) best = cur;
      }
      return best.src || '';
    } catch(_) { return ''; }
  }
  function send(payload){
    var params = new URLSearchParams({
      service: SERVICE_ID,
      playing: payload.playing ? '1' : '0',
      title: payload.title,
      artist: payload.artist,
      artwork: payload.artwork
    });
    var url = 'stashnp://report/np?' + params.toString();
    try { new Image().src = url; } catch(_) {}
  }
  function tick(){
    try {
      var v = document.querySelector('video');
      var m = (navigator.mediaSession && navigator.mediaSession.metadata) || null;
      var hasMedia = !!(v || m);
      var payload = {
        playing: !!(v && !v.paused && !v.ended && v.readyState > 2),
        title: m ? (m.title || '') : (document.title || ''),
        artist: m ? (m.artist || '') : '',
        artwork: pickArtwork(m)
      };
      if (!hasMedia) payload.playing = false;
      // Only emit when the page actually has a video element or mediaSession;
      // otherwise regular chat pages keep flooding with "nothing playing".
      if (!hasMedia && !last) return;
      var key = JSON.stringify(payload);
      if (key === last) return;
      last = key;
      send(payload);
    } catch(_) {}
  }
  setInterval(tick, 2000);
  setTimeout(tick, 800);
})();
"#;

/// Every child webview we own is labelled `webchat-<service-id>` so we can
/// find/hide/close them without needing to know their URLs at cleanup time.
const LABEL_PREFIX: &str = "webchat-";

/// Clamp an incoming zoom value to the same `[0.5, 2.0]` band the frontend
/// enforces and emit a JS-safe numeric literal. Anything missing or outside
/// the band falls back to `1` so the injected script always has a parseable
/// number — an unsubstituted placeholder would throw inside the page.
fn sanitize_zoom(value: Option<f64>) -> String {
    let z = value
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.5, 2.0))
        .unwrap_or(1.0);
    format!("{z:.2}")
}

/// Parse a user-supplied URL and reject anything that is not `http`/`https`.
/// The native webview builder trusts whatever `WebviewUrl::External` gets,
/// so `file:`, `data:`, or `javascript:` would otherwise leak through.
fn parse_http_url(url: &str) -> Result<url::Url, String> {
    let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "webchat: scheme '{}' not allowed (only http/https)",
            parsed.scheme()
        ));
    }
    Ok(parsed)
}

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
/// Keep `Version/` near current shipping Safari; older majors get the same
/// "this browser may be unsafe" page on Google sign-in.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

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
    initial_zoom: Option<f64>,
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

    let parsed = parse_http_url(&url)?;
    let ua = user_agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| SAFARI_UA.to_string());
    let zoom_literal = sanitize_zoom(initial_zoom);
    let script = WEBVIEW_DISGUISE_TEMPLATE
        .replace("{SERVICE_ID}", &service)
        .replace("{INITIAL_ZOOM}", &zoom_literal);
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .user_agent(&ua)
        .initialization_script(&script);
    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);

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

/// Destroy every attached webchat webview. Unlike `webchat_hide_all` which
/// only toggles visibility (preserving the session + its memory), this drops
/// the underlying webviews so the OS can reclaim the web process memory.
/// If `keep` is `Some`, the webview for that service id is left alone — used
/// by the "Unload inactive tabs" shell button when the AI tab is active and
/// the user is mid-session with a specific service.
#[tauri::command]
pub fn webchat_close_all(app: AppHandle, keep: Option<String>) -> Result<(), String> {
    let keep_label = match keep.as_deref() {
        Some(s) if !s.trim().is_empty() => label_for(s).ok(),
        _ => None,
    };
    let labels: Vec<String> = app
        .webviews()
        .keys()
        .filter(|k| k.starts_with(LABEL_PREFIX))
        .filter(|k| keep_label.as_deref() != Some(k.as_str()))
        .cloned()
        .collect();
    for label in labels {
        if let Some(wv) = app.webviews().get(&label).cloned() {
            let _ = wv.close();
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

/// Toggle playback of the first `<video>` element on the page. Works for
/// YouTube, embedded media in Gemini answers, Twitter video, etc. — we just
/// pick the first one and flip `.paused`. The poller's next tick updates
/// the now-playing bar's play/pause icon to the real state.
#[tauri::command]
pub fn webchat_toggle_play(app: AppHandle, service: String) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        let script = r#"(function(){
            var v = document.querySelector('video');
            if (!v) return;
            if (v.paused) v.play(); else v.pause();
        })();"#;
        wv.eval(script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Navigate the embedded webview back one step in its history. Safe no-op
/// when there is nothing to go back to — the browser's `history.back()`
/// handles that silently.
#[tauri::command]
pub fn webchat_back(app: AppHandle, service: String) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        wv.eval("history.back()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Navigate the embedded webview forward one step in its history. Safe no-op
/// when there is nothing to go forward to.
#[tauri::command]
pub fn webchat_forward(app: AppHandle, service: String) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        wv.eval("history.forward()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the *current* URL of the embedded webview — i.e. where the user
/// has navigated to, not the home URL we passed to `webchat_embed`. Powers
/// the "Save as tab" button: if the user clicked around inside a chat and
/// ended up on a specific thread, that's what gets pinned as a new tab.
#[tauri::command]
pub fn webchat_current_url(app: AppHandle, service: String) -> Result<String, String> {
    let label = label_for(&service)?;
    let wv = app
        .webviews()
        .get(&label)
        .cloned()
        .ok_or_else(|| format!("webview {label} is not attached"))?;
    let url = wv.url().map_err(|e| e.to_string())?;
    Ok(url.to_string())
}

/// Update the CSS zoom of the embedded service, clamped to `[0.5, 2.0]`.
/// We call through the helper installed by the injection script so the new
/// value is also remembered for the next SPA navigation (which would
/// otherwise rerender `<body>` and drop the style). No-op if the webview is
/// not attached — the next `webchat_embed` will pick up the persisted value.
#[tauri::command]
pub fn webchat_set_zoom(app: AppHandle, service: String, zoom: f64) -> Result<(), String> {
    let label = label_for(&service)?;
    if let Some(wv) = app.webviews().get(&label).cloned() {
        let z = sanitize_zoom(Some(zoom));
        let script = format!(
            "try {{ (window.__stashWebchatApplyZoom || function(v){{ \
                if (document.body) document.body.style.zoom = String(v); \
            }})({z}); }} catch(_) {{}}"
        );
        wv.eval(&script).map_err(|e| e.to_string())?;
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
    use super::{label_for, parse_http_url, sanitize_zoom, SAFARI_UA};

    #[test]
    fn sanitize_zoom_clamps_and_formats() {
        assert_eq!(sanitize_zoom(None), "1.00");
        assert_eq!(sanitize_zoom(Some(f64::NAN)), "1.00");
        assert_eq!(sanitize_zoom(Some(0.1)), "0.50");
        assert_eq!(sanitize_zoom(Some(5.0)), "2.00");
        assert_eq!(sanitize_zoom(Some(1.234)), "1.23");
    }

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
    fn parse_http_url_accepts_http_and_https() {
        assert!(parse_http_url("http://example.com/path").is_ok());
        assert!(parse_http_url("https://claude.ai/").is_ok());
        assert_eq!(
            parse_http_url("https://x.test/").unwrap().host_str(),
            Some("x.test")
        );
    }

    #[test]
    fn parse_http_url_rejects_other_schemes() {
        assert!(parse_http_url("file:///etc/passwd").is_err());
        assert!(parse_http_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
        assert!(parse_http_url("ftp://example.com/").is_err());
    }

    #[test]
    fn parse_http_url_rejects_garbage() {
        assert!(parse_http_url("").is_err());
        assert!(parse_http_url("not a url").is_err());
    }

    #[test]
    fn safari_ua_passes_google_embedded_browser_check() {
        assert!(SAFARI_UA.contains("Safari/"));
        assert!(!SAFARI_UA.contains("Chrome/"));
        assert!(!SAFARI_UA.to_lowercase().contains("webview"));
    }
}
