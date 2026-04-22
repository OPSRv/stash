//! `stash` — command-line transport for the running Stash app.
//!
//! Connects to the app's Unix-domain socket, sends one JSON-line
//! request, prints the textual response to stdout, and exits.
//!
//! Exit codes:
//! - `0` command succeeded
//! - `1` command failed (app was reachable but reported an error)
//! - `2` Stash is not running (socket missing / connect refused)
//! - `3` transport or protocol error (encode/write/read/decode)

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
    args: Vec<String>,
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
        "usage: stash [--json] <command> [args...]\n\
         \n\
         examples:\n  \
         stash help\n  \
         stash status\n  \
         stash battery\n  \
         stash note \"buy milk\"\n  \
         stash clip\n\
         \n\
         flags:\n  \
         --json        print the raw JSON response instead of text\n  \
         --version,-V  print stash CLI version and exit\n  \
         --help,-h     print this help and exit\n"
    );
}

fn print_version() {
    println!("stash {}", env!("CARGO_PKG_VERSION"));
}

/// Split argv into pre-command flags (`--json`, `--help`, `--version`)
/// and everything the server should see. Global flags are only honoured
/// *before* the command name so arguments like
/// `stash note "think about --json design"` keep `--json` intact.
struct Parsed {
    json_out: bool,
    show_help: bool,
    show_version: bool,
    rest: Vec<String>,
}

fn parse_argv(mut argv: Vec<String>) -> Parsed {
    let mut json_out = false;
    let mut show_help = false;
    let mut show_version = false;
    let mut rest: Vec<String> = Vec::with_capacity(argv.len());
    while !argv.is_empty() {
        let tok = argv.remove(0);
        match tok.as_str() {
            "--json" => json_out = true,
            "--help" | "-h" => show_help = true,
            "--version" | "-V" => show_version = true,
            // `--` ends flag parsing explicitly, like most CLIs.
            "--" => {
                rest.extend(argv.drain(..));
                break;
            }
            // First non-flag token is the command — everything after it,
            // including strings that happen to start with `--`, belongs
            // to the command's own argv.
            _ => {
                rest.push(tok);
                rest.extend(argv.drain(..));
                break;
            }
        }
    }
    Parsed { json_out, show_help, show_version, rest }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Parsed {
        json_out,
        show_help,
        show_version,
        mut rest,
    } = parse_argv(argv);

    if show_version {
        print_version();
        return ExitCode::SUCCESS;
    }
    if show_help {
        print_usage();
        return ExitCode::SUCCESS;
    }
    if rest.is_empty() {
        print_usage();
        // Exit 3 (usage error) instead of 1 so scripts can distinguish
        // "Stash said no" from "you invoked me wrong".
        return ExitCode::from(3);
    }

    let cmd = rest.remove(0);
    let args_text = rest.join(" ");
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok());

    let req = Request {
        cmd,
        args_text,
        args: rest,
        cwd,
    };

    let path = match socket_path() {
        Some(p) => p,
        None => {
            eprintln!("stash: cannot resolve data directory");
            return ExitCode::from(3);
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
            return ExitCode::from(3);
        }
    };
    body.push('\n');

    if let Err(e) = write_half.write_all(body.as_bytes()).await {
        eprintln!("stash: write: {e}");
        return ExitCode::from(3);
    }
    // Closing our write half lets the server finish reading cleanly
    // even if its read_line is still buffered.
    let _ = write_half.shutdown().await;

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    match tokio::time::timeout(Duration::from_secs(60), reader.read_line(&mut line)).await {
        Ok(Ok(0)) => {
            eprintln!("stash: server closed connection without reply");
            return ExitCode::from(3);
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            eprintln!("stash: read: {e}");
            return ExitCode::from(3);
        }
        Err(_) => {
            eprintln!("stash: server timed out");
            return ExitCode::from(3);
        }
    }

    let resp: Response = match serde_json::from_str(line.trim_end()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("stash: invalid response: {e}");
            return ExitCode::from(3);
        }
    };

    // `--json` forwards the raw wire response for scripting, but the
    // exit code still reflects `ok` so callers can branch on it without
    // parsing the payload themselves.
    if json_out {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        return if resp.ok {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        };
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_argv_extracts_json_flag_before_command() {
        let p = parse_argv(vec!["--json".into(), "status".into()]);
        assert!(p.json_out);
        assert_eq!(p.rest, vec!["status"]);
    }

    #[test]
    fn parse_argv_does_not_strip_flags_from_command_args() {
        // `--json` inside the command payload must survive — otherwise
        // `stash note "think about --json"` silently corrupts the note.
        let p = parse_argv(vec![
            "note".into(),
            "think about --json design".into(),
        ]);
        assert!(!p.json_out);
        assert_eq!(p.rest, vec!["note", "think about --json design"]);
    }

    #[test]
    fn parse_argv_handles_help_and_version_anywhere_before_command() {
        let p = parse_argv(vec!["-h".into()]);
        assert!(p.show_help);

        let p = parse_argv(vec!["--version".into()]);
        assert!(p.show_version);

        let p = parse_argv(vec!["--json".into(), "-V".into()]);
        assert!(p.json_out);
        assert!(p.show_version);
    }

    #[test]
    fn parse_argv_double_dash_terminates_flag_parsing() {
        let p = parse_argv(vec![
            "--".into(),
            "--version".into(),
            "arg".into(),
        ]);
        assert!(!p.show_version);
        assert_eq!(p.rest, vec!["--version", "arg"]);
    }
}
