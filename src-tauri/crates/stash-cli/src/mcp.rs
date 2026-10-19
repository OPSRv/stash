//! `stash mcp` — Model Context Protocol server over stdio.
//!
//! Lets MCP clients (Claude Desktop, Claude Code, …) drive the running
//! Stash app. Every slash command registered in the app is exposed as
//! one MCP tool taking a single free-form `args` string — the same text
//! you'd type after `/cmd` in Telegram or `stash cmd` in a shell. The
//! list is fetched live from the app on each `tools/list`, so new
//! commands show up without touching this file.
//!
//! Only the tools subset of MCP is implemented: newline-delimited
//! JSON-RPC 2.0 on stdin/stdout, `initialize`, `ping`, `tools/list`,
//! `tools/call`. stdout carries protocol frames only; diagnostics go to
//! stderr, which MCP hosts collect into their logs.

use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::{send_request, socket_path, Request, TransportError, BUNDLE_ID};

/// Reserved IPC request that returns the command registry as JSON.
/// Must match `LIST_COMMANDS` in the app's `ipc/server.rs`.
const LIST_COMMANDS: &str = "__commands";

/// Newest first. We echo the client's version when we know it,
/// otherwise answer with the newest and let the client decide.
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Controls the Stash macOS menubar app on the user's Mac. \
Each tool is a Stash command; put everything that would follow the command name into `args` \
(see the tool's usage line). Use `send` to push a message to the user's phone via Telegram.";

const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const PARSE_ERROR: i64 = -32700;

pub async fn run() -> ExitCode {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            // EOF: the host closed our stdin, which is the MCP shutdown signal.
            Ok(None) => return ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("stash mcp: stdin: {e}");
                return ExitCode::from(3);
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Some(reply) = handle_line(&line).await else {
            continue;
        };
        let mut out = reply.to_string();
        out.push('\n');
        if stdout.write_all(out.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
            return ExitCode::from(3);
        }
    }
}

/// Parse one frame and produce the reply frame, or `None` for
/// notifications (which never get a response).
async fn handle_line(line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(error_frame(Value::Null, PARSE_ERROR, &format!("parse error: {e}"))),
    };
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => result_frame(id, initialize_result(&params)),
        "ping" => result_frame(id, json!({})),
        "tools/list" => match list_tools().await {
            Ok(tools) => result_frame(id, json!({ "tools": tools })),
            // Surface "app not running" as an empty list rather than a
            // protocol error — hosts tend to drop a server whose
            // tools/list fails, and the app may be started later.
            Err(e) => {
                eprintln!("stash mcp: tools/list: {e}");
                result_frame(id, json!({ "tools": [] }))
            }
        },
        "tools/call" => match call_tool(&params).await {
            Ok(result) => result_frame(id, result),
            Err(e) => error_frame(id, INVALID_PARAMS, &e),
        },
        other => error_frame(id, METHOD_NOT_FOUND, &format!("method not found: {other}")),
    })
}

fn initialize_result(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
    let version = SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == requested)
        .unwrap_or(&SUPPORTED_PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "stash", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

async fn list_tools() -> Result<Vec<Value>, String> {
    let text = call_app(LIST_COMMANDS, "").await?;
    let commands: Vec<Value> =
        serde_json::from_str(&text).map_err(|e| format!("bad command list from app: {e}"))?;
    Ok(commands.iter().filter_map(command_to_tool).collect())
}

/// Map one `{name, description, usage}` registry entry onto an MCP tool.
fn command_to_tool(cmd: &Value) -> Option<Value> {
    let name = cmd.get("name")?.as_str()?;
    let description = cmd.get("description").and_then(Value::as_str).unwrap_or_default();
    let usage = cmd.get("usage").and_then(Value::as_str).unwrap_or_default();
    Some(json!({
        "name": name,
        "description": format!("{description}\nUsage: {usage}"),
        "inputSchema": {
            "type": "object",
            "properties": {
                "args": {
                    "type": "string",
                    "description": "Everything after the command name, as in the usage line. Omit for no arguments."
                }
            },
            "additionalProperties": false
        }
    }))
}

/// Run a command. App-level failures are reported as a tool result with
/// `isError: true` (so the model sees the message); only malformed
/// requests become JSON-RPC errors.
async fn call_tool(params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .ok_or("missing tool name")?;
    if name.starts_with("__") {
        return Err(format!("unknown tool: {name}"));
    }
    let args = params
        .get("arguments")
        .and_then(|a| a.get("args"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (text, is_error) = match call_app(name, args).await {
        Ok(t) if t.is_empty() => ("done".to_string(), false),
        Ok(t) => (t, false),
        Err(e) => (e, true),
    };
    Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
}

/// One IPC round trip, launching Stash in the background if it isn't
/// running yet.
async fn call_app(cmd: &str, args_text: &str) -> Result<String, String> {
    let path = socket_path().ok_or("cannot resolve Stash data directory")?;
    let req = Request {
        cmd: cmd.to_string(),
        args_text: args_text.to_string(),
        args: if args_text.is_empty() { vec![] } else { vec![args_text.to_string()] },
        cwd: None,
    };
    let resp = match send_request(&path, &req).await {
        Err(TransportError::NotRunning) => {
            launch_app().await?;
            send_request(&path, &req).await
        }
        other => other,
    }
    .map_err(|e| e.to_string())?
    .0;
    if resp.ok {
        Ok(resp.text)
    } else {
        Err(resp.error.unwrap_or_else(|| "command failed".into()))
    }
}

/// `open -g -b <bundle id>` (background, no focus steal), then wait for
/// the IPC socket to come up.
async fn launch_app() -> Result<(), String> {
    let status = tokio::process::Command::new("/usr/bin/open")
        .args(["-g", "-b", BUNDLE_ID])
        .status()
        .await
        .map_err(|e| format!("cannot launch Stash: {e}"))?;
    if !status.success() {
        return Err("Stash app is not running and could not be launched".into());
    }
    let path = socket_path().ok_or("cannot resolve Stash data directory")?;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if tokio::net::UnixStream::connect(&path).await.is_ok() {
            return Ok(());
        }
    }
    Err("Stash was launched but its IPC socket did not come up within 10s".into())
}

fn result_frame(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_frame(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn notifications_get_no_reply() {
        let r = handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        assert!(r.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn initialize_echoes_known_version_and_falls_back_to_newest() {
        let r = handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#)
            .await
            .unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "stash");
        assert!(r["result"]["capabilities"]["tools"].is_object());

        let r = handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#)
            .await
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], SUPPORTED_PROTOCOL_VERSIONS[0]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ping_unknown_method_and_garbage() {
        let r = handle_line(r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#).await.unwrap();
        assert_eq!(r["result"], json!({}));

        let r = handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"resources/list"}"#).await.unwrap();
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);

        let r = handle_line("not json").await.unwrap();
        assert_eq!(r["error"]["code"], PARSE_ERROR);
        assert_eq!(r["id"], Value::Null);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tools_call_rejects_missing_and_reserved_names() {
        let r = handle_line(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}}"#).await.unwrap();
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = handle_line(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"__commands"}}"#)
            .await
            .unwrap();
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn command_maps_to_tool_with_args_schema() {
        let t = command_to_tool(&json!({"name":"send","description":"Send it","usage":"/send <text>"})).unwrap();
        assert_eq!(t["name"], "send");
        assert_eq!(t["description"], "Send it\nUsage: /send <text>");
        assert_eq!(t["inputSchema"]["properties"]["args"]["type"], "string");
        assert!(command_to_tool(&json!({"description":"no name"})).is_none());
    }
}
