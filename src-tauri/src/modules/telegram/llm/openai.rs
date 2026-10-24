//! OpenAI Chat Completions adapter.
//!
//! Covers both the `openai` provider (base URL
//! `https://api.openai.com/v1`) and the `custom` provider (any
//! base URL exposing an OpenAI-compatible `/chat/completions`
//! endpoint — Ollama, LM Studio, Groq, DeepSeek, OpenRouter, …).
//!
//! The wire translation is split into pure `to_wire` / `from_wire`
//! helpers so tests cover every shape without a real HTTP round-
//! trip. The `chat` entry point is a thin I/O wrapper around them.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{
    http, ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role, ToolCall, ToolSpec,
};

pub struct OpenAiClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl OpenAiClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            http: http::build_client(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }
}

#[async_trait]
impl LlmClient for OpenAiClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        let body = to_wire(&self.model, &req).to_string();
        let url = format!("{}/chat/completions", self.base_url);
        let value = http::post_json_with_retry(
            || {
                self.http
                    .post(&url)
                    .bearer_auth(&self.api_key)
                    .header("Content-Type", "application/json")
                    .body(body.clone())
            },
            |_, _| None,
        )
        .await?;
        from_wire(&value)
    }
}

/// Reasoning model families (o-series, GPT-5) reject `max_tokens` and
/// any non-default `temperature`; they take `max_completion_tokens`
/// instead. Router prefixes like `openai/o3-mini` are tolerated.
fn is_reasoning_model(model: &str) -> bool {
    let id = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    ["o1", "o3", "o4", "gpt-5"]
        .iter()
        .any(|p| id.starts_with(p))
}

/// Build the JSON payload sent to `/chat/completions`. Separated out
/// so tests assert on a `serde_json::Value` without touching HTTP.
pub fn to_wire(model: &str, req: &LlmRequest) -> Value {
    let messages: Vec<Value> = req
        .messages
        .iter()
        .filter(|m| !m.is_cache_breakpoint())
        .map(message_to_wire)
        .collect();
    let mut body = json!({
        "model": model,
        "messages": messages,
    });
    if is_reasoning_model(model) {
        body["max_completion_tokens"] = json!(req.max_tokens);
    } else {
        body["temperature"] = json!(req.temperature);
        body["max_tokens"] = json!(req.max_tokens);
    }
    if !req.tools.is_empty() {
        body["tools"] = tools_to_wire(&req.tools);
    }
    body
}

fn message_to_wire(msg: &ChatMessage) -> Value {
    let role = match msg.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut out = json!({
        "role": role,
        "content": msg.content,
    });
    if !msg.tool_calls.is_empty() {
        // OpenAI expects an array of `{id, type:"function", function:
        // {name, arguments}}` entries on assistant turns that request
        // tools.
        let calls: Vec<Value> = msg
            .tool_calls
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": c.args_json },
                })
            })
            .collect();
        out["tool_calls"] = Value::Array(calls);
    }
    if let Some(id) = &msg.tool_call_id {
        out["tool_call_id"] = Value::String(id.clone());
    }
    out
}

fn tools_to_wire(tools: &[ToolSpec]) -> Value {
    let arr: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.schema,
                },
            })
        })
        .collect();
    Value::Array(arr)
}

/// Parse a `/chat/completions` response body into the neutral
/// `LlmResponse`. Surfaces structural problems as
/// `LlmError::BadResponse`.
pub fn from_wire(value: &Value) -> Result<LlmResponse, LlmError> {
    let message = value
        .pointer("/choices/0/message")
        .ok_or_else(|| LlmError::BadResponse("missing choices[0].message".into()))?;

    let text = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let mut tool_calls: Vec<ToolCall> = Vec::new();
    if let Some(arr) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for call in arr {
            let id = call
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| LlmError::BadResponse("tool_call missing id".into()))?
                .to_string();
            let function = call
                .get("function")
                .ok_or_else(|| LlmError::BadResponse("tool_call missing function".into()))?;
            let name = function
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| LlmError::BadResponse("tool_call missing name".into()))?
                .to_string();
            let args_json = function
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}")
                .to_string();
            tool_calls.push(ToolCall {
                id,
                name,
                args_json,
                signature: None,
            });
        }
    }

    Ok(LlmResponse { text, tool_calls })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::llm::ChatMessage;

    #[test]
    fn to_wire_encodes_messages_and_tools() {
        let req = LlmRequest {
            messages: vec![ChatMessage::system("be helpful"), ChatMessage::user("hi")],
            tools: vec![ToolSpec {
                name: "get_battery".into(),
                description: "Return battery percent + charging state.".into(),
                schema: json!({ "type": "object", "properties": {} }),
            }],
            ..Default::default()
        };
        let wire = to_wire("gpt-4o-mini", &req);
        assert_eq!(wire["model"], "gpt-4o-mini");
        assert_eq!(wire["messages"][0]["role"], "system");
        assert_eq!(wire["messages"][1]["content"], "hi");
        assert_eq!(wire["tools"][0]["type"], "function");
        assert_eq!(wire["tools"][0]["function"]["name"], "get_battery");
        // `tools` omitted when empty.
        let empty = to_wire("m", &LlmRequest::default());
        assert!(empty.get("tools").is_none());
    }

    #[test]
    fn reasoning_model_selector() {
        for m in [
            "o1",
            "o1-mini",
            "o3-mini",
            "o4-mini",
            "gpt-5",
            "gpt-5-mini",
            "openai/o3",
            "GPT-5.1",
        ] {
            assert!(is_reasoning_model(m), "{m} should be a reasoning model");
        }
        for m in [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4.1",
            "llama3",
            "deepseek-chat",
            "omni",
        ] {
            assert!(
                !is_reasoning_model(m),
                "{m} should not be a reasoning model"
            );
        }
    }

    #[test]
    fn reasoning_models_get_max_completion_tokens_and_no_temperature() {
        let req = LlmRequest {
            messages: vec![ChatMessage::user("hi")],
            ..Default::default()
        };
        let wire = to_wire("o3-mini", &req);
        assert_eq!(wire["max_completion_tokens"], 8192);
        assert!(wire.get("max_tokens").is_none());
        assert!(wire.get("temperature").is_none());

        let wire = to_wire("gpt-4o", &req);
        assert_eq!(wire["max_tokens"], 8192);
        assert!(wire.get("temperature").is_some());
        assert!(wire.get("max_completion_tokens").is_none());
    }

    #[test]
    fn cache_breakpoint_is_not_sent() {
        let req = LlmRequest {
            messages: vec![
                ChatMessage::system("static"),
                ChatMessage::cache_breakpoint(),
                ChatMessage::system("dynamic"),
                ChatMessage::user("hi"),
            ],
            ..Default::default()
        };
        let wire = to_wire("gpt-4o", &req);
        let msgs = wire["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["content"], "dynamic");
    }

    #[test]
    fn to_wire_assistant_turn_carries_tool_calls() {
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCall {
            id: "call_1".into(),
            name: "get_battery".into(),
            args_json: "{}".into(),
            signature: None,
        });
        let wire = message_to_wire(&assistant);
        assert_eq!(wire["role"], "assistant");
        assert_eq!(wire["tool_calls"][0]["id"], "call_1");
        assert_eq!(wire["tool_calls"][0]["function"]["name"], "get_battery");
    }

    #[test]
    fn to_wire_tool_turn_carries_tool_call_id() {
        let wire = message_to_wire(&ChatMessage::tool("call_1", "{\"pct\":80}"));
        assert_eq!(wire["role"], "tool");
        assert_eq!(wire["tool_call_id"], "call_1");
        assert_eq!(wire["content"], "{\"pct\":80}");
    }

    #[test]
    fn from_wire_parses_plain_text_turn() {
        let body = json!({
            "choices": [{
                "message": { "role": "assistant", "content": "hi there" }
            }]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.text, "hi there");
        assert!(out.tool_calls.is_empty());
    }

    #[test]
    fn from_wire_parses_tool_call_turn() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_42",
                            "type": "function",
                            "function": {
                                "name": "get_battery",
                                "arguments": "{\"why\":\"test\"}"
                            }
                        }
                    ]
                }
            }]
        });
        let out = from_wire(&body).unwrap();
        assert!(out.text.is_empty());
        assert_eq!(out.tool_calls.len(), 1);
        let call = &out.tool_calls[0];
        assert_eq!(call.id, "call_42");
        assert_eq!(call.name, "get_battery");
        assert_eq!(call.args_json, "{\"why\":\"test\"}");
    }

    #[test]
    fn from_wire_missing_choices_is_bad_response() {
        let body = json!({ "error": { "message": "busted" } });
        match from_wire(&body) {
            Err(LlmError::BadResponse(_)) => {}
            other => panic!("expected BadResponse, got {other:?}"),
        }
    }

    #[test]
    fn from_wire_tool_call_without_id_is_bad_response() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        { "type": "function", "function": { "name": "x", "arguments": "{}" } }
                    ]
                }
            }]
        });
        assert!(matches!(from_wire(&body), Err(LlmError::BadResponse(_))));
    }
}
