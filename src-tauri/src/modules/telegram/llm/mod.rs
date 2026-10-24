//! Provider-agnostic LLM client surface.
//!
//! Each adapter under this module (OpenAI, Anthropic, …) translates
//! these neutral shapes to the provider's own wire format and back.
//! The assistant orchestrator drives clients through the `LlmClient`
//! trait so it never learns a provider-specific detail.

pub mod anthropic;
pub mod claude_code;
pub mod factory;
pub mod google;
pub(crate) mod http;
pub mod openai;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// Single message in a chat conversation. Assistant rows may carry
/// `tool_calls`; tool rows carry a `tool_call_id` matching an earlier
/// assistant call. Everything else leaves the optional fields empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
        }
    }

    /// Marker row splitting the system prompt into a static prefix
    /// (everything before it) and a volatile tail (everything after).
    /// Anthropic turns the split into a prompt-cache breakpoint; every
    /// other adapter simply drops the row. Encoded as a sentinel system
    /// message so `LlmRequest` keeps its shape for existing callers.
    pub fn cache_breakpoint() -> Self {
        Self::system(CACHE_BREAKPOINT)
    }

    pub fn is_cache_breakpoint(&self) -> bool {
        self.role == Role::System && self.content == CACHE_BREAKPOINT
    }
}

/// Sentinel content of `ChatMessage::cache_breakpoint()`. Contains a
/// NUL so it can never collide with a real prompt.
const CACHE_BREAKPOINT: &str = "\u{0}stash:cache-breakpoint";

/// Char-safe truncation: keeps at most `max_chars` characters and
/// appends `suffix` when anything was cut. Never splits a UTF-8
/// sequence, unlike byte slicing (`&s[..n]`), which panics on
/// Cyrillic / emoji.
pub fn truncate_chars(s: &str, max_chars: usize, suffix: &str) -> String {
    match s.char_indices().nth(max_chars) {
        None => s.to_string(),
        Some((byte_idx, _)) => format!("{}{suffix}", &s[..byte_idx]),
    }
}

/// Single tool invocation requested by the assistant. `args_json` is
/// the serialized JSON object the tool expects — the registry parses
/// and validates it at call time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args_json: String,
    /// Opaque provider-specific blob (e.g. Gemini's `thoughtSignature`).
    /// Must be echoed back on the same call when the assistant turn is
    /// re-sent with tool results, otherwise Gemini 2.5 rejects the
    /// request with 400. Other providers ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Schema entry advertised to the model so it knows which tools it
/// may call. `schema` is a JSON Schema document describing `args`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub temperature: f32,
    pub max_tokens: u32,
}

impl Default for LlmRequest {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            tools: Vec::new(),
            temperature: 0.2,
            max_tokens: 8192,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmResponse {
    /// Plain assistant text. Empty when the turn only contains tool
    /// calls — that's not an error, the orchestrator loops.
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Errors surfaced to the orchestrator. Adapters map provider-
/// specific failures to these variants; anything else becomes
/// `BadResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmError {
    Network(String),
    Auth,
    RateLimit,
    BadResponse(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Network(s) => write!(f, "network error: {s}"),
            LlmError::Auth => write!(f, "invalid or missing API key"),
            LlmError::RateLimit => write!(f, "rate limited by provider"),
            LlmError::BadResponse(s) => write!(f, "bad response from provider: {s}"),
        }
    }
}

impl std::error::Error for LlmError {}

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError>;

    /// Whether the client executes `LlmRequest::tools` through the
    /// orchestrator's tool loop. `false` for clients that bring their
    /// own tool surface (Claude Code reaches Stash via MCP), so the
    /// assistant skips function-tool specs and prompt hints for them.
    fn native_tools(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_request_is_sane() {
        let r = LlmRequest::default();
        assert!(r.messages.is_empty());
        assert!(r.tools.is_empty());
        assert!((r.temperature - 0.2).abs() < f32::EPSILON);
        assert_eq!(r.max_tokens, 8192);
    }

    #[test]
    fn chat_message_constructors_fill_only_expected_fields() {
        let sys = ChatMessage::system("s");
        assert_eq!(sys.role, Role::System);
        assert!(sys.tool_calls.is_empty());
        assert!(sys.tool_call_id.is_none());

        let tool = ChatMessage::tool("call_1", "{}");
        assert_eq!(tool.role, Role::Tool);
        assert_eq!(tool.tool_call_id.as_deref(), Some("call_1"));
    }

    #[test]
    fn truncate_chars_is_utf8_safe() {
        // Byte slicing at 3 would land mid-codepoint for Cyrillic.
        assert_eq!(truncate_chars("привіт", 3, "…"), "при…");
        assert_eq!(truncate_chars("🙂🙂🙂", 2, "…"), "🙂🙂…");
        assert_eq!(truncate_chars("short", 10, "…"), "short");
        assert_eq!(truncate_chars("exact", 5, "…"), "exact");
        assert_eq!(truncate_chars("", 0, "…"), "");
    }

    #[test]
    fn cache_breakpoint_is_recognised_only_as_system() {
        assert!(ChatMessage::cache_breakpoint().is_cache_breakpoint());
        assert!(!ChatMessage::system("plain").is_cache_breakpoint());
        let mut u = ChatMessage::cache_breakpoint();
        u.role = Role::User;
        assert!(!u.is_cache_breakpoint());
    }

    #[test]
    fn role_serializes_lowercase() {
        let s = serde_json::to_string(&Role::Assistant).unwrap();
        assert_eq!(s, "\"assistant\"");
    }

    #[test]
    fn llm_error_display_is_human_readable() {
        assert_eq!(format!("{}", LlmError::Auth), "invalid or missing API key");
        assert_eq!(
            format!("{}", LlmError::RateLimit),
            "rate limited by provider"
        );
    }
}
