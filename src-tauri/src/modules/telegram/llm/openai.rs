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

use super::{ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role, ToolCall, ToolSpec};

pub struct OpenAiClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl OpenAiClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }
}

#[async_trait]
impl LlmClient for OpenAiClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        let body = to_wire(&self.model, &req);
        let url = format!("{}/chat/completions", self.base_url);

        // 5xx retry — single shot with a 1s back-off. Captures the
        // common "provider is warming up a new replica" case without
        // amplifying rate-limit storms.
        let mut attempt = 0;
        let response = loop {
            let resp = self
                .http
                .post(&url)
                .bearer_auth(&self.api_key)
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .await;
            match resp {
                Ok(r) => {
                    let status = r.status();
                    if status.is_server_error() && attempt == 0 {
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                    break r;
                }
                Err(e) => return Err(LlmError::Network(e.to_string())),
            }
        };

        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(LlmError::Auth);
        }
        if status.as_u16() == 429 {
            return Err(LlmError::RateLimit);
        }

        // The repo's `reqwest` is compiled without the `json` feature;
        // parse as text + serde_json per existing convention.
        let text = response
            .text()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?;

        if !status.is_success() {
            return Err(LlmError::BadResponse(format!(
                "status {}: {}",
                status.as_u16(),
                truncate(&text, 200)
            )));
        }

        let value: Value = serde_json::from_str(&text)
            .map_err(|e| LlmError::BadResponse(format!("json parse: {e}")))?;
        from_wire(&value)
    }
}

/// Build the JSON payload sent to `/chat/completions`. Separated out
/// so tests assert on a `serde_json::Value` without touching HTTP.
pub fn to_wire(model: &str, req: &LlmRequest) -> Value {
    let messages: Vec<Value> = req.messages.iter().map(message_to_wire).collect();
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
    });
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
            });
        }
    }

    Ok(LlmResponse { text, tool_calls })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::llm::{ChatMessage, Role};

    #[test]
    fn to_wire_encodes_messages_and_tools() {
        let req = LlmRequest {
            messages: vec![
                ChatMessage::system("be helpful"),
                ChatMessage::user("hi"),
            ],
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
    fn to_wire_assistant_turn_carries_tool_calls() {
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCall {
            id: "call_1".into(),
            name: "get_battery".into(),
            args_json: "{}".into(),
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
