//! IPC wire format.
//!
//! Duplicated verbatim in the `stash-cli` crate — the schema is tiny
//! and decoupling avoids dragging the whole app crate into the CLI's
//! compile graph.

use serde::{Deserialize, Serialize};

/// Request envelope sent by the CLI. `args_text` is the raw argument
/// string after the command name, matching the Telegram dispatcher's
/// convention (handlers do their own parsing). `args` preserves the
/// original positional boundaries for handlers that need them — the
/// plain `.join(" ")` in `args_text` is lossy when multiple arguments
/// contain internal whitespace (`"a b" "c d"` collapses to `"a b c d"`).
/// `cwd` is the client's working directory, forwarded for commands that
/// care (e.g. future `claude` launcher).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub cmd: String,
    #[serde(default)]
    pub args_text: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Response envelope returned to the CLI. `ok=false` sets a non-zero
/// exit code on the client side; `text` is human-readable output for
/// stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            ok: true,
            text: text.into(),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: String::new(),
            error: Some(msg.into()),
        }
    }
}
