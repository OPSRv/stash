//! Provider-agnostic LLM client surface.
//!
//! Each adapter under this module (OpenAI, Anthropic, …) translates
//! these neutral shapes to the provider's own wire format and back.
//! The assistant orchestrator drives clients through the `LlmClient`
//! trait so it never learns a provider-specific detail.

pub mod anthropic;
pub mod factory;
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
}

/// Single tool invocation requested by the assistant. `args_json` is
/// the serialized JSON object the tool expects — the registry parses
/// and validates it at call time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args_json: String,
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
            max_tokens: 1024,
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
    ToolSchemaRejected(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Network(s) => write!(f, "network error: {s}"),
            LlmError::Auth => write!(f, "invalid or missing API key"),
            LlmError::RateLimit => write!(f, "rate limited by provider"),
            LlmError::BadResponse(s) => write!(f, "bad response from provider: {s}"),
            LlmError::ToolSchemaRejected(s) => {
                write!(f, "provider rejected tool schema: {s}")
            }
        }
    }
}

impl std::error::Error for LlmError {}

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError>;
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
        assert_eq!(r.max_tokens, 1024);
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
    fn role_serializes_lowercase() {
        let s = serde_json::to_string(&Role::Assistant).unwrap();
        assert_eq!(s, "\"assistant\"");
    }

    #[test]
    fn llm_error_display_is_human_readable() {
        assert_eq!(format!("{}", LlmError::Auth), "invalid or missing API key");
        assert_eq!(format!("{}", LlmError::RateLimit), "rate limited by provider");
    }
}
