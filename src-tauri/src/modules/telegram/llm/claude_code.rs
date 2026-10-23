//! Claude Code adapter — drives the locally installed Claude Code CLI
//! in headless mode (`claude -p`) so the assistant can run on the
//! user's Claude Pro/Max subscription instead of an API key.
//!
//! Unlike the HTTP adapters this one never returns `tool_calls`: the
//! CLI runs its own agent loop, and Stash's commands reach it through
//! the `stash mcp` stdio server attached via `--mcp-config`. Each
//! `chat` call therefore yields the final text in one shot, which ends
//! the orchestrator's loop immediately.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;

use super::{ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role};

/// Hard cap on one `claude -p` run (agent loop + MCP tool calls).
const RUN_TIMEOUT: Duration = Duration::from_secs(180);
/// Cap on the login-shell `command -v claude` probe.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// MCP tools that call back into the assistant. Exposing them to the
/// CLI would let Claude re-enter `handle_user_text`, which would spawn
/// another `claude -p`, and so on — infinite recursion.
const RECURSIVE_TOOLS: &[&str] = &[
    "mcp__stash__ai",
    "mcp__stash__summarize",
    "mcp__stash__voice",
];

/// Appended to the system prompt when the Stash MCP server is attached.
const MCP_TOOLS_NOTE: &str = "Stash commands are available as MCP tools named \
`mcp__stash__<command>`, each taking a single `args` string (everything after the command \
name, as in the usage line).";

/// Login failures get their own text — `LlmError::Auth` reads "invalid
/// or missing API key", which is misleading for a subscription CLI.
const NOT_LOGGED_IN_MSG: &str =
    "Claude Code is not logged in — run `claude` in a terminal and sign in.";

const NOT_FOUND_MSG: &str =
    "Claude Code CLI not found — install it and run `claude` once to log in.";

/// Successful resolution is cached for the app's lifetime; failures are
/// not, so installing the CLI later works without restarting Stash.
static CLAUDE_BIN: Mutex<Option<PathBuf>> = Mutex::new(None);

pub struct ClaudeCodeClient {
    /// Bundled `stash` CLI used as the MCP server. `None` → plain
    /// completion with no Stash tools.
    stash_bin: Option<PathBuf>,
    /// Model alias or id passed to `--model`. `None` → CLI default.
    model: Option<String>,
}

impl ClaudeCodeClient {
    pub fn new(stash_bin: Option<PathBuf>, model: &str) -> Self {
        let model = Some(model.trim().to_string()).filter(|m| !m.is_empty());
        Self { stash_bin, model }
    }
}

/// Prompt material derived from the neutral message list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderedPrompt {
    /// All system messages joined — goes to `--append-system-prompt`.
    pub system: String,
    /// Conversation transcript + latest user message — goes to stdin.
    pub prompt: String,
}

/// Flatten the chat into a single prompt. System rows are pulled out;
/// earlier turns become a compact `User:` / `Assistant:` transcript
/// (tool rows and empty assistant rows are dropped); the latest user
/// message is placed last. With no prior turns the prompt is just the
/// user's text.
pub(crate) fn render_prompt(messages: &[ChatMessage]) -> RenderedPrompt {
    let system = messages
        .iter()
        .filter(|m| m.role == Role::System && !m.content.trim().is_empty())
        .map(|m| m.content.trim())
        .collect::<Vec<_>>()
        .join("\n\n");

    let last_user = messages.iter().rposition(|m| m.role == Role::User);
    let current = last_user
        .map(|i| messages[i].content.trim().to_string())
        .unwrap_or_default();
    let earlier = &messages[..last_user.unwrap_or(0)];

    let transcript: Vec<String> = earlier
        .iter()
        .filter_map(|m| {
            let text = m.content.trim();
            if text.is_empty() {
                return None;
            }
            match m.role {
                Role::User => Some(format!("User: {text}")),
                Role::Assistant => Some(format!("Assistant: {text}")),
                Role::System | Role::Tool => None,
            }
        })
        .collect();

    let prompt = if transcript.is_empty() {
        current
    } else {
        format!(
            "Conversation so far:\n{}\n\nCurrent message:\n{current}",
            transcript.join("\n")
        )
    };
    RenderedPrompt { system, prompt }
}

/// `--mcp-config` payload attaching the Stash MCP server.
pub(crate) fn mcp_config_json(stash_bin: &Path) -> String {
    serde_json::json!({
        "mcpServers": {
            "stash": { "command": stash_bin.to_string_lossy(), "args": ["mcp"] }
        }
    })
    .to_string()
}

/// CLI arguments (prompt itself goes over stdin). Variadic flags
/// (`--allowedTools`, `--disallowedTools`, `--tools`, `--mcp-config`)
/// are always followed by another flag so they never swallow a value.
pub(crate) fn build_args(
    system: &str,
    model: Option<&str>,
    stash_bin: Option<&Path>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        // Don't clutter the user's `claude --resume` history.
        "--no-session-persistence".into(),
        // Skip user/project settings: their hooks, permissions and
        // plugins belong to the user's coding sessions, not to Stash.
        "--setting-sources".into(),
        "".into(),
        // No built-in tools (Bash, Edit, Read, …): prompts can come
        // from Telegram, so the CLI must only reach Stash via MCP.
        "--tools".into(),
        "".into(),
    ];
    let mut system = system.to_string();
    if let Some(bin) = stash_bin {
        args.push("--mcp-config".into());
        args.push(mcp_config_json(bin));
        args.push("--strict-mcp-config".into());
        args.push("--allowedTools".into());
        args.push("mcp__stash".into());
        args.push("--disallowedTools".into());
        args.extend(RECURSIVE_TOOLS.iter().map(|s| s.to_string()));
        if system.is_empty() {
            system = MCP_TOOLS_NOTE.to_string();
        } else {
            system = format!("{system}\n\n{MCP_TOOLS_NOTE}");
        }
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if !system.is_empty() {
        args.push("--append-system-prompt".into());
        args.push(system);
    }
    args
}

/// Interpret `claude -p --output-format json` output. The CLI prints a
/// single `{"type":"result", …}` object on stdout even for API errors
/// (with a non-zero exit), so stdout is parsed before the exit status
/// is consulted.
pub(crate) fn parse_output(stdout: &str, stderr: &str, success: bool) -> Result<String, LlmError> {
    let value = find_result_json(stdout);
    let Some(v) = value else {
        let tail = tail(
            if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            },
            400,
        );
        return Err(if success {
            LlmError::BadResponse(format!("claude returned no JSON result: {tail}"))
        } else {
            LlmError::BadResponse(format!("claude exited with an error: {tail}"))
        });
    };

    let result = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
    let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
    if is_error {
        let status = v.get("api_error_status").and_then(|s| s.as_u64());
        let msg = if result.is_empty() {
            v.get("subtype")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown error")
                .to_string()
        } else {
            result.to_string()
        };
        return Err(classify_error(status, &msg));
    }
    Ok(result.to_string())
}

fn find_result_json(stdout: &str) -> Option<serde_json::Value> {
    let is_result =
        |v: &serde_json::Value| v.get("result").is_some() || v.get("is_error").is_some();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if is_result(&v) {
            return Some(v);
        }
    }
    // Fallback: a stray log line before the JSON — take the last
    // parseable result object.
    stdout
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .find(is_result)
}

fn classify_error(status: Option<u64>, msg: &str) -> LlmError {
    let lower = msg.to_lowercase();
    let auth = matches!(status, Some(401) | Some(403))
        || [
            "not logged in",
            "/login",
            "please run",
            "invalid api key",
            "authentication",
            "oauth token",
        ]
        .iter()
        .any(|n| lower.contains(n));
    if auth {
        return LlmError::BadResponse(NOT_LOGGED_IN_MSG.into());
    }
    let rate = status == Some(429)
        || ["rate limit", "usage limit", "limit reached", "overloaded"]
            .iter()
            .any(|n| lower.contains(n));
    if rate {
        return LlmError::RateLimit;
    }
    LlmError::BadResponse(msg.to_string())
}

fn tail(s: &str, max_chars: usize) -> String {
    let s = s.trim();
    let n = s.chars().count();
    if n <= max_chars {
        s.to_string()
    } else {
        s.chars().skip(n - max_chars).collect()
    }
}

/// PATH for the child: GUI apps on macOS start with a minimal PATH, but
/// `claude` may need `node` or its own helpers from the usual install
/// locations.
pub(crate) fn augmented_path(
    current: Option<&str>,
    home: Option<&Path>,
    claude_dir: Option<&Path>,
) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = claude_dir {
        dirs.push(d.to_path_buf());
    }
    if let Some(cur) = current {
        dirs.extend(std::env::split_paths(cur));
    }
    if let Some(h) = home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".claude/local"));
    }
    for d in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        dirs.push(PathBuf::from(d));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    std::env::join_paths(dirs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Locate the `claude` binary: PATH → well-known install locations →
/// the user's login shell.
async fn resolve_claude_bin() -> Option<PathBuf> {
    if let Some(p) = CLAUDE_BIN.lock().ok().and_then(|g| g.clone()) {
        if is_executable(&p) {
            return Some(p);
        }
    }
    let found = probe_claude_bin().await;
    if let (Some(p), Ok(mut g)) = (found.as_ref(), CLAUDE_BIN.lock()) {
        *g = Some(p.clone());
    }
    found
}

async fn probe_claude_bin() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        if let Some(p) = std::env::split_paths(&path)
            .map(|d| d.join("claude"))
            .find(|p| is_executable(p))
        {
            return Some(p);
        }
    }
    let home = dirs_next::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        candidates.push(h.join(".local/bin/claude"));
        candidates.push(h.join(".claude/local/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    if let Some(p) = candidates.into_iter().find(|p| is_executable(p)) {
        return Some(p);
    }

    let probe = tokio::process::Command::new("/bin/zsh")
        .args(["-lc", "command -v claude"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(SHELL_PROBE_TIMEOUT, probe)
        .await
        .ok()?
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout)
        .trim()
        .lines()
        .last()?
        .trim()
        .to_string();
    let p = PathBuf::from(line);
    (p.is_absolute() && is_executable(&p)).then_some(p)
}

#[async_trait]
impl LlmClient for ClaudeCodeClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        // `req.tools` is deliberately ignored — Stash tools reach the
        // CLI through the MCP server instead.
        let claude_bin = resolve_claude_bin()
            .await
            .ok_or_else(|| LlmError::BadResponse(NOT_FOUND_MSG.into()))?;

        let rendered = render_prompt(&req.messages);
        let args = build_args(
            &rendered.system,
            self.model.as_deref(),
            self.stash_bin.as_deref(),
        );
        let home = dirs_next::home_dir();
        let path_env = augmented_path(
            std::env::var("PATH").ok().as_deref(),
            home.as_deref(),
            claude_bin.parent(),
        );

        let mut cmd = tokio::process::Command::new(&claude_bin);
        cmd.args(&args)
            // Neutral cwd so the CLI doesn't pick up a project CLAUDE.md.
            .current_dir(std::env::temp_dir())
            .env("PATH", path_env)
            // Set when Stash itself was launched from a Claude Code
            // terminal (dev loop); the CLI refuses to nest under it.
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| LlmError::Network(format!("failed to start claude: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(rendered.prompt.as_bytes())
                .await
                .map_err(|e| LlmError::Network(format!("claude stdin: {e}")))?;
            // Dropping closes the pipe → EOF → the CLI starts the turn.
        }

        let output = match tokio::time::timeout(RUN_TIMEOUT, child.wait_with_output()).await {
            Ok(res) => res.map_err(|e| LlmError::Network(format!("claude: {e}")))?,
            // The future owning the child is dropped → kill_on_drop.
            Err(_) => return Err(LlmError::Network("claude timed out".into())),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let text = parse_output(&stdout, &stderr, output.status.success())?;
        Ok(LlmResponse {
            text,
            tool_calls: Vec::new(),
        })
    }

    fn native_tools(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_single_user_message_is_plain_text() {
        let r = render_prompt(&[ChatMessage::system("sys"), ChatMessage::user("hello")]);
        assert_eq!(r.system, "sys");
        assert_eq!(r.prompt, "hello");
    }

    #[test]
    fn render_joins_system_and_builds_transcript() {
        let mut with_calls = ChatMessage::assistant("");
        with_calls.tool_calls.push(super::super::ToolCall {
            id: "c1".into(),
            name: "x".into(),
            args_json: "{}".into(),
            signature: None,
        });
        let msgs = vec![
            ChatMessage::system("one"),
            ChatMessage::system("  "),
            ChatMessage::system("two"),
            ChatMessage::user("hi"),
            ChatMessage::assistant("hello there"),
            with_calls,
            ChatMessage::tool("c1", "{\"ok\":true}"),
            ChatMessage::user("what now?"),
        ];
        let r = render_prompt(&msgs);
        assert_eq!(r.system, "one\n\ntwo");
        assert_eq!(
            r.prompt,
            "Conversation so far:\nUser: hi\nAssistant: hello there\n\nCurrent message:\nwhat now?"
        );
    }

    #[test]
    fn render_without_user_message_yields_empty_prompt() {
        let r = render_prompt(&[ChatMessage::system("s")]);
        assert_eq!(r.prompt, "");
    }

    #[test]
    fn args_with_mcp_block_recursive_tools() {
        let args = build_args("sys", Some("sonnet"), Some(Path::new("/x/stash")));
        let joined = args.join(" ");
        assert!(joined.contains("--strict-mcp-config"));
        let dis = args.iter().position(|a| a == "--disallowedTools").unwrap();
        assert_eq!(
            &args[dis + 1..dis + 4],
            RECURSIVE_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .as_slice()
        );
        let m = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[m + 1], "sonnet");
        let sp = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert!(args[sp + 1].starts_with("sys\n\n"));
        assert!(args[sp + 1].contains("mcp__stash__"));
        let cfg = args.iter().position(|a| a == "--mcp-config").unwrap();
        let v: serde_json::Value = serde_json::from_str(&args[cfg + 1]).unwrap();
        assert_eq!(v["mcpServers"]["stash"]["command"], "/x/stash");
        assert_eq!(v["mcpServers"]["stash"]["args"][0], "mcp");
    }

    #[test]
    fn args_without_mcp_or_model() {
        let args = build_args("", None, None);
        assert!(!args
            .iter()
            .any(|a| a == "--mcp-config" || a == "--model" || a == "--append-system-prompt"));
        assert_eq!(&args[..3], &["-p", "--output-format", "json"]);
    }

    #[test]
    fn parse_success() {
        let out = r#"{"type":"result","subtype":"success","is_error":false,"result":"PONG","num_turns":1}"#;
        assert_eq!(parse_output(out, "", true).unwrap(), "PONG");
    }

    #[test]
    fn parse_tolerates_leading_log_line() {
        let out =
            "warning: something\n{\"type\":\"result\",\"is_error\":false,\"result\":\"ok\"}\n";
        assert_eq!(parse_output(out, "", true).unwrap(), "ok");
    }

    #[test]
    fn parse_api_error_with_nonzero_exit() {
        let out = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"There's an issue with the selected model (x)."}"#;
        match parse_output(out, "[claude-code:unrecognized_model]", false) {
            Err(LlmError::BadResponse(m)) => assert!(m.contains("selected model")),
            other => panic!("expected BadResponse, got {other:?}"),
        }
    }

    #[test]
    fn parse_maps_auth_and_rate_limit() {
        let auth =
            r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(
            parse_output(auth, "", false),
            Err(LlmError::BadResponse(NOT_LOGGED_IN_MSG.into()))
        );
        let auth401 = r#"{"type":"result","is_error":true,"api_error_status":401,"result":"x"}"#;
        assert_eq!(
            parse_output(auth401, "", false),
            Err(LlmError::BadResponse(NOT_LOGGED_IN_MSG.into()))
        );
        let rate = r#"{"type":"result","is_error":true,"result":"Claude usage limit reached. Resets at 5pm"}"#;
        assert_eq!(parse_output(rate, "", false), Err(LlmError::RateLimit));
        let rate429 = r#"{"type":"result","is_error":true,"api_error_status":429,"result":"x"}"#;
        assert_eq!(parse_output(rate429, "", false), Err(LlmError::RateLimit));
    }

    #[test]
    fn parse_error_without_result_uses_subtype() {
        let out = r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#;
        assert_eq!(
            parse_output(out, "", false),
            Err(LlmError::BadResponse("error_max_turns".into()))
        );
    }

    #[test]
    fn parse_no_json_reports_stderr_tail() {
        match parse_output("", "boom: cannot start", false) {
            Err(LlmError::BadResponse(m)) => assert!(m.contains("boom: cannot start")),
            other => panic!("expected BadResponse, got {other:?}"),
        }
        match parse_output("plain text", "", true) {
            Err(LlmError::BadResponse(m)) => assert!(m.contains("no JSON")),
            other => panic!("expected BadResponse, got {other:?}"),
        }
    }

    #[test]
    fn augmented_path_prepends_claude_dir_and_dedupes() {
        let p = augmented_path(
            Some("/usr/bin:/custom"),
            Some(Path::new("/Users/u")),
            Some(Path::new("/Users/u/.local/bin")),
        );
        let parts: Vec<&str> = p.split(':').collect();
        assert_eq!(parts[0], "/Users/u/.local/bin");
        assert!(parts.contains(&"/custom"));
        assert!(parts.contains(&"/opt/homebrew/bin"));
        assert_eq!(parts.iter().filter(|s| **s == "/usr/bin").count(), 1);
        assert_eq!(
            parts
                .iter()
                .filter(|s| **s == "/Users/u/.local/bin")
                .count(),
            1
        );
    }
}
