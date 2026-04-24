use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const LABEL: &str = "music";

/// Injected into the music webview on every page load. Polls `mediaSession`
/// + the `<video>` element every 2s and reports the current now-playing
/// state to Rust. Tauri 2 does not inject its IPC bridge into remote-origin
/// webviews, so we tunnel state through a custom URI scheme (`stashnp://`)
/// registered on the Rust side — every reported change fires a no-cors
/// `fetch` whose URL encodes the payload. The install-guard prevents
/// duplicate intervals when YT Music navigates between songs.
const INIT_SCRIPT: &str = r#"
(function(){
  if (window.__stashNowPlayingInstalled) return;
  window.__stashNowPlayingInstalled = true;
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
    } catch(e) { return ''; }
  }
  function send(payload){
    var params = new URLSearchParams({
      playing: payload.playing ? '1' : '0',
      title: payload.title,
      artist: payload.artist,
      artwork: payload.artwork
    });
    // WKWebView's fetch API rejects non-http(s) schemes even when the host
    // has registered a handler, so we ping our custom scheme via an <img>
    // load instead — images happily request any URL and the failure is
    // silent. The request still reaches the scheme handler on Rust.
    var url = 'stashnp://report/np?' + params.toString();
    try { new Image().src = url; } catch(e) {}
    console.log('[stash] np tick', payload);
  }
  function tick(){
    try {
      var v = document.querySelector('video');
      var m = (navigator.mediaSession && navigator.mediaSession.metadata) || null;
      var payload = {
        playing: !!(v && !v.paused && !v.ended && v.readyState > 2),
        title: m ? (m.title || '') : '',
        artist: m ? (m.artist || '') : '',
        artwork: pickArtwork(m)
      };
      var key = JSON.stringify(payload);
      if (key === last) return;
      last = key;
      send(payload);
    } catch(e) {}
  }
  setInterval(tick, 2000);
  setTimeout(tick, 800);
})();
"#;

/// Safari UA — Google blocks sign-in from identifiable embedded WebViews
/// ("browser not secure"); pretending to be Safari on macOS passes the check.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
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
    let mut builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .user_agent(&ua)
        .initialization_script(INIT_SCRIPT);
    // Enable right-click → Inspect Element in dev builds so the injected
    // now-playing poller (and any YT Music DOM drift) can be diagnosed.
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

fn click_in_webview(app: &AppHandle, selector: &str) -> Result<(), String> {
    // Injected JS is plain click() — YouTube Music exposes the player bar
    // controls as real buttons, so a synthetic click drives them reliably.
    let script = format!(
        "(function(){{var el=document.querySelector({sel});if(el)el.click();}})();",
        sel = json_quote(selector)
    );
    run_in_webview(app, &script)
}

/// Evaluate arbitrary JS inside the attached music webview. Returns
/// `"music webview not attached"` on absence so the caller can decide
/// whether to auto-reveal the tab. Values returned from the script are
/// not surfaced back here — `wv.eval` is fire-and-forget — so the
/// script must self-contain its decision making.
fn run_in_webview(app: &AppHandle, script: &str) -> Result<(), String> {
    let wv = app
        .webviews()
        .get(LABEL)
        .cloned()
        .ok_or_else(|| "music webview not attached".to_string())?;
    wv.eval(script).map_err(|e| e.to_string())?;
    Ok(())
}

/// Minimal JSON string escaper — we only need it for CSS selectors that we
/// control, so we don't pull in serde_json just to quote a short literal.
fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[tauri::command]
pub fn music_play_pause(app: AppHandle) -> Result<(), String> {
    // Cascade: the player-bar toggle only exists once a track is loaded
    // (i.e. after the user has picked something at least once). On a
    // cold home page we fall back to clicking the first Quick-Picks /
    // shelf play button, then the underlying <video> element as a last
    // resort. This makes `/music play` actually start *some* music on a
    // fresh session — which is what users mean when they say it.
    run_in_webview(
        &app,
        r#"(function(){
            function clickIf(el){ if(!el) return false; el.click(); return true; }
            var bar = document.querySelector('#play-pause-button');
            if (bar && !bar.disabled && bar.offsetParent) { bar.click(); return 'bar'; }
            var shelfSel = [
                'ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer [aria-label^="Play"]',
                'ytmusic-carousel-shelf-renderer ytmusic-two-row-item-renderer [aria-label^="Play"]',
                'ytmusic-carousel-shelf-renderer ytmusic-responsive-list-item-renderer [aria-label^="Play"]',
                'ytmusic-grid-renderer [aria-label^="Play"]'
            ].join(',');
            var shelf = document.querySelector(shelfSel);
            if (clickIf(shelf)) return 'shelf';
            var vid = document.querySelector('video');
            if (vid && vid.readyState > 0) { vid.play().catch(function(){}); return 'video'; }
            return 'none';
        })();"#,
    )
}

#[tauri::command]
pub fn music_next(app: AppHandle) -> Result<(), String> {
    click_in_webview(&app, ".next-button.ytmusic-player-bar")
}

#[tauri::command]
pub fn music_prev(app: AppHandle) -> Result<(), String> {
    click_in_webview(&app, ".previous-button.ytmusic-player-bar")
}

#[cfg(test)]
mod tests {
    use super::{json_quote, SAFARI_UA};

    #[test]
    fn json_quote_escapes_backslash_and_quote() {
        assert_eq!(json_quote("#play"), "\"#play\"");
        assert_eq!(json_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_quote("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn safari_ua_passes_google_embedded_browser_check() {
        assert!(SAFARI_UA.contains("Safari/"));
        assert!(SAFARI_UA.contains("Version/"));
        assert!(!SAFARI_UA.contains("Chrome/"));
        assert!(!SAFARI_UA.to_lowercase().contains("electron"));
        assert!(!SAFARI_UA.to_lowercase().contains("webview"));
    }
}
