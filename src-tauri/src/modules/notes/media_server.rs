//! Loopback HTTP server for streaming audio attachments to `<audio>`.
//!
//! Why: on macOS, large/streaming media in `<audio>`/`<video>` is handed
//! off to AVFoundation, which only understands `http(s)://` and `file://`
//! — it cannot open Tauri's custom `asset://` protocol. That kills inline
//! playback for anything yt-dlp size'd (50 MB+ m4a). A loopback server
//! sidesteps the limitation: serve files over `http://127.0.0.1:<port>`,
//! AVFoundation streams happily, and we get Range-request seeking too.
//!
//! Security model:
//!   * Bind only to `127.0.0.1` (never reachable off-host).
//!   * Single secret token generated at startup. Every request must
//!     carry `?t=<token>`; mismatch → 403.
//!   * Path is validated against the same scope guards used by
//!     `notes_read_audio_path` (audio dir + attachments root). A leaked
//!     token still cannot read arbitrary files on disk.
//!   * Symlink hop is rejected: if `canonicalize()` fails or the resolved
//!     path leaves the allowed roots, the request is dropped.
//!   * Token + port are exposed only to the frontend via a Tauri
//!     command — never written to disk.
//!
//! Lifecycle:
//!   * `start()` is idempotent — the caller (`NotesState::media_server`
//!     OnceLock) only ever calls it once, but the inner accept loop is
//!     polling-based (`recv_timeout` + shutdown flag) so a future
//!     `stop()` shuts threads down cleanly.
//!   * The number of in-flight request handlers is bounded; bursts above
//!     `MAX_INFLIGHT` are answered with 503 instead of spawning unbounded
//!     OS threads.

use std::io::{Read, Seek, SeekFrom};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server, StatusCode};

/// Cap concurrent connection handlers. The frontend only opens one or two
/// streams at a time; anything past this cap is a runaway client (or a
/// malicious caller riding a leaked token) and gets 503'd.
const MAX_INFLIGHT: usize = 16;

/// Period at which the accept loop re-checks the shutdown flag. Short
/// enough that `stop()` returns within ~half a second, long enough that
/// the idle CPU cost is invisible.
const ACCEPT_POLL: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub struct MediaServer {
    pub port: u16,
    pub token: String,
    /// Shared shutdown flag. Setting it makes the accept loop exit on
    /// the next `recv_timeout` tick; existing in-flight handlers run
    /// to completion before threads join.
    shutdown: Arc<AtomicBool>,
    /// Optional join handle for the accept loop. Wrapped in a `Mutex`
    /// because `MediaServer` is `Clone` — the original retains the
    /// handle, every cloned reader sees `None`.
    handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl MediaServer {
    /// Signal the accept loop to exit and join its thread. Idempotent;
    /// safe to call multiple times. After return, no further requests
    /// are accepted on the bound port.
    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(h) = guard.take() {
                // Blocking on the accept thread is fine — it polls every
                // ACCEPT_POLL ms and bails out as soon as the flag flips.
                let _ = h.join();
            }
        }
    }
}

#[derive(Clone)]
struct Roots {
    audio: PathBuf,
    attachments: PathBuf,
    images: PathBuf,
}

/// Start the loopback server on an ephemeral port. Returns the bound
/// address + a freshly minted token; spawns a daemon thread for the
/// accept loop. Idempotent if called once at app boot.
pub fn start(audio: PathBuf, attachments: PathBuf, images: PathBuf) -> Result<MediaServer, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|e| format!("bind 127.0.0.1:0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();

    let server = Server::from_listener(listener, None)
        .map_err(|e| format!("tiny_http::Server failed: {e}"))?;

    let token = mint_token();
    let token_for_thread = token.clone();
    let roots = Arc::new(Roots { audio, attachments, images });
    let server = Arc::new(server);
    let shutdown = Arc::new(AtomicBool::new(false));
    let inflight = Arc::new(AtomicUsize::new(0));

    let server_for_thread = Arc::clone(&server);
    let shutdown_for_thread = Arc::clone(&shutdown);
    let inflight_for_thread = Arc::clone(&inflight);
    let join = std::thread::Builder::new()
        .name("notes-media-server".into())
        .spawn(move || {
            accept_loop(
                server_for_thread,
                token_for_thread,
                roots,
                shutdown_for_thread,
                inflight_for_thread,
            )
        })
        .map_err(|e| format!("spawn server thread failed: {e}"))?;

    Ok(MediaServer {
        port,
        token,
        shutdown,
        handle: Arc::new(Mutex::new(Some(join))),
    })
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
    roots: Arc<Roots>,
    shutdown: Arc<AtomicBool>,
    inflight: Arc<AtomicUsize>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match server.recv_timeout(ACCEPT_POLL) {
            Ok(Some(request)) => {
                // Bound concurrent handlers — a leaked token + malicious
                // peer cannot trigger unbounded thread spawn.
                if inflight.load(Ordering::SeqCst) >= MAX_INFLIGHT {
                    let _ = request.respond(Response::empty(StatusCode(503)));
                    continue;
                }
                let token = token.clone();
                let roots = Arc::clone(&roots);
                let inflight_cell = Arc::clone(&inflight);
                let _ = std::thread::Builder::new()
                    .name("notes-media-conn".into())
                    .spawn(move || {
                        inflight_cell.fetch_add(1, Ordering::SeqCst);
                        handle(request, &token, &roots);
                        inflight_cell.fetch_sub(1, Ordering::SeqCst);
                    });
            }
            Ok(None) => {
                // Timeout — loop and re-check shutdown. Cheap.
            }
            Err(_) => {
                // tiny_http surfaces transient I/O errors on accept;
                // bailing out of the whole server on a single bad
                // socket would be over-eager. Backoff briefly and
                // continue.
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn handle(request: tiny_http::Request, token: &str, roots: &Roots) {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }

    let url = request.url().to_string();
    let (route, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let kind = match route {
        "/audio" => RouteKind::Audio,
        "/image" => RouteKind::Image,
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
    // Hard path resolve: if `canonicalize` fails (broken symlink,
    // permission denied, vanished file) we 404 instead of falling back
    // to the unresolved path — that fallback would let a symlink that
    // points outside the allowed roots slip past the `starts_with`
    // guard below.
    let canon = match p.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let _ = request.respond(Response::empty(StatusCode(404)));
            return;
        }
    };
    let in_scope = match kind {
        RouteKind::Audio => {
            canon.starts_with(&roots.audio) || canon.starts_with(&roots.attachments)
        }
        // Inline `![](...)` references resolve against the managed images
        // dir; attachments may also be image files surfaced via the embed.
        RouteKind::Image => {
            canon.starts_with(&roots.images) || canon.starts_with(&roots.attachments)
        }
    };
    if !in_scope {
        let _ = request.respond(Response::empty(StatusCode(403)));
        return;
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
        RouteKind::Audio => mime_for_audio(&canon),
        RouteKind::Image => mime_for_image(&canon),
    };

    let (start, end) = match (range_header.as_deref(), parse_range(range_header.as_deref(), total))
    {
        // Honour any well-formed range header.
        (Some(_), Some(range)) => range,
        // RFC 7233: a malformed/unsatisfiable Range header should answer
        // 416 with a Content-Range describing the whole resource — not
        // silently fall through to a full-body 200, which masks bugs in
        // clients that send `bytes=abc-` and expect partial content.
        (Some(_), None) => {
            let cr = format!("bytes */{total}");
            let mut response = Response::empty(StatusCode(416));
            if let Ok(h) = Header::from_bytes("Content-Range", cr.as_bytes()) {
                response.add_header(h);
            }
            let _ = request.respond(response);
            return;
        }
        // No header: serve the whole file.
        (None, _) => (0, total.saturating_sub(1)),
    };
    let len = end + 1 - start;
    let is_partial = range_header.is_some();

    let status = if is_partial { 206 } else { 200 };

    // Build common headers once.
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

    // Stream the requested byte range. Open a fresh handle so each
    // request seeks independently — `tiny_http` may pipeline.
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
    // Errors here usually mean the client (AVFoundation) closed the
    // socket mid-seek — normal, not fatal.
    let _ = request.respond(response);
}

/// Single-pair `bytes=start-end?` parser. RFC 7233 multi-range requests
/// (`bytes=0-99,200-299`) are rare in `<audio>` and we honour just the
/// first pair if a client ever sends one.
fn parse_range(raw: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let raw = raw?.trim();
    let raw = raw.strip_prefix("bytes=").unwrap_or(raw);
    let first = raw.split(',').next()?.trim();
    let (s, e) = first.split_once('-')?;
    let (start, end): (u64, u64) = if s.is_empty() {
        // `bytes=-N` → suffix: last N bytes of the file.
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

#[derive(Clone, Copy)]
enum RouteKind {
    Audio,
    Image,
}

fn mime_for_image(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
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
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
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

/// Minimal `application/x-www-form-urlencoded` decoder. We only need
/// `%xx` and `+ → space`. Unknown escapes are passed through verbatim
/// so a malformed query never panics.
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
        // `bytes=abc-` previously slipped past the parser and served the
        // whole file. Now the handler turns that into a 416.
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
        assert_eq!(mime_for_audio(Path::new("a.weird")), "application/octet-stream");
    }

    #[test]
    fn server_can_stop_cleanly() {
        // Smoke test: start → stop should return promptly without
        // panicking, even with no requests served.
        let tmp = std::env::temp_dir();
        let server = start(tmp.clone(), tmp.clone(), tmp).expect("start");
        let port = server.port;
        server.stop();
        // After stop, the port should be free for re-bind. Allow a tiny
        // window for the OS to release; failure here would mean the
        // accept thread leaked.
        for _ in 0..20 {
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("port {port} still bound after stop()");
    }
}
