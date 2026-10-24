//! Anthropic Messages API adapter.
//!
//! Same split as `openai.rs` — pure `to_wire` / `from_wire` helpers
//! tested directly, with a thin `chat` I/O wrapper on top.
//!
//! Notable translations vs OpenAI:
//! - `system` is a top-level field, not a message (string, or text
//!   blocks with a prompt-cache breakpoint when the caller marks one).
//! - Assistant turns return a `content` array of blocks; text blocks
//!   and `tool_use` blocks interleave. We concatenate text and collect
//!   tool_use entries into `ToolCall`s.
//! - Tool results are sent as a **user** message whose content is a
//!   `tool_result` block keyed by `tool_use_id`.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{http, ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role, ToolCall};

pub struct AnthropicClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl AnthropicClient {
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
impl LlmClient for AnthropicClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        let body = to_wire(&self.model, &req).to_string();
        let url = format!("{}/messages", self.base_url);
        let value = http::post_json_with_retry(
            || {
                self.http
                    .post(&url)
                    .header("x-api-key", &self.api_key)
                    .header("anthropic-version", "2023-06-01")
                    .header("Content-Type", "application/json")
                    .body(body.clone())
            },
            |_, _| None,
        )
        .await?;
        from_wire(&value)
    }
}

pub fn to_wire(model: &str, req: &LlmRequest) -> Value {
    // Pull out the System messages — Anthropic wants a top-level
    // `system` field, not a role entry. A cache breakpoint row splits
    // them into a static prefix and a volatile tail.
    let mut static_parts: Vec<&str> = Vec::new();
    let mut dynamic_parts: Vec<&str> = Vec::new();
    let mut seen_breakpoint = false;
    let mut messages: Vec<Value> = Vec::new();
    for m in &req.messages {
        match m.role {
            Role::System if m.is_cache_breakpoint() => seen_breakpoint = true,
            Role::System if seen_breakpoint => dynamic_parts.push(&m.content),
            Role::System => static_parts.push(&m.content),
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
    if let Some(system) = system_to_wire(&static_parts, &dynamic_parts, seen_breakpoint) {
        body["system"] = system;
    }
    if !req.tools.is_empty() {
        let mut tools: Vec<Value> = req
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
        // Tool definitions are identical across turns — cache them.
        if let Some(last) = tools.last_mut() {
            last["cache_control"] = json!({ "type": "ephemeral" });
        }
        body["tools"] = Value::Array(tools);
    }
    body
}

/// Build the `system` field. Without a cache breakpoint it stays the
/// plain string other callers (one-shot prompts) have always sent. With
/// one, it becomes text blocks and the static block carries
/// `cache_control`, so tools + static prompt are served from the prompt
/// cache while the clock / facts tail changes freely.
fn system_to_wire(
    static_parts: &[&str],
    dynamic_parts: &[&str],
    breakpoint: bool,
) -> Option<Value> {
    let static_txt = static_parts.join("\n\n");
    let dynamic_txt = dynamic_parts.join("\n\n");
    if !breakpoint {
        return (!static_txt.is_empty()).then(|| Value::String(static_txt));
    }
    let mut blocks: Vec<Value> = Vec::new();
    if !static_txt.is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": static_txt,
            "cache_control": { "type": "ephemeral" },
        }));
    }
    if !dynamic_txt.is_empty() {
        blocks.push(json!({ "type": "text", "text": dynamic_txt }));
    }
    (!blocks.is_empty()).then(|| Value::Array(blocks))
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
    fn cache_breakpoint_splits_system_into_cached_blocks() {
        let req = LlmRequest {
            messages: vec![
                ChatMessage::system("base"),
                ChatMessage::system("catalog"),
                ChatMessage::cache_breakpoint(),
                ChatMessage::system("clock"),
                ChatMessage::system("facts"),
                ChatMessage::user("hi"),
            ],
            tools: vec![
                ToolSpec {
                    name: "a".into(),
                    description: "".into(),
                    schema: json!({ "type": "object" }),
                },
                ToolSpec {
                    name: "b".into(),
                    description: "".into(),
                    schema: json!({ "type": "object" }),
                },
            ],
            ..Default::default()
        };
        let wire = to_wire("claude", &req);
        let sys = wire["system"].as_array().expect("system blocks");
        assert_eq!(sys.len(), 2);
        assert_eq!(sys[0]["text"], "base\n\ncatalog");
        assert_eq!(sys[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(sys[1]["text"], "clock\n\nfacts");
        assert!(sys[1].get("cache_control").is_none());
        // Only the last tool carries the breakpoint.
        assert!(wire["tools"][0].get("cache_control").is_none());
        assert_eq!(wire["tools"][1]["cache_control"]["type"], "ephemeral");
        assert_eq!(wire["messages"].as_array().unwrap().len(), 1);
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
