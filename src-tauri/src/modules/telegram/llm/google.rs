//! Google Gemini (`generativelanguage.googleapis.com`) adapter.
//!
//! Wire differences vs. OpenAI/Anthropic we translate for here:
//! - API key travels as a `?key=` query string, not a header.
//! - `system` lifts to a `systemInstruction` field (similar shape
//!   to Anthropic — a separate `parts` block).
//! - Messages are called `contents`; assistant role is `model`;
//!   tool-call role is also `user` carrying a `functionResponse`
//!   part (Gemini has no `tool` role, no tool_call_id — tools
//!   correlate by name, which is fine for single-turn loops).
//! - The model picks a function by emitting a `functionCall` part
//!   inside an assistant turn; no OpenAI-style `tool_calls` array.
//! - Tool schemas live under `tools[0].functionDeclarations[]`
//!   with `parameters` reused from JSON Schema (Gemini accepts
//!   the same Draft-07 shape we already produce).

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role, ToolCall};

pub struct GoogleClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl GoogleClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }
}

#[async_trait]
impl LlmClient for GoogleClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        let body = to_wire(&req);
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            self.base_url, self.model, self.api_key
        );

        let mut attempt = 0;
        let response = loop {
            let resp = self
                .http
                .post(&url)
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

        // Gemini often returns a 400 with `API_KEY_INVALID` for
        // unusable keys; surface that as Auth so the dispatcher
        // falls back to inbox + shows a clear banner.
        if status.as_u16() == 400 && text.contains("API_KEY_INVALID") {
            return Err(LlmError::Auth);
        }

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

pub fn to_wire(req: &LlmRequest) -> Value {
    let mut system_txt = String::new();
    let mut contents: Vec<Value> = Vec::new();
    for m in &req.messages {
        match m.role {
            Role::System => {
                if !system_txt.is_empty() {
                    system_txt.push_str("\n\n");
                }
                system_txt.push_str(&m.content);
            }
            Role::User => contents.push(json!({
                "role": "user",
                "parts": [{ "text": m.content }],
            })),
            Role::Assistant => contents.push(assistant_to_wire(m)),
            Role::Tool => contents.push(tool_result_to_wire(m)),
        }
    }

    let mut body = json!({
        "contents": contents,
        "generationConfig": {
            "temperature": req.temperature,
            "maxOutputTokens": req.max_tokens,
        },
    });
    if !system_txt.is_empty() {
        body["systemInstruction"] = json!({
            "parts": [{ "text": system_txt }],
        });
    }
    if !req.tools.is_empty() {
        let decls: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": sanitize_schema(&t.schema),
                })
            })
            .collect();
        body["tools"] = json!([{ "functionDeclarations": decls }]);
    }
    body
}

/// Strip JSON-Schema fields Gemini rejects. OpenAPI 3.0 subset is
/// what the Generative Language API documents; `additionalProperties`,
/// `$schema`, `definitions`, and a handful of draft-07 niceties get
/// rejected with a 400 "Unknown name …: Cannot find field." Recursing
/// keeps nested object/array schemas clean too.
fn sanitize_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                if matches!(
                    k.as_str(),
                    "additionalProperties"
                        | "$schema"
                        | "$id"
                        | "$ref"
                        | "definitions"
                        | "$defs"
                        | "examples"
                        | "default"
                ) {
                    continue;
                }
                out.insert(k.clone(), sanitize_schema(v));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sanitize_schema).collect()),
        other => other.clone(),
    }
}

fn assistant_to_wire(msg: &ChatMessage) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    if !msg.content.is_empty() {
        parts.push(json!({ "text": msg.content }));
    }
    for c in &msg.tool_calls {
        let args: Value = serde_json::from_str(&c.args_json).unwrap_or(json!({}));
        let mut part = serde_json::Map::new();
        part.insert(
            "functionCall".into(),
            json!({ "name": c.name, "args": args }),
        );
        // Gemini 2.5 rejects echoed functionCall parts that lack the
        // `thoughtSignature` it originally emitted — see from_wire.
        if let Some(sig) = &c.signature {
            part.insert("thoughtSignature".into(), Value::String(sig.clone()));
        }
        parts.push(Value::Object(part));
    }
    json!({ "role": "model", "parts": parts })
}

fn tool_result_to_wire(msg: &ChatMessage) -> Value {
    // Gemini correlates by function name, not by id. When the
    // orchestrator already passed us a tool row we rely on the
    // matching assistant turn right above to carry the same name;
    // if the tool result JSON is itself an object we splat it as
    // `response`, otherwise wrap it under `{content: "…"}` so the
    // wire shape stays valid.
    let name = msg.tool_call_id.clone().unwrap_or_default();
    let response: Value =
        serde_json::from_str(&msg.content).unwrap_or_else(|_| json!({ "content": msg.content }));
    json!({
        "role": "user",
        "parts": [
            { "functionResponse": { "name": name, "response": response } }
        ],
    })
}

pub fn from_wire(value: &Value) -> Result<LlmResponse, LlmError> {
    let parts = value
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| LlmError::BadResponse("missing candidates[0].content.parts".into()))?;

    let mut text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for part in parts {
        if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(t);
            continue;
        }
        if let Some(call) = part.get("functionCall") {
            let name = call
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| LlmError::BadResponse("functionCall missing name".into()))?
                .to_string();
            let args_json = call
                .get("args")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string());
            // Gemini 2.5 attaches an opaque thoughtSignature alongside
            // each functionCall part. We must echo it back verbatim on
            // the next request, otherwise Gemini returns 400.
            let signature = part
                .get("thoughtSignature")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let id = format!("google-{}-{}", name, tool_calls.len());
            tool_calls.push(ToolCall {
                id,
                name,
                args_json,
                signature,
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
    use crate::modules::telegram::llm::{ChatMessage, ToolSpec};

    #[test]
    fn system_lifts_to_instruction_field() {
        let req = LlmRequest {
            messages: vec![
                ChatMessage::system("stay brief"),
                ChatMessage::user("hi"),
            ],
            ..Default::default()
        };
        let wire = to_wire(&req);
        assert_eq!(
            wire["systemInstruction"]["parts"][0]["text"],
            "stay brief"
        );
        assert_eq!(wire["contents"].as_array().unwrap().len(), 1);
        assert_eq!(wire["contents"][0]["role"], "user");
        assert_eq!(wire["contents"][0]["parts"][0]["text"], "hi");
    }

    #[test]
    fn assistant_tool_call_becomes_function_call_part() {
        let mut a = ChatMessage::assistant("let me check");
        a.tool_calls.push(ToolCall {
            id: "ignored-on-wire".into(),
            name: "get_battery".into(),
            args_json: "{\"scope\":\"now\"}".into(),
            signature: None,
        });
        let wire = assistant_to_wire(&a);
        assert_eq!(wire["role"], "model");
        assert_eq!(wire["parts"][0]["text"], "let me check");
        assert_eq!(wire["parts"][1]["functionCall"]["name"], "get_battery");
        assert_eq!(wire["parts"][1]["functionCall"]["args"]["scope"], "now");
    }

    #[test]
    fn tools_encoded_under_function_declarations() {
        let req = LlmRequest {
            messages: vec![ChatMessage::user("x")],
            tools: vec![ToolSpec {
                name: "ping".into(),
                description: "check".into(),
                schema: json!({ "type": "object", "properties": {} }),
            }],
            ..Default::default()
        };
        let wire = to_wire(&req);
        assert_eq!(wire["tools"][0]["functionDeclarations"][0]["name"], "ping");
    }

    #[test]
    fn sanitize_drops_fields_gemini_rejects() {
        let schema = json!({
            "type": "object",
            "additionalProperties": false,
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
                "text": {
                    "type": "string",
                    "default": "x",
                    "examples": ["a", "b"]
                },
                "meta": {
                    "type": "object",
                    "additionalProperties": true,
                    "properties": {}
                }
            },
            "required": ["text"]
        });
        let cleaned = sanitize_schema(&schema);
        assert!(cleaned.get("additionalProperties").is_none());
        assert!(cleaned.get("$schema").is_none());
        let text = &cleaned["properties"]["text"];
        assert!(text.get("default").is_none());
        assert!(text.get("examples").is_none());
        assert!(cleaned["properties"]["meta"]
            .get("additionalProperties")
            .is_none());
        // Structural fields survive.
        assert_eq!(cleaned["type"], "object");
        assert_eq!(cleaned["required"], json!(["text"]));
    }

    #[test]
    fn to_wire_sanitizes_tool_schemas() {
        let req = LlmRequest {
            messages: vec![ChatMessage::user("x")],
            tools: vec![ToolSpec {
                name: "remember".into(),
                description: "".into(),
                schema: json!({
                    "type": "object",
                    "properties": { "text": { "type": "string" } },
                    "required": ["text"],
                    "additionalProperties": false
                }),
            }],
            ..Default::default()
        };
        let wire = to_wire(&req);
        let params = &wire["tools"][0]["functionDeclarations"][0]["parameters"];
        assert!(params.get("additionalProperties").is_none());
        assert_eq!(params["properties"]["text"]["type"], "string");
    }

    #[test]
    fn from_wire_parses_plain_text_turn() {
        let body = json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{ "text": "hello world" }]
                }
            }]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.text, "hello world");
        assert!(out.tool_calls.is_empty());
    }

    #[test]
    fn from_wire_parses_function_call_turn() {
        let body = json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "text": "let me check" },
                        { "functionCall": {
                            "name": "get_battery",
                            "args": { "why": "user asked" }
                        } }
                    ]
                }
            }]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.text, "let me check");
        assert_eq!(out.tool_calls.len(), 1);
        assert_eq!(out.tool_calls[0].name, "get_battery");
        let args: Value = serde_json::from_str(&out.tool_calls[0].args_json).unwrap();
        assert_eq!(args["why"], "user asked");
    }

    #[test]
    fn tool_result_wraps_non_json_content() {
        let wire = tool_result_to_wire(&ChatMessage::tool("get_battery", "just a string"));
        assert_eq!(wire["role"], "user");
        assert_eq!(
            wire["parts"][0]["functionResponse"]["name"],
            "get_battery"
        );
        assert_eq!(
            wire["parts"][0]["functionResponse"]["response"]["content"],
            "just a string"
        );
    }

    #[test]
    fn from_wire_missing_candidates_is_bad_response() {
        let body = json!({ "error": "busted" });
        assert!(matches!(from_wire(&body), Err(LlmError::BadResponse(_))));
    }

    #[test]
    fn from_wire_captures_thought_signature_on_function_call() {
        let body = json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "functionCall": { "name": "note", "args": {} },
                          "thoughtSignature": "ZmFrZS1zaWc=" }
                    ]
                }
            }]
        });
        let out = from_wire(&body).unwrap();
        assert_eq!(out.tool_calls.len(), 1);
        assert_eq!(
            out.tool_calls[0].signature.as_deref(),
            Some("ZmFrZS1zaWc=")
        );
    }

    #[test]
    fn assistant_echoes_thought_signature_back_on_wire() {
        let mut a = ChatMessage::assistant("");
        a.tool_calls.push(ToolCall {
            id: "ignored".into(),
            name: "note".into(),
            args_json: "{}".into(),
            signature: Some("ZmFrZS1zaWc=".into()),
        });
        let wire = assistant_to_wire(&a);
        assert_eq!(wire["parts"][0]["functionCall"]["name"], "note");
        assert_eq!(wire["parts"][0]["thoughtSignature"], "ZmFrZS1zaWc=");
    }

    #[test]
    fn assistant_without_signature_omits_field() {
        let mut a = ChatMessage::assistant("");
        a.tool_calls.push(ToolCall {
            id: "ignored".into(),
            name: "note".into(),
            args_json: "{}".into(),
            signature: None,
        });
        let wire = assistant_to_wire(&a);
        assert!(wire["parts"][0].get("thoughtSignature").is_none());
    }
}
