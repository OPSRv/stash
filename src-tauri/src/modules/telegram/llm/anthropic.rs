//! Anthropic Messages API adapter.
//!
//! Same split as `openai.rs` — pure `to_wire` / `from_wire` helpers
//! tested directly, with a thin `chat` I/O wrapper on top.
//!
//! Notable translations vs OpenAI:
//! - `system` is a top-level string, not a message.
//! - Assistant turns return a `content` array of blocks; text blocks
//!   and `tool_use` blocks interleave. We concatenate text and collect
//!   tool_use entries into `ToolCall`s.
//! - Tool results are sent as a **user** message whose content is a
//!   `tool_result` block keyed by `tool_use_id`.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role, ToolCall};

pub struct AnthropicClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl AnthropicClient {
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
impl LlmClient for AnthropicClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        let body = to_wire(&self.model, &req);
        let url = format!("{}/messages", self.base_url);

        let mut attempt = 0;
        let response = loop {
            let resp = self
                .http
                .post(&url)
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .await;
            match resp {
                Ok(r) => {
                    if r.status().is_server_error() && attempt == 0 {
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

pub fn to_wire(model: &str, req: &LlmRequest) -> Value {
    // Pull out the System message — Anthropic wants a top-level
    // `system` string, not a role entry.
    let mut system_txt = String::new();
    let mut messages: Vec<Value> = Vec::new();
    for m in &req.messages {
        match m.role {
            Role::System => {
                if !system_txt.is_empty() {
                    system_txt.push_str("\n\n");
                }
                system_txt.push_str(&m.content);
            }
            Role::User => messages.push(json!({
                "role": "user",
                "content": m.content,
            })),
            Role::Assistant => messages.push(assistant_to_wire(m)),
            Role::Tool => messages.push(tool_result_to_wire(m)),
        }
    }

    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
    });
    if !system_txt.is_empty() {
        body["system"] = Value::String(system_txt);
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.schema,
                })
            })
            .collect();
        body["tools"] = Value::Array(tools);
    }
    body
}

fn assistant_to_wire(msg: &ChatMessage) -> Value {
    // Anthropic assistant content is always a blocks array. We emit a
    // single text block for non-empty text, plus a tool_use block per
    // tool call — matching the shape the provider expects on replay.
    let mut blocks: Vec<Value> = Vec::new();
    if !msg.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": msg.content }));
    }
    for c in &msg.tool_calls {
        let input: Value = serde_json::from_str(&c.args_json).unwrap_or(json!({}));
        blocks.push(json!({
            "type": "tool_use",
            "id": c.id,
            "name": c.name,
            "input": input,
        }));
    }
    json!({ "role": "assistant", "content": blocks })
}

fn tool_result_to_wire(msg: &ChatMessage) -> Value {
    let tool_use_id = msg.tool_call_id.clone().unwrap_or_default();
    json!({
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": msg.content,
            }
        ]
    })
}

pub fn from_wire(value: &Value) -> Result<LlmResponse, LlmError> {
    let content = value
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| LlmError::BadResponse("missing content array".into()))?;

    let mut text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for block in content {
        let ty = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ty {
            "text" => {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
            }
            "tool_use" => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| LlmError::BadResponse("tool_use missing id".into()))?
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| LlmError::BadResponse("tool_use missing name".into()))?
                    .to_string();
                let args_json = block
                    .get("input")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "{}".to_string());
                tool_calls.push(ToolCall {
                    id,
                    name,
                    args_json,
                    signature: None,
                });
            }
            _ => {
                // Ignore unknown block types — Anthropic ships new
                // ones periodically; we'd rather miss an experimental
                // block than refuse otherwise-usable replies.
            }
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
    use crate::modules::telegram::llm::{ChatMessage, ToolSpec};

    #[test]
    fn system_message_lifts_to_top_level_field() {
        let req = LlmRequest {
            messages: vec![
                ChatMessage::system("you are brisk"),
                ChatMessage::user("hi"),
            ],
            ..Default::default()
        };
        let wire = to_wire("claude-3-5-sonnet-latest", &req);
        assert_eq!(wire["system"], "you are brisk");
        assert_eq!(wire["messages"].as_array().unwrap().len(), 1);
        assert_eq!(wire["messages"][0]["role"], "user");
    }

    #[test]
    fn assistant_tool_call_becomes_tool_use_block() {
        let mut a = ChatMessage::assistant("sure");
        a.tool_calls.push(ToolCall {
            id: "toolu_1".into(),
            name: "get_battery".into(),
            args_json: "{\"scope\":\"now\"}".into(),
            signature: None,
        });
        let wire = assistant_to_wire(&a);
        assert_eq!(wire["role"], "assistant");
        let blocks = wire["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "tool_use");
        assert_eq!(blocks[1]["id"], "toolu_1");
        assert_eq!(blocks[1]["name"], "get_battery");
        assert_eq!(blocks[1]["input"]["scope"], "now");
    }

    #[test]
    fn tool_result_round_trips_as_user_message() {
        let wire = tool_result_to_wire(&ChatMessage::tool("toolu_1", "{\"pct\":72}"));
        assert_eq!(wire["role"], "user");
        let block = &wire["content"][0];
        assert_eq!(block["type"], "tool_result");
        assert_eq!(block["tool_use_id"], "toolu_1");
        assert_eq!(block["content"], "{\"pct\":72}");
    }

    #[test]
    fn tools_encoded_with_input_schema_key() {
        let req = LlmRequest {
            messages: vec![ChatMessage::user("x")],
            tools: vec![ToolSpec {
                name: "ping".into(),
                description: "check".into(),
                schema: json!({ "type": "object", "properties": {} }),
            }],
            ..Default::default()
        };
        let wire = to_wire("claude", &req);
        assert_eq!(wire["tools"][0]["name"], "ping");
        assert!(wire["tools"][0].get("input_schema").is_some());
    }

    #[test]
    fn from_wire_concatenates_text_blocks() {
        let body = json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "text", "text": "world" }
            ]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.text, "hello\nworld");
        assert!(out.tool_calls.is_empty());
    }

    #[test]
    fn from_wire_parses_tool_use_block() {
        let body = json!({
            "content": [
                { "type": "text", "text": "let me check" },
                {
                    "type": "tool_use",
                    "id": "toolu_abc",
                    "name": "get_battery",
                    "input": { "why": "user asked" }
                }
            ]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.text, "let me check");
        assert_eq!(out.tool_calls.len(), 1);
        assert_eq!(out.tool_calls[0].id, "toolu_abc");
        assert_eq!(out.tool_calls[0].name, "get_battery");
        let parsed: Value = serde_json::from_str(&out.tool_calls[0].args_json).unwrap();
        assert_eq!(parsed["why"], "user asked");
    }

    #[test]
    fn from_wire_ignores_unknown_block_types() {
        let body = json!({
            "content": [
                { "type": "text", "text": "visible" },
                { "type": "experimental_thing", "blob": 42 }
            ]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.text, "visible");
    }

    #[test]
    fn from_wire_missing_content_array_is_bad_response() {
        let body = json!({ "whatever": true });
        assert!(matches!(from_wire(&body), Err(LlmError::BadResponse(_))));
    }
}
