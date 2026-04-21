//! Unix-domain socket server that drives the shared `CommandRegistry`
//! for the `stash` CLI.
//!
//! Lifecycle:
//! - `spawn` is called once at app setup. It removes any stale socket
//!   (leftover from a previous crash), binds a fresh `UnixListener`,
//!   `chmod 0600`s the path (even though the per-user `Application
//!   Support` directory is already owner-only, we don't rely on that),
//!   and starts a tokio task that accepts connections forever.
//! - Each connection is handled on its own task. One JSON-line request
//!   → one JSON-line response → close. No keep-alive: throughput is
//!   human-driven, and closing keeps the protocol trivial.
//! - Errors are logged via `tracing` and never bubble up — the app
//!   keeps running even if the IPC layer can't start.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use super::protocol::{Request, Response};
use crate::modules::telegram::commands_registry::Ctx;
use crate::modules::telegram::state::TelegramState;

/// Absolute path to the IPC socket inside the app's data directory.
/// Kept as a function (not a lazy_static) because the data dir is
/// resolved at runtime through the Tauri `path()` resolver.
pub fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create app_data_dir: {e}"))?;
    Ok(dir.join("ipc.sock"))
}

/// Start the IPC server as a tokio task. Returns immediately; failures
/// are logged. Safe to call once per app launch.
pub fn spawn(app: AppHandle, state: Arc<TelegramState>) {
    let path = match socket_path(&app) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "ipc: socket path unavailable, CLI disabled");
            return;
        }
    };

    // Clear any stale socket. This is safe: the data dir is per-user,
    // and if another Stash instance is actually running on the same
    // socket, `bind` below will still succeed *after* the unlink — but
    // two live apps on one user account is already an unsupported
    // state (both would fight for the tray).
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(error = %e, path = %path.display(), "ipc: cannot remove stale socket");
            return;
        }
    }

    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(error = %e, "ipc: bind failed, CLI disabled");
            return;
        }
    };

    // Owner-only rwx on the socket file. `UnixListener::bind` creates
    // it with the process umask applied — don't trust that to land on
    // 0600.
    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(error = %e, "ipc: chmod 0600 failed");
    }

    tracing::info!(path = %path.display(), "ipc: listening");

    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let app = app.clone();
                    let state = Arc::clone(&state);
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_connection(stream, app, state).await {
                            tracing::debug!(error = %e, "ipc: connection error");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(error = %e, "ipc: accept failed");
                    // Brief back-off so a broken listener doesn't spin
                    // the event loop. Accept errors are rare in
                    // practice (FD exhaustion).
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    });
}

async fn handle_connection(
    stream: UnixStream,
    app: AppHandle,
    state: Arc<TelegramState>,
) -> Result<(), String> {
    serve_one(stream, move |req| {
        let app = app.clone();
        let state = Arc::clone(&state);
        async move { dispatch(req, app, state).await }
    })
    .await
}

/// I/O-only half of the connection handler: reads one JSON line, calls
/// `dispatcher`, writes one JSON line, closes. Split out so tests can
/// drive the transport without a Tauri runtime.
pub(crate) async fn serve_one<F, Fut>(stream: UnixStream, dispatcher: F) -> Result<(), String>
where
    F: FnOnce(Request) -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read: {e}"))?;
    if n == 0 {
        return Err("empty request".into());
    }

    let response = match serde_json::from_str::<Request>(line.trim_end()) {
        Ok(req) => dispatcher(req).await,
        Err(e) => Response::err(format!("invalid request: {e}")),
    };

    let mut body = serde_json::to_string(&response)
        .unwrap_or_else(|_| r#"{"ok":false,"error":"response encode failed"}"#.into());
    body.push('\n');

    write_half
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    write_half
        .shutdown()
        .await
        .map_err(|e| format!("shutdown: {e}"))?;
    Ok(())
}

pub(crate) async fn dispatch(
    req: Request,
    app: AppHandle,
    state: Arc<TelegramState>,
) -> Response {
    let cmd_name = req.cmd.trim().to_ascii_lowercase();
    if cmd_name.is_empty() {
        return Response::err("missing command");
    }

    let handler = match state.find_command(&cmd_name) {
        Some(h) => h,
        None => return Response::err(format!("unknown command: {cmd_name}")),
    };

    // `chat_id = 0` is a sentinel marking a CLI-originated invocation.
    // No existing handler reads `chat_id`; if one starts to, it must
    // treat `0` as "no Telegram chat".
    let ctx = Ctx { chat_id: 0, app };
    let reply = handler.handle(ctx, &req.args_text).await;
    Response::ok(reply.text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ipc::protocol::Response;

    #[test]
    fn response_helpers_shape_json() {
        let ok = serde_json::to_value(Response::ok("hi")).unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["text"], "hi");
        assert!(ok.get("error").is_none());

        let err = serde_json::to_value(Response::err("boom")).unwrap();
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"], "boom");
    }

    #[test]
    fn request_deserializes_with_missing_optional_fields() {
        let r: Request = serde_json::from_str(r#"{"cmd":"status"}"#).unwrap();
        assert_eq!(r.cmd, "status");
        assert_eq!(r.args_text, "");
        assert!(r.cwd.is_none());
    }

    // Round-trip: pair of UnixStreams, server side runs `serve_one` with
    // an echo dispatcher, client writes a request line, reads the
    // response line. Catches framing regressions (newline delimitation,
    // half-shutdown ordering) without needing a Tauri runtime.
    #[tokio::test(flavor = "current_thread")]
    async fn serve_one_round_trips_request_and_response() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let (server, client) = UnixStream::pair().expect("unix socket pair");

        let server_task = tokio::spawn(async move {
            super::serve_one(server, |req| async move {
                assert_eq!(req.cmd, "echo");
                Response::ok(format!("got: {}", req.args_text))
            })
            .await
            .unwrap();
        });

        let (read_half, mut write_half) = client.into_split();
        write_half
            .write_all(b"{\"cmd\":\"echo\",\"args_text\":\"hi there\"}\n")
            .await
            .unwrap();
        write_half.shutdown().await.unwrap();

        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let resp: Response = serde_json::from_str(line.trim_end()).unwrap();
        assert!(resp.ok);
        assert_eq!(resp.text, "got: hi there");

        server_task.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serve_one_reports_invalid_request_as_error_response() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let (server, client) = UnixStream::pair().expect("unix socket pair");

        let server_task = tokio::spawn(async move {
            super::serve_one(server, |_req| async move {
                panic!("dispatcher must not be called on bad request")
            })
            .await
            .unwrap();
        });

        let (read_half, mut write_half) = client.into_split();
        write_half.write_all(b"not json\n").await.unwrap();
        write_half.shutdown().await.unwrap();

        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let resp: Response = serde_json::from_str(line.trim_end()).unwrap();
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("invalid request"));

        server_task.await.unwrap();
    }
}
