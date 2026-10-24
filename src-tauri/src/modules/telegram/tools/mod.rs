//! Tool trait + registry for AI function-calling.
//!
//! Tools are thin adapters that take a JSON-encoded argument blob,
//! do work (usually through another module's API), and return a
//! JSON result. The `ToolRegistry` publishes their `ToolSpec`s to
//! the LLM and routes `ToolCall`s back to the right handler with a
//! hard per-call timeout (5 s unless the tool overrides `timeout`) +
//! audit log per call. Destructive tools (`confirm::DANGEROUS_TOOLS`)
//! are never run directly: the call is parked behind a Telegram
//! confirmation card instead.
//!
//! `Tool::args_redaction` lets each tool mark free-text fields that
//! should not be written verbatim into the log — so a `remember`
//! call keeps the fact private even under `RUST_LOG=info`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

pub mod memory;
pub mod reminders;
pub mod stash;

use super::llm::{ToolCall, ToolSpec};
use super::state::TelegramState;

/// Default per-tool timeout. Local ops (battery, clipboard) resolve
/// in <1 ms; any tool that actually reaches this cap has either hung
/// or misbehaved, so aborting and letting the LLM see an error
/// response is the right move.
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(5);

/// Slash-commands the LLM must not dispatch via `invoke_command` (and
/// that are hidden from its command catalog). `ai` / `summarize` /
/// `voice` / `ask` re-enter the LLM (recursion + tool-timeout kills),
/// the rest are interactive / internal plumbing (pairing, the
/// confirmation-card callback, retry of the last prompt, onboarding).
/// Mirrors `RECURSIVE_TOOLS` in `llm/claude_code.rs` for the MCP path.
pub const LLM_EXCLUDED_COMMANDS: &[&str] = &[
    "ai",
    "summarize",
    "voice",
    "pair",
    "confirm",
    "retry",
    "ask",
    "start",
];

pub fn is_llm_excluded_command(name: &str) -> bool {
    LLM_EXCLUDED_COMMANDS.contains(&name)
}

pub struct ToolCtx {
    pub state: Arc<TelegramState>,
    /// Tauri handle for tools that dispatch slash-commands or emit
    /// cross-module events. `None` in unit tests that don't exercise
    /// those paths — tools requiring it surface a clear error.
    pub app: Option<tauri::AppHandle>,
    /// Unix epoch milliseconds. Passed in by the orchestrator so
    /// tests can inject a deterministic clock.
    pub now_ms: i64,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn schema(&self) -> Value;
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String>;

    /// Per-tool timeout override. `None` → the registry default
    /// (`TOOL_TIMEOUT`). Tools that legitimately wait on another
    /// command (e.g. `invoke_command`) raise it.
    fn timeout(&self) -> Option<Duration> {
        None
    }
}

pub struct ToolRegistry {
    tools: HashMap<&'static str, Arc<dyn Tool>>,
    order: Vec<&'static str>,
    timeout: Duration,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self {
            tools: HashMap::new(),
            order: Vec::new(),
            timeout: TOOL_TIMEOUT,
        }
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test-only override: shorten the per-invoke timeout so timeout
    /// tests don't take 5 real seconds to run.
    #[cfg(test)]
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            timeout,
            ..Self::default()
        }
    }

    pub fn register<T: Tool + 'static>(&mut self, tool: T) {
        let name = tool.name();
        if !self.tools.contains_key(name) {
            self.order.push(name);
        }
        self.tools.insert(name, Arc::new(tool));
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.order
            .iter()
            .filter_map(|n| self.tools.get(n))
            .map(|t| ToolSpec {
                name: t.name().to_string(),
                description: t.description().to_string(),
                schema: t.schema(),
            })
            .collect()
    }

    pub fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// Execute a single tool call. Returns the tool's JSON payload as
    /// a string (ready to round-trip back into the LLM as a `tool`
    /// role message).
    pub async fn invoke(&self, ctx: &ToolCtx, call: &ToolCall) -> Result<String, String> {
        let tool = self
            .find(&call.name)
            .ok_or_else(|| format!("unknown tool: {}", call.name))?;

        let args: Value = if call.args_json.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&call.args_json)
                .map_err(|e| format!("bad args JSON for {}: {e}", call.name))?
        };

        tracing::info!(
            tool = %call.name,
            call_id = %call.id,
            args_sketch = %redact(&args),
            "tool invoke"
        );

        if super::confirm::tool_needs_confirmation(tool.name()) {
            let description = super::confirm::describe_tool(tool.name(), &args);
            let pending = super::confirm::PendingAction::Tool {
                tool: Arc::clone(&tool),
                args,
            };
            return Ok(super::confirm::request(&ctx.state, pending, &description).to_string());
        }

        let timeout = tool.timeout().unwrap_or(self.timeout);
        let work = tool.invoke(ctx, args);
        let result = tokio::time::timeout(timeout, work)
            .await
            .map_err(|_| format!("tool {} timed out after {:?}", call.name, timeout))??;

        Ok(result.to_string())
    }
}

/// Replace string values in an arguments object with a length-only
/// sketch so the audit log never contains free-text bodies
/// (`remember_fact`'s `text`, for instance). Object / array / number
/// / bool values pass through untouched — they're structural.
fn redact(v: &Value) -> String {
    let redacted = redact_value(v);
    redacted.to_string()
}

fn redact_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(format!("<str:{}>", s.chars().count())),
        Value::Array(a) => Value::Array(a.iter().map(redact_value).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), redact_value(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;
    use crate::modules::telegram::repo::TelegramRepo;
    use rusqlite::Connection;
    use serde_json::json;

    struct EchoTool;

    #[async_trait]
    impl Tool for EchoTool {
        fn name(&self) -> &'static str {
            "echo"
        }
        fn description(&self) -> &'static str {
            "Return its input verbatim"
        }
        fn schema(&self) -> Value {
            json!({ "type": "object" })
        }
        async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
            Ok(args)
        }
    }

    struct HangTool;

    #[async_trait]
    impl Tool for HangTool {
        fn name(&self) -> &'static str {
            "hang"
        }
        fn description(&self) -> &'static str {
            "never returns"
        }
        fn schema(&self) -> Value {
            json!({ "type": "object" })
        }
        async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(json!({}))
        }
    }

    fn fresh_state() -> Arc<TelegramState> {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn crate::modules::telegram::keyring::SecretStore> =
            Arc::new(MemStore::new());
        Arc::new(TelegramState::new(repo, secrets))
    }

    fn fake_ctx() -> ToolCtx {
        ToolCtx {
            state: fresh_state(),
            app: None,
            now_ms: 0,
        }
    }

    #[test]
    fn specs_reflect_registered_tools_in_order() {
        let mut reg = ToolRegistry::new();
        reg.register(EchoTool);
        reg.register(HangTool);
        let names: Vec<String> = reg.specs().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["echo".to_string(), "hang".to_string()]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_echo_returns_args_payload() {
        let mut reg = ToolRegistry::new();
        reg.register(EchoTool);
        let ctx = fake_ctx();
        let call = ToolCall {
            id: "c1".into(),
            name: "echo".into(),
            args_json: "{\"hello\":\"world\"}".into(),
            signature: None,
        };
        let out = reg.invoke(&ctx, &call).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hello"], "world");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_unknown_tool_errors() {
        let reg = ToolRegistry::new();
        let ctx = fake_ctx();
        let call = ToolCall {
            id: "c1".into(),
            name: "nope".into(),
            args_json: "{}".into(),
            signature: None,
        };
        assert!(reg
            .invoke(&ctx, &call)
            .await
            .unwrap_err()
            .contains("unknown tool"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_times_out_after_budget() {
        let mut reg = ToolRegistry::with_timeout(Duration::from_millis(50));
        reg.register(HangTool);
        let ctx = fake_ctx();
        let call = ToolCall {
            id: "c1".into(),
            name: "hang".into(),
            args_json: "{}".into(),
            signature: None,
        };
        let res = reg.invoke(&ctx, &call).await;
        assert!(res.unwrap_err().contains("timed out"));
    }

    struct SlowTool;

    #[async_trait]
    impl Tool for SlowTool {
        fn name(&self) -> &'static str {
            "slow"
        }
        fn description(&self) -> &'static str {
            "sleeps past the registry default"
        }
        fn schema(&self) -> Value {
            json!({ "type": "object" })
        }
        async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
            tokio::time::sleep(Duration::from_millis(80)).await;
            Ok(json!({ "done": true }))
        }
        fn timeout(&self) -> Option<Duration> {
            Some(Duration::from_secs(2))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn per_tool_timeout_overrides_registry_default() {
        let mut reg = ToolRegistry::with_timeout(Duration::from_millis(20));
        reg.register(SlowTool);
        let call = ToolCall {
            id: "c1".into(),
            name: "slow".into(),
            args_json: "{}".into(),
            signature: None,
        };
        let out = reg.invoke(&fake_ctx(), &call).await.unwrap();
        assert!(out.contains("\"done\":true"));
    }

    struct FakeDangerous(Arc<std::sync::atomic::AtomicBool>);

    #[async_trait]
    impl Tool for FakeDangerous {
        fn name(&self) -> &'static str {
            "clipboard_clear"
        }
        fn description(&self) -> &'static str {
            "pretends to wipe history"
        }
        fn schema(&self) -> Value {
            json!({ "type": "object" })
        }
        async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(json!({}))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dangerous_tool_is_not_run_without_confirmation() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut reg = ToolRegistry::new();
        reg.register(FakeDangerous(Arc::clone(&ran)));
        let call = ToolCall {
            id: "c1".into(),
            name: "clipboard_clear".into(),
            args_json: "{}".into(),
            signature: None,
        };
        let out = reg.invoke(&fake_ctx(), &call).await.unwrap();
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        // Unpaired state → the LLM is told confirmation isn't possible.
        assert!(out.contains("confirmation_unavailable"), "{out}");
    }

    #[test]
    fn redact_replaces_strings_with_length_sketch() {
        let v = json!({
            "text": "hello, world",
            "count": 3,
            "nested": { "secret": "leak me" }
        });
        let out = redact(&v);
        assert!(!out.contains("hello, world"));
        assert!(!out.contains("leak me"));
        assert!(out.contains("<str:"));
        // Numbers survive untouched so the audit log still shows
        // meaningful structural info.
        assert!(out.contains("\"count\":3"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invoke_handles_empty_args_json_as_empty_object() {
        let mut reg = ToolRegistry::new();
        reg.register(EchoTool);
        let ctx = fake_ctx();
        let call = ToolCall {
            id: "c1".into(),
            name: "echo".into(),
            args_json: "".into(),
            signature: None,
        };
        let out = reg.invoke(&ctx, &call).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.is_object());
    }
}
