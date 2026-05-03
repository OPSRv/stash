//! Shared loopback HTTP server for streaming on-disk media to `<audio>`
//! / `<video>`. Lives at the top of the module tree so every feature
//! (notes, downloader, future surfaces) plugs into the same server
//! rather than each rolling its own.
//!
//! Why: on macOS, `<audio>` / `<video>` is handed off to AVFoundation,
//! which only understands `http(s)://` and `file://` — Tauri's
//! `asset://` custom scheme silently fails for streaming media bigger
//! than a few MB. A loopback server sidesteps the limitation: serve
//! files over `http://127.0.0.1:<port>`, AVFoundation streams happily,
//! and we get Range-request seeking too.
//!
//! Security model:
//!   * Bind only to `127.0.0.1` (never reachable off-host).
//!   * Single secret token generated at startup. Every request must
//!     carry `?t=<token>`; mismatch → 403.
//!   * Path is canonicalised and validated against the **current**
//!     snapshot of registered roots for the requested kind. A leaked
//!     token still cannot read arbitrary files.
//!   * Symlink hop is rejected: if `canonicalize()` fails or the
//!     resolved path leaves the registered roots, the request is
//!     dropped.
//!   * Token + port are exposed only to the frontend via Tauri
//!     commands — never written to disk.
//!
//! Lifecycle:
//!   * `MediaServerState` is the managed state. The accept loop is
//!     booted lazily on first `stream_url` so a user who never opens
//!     a media-bearing tab pays nothing.
//!   * `Roots` is dynamic — modules call `register(kind, path)` at
//!     boot or when the user re-points a directory (e.g. Settings →
//!     Downloads folder). Each handler reads the live snapshot.
//!   * `stop()` flips a shutdown flag the accept loop polls every
//!     ~250ms; in-flight handlers run to completion before threads
//!     join.

use std::io::{Read, Seek, SeekFrom};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server, StatusCode};

const MAX_INFLIGHT: usize = 16;
const ACCEPT_POLL: Duration = Duration::from_millis(250);

/// Kind of media a path is being streamed as. Determines route, MIME
/// detection and which root list the path is validated against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Audio,
    Video,
    Image,
}

impl MediaKind {
    fn route(self) -> &'static str {
        match self {
            MediaKind::Audio => "/audio",
            MediaKind::Video => "/video",
            MediaKind::Image => "/image",
        }
    }
}

#[derive(Default)]
struct RootsInner {
    audio: Vec<PathBuf>,
    video: Vec<PathBuf>,
    image: Vec<PathBuf>,
}

impl RootsInner {
    fn list_for(&self, kind: MediaKind) -> &Vec<PathBuf> {
        match kind {
            MediaKind::Audio => &self.audio,
            MediaKind::Video => &self.video,
            MediaKind::Image => &self.image,
        }
    }

    fn list_mut(&mut self, kind: MediaKind) -> &mut Vec<PathBuf> {
        match kind {
            MediaKind::Audio => &mut self.audio,
            MediaKind::Video => &mut self.video,
            MediaKind::Image => &mut self.image,
        }
    }

    fn contains(&self, kind: MediaKind, canon: &Path) -> bool {
        self.list_for(kind).iter().any(|r| canon.starts_with(r))
    }
}

struct Running {
    port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

/// Shared state — managed by Tauri as `Arc<MediaServerState>`. Modules
/// register their roots once at boot (and re-register whenever a root
/// is re-pointed by the user); commands then resolve any path under a
/// registered root to a streaming URL via [`MediaServerState::stream_url`].
pub struct MediaServerState {
    roots: Arc<RwLock<RootsInner>>,
    running: OnceLock<Running>,
}

impl MediaServerState {
    pub fn new() -> Self {
        Self {
            roots: Arc::new(RwLock::new(RootsInner::default())),
            running: OnceLock::new(),
        }
    }

    /// Register a directory as a permitted root for `kind`. Idempotent.
    /// `path` is canonicalised — non-existent dirs are silently dropped
    /// (callers are not expected to know whether `~/Music/Stash Stems`
    /// already exists).
    pub fn register(&self, kind: MediaKind, path: PathBuf) {
        let canon = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut guard = self.roots.write().expect("media_server roots poisoned");
        let list = guard.list_mut(kind);
        if !list.iter().any(|p| p == &canon) {
            list.push(canon);
        }
    }

    /// Drop a previously registered root. Used by `dl_set_downloads_dir`
    /// when the user re-points the downloads folder, so the old
    /// directory loses scope as soon as the new one is added.
    pub fn unregister(&self, kind: MediaKind, path: &Path) {
        let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mut guard = self.roots.write().expect("media_server roots poisoned");
        guard.list_mut(kind).retain(|p| p != &canon);
    }

    /// Resolve `path` to a `http://127.0.0.1:<port>/<route>?path=…&t=…`
    /// URL the renderer can hand to `<audio>` / `<video>` / `<img>`.
    /// Boots the accept loop on first call. Errors if the path does
    /// not canonicalise, isn't a file, or isn't under any registered
    /// root for `kind`.
    pub fn stream_url(&self, kind: MediaKind, path: &str) -> Result<String, String> {
        let p = Path::new(path);
        let canon = p
            .canonicalize()
            .map_err(|e| format!("canonicalize failed: {e}"))?;
        if !canon.is_file() {
            return Err("path is not a file".into());
        }
        {
            let guard = self.roots.read().expect("media_server roots poisoned");
            if !guard.contains(kind, &canon) {
                return Err(format!(
                    "path is outside the registered {:?} roots",
                    kind
                ));
            }
        }
        let running = self.ensure_running()?;
        let abs = canon
            .to_str()
            .ok_or_else(|| "path is not valid UTF-8".to_string())?;
        Ok(format!(
            "http://127.0.0.1:{}{}?path={}&t={}",
            running.port,
            kind.route(),
            url_encode_component(abs),
            url_encode_component(&running.token),
        ))
    }

    /// Idempotent shutdown. Called from the app's `RunEvent::Exit`
    /// handler so the bound port is released before a hot-restart or
    /// test harness re-uses the process.
    pub fn stop(&self) {
        if let Some(running) = self.running.get() {
            running.shutdown.store(true, Ordering::SeqCst);
            if let Ok(mut guard) = running.handle.lock() {
                if let Some(h) = guard.take() {
                    let _ = h.join();
                }
            }
        }
    }

    fn ensure_running(&self) -> Result<&Running, String> {
        if let Some(r) = self.running.get() {
            return Ok(r);
        }
        // Two callers may race here; the first wins the OnceLock and
        // the loser drops its server on the floor (its accept thread
        // never started because we only spawn after `set` succeeds).
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("local_addr failed: {e}"))?
            .port();
        let server = Server::from_listener(listener, None)
            .map_err(|e| format!("tiny_http::Server failed: {e}"))?;
        let token = mint_token();
        let shutdown = Arc::new(AtomicBool::new(false));

        let server = Arc::new(server);
        let inflight = Arc::new(AtomicUsize::new(0));

        let server_for_thread = Arc::clone(&server);
        let shutdown_for_thread = Arc::clone(&shutdown);
        let inflight_for_thread = Arc::clone(&inflight);
        let token_for_thread = token.clone();
        let roots_for_thread = Arc::clone(&self.roots);
        let join = std::thread::Builder::new()
            .name("media-server".into())
            .spawn(move || {
                accept_loop(
                    server_for_thread,
                    token_for_thread,
                    roots_for_thread,
                    shutdown_for_thread,
                    inflight_for_thread,
                )
            })
            .map_err(|e| format!("spawn server thread failed: {e}"))?;

        let running = Running {
            port,
            token,
            shutdown,
            handle: Mutex::new(Some(join)),
        };
        let _ = self.running.set(running);
        Ok(self.running.get().expect("just set"))
    }
}

impl Default for MediaServerState {
    fn default() -> Self {
        Self::new()
    }
}

fn mint_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut buf);
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn accept_loop(
    server: Arc<Server>,
    token: String,
    roots: Arc<RwLock<RootsInner>>,
    shutdown: Arc<AtomicBool>,
    inflight: Arc<AtomicUsize>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match server.recv_timeout(ACCEPT_POLL) {
            Ok(Some(request)) => {
                if inflight.load(Ordering::SeqCst) >= MAX_INFLIGHT {
                    let _ = request.respond(Response::empty(StatusCode(503)));
                    continue;
                }
                let token = token.clone();
                let roots = Arc::clone(&roots);
                let inflight_cell = Arc::clone(&inflight);
                let _ = std::thread::Builder::new()
                    .name("media-server-conn".into())
                    .spawn(move || {
                        inflight_cell.fetch_add(1, Ordering::SeqCst);
                        handle(request, &token, &roots);
                        inflight_cell.fetch_sub(1, Ordering::SeqCst);
                    });
            }
            Ok(None) => {}
            Err(_) => {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn handle(request: tiny_http::Request, token: &str, roots: &RwLock<RootsInner>) {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }

    let url = request.url().to_string();
    let (route, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let kind = match route {
        "/audio" => MediaKind::Audio,
        "/image" => MediaKind::Image,
        "/video" => MediaKind::Video,
        _ => {
            let _ = request.respond(Response::empty(StatusCode(404)));
            return;
        }
    };

    let mut path: Option<String> = None;
    let mut got_token: Option<String> = None;
    for pair in query.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => continue,
        };
        let decoded = url_decode(v);
        match k {
            "path" => path = Some(decoded),
            "t" => got_token = Some(decoded),
            _ => {}
        }
    }

    if got_token.as_deref() != Some(token) {
        let _ = request.respond(Response::empty(StatusCode(403)));
        return;
    }
    let path = match path {
        Some(p) if !p.is_empty() => p,
        _ => {
            let _ = request.respond(Response::empty(StatusCode(400)));
            return;
        }
    };

    let p = Path::new(&path);
    let canon = match p.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let _ = request.respond(Response::empty(StatusCode(404)));
            return;
        }
    };
    {
        let guard = roots.read().expect("media_server roots poisoned");
        if !guard.contains(kind, &canon) {
            let _ = request.respond(Response::empty(StatusCode(403)));
            return;
        }
    }
    if !canon.is_file() {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    }

    let total = match std::fs::metadata(&canon) {
        Ok(m) => m.len(),
        Err(_) => {
            let _ = request.respond(Response::empty(StatusCode(500)));
            return;
        }
    };

    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    let head_only = request.method() == &Method::Head;
    let mime = match kind {
        MediaKind::Audio => mime_for_audio(&canon),
        MediaKind::Image => mime_for_image(&canon),
        MediaKind::Video => mime_for_video(&canon),
    };

    let (start, end) = match (
        range_header.as_deref(),
        parse_range(range_header.as_deref(), total),
    ) {
        (Some(_), Some(range)) => range,
        (Some(_), None) => {
            let cr = format!("bytes */{total}");
            let mut response = Response::empty(StatusCode(416));
            if let Ok(h) = Header::from_bytes("Content-Range", cr.as_bytes()) {
                response.add_header(h);
            }
            let _ = request.respond(response);
            return;
        }
        (None, _) => (0, total.saturating_sub(1)),
    };
    let len = end + 1 - start;
    let is_partial = range_header.is_some();
    let status = if is_partial { 206 } else { 200 };

    let mut headers: Vec<Header> = vec![
        Header::from_bytes("Content-Type", mime.as_bytes())
            .expect("static mime header is well-formed"),
        Header::from_bytes("Accept-Ranges", &b"bytes"[..])
            .expect("static accept-ranges header is well-formed"),
        Header::from_bytes("Cache-Control", &b"no-store"[..])
            .expect("static cache-control header is well-formed"),
        Header::from_bytes("Content-Length", len.to_string().as_bytes())
            .expect("numeric content-length is well-formed"),
    ];
    if is_partial {
        let cr = format!("bytes {start}-{end}/{total}");
        if let Ok(h) = Header::from_bytes("Content-Range", cr.as_bytes()) {
            headers.push(h);
        }
    }

    if head_only {
        let mut response = Response::empty(StatusCode(status));
        for h in headers {
            response.add_header(h);
        }
        let _ = request.respond(response);
        return;
    }

    let mut file = match std::fs::File::open(&canon) {
        Ok(f) => f,
        Err(_) => {
            let _ = request.respond(Response::empty(StatusCode(500)));
            return;
        }
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        let _ = request.respond(Response::empty(StatusCode(500)));
        return;
    }
    let take: Box<dyn Read + Send> = Box::new(file.take(len));
    let response = Response::new(StatusCode(status), headers, take, Some(len as usize), None);
    let _ = request.respond(response);
}

fn parse_range(raw: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let raw = raw?.trim();
    let raw = raw.strip_prefix("bytes=").unwrap_or(raw);
    let first = raw.split(',').next()?.trim();
    let (s, e) = first.split_once('-')?;
    let (start, end): (u64, u64) = if s.is_empty() {
        let n: u64 = e.parse().ok()?;
        if n == 0 || total == 0 {
            return None;
        }
        (total.saturating_sub(n), total.saturating_sub(1))
    } else {
        let start: u64 = s.parse().ok()?;
        let end: u64 = if e.is_empty() {
            total.saturating_sub(1)
        } else {
            e.parse().ok()?
        };
        (start, end)
    };
    if start > end || end >= total {
        return None;
    }
    Some((start, end))
}

fn mime_for_image(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        Some(ref e) if e == "png" => "image/png",
        Some(ref e) if e == "jpg" || e == "jpeg" => "image/jpeg",
        Some(ref e) if e == "gif" => "image/gif",
        Some(ref e) if e == "webp" => "image/webp",
        Some(ref e) if e == "svg" => "image/svg+xml",
        Some(ref e) if e == "bmp" => "image/bmp",
        Some(ref e) if e == "heic" || e == "heif" => "image/heic",
        Some(ref e) if e == "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn mime_for_audio(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        Some(ref e) if e == "mp4" || e == "m4a" || e == "aac" => "audio/mp4",
        Some(ref e) if e == "mp3" => "audio/mpeg",
        Some(ref e) if e == "wav" => "audio/wav",
        Some(ref e) if e == "ogg" || e == "opus" => "audio/ogg",
        Some(ref e) if e == "webm" => "audio/webm",
        Some(ref e) if e == "flac" => "audio/flac",
        Some(ref e) if e == "aiff" || e == "aif" => "audio/aiff",
        _ => "application/octet-stream",
    }
}

fn mime_for_video(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        Some(ref e) if e == "mp4" || e == "m4v" => "video/mp4",
        Some(ref e) if e == "mov" => "video/quicktime",
        Some(ref e) if e == "webm" => "video/webm",
        Some(ref e) if e == "mkv" => "video/x-matroska",
        Some(ref e) if e == "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

/// File extensions the unified `media_stream_url` command treats as
/// video. Anything else falls back to audio scope. Mirrors the
/// `<video>`-eligible MIMEs above.
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv", "avi"];

/// Pick a kind by extension. `webm` is ambiguous (audio-only WebM is
/// legal) but in this app every webm we ship as `<video>` came from
/// yt-dlp's video pipeline, so default `webm` to video. Audio-only
/// surfaces (notes voice memos, the audio-stream notes command) keep
/// calling `MediaKind::Audio` directly.
pub fn kind_for_extension(path: &str) -> MediaKind {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if VIDEO_EXTS.contains(&ext.as_str()) {
        MediaKind::Video
    } else {
        MediaKind::Audio
    }
}

fn url_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        let unreserved = c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '~' | '/');
        if unreserved {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Single front door used by the shared `<VideoPlayer>` (and any
/// future generic media surface). Picks the kind by extension and
/// resolves through the shared registered roots.
#[tauri::command]
pub fn media_stream_url(
    state: tauri::State<'_, Arc<MediaServerState>>,
    path: String,
) -> Result<String, String> {
    let kind = kind_for_extension(&path);
    state.stream_url(kind, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bytes_start_only() {
        assert_eq!(parse_range(Some("bytes=100-"), 1000), Some((100, 999)));
    }

    #[test]
    fn parses_bytes_start_end() {
        assert_eq!(parse_range(Some("bytes=10-20"), 1000), Some((10, 20)));
    }

    #[test]
    fn parses_suffix_range() {
        assert_eq!(parse_range(Some("bytes=-50"), 1000), Some((950, 999)));
    }

    #[test]
    fn rejects_out_of_bounds() {
        assert_eq!(parse_range(Some("bytes=500-2000"), 1000), None);
    }

    #[test]
    fn rejects_inverted_range() {
        assert_eq!(parse_range(Some("bytes=200-100"), 1000), None);
    }

    #[test]
    fn rejects_non_numeric_range() {
        assert_eq!(parse_range(Some("bytes=abc-"), 1000), None);
        assert_eq!(parse_range(Some("bytes=-xyz"), 1000), None);
    }

    #[test]
    fn missing_range_yields_none() {
        assert_eq!(parse_range(None, 1000), None);
    }

    #[test]
    fn url_decode_handles_percent_and_plus() {
        assert_eq!(url_decode("hello+world"), "hello world");
        assert_eq!(url_decode("a%20b"), "a b");
        assert_eq!(url_decode("%D0%9F"), "П");
    }

    #[test]
    fn mime_lookup_covers_common_audio() {
        assert_eq!(mime_for_audio(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_for_audio(Path::new("a.MP3")), "audio/mpeg");
        assert_eq!(mime_for_audio(Path::new("a.opus")), "audio/ogg");
        assert_eq!(
            mime_for_audio(Path::new("a.weird")),
            "application/octet-stream"
        );
    }

    #[test]
    fn mime_lookup_covers_common_video() {
        assert_eq!(mime_for_video(Path::new("clip.mp4")), "video/mp4");
        assert_eq!(mime_for_video(Path::new("clip.MOV")), "video/quicktime");
        assert_eq!(mime_for_video(Path::new("clip.webm")), "video/webm");
        assert_eq!(
            mime_for_video(Path::new("a.weird")),
            "application/octet-stream"
        );
    }

    #[test]
    fn kind_for_extension_picks_video_for_known_video_exts() {
        assert_eq!(kind_for_extension("/tmp/clip.mp4"), MediaKind::Video);
        assert_eq!(kind_for_extension("clip.MOV"), MediaKind::Video);
        // No extension → audio fallback (notes voice memos with weird
        // filenames still resolve).
        assert_eq!(kind_for_extension("noext"), MediaKind::Audio);
        assert_eq!(kind_for_extension("song.mp3"), MediaKind::Audio);
    }

    #[test]
    fn register_dedupes_canonical_paths() {
        let s = MediaServerState::new();
        let tmp = std::env::temp_dir();
        s.register(MediaKind::Audio, tmp.clone());
        s.register(MediaKind::Audio, tmp.clone());
        let guard = s.roots.read().unwrap();
        assert_eq!(guard.audio.len(), 1);
    }

    #[test]
    fn unregister_removes_root() {
        let s = MediaServerState::new();
        let tmp = std::env::temp_dir();
        s.register(MediaKind::Video, tmp.clone());
        s.unregister(MediaKind::Video, &tmp);
        let guard = s.roots.read().unwrap();
        assert!(guard.video.is_empty());
    }

    #[test]
    fn stream_url_rejects_unregistered_path() {
        let s = MediaServerState::new();
        // Use Cargo.toml as a guaranteed-existing file outside any
        // registered root.
        let file = std::env::current_dir().unwrap().join("Cargo.toml");
        let res = s.stream_url(MediaKind::Video, file.to_str().unwrap());
        assert!(res.is_err(), "expected scope rejection, got {res:?}");
    }

    #[test]
    fn stream_url_accepts_registered_path() {
        let s = MediaServerState::new();
        let dir = std::env::current_dir().unwrap();
        s.register(MediaKind::Audio, dir.clone());
        let file = dir.join("Cargo.toml");
        let res = s.stream_url(MediaKind::Audio, file.to_str().unwrap());
        assert!(res.is_ok(), "expected url, got {res:?}");
        let url = res.unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        assert!(url.contains("/audio?path="));
        assert!(url.contains("&t="));
        s.stop();
    }

    #[test]
    fn server_can_stop_cleanly() {
        let s = MediaServerState::new();
        let tmp = std::env::temp_dir();
        s.register(MediaKind::Audio, tmp.clone());
        let file = tmp.join("Cargo.toml.notthere");
        let _ = s.stream_url(MediaKind::Audio, file.to_str().unwrap()); // boots server
        // If stream_url errored before booting, force-boot via a real path.
        let real = std::env::current_dir().unwrap();
        s.register(MediaKind::Audio, real.clone());
        let _ = s.stream_url(MediaKind::Audio, real.join("Cargo.toml").to_str().unwrap());
        let port = s.running.get().expect("running").port;
        s.stop();
        for _ in 0..20 {
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("port {port} still bound after stop()");
    }
}
