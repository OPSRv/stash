# Telegram Bot — Phase 3 Implementation Plan (AI assistant + tools)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task.

**Goal:** Make the Telegram bot chat. Free-text messages (and `/ai <q>`)
route through a Rust-native LLM client that carries a rolling 50-message
history, a user-editable system prompt, an explicit "memory" of facts,
and function-calling tools wired to the rest of the app (reminders,
memory, battery, clipboard, pomodoro, start-download).

**Architecture:** New submodules under
`src-tauri/src/modules/telegram/`:

```
llm/
├── mod.rs         — LlmClient trait + message/tool types
├── openai.rs      — OpenAI-compatible + `custom` provider (same wire)
├── anthropic.rs   — Anthropic Messages API
└── google.rs      — optional, deferred; feature-gated stub
assistant.rs       — orchestration: history + facts + tools → LLM → reply
tools/
├── mod.rs         — Tool trait + ToolRegistry
├── reminders.rs   — create_reminder / list_reminders / cancel_reminder
├── memory.rs      — remember_fact / list_facts / forget_fact
└── stash.rs       — get_battery / get_last_clip / pomodoro_status / start_download
```

Frontend additions under `src/modules/telegram/sections/`:
`MemoryPanel.tsx`, `AiPromptPanel.tsx`. `RemindersPanel` already
rendered via the existing Phase 4 slice — skipped here.

**Design reference:** §3, §4, §5.2, §5.3, §6, §7 of
`docs/plans/2026-04-21-telegram-bot-design.md`. Any deviation must
update the design doc first. Status in §11 flips to ✅ only when all
tasks below ship.

**Source of keys:** LLM API key is **read from `com.stash.ai`**
Keychain service (account = provider name, matching AI module).
Telegram module does not duplicate the key. Provider/model/base URL
are read from the AI module's settings — Telegram inherits the active
config; switching provider in the AI tab immediately applies to the
assistant.

**Tech:** Rust (reqwest with rustls + text() + serde_json per existing
pattern — `json` feature is not compiled in this repo), existing
teloxide sender, rusqlite chat/memory tables (already migrated in
Phase 0). No new crates required.

---

## Conventions

- **TDD mandatory** — failing test first, minimal impl second.
- **Commit after each task** with a scoped message.
- **Rust tests:**
  `cargo test --manifest-path src-tauri/Cargo.toml -p stash-app
   modules::telegram::`
  Use `Connection::open_in_memory()` for DB, `MemStore` for secrets,
  a stub `LlmClient` for assistant orchestration.
- **Frontend tests:** `npm run test -- --run src/modules/telegram/`.
- **Never add Russian (`ru`).**
- **No ad-hoc buttons/inputs** — `src/shared/ui/` only.
- **No invoke in components** — route through `src/modules/telegram/api.ts`.
- **Accent colour:** `rgba(var(--stash-accent-rgb), α)` only.
- **Tool call audit:** every tool invocation logs via
  `tracing::info!(tool=..., args_sketch=...)` with free-text redacted.

---

## Task 0: Settings additions — system_prompt, context_window

Design §4.2 already lists the keys; they're not yet wired.

**Files:**
- Modify: `src-tauri/src/modules/telegram/settings.rs`
- Modify: `src/settings/store.ts`
- Modify: `src/modules/telegram/api.ts`
- Create: `src/modules/telegram/sections/AiPromptPanel.test.tsx`

**Shape:**
```rust
pub struct AiSettings {
    pub system_prompt: String,  // default: a single line, user-editable
    pub context_window: u32,    // default 50, clamp [10, 200]
}
```

Extend `telegram_get_settings` / `telegram_set_settings` to carry
`ai`. Frontend `TelegramSettings` type gains the same field.

**Tests (Rust):** round-trip via `settings.json`; clamp; default.

Commit: `feat(telegram): persisted ai system_prompt + context_window settings`

---

## Task 1: Chat repo ops — append + load_recent + prune

Design §4.3 and §5.2.

**Files:**
- Modify: `src-tauri/src/modules/telegram/repo.rs`

**API:**
```rust
pub struct ChatRow {
    pub id: i64,
    pub role: ChatRole,        // User|Assistant|System|Tool
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub created_at: i64,
}

impl TelegramRepo {
    pub fn chat_insert(&mut self, rows: &[ChatRow]) -> Result<()>;
    pub fn chat_load_recent(&self, limit: usize) -> Result<Vec<ChatRow>>;
    pub fn chat_prune(&mut self, keep: usize) -> Result<usize>;
}
```

Insert a user+assistant pair in a single transaction.

**Tests:** insert/load order; prune keeps newest N; role CHECK
still rejects unknown roles; tool rows round-trip `tool_call_id`.

Commit: `feat(telegram): chat repo — append / load_recent / prune`

---

## Task 2: Memory repo ops — insert / list / delete

**Files:**
- Modify: `src-tauri/src/modules/telegram/repo.rs`

**API:**
```rust
pub fn memory_insert(&mut self, fact: &str) -> Result<i64>;
pub fn memory_list(&self) -> Result<Vec<MemoryRow>>;
pub fn memory_delete(&mut self, id: i64) -> Result<bool>;
```

**Tests:** round-trip; list is newest-first; delete returns false
for unknown ids; trims/rejects empty fact.

Commit: `feat(telegram): memory repo — insert / list / delete`

---

## Task 3: `LlmClient` trait + message/tool types

**Files:**
- Create: `src-tauri/src/modules/telegram/llm/mod.rs`

Types are provider-agnostic; each adapter translates to its wire
format.

```rust
pub enum Role { System, User, Assistant, Tool }

pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    pub tool_call_id: Option<String>,   // for Role::Tool
    pub tool_calls: Vec<ToolCall>,      // for Role::Assistant
}

pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args_json: String,
}

pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,  // JSON Schema for args
}

pub struct LlmRequest {
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub temperature: f32,   // 0.2 default
    pub max_tokens: u32,    // 1024 default
}

pub struct LlmResponse {
    pub text: String,                   // may be empty when only tool_calls
    pub tool_calls: Vec<ToolCall>,
}

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn chat(&self, req: LlmRequest) -> Result<LlmResponse, LlmError>;
}

pub enum LlmError {
    Network(String),
    Auth,          // 401 / 403
    RateLimit,     // 429
    BadResponse(String),
    ToolSchemaRejected(String),
}
```

**Tests:** only trait-level sanity (enum equality, `Default` for
`LlmRequest`). Adapters are tested separately with HTTP stubs.

Commit: `feat(telegram): LlmClient trait + provider-agnostic types`

---

## Task 4: OpenAI-compatible adapter (covers `openai` + `custom`)

**Files:**
- Create: `src-tauri/src/modules/telegram/llm/openai.rs`

Wire to `/v1/chat/completions`. Use existing `reqwest` client; parse
with `text().await` → `serde_json::from_str` (repo convention — the
`json` feature is not compiled in).

```rust
pub struct OpenAiClient {
    http: reqwest::Client,
    base_url: String,   // https://api.openai.com/v1 or custom
    api_key: String,
    model: String,
}

#[async_trait]
impl LlmClient for OpenAiClient { ... }
```

Key points:
- `messages` encoding: system/user/assistant/tool roles map 1:1;
  `tool_calls` on assistant row goes as
  `[{id, type:"function", function:{name, arguments}}]`.
- `tools` encoding: `[{type:"function", function:{name, description,
  parameters:<schema>}}]`.
- Parse response `choices[0].message`: `content` → `text`;
  `tool_calls[].function.{name,arguments}` → `ToolCall`.
- 401/403 → `LlmError::Auth`; 429 → `LlmError::RateLimit`;
  5xx → retry once after 1s then surface `Network`.

**Tests:** use a dev-dep `wiremock` OR drive the
`base_url`-injectable client against a tokio `TcpListener` that
returns a canned JSON body — mirrors the existing `voice` / `whisper`
test patterns. Cases:
- plain text turn (no tool calls)
- tool-call turn (name + args_json parsed)
- 401 → Auth
- 429 → RateLimit
- 500 → retry once → second 500 → Network

Commit: `feat(telegram): OpenAI-compatible LLM client`

---

## Task 5: Anthropic adapter

**Files:**
- Create: `src-tauri/src/modules/telegram/llm/anthropic.rs`

Wire to `/v1/messages`. Headers: `x-api-key`,
`anthropic-version: 2023-06-01`.

Notable differences to handle in translation:
- `system` is a top-level field, not a message.
- Tool results come as `{ role: "user", content: [{ type:
  "tool_result", tool_use_id, content }] }`.
- Assistant tool calls arrive as `{ type: "tool_use", id, name,
  input }` inside `content` blocks — the adapter merges assistant
  text blocks and tool_use blocks into a single `ChatMessage`.

**Tests:** mirror Task 4's five cases, adjusted for wire shape.

Commit: `feat(telegram): Anthropic LLM client`

---

## Task 6: Provider selector

Single factory that reads AI-module settings + secret store and
returns a boxed `LlmClient`.

**Files:**
- Create: `src-tauri/src/modules/telegram/llm/factory.rs`
- Modify: `src-tauri/src/modules/telegram/llm/mod.rs`

```rust
pub fn build_client(
    ai_settings: &AiSettings,                 // from ai::settings reader
    ai_secrets: &dyn SecretStore,             // com.stash.ai
) -> Result<Box<dyn LlmClient>, LlmError>;
```

`AiSettings` reader lives in `ai::settings` — expose a
`read_active_config()` helper (provider enum, model, base_url). No
direct file parsing inside telegram.

**Missing key** → `LlmError::Auth` with message
"Set an API key in Stash → AI". Dispatcher turns that into a bot
reply (Task 11).

**Tests:** provider dispatch + missing-key path via MemStore.

Commit: `feat(telegram): LLM provider factory`

---

## Task 7: Tool trait + registry + JSON schema

**Files:**
- Create: `src-tauri/src/modules/telegram/tools/mod.rs`

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn schema(&self) -> serde_json::Value;
    async fn invoke(&self, ctx: &ToolCtx, args: serde_json::Value)
        -> Result<serde_json::Value, String>;
}

pub struct ToolCtx {
    pub app: tauri::AppHandle,
    pub state: Arc<TelegramState>,
}

#[derive(Default)]
pub struct ToolRegistry { ... }
impl ToolRegistry {
    pub fn register<T: Tool + 'static>(&mut self, tool: T);
    pub fn specs(&self) -> Vec<ToolSpec>;
    pub async fn invoke(&self, ctx: &ToolCtx, call: &ToolCall)
        -> Result<String, String>; // returns JSON-string payload
}
```

Enforces: 5s local-op timeout per call; deserialization errors are
returned as `Err` (LLM self-corrects). Audit log via `tracing::info!`.

**Tests:** schema enumeration; unknown tool name; timeout triggers;
redaction of `text` args in the audit field.

Commit: `feat(telegram): tool trait + registry with audit + timeout`

---

## Task 8: Memory tools — remember / list / forget

**Files:**
- Create: `src-tauri/src/modules/telegram/tools/memory.rs`

Three tools wired to Task 2's repo methods. Each takes/returns JSON
matching design §7.

**Tests:** round-trip through registry with MemStore secrets +
in-memory repo.

Commit: `feat(telegram): memory tools — remember / list / forget`

---

## Task 9: Reminder tools — create / list / cancel

**Files:**
- Create: `src-tauri/src/modules/telegram/tools/reminders.rs`

Wrap the Phase-4 reminders engine. `create_reminder` accepts
`{text, when:iso8601, repeat?:rrule}`; ISO parsing reuses the
Phase-4 parser (`modules::telegram::reminders::parse_absolute`).

**Tests:** create + list + cancel paths against in-memory repo +
mocked current time.

Commit: `feat(telegram): reminder tools reusing Phase-4 engine`

---

## Task 10: Read-only stash tools — battery / clip / pomodoro / start_download

**Files:**
- Create: `src-tauri/src/modules/telegram/tools/stash.rs`

Thin wrappers over the same cross-module commands used by slash
handlers. `start_download` mirrors `/dl` (which was deferred in
Phase 1 — implement here if not already).

**Tests:** each tool's happy path with a stubbed module state
(battery returns a canned percent, clip returns last entry, etc).

Commit: `feat(telegram): read-only stash tools (battery/clip/pomodoro/dl)`

---

## Task 11: Assistant orchestrator

**Files:**
- Create: `src-tauri/src/modules/telegram/assistant.rs`

Responsibilities (design §5.2):

1. `handle(text, chat_id)` — top-level entry.
2. Load last `context_window` rows from `chat`.
3. Prepend `system_prompt` and a synthesized "Known facts:" message
   from `memory_list` (dropped if empty).
4. Append the new user message.
5. Call `LlmClient::chat`.
6. If `tool_calls` present: **for each** execute via `ToolRegistry`
   **concurrently where safe** (tools opt-in via a `is_parallel_safe`
   flag on the `Tool` trait; default `false` so new tools start
   serialized). Append tool-result messages. Loop.
7. Cap **tool-call depth at 5** per user turn (design §13). On cap:
   stop, return "(too many tool steps — simplifying)" plus the last
   assistant text.
8. Persist `user` + final `assistant` rows (+ any intermediate
   tool rows) in one transaction. Prune to `context_window × 4`.
9. Sender enqueue — reuse the existing serial sender.

Timeouts: each LLM call 30s; each tool call 5s (enforced by
registry).

**Tests:** stub `LlmClient` returning canned responses; assert:
- plain reply path writes user + assistant rows.
- tool-call path dispatches, appends tool row, re-queries LLM,
  writes final assistant row.
- depth cap triggers after 5 tool loops.
- prune runs when row count exceeds `context_window × 4`.
- missing key → bot replies with banner; no DB write.

Commit: `feat(telegram): assistant orchestrator with tool loop + prune`

---

## Task 12: Dispatcher wiring — free text and `/ai <q>`

**Files:**
- Modify: `src-tauri/src/modules/telegram/transport.rs` (or wherever
  the text route currently drops incoming updates).
- Modify: `src-tauri/src/modules/telegram/module_cmds.rs`
  (add `AiCmd` handler).

Free text (no leading `/`) → `assistant::handle`. Explicit `/ai <q>`
re-uses the same path but strips the slash. Already-existing voice
→ transcript pipeline feeds the transcript back as "text" to
`assistant::handle` (no new plumbing — Phase 2 already wires
`voice_auto_to_ai`).

**Tests:** transport unit tests gain a "free text routes to
assistant" assertion against a stubbed assistant sink.

Commit: `feat(telegram): dispatcher routes free text + /ai to assistant`

---

## Task 13: `/remember` / `/memory` / `/forget` slash commands

Design §6 lists these. Tools already exist from Task 8 — slash
handlers are thin wrappers over the same tool functions (design §3.3
"Reuse between command and tool").

**Files:**
- Modify: `src-tauri/src/modules/telegram/module_cmds.rs`

**Tests:** roundtrip through registry; `/forget` with bad id
returns "unknown id" (no crash).

Commit: `feat(telegram): /remember /memory /forget slashes sharing tool impl`

---

## Task 14: `MemoryPanel` UI

**Files:**
- Create: `src/modules/telegram/sections/MemoryPanel.tsx`
- Create: `src/modules/telegram/sections/MemoryPanel.test.tsx`
- Modify: `src/modules/telegram/TelegramShell.tsx` (add tab)
- Modify: `src/modules/telegram/api.ts` (`listMemory`, `deleteMemory`)

UX: list of facts with inline "Delete" icon per row; empty state
shows one-line hint ("Tell the bot to `/remember …` to start.").
All controls via `src/shared/ui/`.

**Tests:**
- list renders from mocked `telegram_list_memory`.
- delete button fires `telegram_delete_memory` and the row
  disappears optimistically; on failure the row returns with an
  inline error line.

Commit: `feat(telegram): MemoryPanel — view + delete facts`

---

## Task 15: `AiPromptPanel` UI

**Files:**
- Create: `src/modules/telegram/sections/AiPromptPanel.tsx`
- Create: `src/modules/telegram/sections/AiPromptPanel.test.tsx`
- Modify: `src/modules/telegram/TelegramShell.tsx` (add tab)

UX: editable `Textarea` bound to `telegram.settings.ai.system_prompt`
with a debounced save (500ms). `SliderField` for `context_window`
(10–200, step 10). "Reset to default" button.

**Tests:**
- initial value comes from `telegram_get_settings`.
- editing fires `telegram_set_settings` (debounced — advance fake
  timers).
- reset restores the default.

Commit: `feat(telegram): AiPromptPanel — system prompt + context window`

---

## Task 16: Wire state + registry + help snapshot

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/modules/telegram/state.rs`

Register new command handlers and tool registry inside
`TelegramState` construction. `/help` snapshot refreshes
automatically (existing mechanism).

**Tests:** `enumerate_preserves_insertion_order` gets a new
assertion that new commands appear in the expected order.

Commit: `feat(telegram): wire assistant + tools into lib.rs`

---

## Task 17: Docs — flip Phase 3 to ✅

**Files:**
- Modify: `docs/plans/2026-04-21-telegram-bot-design.md`
  - §11 "Remaining" → "Shipped".
  - §14 "Provider-agnostic AI" — confirm we shipped OpenAI-compatible
    + Anthropic adapters; Google stub is behind a TODO line.
  - §16 build-notes — capture the hard-won details (provider wire
    quirks, 5-depth tool cap rationale, any chrono-free ISO parsing
    choices).

Commit: `docs(telegram): mark Phase 3 shipped + build notes`

---

## Out-of-scope / follow-up backlog

- Google (Gemini) adapter — stubbed out in `llm/google.rs` with a
  `todo!()` and a feature gate; add when a user actually sets Google
  as the provider.
- TTS reply — still in §12 design backlog.
- Auto-fact extraction — backlog.
- Streamed assistant output — MVP sends the final text in one
  `sender.enqueue`; streaming Telegram `editMessageText` deltas is
  nice-to-have for long answers and stays out of this phase.
- Tool-call rate limiting per user minute — not a concern for
  single-user mode; revisit if multi-user lands.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Chatty tool-use loops blow through LLM credits | depth cap = 5 per user turn; audit log surfaces repeats |
| Provider wire-format drift (OpenAI tool schema tweaks) | adapter owns translation; unit tests with canned bodies catch regressions |
| Schema validation rejections cause silent "nothing happened" | tool invoke returns `Err(string)` that the LLM sees as a tool result — self-correcting loop |
| Context window explodes memory table | prune keeps `context_window × 4` rows per design §5.2 |
| Missing AI key discovered mid-conversation | pre-flight check in `assistant::handle`; short, clear reply before any DB write |

---

## Testing surface summary

New Rust test files:
- `repo.rs` — chat + memory ops (extends existing test module)
- `llm/openai.rs` — canned HTTP bodies + five cases
- `llm/anthropic.rs` — canned HTTP bodies + five cases
- `tools/mod.rs` — registry + timeout + audit redaction
- `tools/memory.rs`, `tools/reminders.rs`, `tools/stash.rs` —
  per-tool happy paths + error paths
- `assistant.rs` — stub LLM driving the orchestration state machine

New frontend test files:
- `MemoryPanel.test.tsx` — list / delete
- `AiPromptPanel.test.tsx` — edit + debounce + reset

**Success criteria:** all new tests pass; existing 617 FE tests +
current Rust test count stay green; one end-to-end manual smoke
(paste key in AI tab → Telegram free text → AI reply with tool call
→ memory row visible in MemoryPanel) is recorded in §16 build notes.
