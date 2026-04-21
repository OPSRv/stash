//! `stash` — command-line transport for the running Stash app.
//!
//! Connects to the app's Unix-domain socket, sends one JSON-line
//! request, prints the textual response to stdout, and exits.
//!
//! Exit codes:
//! - `0` command succeeded
//! - `1` command failed (app was reachable but reported an error)
//! - `2` Stash is not running (socket missing / connect refused)

use std::io::Write as _;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// Bundle identifier must match `tauri.conf.json` `identifier`. Matched
/// here so the CLI can resolve the app's data directory without a
/// runtime handshake.
const BUNDLE_ID: &str = "com.opsrv.stash";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Request {
    cmd: String,
    #[serde(default)]
    args_text: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Response {
    ok: bool,
    #[serde(default)]
    text: String,
    #[serde(default)]
    error: Option<String>,
}

fn socket_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("STASH_IPC_SOCK") {
        return Some(PathBuf::from(p));
    }
    dirs_next::data_dir().map(|d| d.join(BUNDLE_ID).join("ipc.sock"))
}

fn print_usage() {
    eprintln!(
        "usage: stash <command> [args...]\n\
         \n\
         examples:\n  \
         stash help\n  \
         stash status\n  \
         stash battery\n  \
         stash note \"buy milk\"\n  \
         stash clip\n\
         \n\
         flags:\n  \
         --json    print the raw JSON response instead of text\n"
    );
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();

    let mut json_out = false;
    args.retain(|a| {
        if a == "--json" {
            json_out = true;
            false
        } else {
            true
        }
    });

    if args.is_empty() {
        print_usage();
        return ExitCode::from(1);
    }

    let cmd = args.remove(0);
    if cmd == "--help" || cmd == "-h" {
        print_usage();
        return ExitCode::SUCCESS;
    }

    let args_text = args.join(" ");
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok());

    let req = Request {
        cmd,
        args_text,
        cwd,
    };

    let path = match socket_path() {
        Some(p) => p,
        None => {
            eprintln!("stash: cannot resolve data directory");
            return ExitCode::from(2);
        }
    };

    let stream = match tokio::time::timeout(
        Duration::from_secs(2),
        UnixStream::connect(&path),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(_)) | Err(_) => {
            eprintln!("stash: Stash app is not running");
            return ExitCode::from(2);
        }
    };

    let (read_half, mut write_half) = stream.into_split();
    let mut body = match serde_json::to_string(&req) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("stash: encode request: {e}");
            return ExitCode::from(1);
        }
    };
    body.push('\n');

    if let Err(e) = write_half.write_all(body.as_bytes()).await {
        eprintln!("stash: write: {e}");
        return ExitCode::from(2);
    }
    // Closing our write half lets the server finish reading cleanly
    // even if its read_line is still buffered.
    let _ = write_half.shutdown().await;

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    match tokio::time::timeout(Duration::from_secs(60), reader.read_line(&mut line)).await {
        Ok(Ok(0)) => {
            eprintln!("stash: server closed connection without reply");
            return ExitCode::from(2);
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            eprintln!("stash: read: {e}");
            return ExitCode::from(2);
        }
        Err(_) => {
            eprintln!("stash: server timed out");
            return ExitCode::from(2);
        }
    }

    if json_out {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        return ExitCode::SUCCESS;
    }

    let resp: Response = match serde_json::from_str(line.trim_end()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("stash: invalid response: {e}");
            return ExitCode::from(2);
        }
    };

    if resp.ok {
        if !resp.text.is_empty() {
            println!("{}", resp.text);
        }
        ExitCode::SUCCESS
    } else {
        eprintln!(
            "stash: {}",
            resp.error.unwrap_or_else(|| "command failed".into())
        );
        ExitCode::from(1)
    }
}
