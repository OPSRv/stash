//! Google Gemini (`generativelanguage.googleapis.com`) adapter.
//!
//! Wire differences vs. OpenAI/Anthropic we translate for here:
//! - API key travels in the `x-goog-api-key` header (never the URL).
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

use super::{
    http, truncate_chars, ChatMessage, LlmClient, LlmError, LlmRequest, LlmResponse, Role, ToolCall,
};

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
            http: http::build_client(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }
}

#[async_trait]
impl LlmClient for GoogleClient {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
        let body = to_wire(&req).to_string();
        // Key goes in a header, never the URL: reqwest error strings
        // embed the URL and those reach logs and Telegram.
        let url = format!("{}/models/{}:generateContent", self.base_url, self.model);
        let value = http::post_json_with_retry(
            || {
                self.http
                    .post(&url)
                    .header("x-goog-api-key", &self.api_key)
                    .header("Content-Type", "application/json")
                    .body(body.clone())
            },
            // Gemini often returns a 400 with `API_KEY_INVALID` for
            // unusable keys; surface that as Auth so the dispatcher
            // falls back to inbox + shows a clear banner.
            |status, text| {
                (status == 400 && text.contains("API_KEY_INVALID")).then_some(LlmError::Auth)
            },
        )
        .await?;
        from_wire(&value)
    }
}

pub fn to_wire(req: &LlmRequest) -> Value {
    let mut system_txt = String::new();
    let mut contents: Vec<Value> = Vec::new();
    // Gemini correlates tool results by function *name*; our ids are
    // synthetic, so remember which name each id belongs to.
    let mut call_names: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    // Gemini wants every functionResponse answering one model turn in a
    // single `user` content; consecutive tool messages are merged.
    let mut last_was_tool = false;
    for m in &req.messages {
        let is_tool = m.role == Role::Tool;
        match m.role {
            Role::System if m.is_cache_breakpoint() => {}
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
            Role::Assistant => {
                for c in &m.tool_calls {
                    call_names.insert(&c.id, &c.name);
                }
                contents.push(assistant_to_wire(m));
            }
            Role::Tool => {
                let id = m.tool_call_id.as_deref().unwrap_or_default();
                let name = call_names
                    .get(id)
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| name_from_call_id(id));
                let wire = tool_result_to_wire(&name, m);
                let merged = last_was_tool
                    && contents
                        .last_mut()
                        .and_then(|c| c["parts"].as_array_mut())
                        .map(|parts| {
                            parts.extend(wire["parts"].as_array().cloned().unwrap_or_default())
                        })
                        .is_some();
                if !merged {
                    contents.push(wire);
                }
            }
        }
        if !(m.role == Role::System) {
            last_was_tool = is_tool;
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

/// Synthesise the call id for the `idx`-th functionCall of a turn.
fn call_id(name: &str, idx: usize) -> String {
    format!("google-{name}-{idx}")
}

/// Inverse of `call_id`, used when the originating assistant turn is
/// not in the request. Ids that don't match the scheme pass through.
fn name_from_call_id(id: &str) -> String {
    id.strip_prefix("google-")
        .and_then(|rest| rest.rsplit_once('-'))
        .filter(|(_, idx)| !idx.is_empty() && idx.bytes().all(|b| b.is_ascii_digit()))
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| id.to_string())
}

fn tool_result_to_wire(name: &str, msg: &ChatMessage) -> Value {
    // Gemini correlates by function name, not by id — `name` is the
    // real function name resolved by `to_wire`. If the tool result
    // JSON is itself an object we splat it as `response`, otherwise
    // wrap it under `{content: "…"}` so the wire shape stays valid
    // (`response` must be an object).
    let response: Value = match serde_json::from_str::<Value>(&msg.content) {
        Ok(v) if v.is_object() => v,
        _ => json!({ "content": msg.content }),
    };
    json!({
        "role": "user",
        "parts": [
            { "functionResponse": { "name": name, "response": response } }
        ],
    })
}

pub fn from_wire(value: &Value) -> Result<LlmResponse, LlmError> {
    let parts = match value
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
    {
        Some(p) => p,
        None => {
            // Gemini emits a candidate with no `content.parts` when the
            // turn was cut short — most often `MAX_TOKENS` on thinking
            // models that spent the whole budget reasoning, sometimes
            // `SAFETY` / `RECITATION` / `PROHIBITED_CONTENT`. Surface
            // the reason so the user knows whether to bump the cap or
            // change the prompt.
            let reason = value
                .pointer("/candidates/0/finishReason")
                .and_then(|v| v.as_str());
            let block = value
                .pointer("/promptFeedback/blockReason")
                .and_then(|v| v.as_str());
            let msg = match (reason, block) {
                (Some("MAX_TOKENS"), _) => {
                    "Gemini hit the output-token cap before producing a reply \
                     (thinking models burn the budget on reasoning — \
                     try a non-thinking model or raise the limit)"
                        .to_string()
                }
                (Some(r), _)
                    if matches!(
                        r,
                        "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "BLOCKLIST"
                    ) =>
                {
                    format!("Gemini blocked the response ({r})")
                }
                (_, Some(b)) => format!("Gemini blocked the prompt ({b})"),
                (Some(r), _) => format!("Gemini returned no content (finishReason: {r})"),
                (None, None) => format!(
                    "Gemini returned an unrecognised response shape: {}",
                    truncate_chars(&value.to_string(), 400, "…")
                ),
            };
            return Err(LlmError::BadResponse(msg));
        }
    };

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
            let id = call_id(&name, tool_calls.len());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::llm::{ChatMessage, ToolSpec};

    #[test]
    fn system_lifts_to_instruction_field() {
        let req = LlmRequest {
            messages: vec![ChatMessage::system("stay brief"), ChatMessage::user("hi")],
            ..Default::default()
        };
        let wire = to_wire(&req);
        assert_eq!(wire["systemInstruction"]["parts"][0]["text"], "stay brief");
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
        let wire = tool_result_to_wire(
            "get_battery",
            &ChatMessage::tool("google-get_battery-0", "just a string"),
        );
        assert_eq!(wire["role"], "user");
        assert_eq!(wire["parts"][0]["functionResponse"]["name"], "get_battery");
        assert_eq!(
            wire["parts"][0]["functionResponse"]["response"]["content"],
            "just a string"
        );
    }

    #[test]
    fn tool_result_uses_real_function_name_not_call_id() {
        // Round-trip: parse functionCalls, replay them with results.
        let body = json!({
            "candidates": [{ "content": { "role": "model", "parts": [
                { "functionCall": { "name": "get_battery", "args": {} } },
                { "functionCall": { "name": "list_facts", "args": {} } }
            ] } }]
        });
        let resp = from_wire(&body).unwrap();
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls = resp.tool_calls.clone();
        let req = LlmRequest {
            messages: vec![
                ChatMessage::user("x"),
                assistant,
                ChatMessage::tool(resp.tool_calls[0].id.clone(), "{\"pct\":72}"),
                ChatMessage::tool(resp.tool_calls[1].id.clone(), "[]"),
            ],
            ..Default::default()
        };
        let wire = to_wire(&req);
        // Parallel calls → both responses in ONE user content.
        assert_eq!(wire["contents"].as_array().unwrap().len(), 3);
        assert_eq!(wire["contents"][2]["role"], "user");
        assert_eq!(wire["contents"][2]["parts"].as_array().unwrap().len(), 2);
        let fr0 = &wire["contents"][2]["parts"][0]["functionResponse"];
        assert_eq!(fr0["name"], "get_battery");
        assert_eq!(fr0["response"]["pct"], 72);
        let fr1 = &wire["contents"][2]["parts"][1]["functionResponse"];
        assert_eq!(fr1["name"], "list_facts");
        // Non-object JSON is wrapped so `response` stays an object.
        assert_eq!(fr1["response"]["content"], "[]");
    }

    #[test]
    fn tool_results_of_separate_turns_are_not_merged() {
        let mut a1 = ChatMessage::assistant("");
        a1.tool_calls = vec![super::super::ToolCall {
            id: "google-get_battery-0".into(),
            name: "get_battery".into(),
            args_json: "{}".into(),
            ..Default::default()
        }];
        let mut a2 = ChatMessage::assistant("");
        a2.tool_calls = vec![super::super::ToolCall {
            id: "google-list_facts-0".into(),
            name: "list_facts".into(),
            args_json: "{}".into(),
            ..Default::default()
        }];
        let req = LlmRequest {
            messages: vec![
                ChatMessage::user("x"),
                a1,
                ChatMessage::tool("google-get_battery-0", "{}"),
                a2,
                ChatMessage::tool("google-list_facts-0", "{}"),
                ChatMessage::user("y"),
            ],
            ..Default::default()
        };
        let wire = to_wire(&req);
        let contents = wire["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 6);
        assert_eq!(contents[2]["parts"].as_array().unwrap().len(), 1);
        assert_eq!(contents[4]["parts"].as_array().unwrap().len(), 1);
        assert_eq!(contents[5]["parts"][0]["text"], "y");
    }

    #[test]
    fn name_from_call_id_falls_back_to_parsing() {
        assert_eq!(name_from_call_id("google-get_battery-0"), "get_battery");
        assert_eq!(
            name_from_call_id("google-convert-media-12"),
            "convert-media"
        );
        assert_eq!(name_from_call_id("call_abc"), "call_abc");
        assert_eq!(name_from_call_id("google-nodigits-x"), "google-nodigits-x");
    }

    #[test]
    fn cache_breakpoint_is_not_sent() {
        let req = LlmRequest {
            messages: vec![
                ChatMessage::system("a"),
                ChatMessage::cache_breakpoint(),
                ChatMessage::system("b"),
                ChatMessage::user("hi"),
            ],
            ..Default::default()
        };
        let wire = to_wire(&req);
        assert_eq!(wire["systemInstruction"]["parts"][0]["text"], "a\n\nb");
    }

    #[test]
    fn from_wire_unrecognised_shape_truncates_utf8_safely() {
        let body = json!({ "weird": "й".repeat(1000) });
        assert!(matches!(from_wire(&body), Err(LlmError::BadResponse(_))));
    }

    #[test]
    fn from_wire_missing_candidates_is_bad_response() {
        let body = json!({ "error": "busted" });
        assert!(matches!(from_wire(&body), Err(LlmError::BadResponse(_))));
    }

    #[test]
    fn from_wire_max_tokens_finish_reason_is_human_readable() {
        let body = json!({
            "candidates": [{
                "finishReason": "MAX_TOKENS",
                "content": { "role": "model" }
            }]
        });
        match from_wire(&body) {
            Err(LlmError::BadResponse(m)) => {
                assert!(
                    m.contains("MAX_TOKENS") || m.to_lowercase().contains("token"),
                    "expected token-cap hint, got: {m}"
                );
            }
            other => panic!("expected BadResponse, got {other:?}"),
        }
    }

    #[test]
    fn from_wire_safety_finish_reason_surfaces_block() {
        let body = json!({
            "candidates": [{
                "finishReason": "SAFETY",
                "content": { "role": "model" }
            }]
        });
        match from_wire(&body) {
            Err(LlmError::BadResponse(m)) => assert!(m.contains("SAFETY")),
            other => panic!("expected BadResponse, got {other:?}"),
        }
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
        assert_eq!(out.tool_calls[0].signature.as_deref(), Some("ZmFrZS1zaWc="));
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
