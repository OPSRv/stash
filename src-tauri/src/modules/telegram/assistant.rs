//! AI assistant orchestrator.
//!
//! Takes a user message, loads the rolling chat history and the
//! remembered facts, fans out to the configured `LlmClient`, runs
//! any tool-calls the model requests, and writes the whole turn
//! back into the `chat` table with pruning.
//!
//! The orchestrator owns no provider-specific knowledge — it speaks
//! only the neutral `LlmClient` surface. Swapping between OpenAI and
//! Anthropic is the factory's job.

use std::sync::Arc;

use super::llm::{self, ChatMessage, LlmClient, LlmError, LlmRequest, Role, ToolCall};
use super::repo::{ChatRole, ChatRow, NewChatRow};
use super::settings::AiSettings;
use super::state::TelegramState;
use super::tools::{ToolCtx, ToolRegistry};
use crate::modules::ai::state::AiState;

/// Hard cap on LLM ↔ tool round-trips per user turn. Without this a
/// badly-looping tool ("I don't know, let me list_facts again") can
/// exhaust API credits. Five is generous for any reasonable plan.
pub const MAX_TOOL_DEPTH: usize = 5;

/// History multiplier — we store `context_window × 4` rows so the
/// chat table keeps tool + tool-result interleaves from the most
/// recent turns even when the active window only carries messages
/// the LLM actually saw.
pub const HISTORY_FACTOR: usize = 4;

pub struct Assistant {
    pub state: Arc<TelegramState>,
    /// Optional Tauri handle. Needed only by tools that dispatch
    /// slash-commands (the `invoke_command` tool). Unit tests build an
    /// Assistant without one — tools that require it surface a clear
    /// error when invoked in that mode.
    pub app: Option<tauri::AppHandle>,
    pub client: Box<dyn LlmClient>,
    pub tools: ToolRegistry,
}

/// Outcome of a single `handle` call. The dispatcher turns this into
/// a bot reply via the sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantReply {
    pub text: String,
    /// `true` when we stopped because of the tool-depth cap rather
    /// than the model giving a clean final answer. UI layer can
    /// surface a gentle "(simplified)" marker.
    pub truncated: bool,
}

impl Assistant {
    /// Process one user message. Writes every row (user, assistant,
    /// any intermediate tool rows) to the `chat` table in the same
    /// sequence the LLM saw them.
    pub async fn handle(&self, user_text: &str) -> Result<AssistantReply, LlmError> {
        let ai_settings = AiSettings::load(self.state.as_ref());

        // 1. Load history + facts.
        let history = self
            .state
            .repo
            .lock()
            .map_err(|e| LlmError::BadResponse(e.to_string()))?
            .chat_load_recent(ai_settings.context_window as usize)
            .map_err(|e| LlmError::BadResponse(e.to_string()))?;

        let facts = self
            .state
            .repo
            .lock()
            .map_err(|e| LlmError::BadResponse(e.to_string()))?
            .memory_list()
            .map_err(|e| LlmError::BadResponse(e.to_string()))?;

        // 2. Build message sequence: system → facts → history → user.
        let mut messages: Vec<ChatMessage> = Vec::with_capacity(history.len() + 5);
        messages.push(ChatMessage::system(&ai_settings.system_prompt));
        // Wall-clock context. Without this LLMs default to whatever
        // year sits in their training data and confidently answer
        // "today's date" with stale values. Injected per turn so the
        // first message after midnight already sees the new day.
        messages.push(ChatMessage::system(current_time_prompt()));
        if !facts.is_empty() {
            let joined = facts
                .iter()
                .map(|f| format!("- {}", f.fact))
                .collect::<Vec<_>>()
                .join("\n");
            messages.push(ChatMessage::system(format!("Known facts:\n{joined}")));
        }
        // Expose every registered slash-command so the model can
        // dispatch them via the `invoke_command` tool.
        let commands_text = list_commands_for_prompt(&self.state);
        if !commands_text.is_empty() {
            messages.push(ChatMessage::system(commands_text));
        }
        // Inject a terse recap of the most recent inbox items so the
        // assistant can reference them ("що я надсилав учора?",
        // "summarise those voice notes").
        let inbox_text = recent_inbox_for_prompt(&self.state);
        if !inbox_text.is_empty() {
            messages.push(ChatMessage::system(inbox_text));
        }
        // History replay strips tool-call / tool-response traces on
        // purpose. Gemini requires every `functionCall` to be followed
        // immediately by its `functionResponse`, and SQLite pruning
        // (context_window × HISTORY_FACTOR) can cut the pair in half,
        // yielding 400 "function response turn must come immediately
        // after a function call turn". The current turn still gets
        // live tool-calling; history keeps only the textual reply, so
        // the model sees *what* it decided without the dangling call.
        for row in &history {
            if let Some(m) = history_to_message(row) {
                messages.push(m);
            }
        }
        messages.push(ChatMessage::user(user_text));

        // 3. Turn loop.
        let mut new_rows: Vec<NewChatRow> = Vec::new();
        new_rows.push(NewChatRow {
            role: ChatRole::User,
            content: user_text.to_string(),
            tool_call_id: None,
            tool_name: None,
            created_at: self.now_ms(),
        });

        let mut depth = 0usize;
        let tools_spec = self.tools.specs();
        let mut truncated = false;
        let final_text: String = loop {
            let req = LlmRequest {
                messages: messages.clone(),
                tools: tools_spec.clone(),
                ..Default::default()
            };
            let resp = self.client.chat(req).await?;

            // Record the assistant turn — even tool-call-only turns
            // land as assistant rows so chat_load_recent can replay
            // them on the next call.
            let assistant_content = resp.text.clone();
            let tool_calls = resp.tool_calls.clone();
            let assistant_msg = ChatMessage {
                role: Role::Assistant,
                content: assistant_content.clone(),
                tool_call_id: None,
                tool_calls: tool_calls.clone(),
            };
            messages.push(assistant_msg);
            new_rows.push(NewChatRow {
                role: ChatRole::Assistant,
                content: encode_assistant_row(&assistant_content, &tool_calls),
                tool_call_id: None,
                tool_name: None,
                created_at: self.now_ms(),
            });

            if tool_calls.is_empty() {
                break assistant_content;
            }

            if depth >= MAX_TOOL_DEPTH {
                truncated = true;
                // Serve whatever text the model did produce; if none,
                // a plain cap notice is better than silence.
                break if assistant_content.trim().is_empty() {
                    "(Too many tool steps — simplifying.)".to_string()
                } else {
                    assistant_content
                };
            }
            depth += 1;

            // 4. Dispatch tool calls and append results.
            let ctx = self.tool_ctx();
            for call in tool_calls {
                let result = match self.tools.invoke(&ctx, &call).await {
                    Ok(payload) => payload,
                    Err(e) => format!(
                        "{{\"error\":{}}}",
                        serde_json::to_string(&e).unwrap_or_else(|_| "\"tool error\"".into())
                    ),
                };
                messages.push(ChatMessage::tool(call.id.clone(), result.clone()));
                new_rows.push(NewChatRow {
                    role: ChatRole::Tool,
                    content: result,
                    tool_call_id: Some(call.id),
                    tool_name: Some(call.name),
                    created_at: self.now_ms(),
                });
            }
        };

        // 5. Persist + prune.
        {
            let mut repo = self
                .state
                .repo
                .lock()
                .map_err(|e| LlmError::BadResponse(e.to_string()))?;
            repo.chat_insert(&new_rows)
                .map_err(|e| LlmError::BadResponse(e.to_string()))?;
            let keep = (ai_settings.context_window as usize).saturating_mul(HISTORY_FACTOR);
            let _ = repo.chat_prune(keep);
        }

        Ok(AssistantReply {
            text: final_text,
            truncated,
        })
    }

    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn tool_ctx(&self) -> ToolCtx {
        ToolCtx {
            state: Arc::clone(&self.state),
            app: self.app.clone(),
            now_ms: self.now_ms(),
        }
    }
}

/// Build a system line with the current local date / time so the
/// model can answer "сьогодні / завтра / котра година" without making
/// up a date from its training cut-off. Format mirrors what users
/// expect from a chat assistant: ISO date, weekday, 24-hour clock,
/// timezone offset. Pulled from `inbox::today_str` + a tiny clock
/// helper so we don't add a chrono dependency.
fn current_time_prompt() -> String {
    use super::inbox::{local_offset_seconds_public, today_str};
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let offset = local_offset_seconds_public();
    let local = now_secs + offset;
    let date = today_str(now_secs);
    let secs_in_day = local.rem_euclid(86_400);
    let hh = secs_in_day / 3600;
    let mm = (secs_in_day % 3600) / 60;
    let weekday = WEEKDAYS[((local.div_euclid(86_400)) + 4).rem_euclid(7) as usize];
    let sign = if offset >= 0 { '+' } else { '-' };
    let off_h = offset.abs() / 3600;
    let off_m = (offset.abs() % 3600) / 60;
    format!(
        "Current local time: {date} {hh:02}:{mm:02} ({weekday}, UTC{sign}{off_h:02}:{off_m:02}). \
         Use this when the user asks about today, tomorrow, current date, weekday, etc."
    )
}

/// 1970-01-01 was a Thursday. Indexing matches `(days + 4) mod 7`
/// where Sunday = 0 — the offset turns the Thursday epoch into the
/// canonical week-start used by `chrono::Weekday::num_days_from_sunday`.
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Produce a short catalog of registered slash-commands so the model
/// knows what it can dispatch through the `invoke_command` tool. The
/// registry is the single source of truth — adding a new command in
/// `lib.rs` surfaces to the AI with no extra wiring.
fn list_commands_for_prompt(state: &TelegramState) -> String {
    let reg = match state.commands.read() {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let handlers = reg.enumerate();
    if handlers.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "Available Stash commands (dispatch with the `invoke_command` tool, \
         arguments passed as a single free-text string):\n",
    );
    for h in handlers {
        out.push_str(&format!(
            "- {} — {} ({})\n",
            h.name(),
            h.description(),
            h.usage()
        ));
    }
    out.trim_end().to_string()
}

/// Summarise the last few inbox items as a system message. Helps the
/// assistant answer "what did I send yesterday?" or summarise without
/// forcing the user to re-paste the content. Limited to six rows to
/// keep the context footprint small.
fn recent_inbox_for_prompt(state: &TelegramState) -> String {
    let repo = match state.repo.lock() {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let Ok(items) = repo.list_inbox(6) else {
        return String::new();
    };
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "Recent Telegram inbox (newest first — may help ground follow-up questions):\n",
    );
    for it in items {
        let summary = it
            .text_content
            .as_deref()
            .or(it.transcript.as_deref())
            .or(it.caption.as_deref())
            .unwrap_or("[attachment only]");
        // Cap per-line length so a pasted essay doesn't dominate the
        // prompt — the model can always scroll via /summarize.
        let short: String = summary.chars().take(200).collect();
        let ellipsis = if summary.chars().count() > 200 {
            "…"
        } else {
            ""
        };
        out.push_str(&format!("- [{}] {short}{ellipsis}\n", it.kind));
    }
    out.trim_end().to_string()
}

/// Serialize an assistant row for the chat table. Plain text replies
/// store only their text; tool-call turns also embed the call list as
/// a compact JSON tail so `history_to_message` can faithfully replay
/// them on the next LLM call.
fn encode_assistant_row(text: &str, calls: &[ToolCall]) -> String {
    if calls.is_empty() {
        return text.to_string();
    }
    let calls_json: Vec<serde_json::Value> = calls
        .iter()
        .map(|c| {
            let mut obj = serde_json::json!({
                "id": c.id,
                "name": c.name,
                "args": c.args_json,
            });
            if let Some(sig) = &c.signature {
                obj["sig"] = serde_json::Value::String(sig.clone());
            }
            obj
        })
        .collect();
    let envelope = serde_json::json!({
        "text": text,
        "tool_calls": calls_json,
    });
    format!("__tool_turn__{envelope}")
}

fn decode_assistant_row(content: &str) -> (String, Vec<ToolCall>) {
    if let Some(rest) = content.strip_prefix("__tool_turn__") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
            let text = v
                .get("text")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let calls: Vec<ToolCall> = v
                .get("tool_calls")
                .and_then(|a| a.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            Some(ToolCall {
                                id: c.get("id")?.as_str()?.to_string(),
                                name: c.get("name")?.as_str()?.to_string(),
                                args_json: c.get("args")?.as_str()?.to_string(),
                                signature: c
                                    .get("sig")
                                    .and_then(|s| s.as_str())
                                    .map(str::to_string),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            return (text, calls);
        }
    }
    (content.to_string(), Vec::new())
}

/// Build a live `Assistant` from the running app's managed state.
///
/// Reads provider/model/base_url from `settings.json` and the API key
/// from the AI module's Keychain store, then registers every tool the
/// runtime knows about. Any failure on the way (missing key, missing
/// managed state) surfaces as `LlmError` so the dispatcher can turn
/// it into a clear bot reply.
pub fn build_runtime_assistant(
    app: &tauri::AppHandle,
    state: &Arc<TelegramState>,
) -> Result<Assistant, LlmError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| LlmError::BadResponse(format!("app_data_dir: {e}")))?;
    let cfg = llm::factory::read_config(&data_dir.join("settings.json"))?;

    let ai_state = app
        .try_state::<AiState>()
        .ok_or_else(|| LlmError::BadResponse("AI module state is not initialised".into()))?;
    let client = llm::factory::build_client(&cfg, &ai_state.secrets)?;

    let mut tools = ToolRegistry::new();
    tools.register(super::tools::memory::RememberFact);
    tools.register(super::tools::memory::ListFacts);
    tools.register(super::tools::memory::ForgetFact);
    tools.register(super::tools::reminders::CreateReminder);
    tools.register(super::tools::reminders::ListReminders);
    tools.register(super::tools::reminders::CancelReminder);
    tools.register(super::tools::stash::GetBattery);
    tools.register(super::tools::stash::MetronomeControl);
    tools.register(super::tools::stash::MusicControl);
    tools.register(super::tools::stash::VolumeControl);
    tools.register(super::tools::stash::SaveNote);
    tools.register(super::tools::stash::ListNotes);
    tools.register(super::tools::stash::NavigateTab);
    tools.register(super::tools::stash::InvokeCommand);
    if let Some(clip) = app.try_state::<Arc<crate::modules::clipboard::commands::ClipboardState>>()
    {
        tools.register(super::tools::stash::GetLastClip::new(clip.inner().clone()));
    }
    if let Some(pomo) = app.try_state::<Arc<crate::modules::pomodoro::state::PomodoroState>>() {
        tools.register(super::tools::stash::PomodoroStatus::new(
            pomo.inner().clone(),
        ));
        tools.register(super::tools::stash::PomodoroStart::new(
            pomo.inner().clone(),
        ));
        tools.register(super::tools::stash::PomodoroStop::new(pomo.inner().clone()));
        tools.register(super::tools::stash::PomodoroSavePreset::new(
            pomo.inner().clone(),
        ));
    }

    Ok(Assistant {
        state: Arc::clone(state),
        app: Some(app.clone()),
        client,
        tools,
    })
}

/// Convenience entry point the dispatcher calls on every free-text
/// message (and on /ai). Builds the assistant fresh so provider
/// changes in Settings take effect on the next message without any
/// explicit refresh step.
pub async fn handle_user_text(
    app: &tauri::AppHandle,
    state: &Arc<TelegramState>,
    text: &str,
) -> Result<AssistantReply, LlmError> {
    let assistant = build_runtime_assistant(app, state)?;
    assistant.handle(text).await
}

fn history_to_message(row: &ChatRow) -> Option<ChatMessage> {
    match row.role {
        ChatRole::User => Some(ChatMessage::user(&row.content)),
        ChatRole::Assistant => {
            // Drop the tool-call envelope and keep the textual body.
            // If a historical assistant turn was *tool-call only*
            // (empty text), we skip it entirely — there's nothing
            // useful to replay without the paired tool response.
            let (text, _calls) = decode_assistant_row(&row.content);
            if text.trim().is_empty() {
                None
            } else {
                Some(ChatMessage {
                    role: Role::Assistant,
                    content: text,
                    tool_call_id: None,
                    tool_calls: Vec::new(),
                })
            }
        }
        ChatRole::System => Some(ChatMessage::system(&row.content)),
        // Tool responses only make sense next to their originating
        // call; since we strip the calls, the responses are dropped
        // too — symmetric, and avoids a dangling tool turn.
        ChatRole::Tool => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::{MemStore, SecretStore};
    use crate::modules::telegram::llm::LlmResponse;
    use crate::modules::telegram::repo::TelegramRepo;
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::sync::Mutex;

    /// Stub LlmClient with a queue of scripted responses. Each
    /// `chat` call pops one entry; tests pre-seed the queue with the
    /// sequence they want to drive.
    struct ScriptedClient {
        responses: Mutex<Vec<Result<LlmResponse, LlmError>>>,
        calls: Mutex<Vec<LlmRequest>>,
    }

    impl ScriptedClient {
        fn new(responses: Vec<Result<LlmResponse, LlmError>>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl LlmClient for ScriptedClient {
        async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
            self.calls.lock().unwrap().push(req);
            let r = self
                .responses
                .lock()
                .unwrap()
                .drain(..1)
                .next()
                .expect("no scripted response left");
            r
        }
    }

    fn fresh_state() -> Arc<TelegramState> {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn SecretStore> = Arc::new(MemStore::new());
        Arc::new(TelegramState::new(repo, secrets))
    }

    fn plain_reply(text: &str) -> LlmResponse {
        LlmResponse {
            text: text.to_string(),
            tool_calls: Vec::new(),
        }
    }

    fn tool_reply(call_id: &str, name: &str, args: &str) -> LlmResponse {
        LlmResponse {
            text: String::new(),
            tool_calls: vec![ToolCall {
                id: call_id.into(),
                name: name.into(),
                args_json: args.into(),
                signature: None,
            }],
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn plain_reply_persists_user_and_assistant_rows() {
        let state = fresh_state();
        let client = ScriptedClient::new(vec![Ok(plain_reply("hi there"))]);
        let assistant = Assistant {
            state: Arc::clone(&state),
            app: None,
            client: Box::new(client),
            tools: ToolRegistry::new(),
        };
        let reply = assistant.handle("hello").await.unwrap();
        assert_eq!(reply.text, "hi there");
        assert!(!reply.truncated);
        let rows = state.repo.lock().unwrap().chat_load_recent(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role, ChatRole::User);
        assert_eq!(rows[0].content, "hello");
        assert_eq!(rows[1].role, ChatRole::Assistant);
        assert_eq!(rows[1].content, "hi there");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tool_call_is_dispatched_and_result_feeds_next_turn() {
        let state = fresh_state();
        // Seed a memory fact so list_facts has something to return.
        state
            .repo
            .lock()
            .unwrap()
            .memory_insert("likes tea", 1)
            .unwrap();

        let client = ScriptedClient::new(vec![
            Ok(tool_reply("c1", "list_facts", "{}")),
            Ok(plain_reply("You like tea.")),
        ]);

        let mut tools = ToolRegistry::new();
        tools.register(crate::modules::telegram::tools::memory::ListFacts);

        let assistant = Assistant {
            state: Arc::clone(&state),
            app: None,
            client: Box::new(client),
            tools,
        };

        let reply = assistant
            .handle("what do you know about me?")
            .await
            .unwrap();
        assert_eq!(reply.text, "You like tea.");
        let rows = state.repo.lock().unwrap().chat_load_recent(10).unwrap();
        // user + assistant(tool call) + tool + assistant(final)
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].role, ChatRole::User);
        assert_eq!(rows[1].role, ChatRole::Assistant);
        assert_eq!(rows[2].role, ChatRole::Tool);
        assert_eq!(rows[2].tool_name.as_deref(), Some("list_facts"));
        assert_eq!(rows[3].role, ChatRole::Assistant);
        assert_eq!(rows[3].content, "You like tea.");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn depth_cap_stops_runaway_tool_loops() {
        let state = fresh_state();
        // Eight consecutive tool turns — more than MAX_TOOL_DEPTH
        // allows.
        let mut queue: Vec<Result<LlmResponse, LlmError>> = (0..8)
            .map(|_| Ok(tool_reply("cx", "list_facts", "{}")))
            .collect();
        // Final never-reached answer.
        queue.push(Ok(plain_reply("late answer")));
        let client = ScriptedClient::new(queue);

        let mut tools = ToolRegistry::new();
        tools.register(crate::modules::telegram::tools::memory::ListFacts);

        let assistant = Assistant {
            state: Arc::clone(&state),
            app: None,
            client: Box::new(client),
            tools,
        };
        let reply = assistant.handle("loop please").await.unwrap();
        assert!(reply.truncated);
        // The cap fires *after* MAX_TOOL_DEPTH loops produced tool
        // rows; we break on the next tool-call turn without
        // executing its tools.
        let rows = state.repo.lock().unwrap().chat_load_recent(100).unwrap();
        let tool_rows = rows.iter().filter(|r| r.role == ChatRole::Tool).count();
        assert_eq!(tool_rows, MAX_TOOL_DEPTH);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn prune_keeps_history_under_cap() {
        let state = fresh_state();
        // Shrink the window so the test isn't dominated by fixture
        // rows. AiSettings::save persists through the repo so the
        // orchestrator will pick it up.
        AiSettings {
            system_prompt: "p".into(),
            context_window: 10,
            diarization_enabled: false,
        }
        .save(state.as_ref())
        .unwrap();
        // Pre-seed 100 rows.
        let rows: Vec<NewChatRow> = (0..100)
            .map(|i| NewChatRow {
                role: if i % 2 == 0 {
                    ChatRole::User
                } else {
                    ChatRole::Assistant
                },
                content: format!("m{i}"),
                tool_call_id: None,
                tool_name: None,
                created_at: i,
            })
            .collect();
        state.repo.lock().unwrap().chat_insert(&rows).unwrap();

        let client = ScriptedClient::new(vec![Ok(plain_reply("ok"))]);
        let assistant = Assistant {
            state: Arc::clone(&state),
            app: None,
            client: Box::new(client),
            tools: ToolRegistry::new(),
        };
        assistant.handle("next").await.unwrap();
        let remaining = state.repo.lock().unwrap().chat_load_recent(1000).unwrap();
        // Window 10 × HISTORY_FACTOR = 40 rows kept.
        assert_eq!(remaining.len(), 10 * HISTORY_FACTOR);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn system_prompt_and_facts_are_injected() {
        let state = fresh_state();
        AiSettings {
            system_prompt: "be brief".into(),
            context_window: 50,
            diarization_enabled: false,
        }
        .save(state.as_ref())
        .unwrap();
        state
            .repo
            .lock()
            .unwrap()
            .memory_insert("likes tea", 1)
            .unwrap();

        let inner = ScriptedClient::new(vec![Ok(plain_reply("ok"))]);
        let calls = Arc::new(Mutex::new(Vec::<LlmRequest>::new()));
        struct CapturingClient {
            inner: ScriptedClient,
            tap: Arc<Mutex<Vec<LlmRequest>>>,
        }
        #[async_trait]
        impl LlmClient for CapturingClient {
            async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError> {
                self.tap.lock().unwrap().push(req.clone());
                self.inner.chat(req).await
            }
        }
        let capturing = CapturingClient {
            inner,
            tap: Arc::clone(&calls),
        };
        let assistant = Assistant {
            state: Arc::clone(&state),
            app: None,
            client: Box::new(capturing),
            tools: ToolRegistry::new(),
        };
        assistant.handle("hello").await.unwrap();
        let observed = calls.lock().unwrap().clone();
        assert_eq!(observed.len(), 1);
        let msgs = &observed[0].messages;
        assert_eq!(msgs[0].role, Role::System);
        assert_eq!(msgs[0].content, "be brief");
        assert_eq!(msgs[1].role, Role::System);
        assert!(
            msgs[1].content.contains("Current local time"),
            "second system message should be the wall-clock context"
        );
        assert_eq!(msgs[2].role, Role::System);
        assert!(msgs[2].content.contains("likes tea"));
        assert_eq!(msgs.last().unwrap().role, Role::User);
        assert_eq!(msgs.last().unwrap().content, "hello");
    }

    #[test]
    fn encode_decode_assistant_row_round_trip() {
        let calls = vec![ToolCall {
            id: "c1".into(),
            name: "list_facts".into(),
            args_json: "{}".into(),
            signature: None,
        }];
        let encoded = encode_assistant_row("picking", &calls);
        let (text, decoded) = decode_assistant_row(&encoded);
        assert_eq!(text, "picking");
        assert_eq!(decoded, calls);
        // Plain text bypasses the envelope.
        assert_eq!(encode_assistant_row("hi", &[]), "hi");
        assert_eq!(decode_assistant_row("hi"), ("hi".to_string(), vec![]));

        // Gemini thoughtSignature survives round-trip so the next LLM
        // request can echo it back on the functionCall part.
        let calls_sig = vec![ToolCall {
            id: "c1".into(),
            name: "note".into(),
            args_json: "{}".into(),
            signature: Some("opaque-sig".into()),
        }];
        let (_, decoded_sig) = decode_assistant_row(&encode_assistant_row("", &calls_sig));
        assert_eq!(decoded_sig[0].signature.as_deref(), Some("opaque-sig"));
    }

    #[test]
    fn history_replay_strips_tool_calls_and_drops_tool_rows() {
        let assistant_with_call = ChatRow {
            id: 1,
            role: ChatRole::Assistant,
            content: encode_assistant_row(
                "let me check",
                &[ToolCall {
                    id: "c1".into(),
                    name: "get_battery".into(),
                    args_json: "{}".into(),
                    signature: None,
                }],
            ),
            tool_call_id: None,
            tool_name: None,
            created_at: 1,
        };
        let tool_row = ChatRow {
            id: 2,
            role: ChatRole::Tool,
            content: "{}".into(),
            tool_call_id: Some("c1".into()),
            tool_name: Some("get_battery".into()),
            created_at: 2,
        };
        let user_row = ChatRow {
            id: 3,
            role: ChatRole::User,
            content: "hi".into(),
            tool_call_id: None,
            tool_name: None,
            created_at: 3,
        };
        // Assistant keeps text, no tool_calls. Tool row is dropped.
        let a = history_to_message(&assistant_with_call).unwrap();
        assert_eq!(a.role, Role::Assistant);
        assert_eq!(a.content, "let me check");
        assert!(a.tool_calls.is_empty());
        assert!(history_to_message(&tool_row).is_none());
        assert!(history_to_message(&user_row).is_some());
    }

    #[test]
    fn history_replay_drops_empty_tool_only_assistant_turns() {
        // Pure tool-call assistant turn (no text) has nothing to
        // replay without its tool response — skip entirely.
        let row = ChatRow {
            id: 1,
            role: ChatRole::Assistant,
            content: encode_assistant_row(
                "",
                &[ToolCall {
                    id: "c1".into(),
                    name: "x".into(),
                    args_json: "{}".into(),
                    signature: None,
                }],
            ),
            tool_call_id: None,
            tool_name: None,
            created_at: 1,
        };
        assert!(history_to_message(&row).is_none());
    }
}
