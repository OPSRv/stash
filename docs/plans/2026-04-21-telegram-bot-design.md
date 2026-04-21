# Telegram Bot + CLI — Design

**Date:** 2026-04-21 (updated 2026-04-22 after Phase 0–2, 4–6 shipped)
**Status:** Live — Phases 0, 1, 2, 4, 5 complete; Phase 6 shipped via
AppleScript (EventKit-direct bridge deferred); Phases 3 (AI assistant)
and 7 (CLI) remain.

## 1. Goals

Single-user Telegram bot that acts as a remote control and companion for Stash:

- **Inbound (Telegram → app):** text, voice (auto-transcribed), photos, files; slash commands; free-text chat with an AI assistant that has tools and memory.
- **Outbound (app → Telegram):** reminders, calendar events (EventKit), battery, pomodoro, download completion; toggleable per event.
- **AI chat:** 50-message rolling context; user-editable system prompt; explicit `/remember` facts persisted in SQLite; tool-use for reminders, memory, and Stash actions.

### Non-goals (explicit)

- Multi-user / multi-chat support. One `chat_id` only, enforced by allowlist.
- Public webhook endpoint. Long polling only (no inbound port, no DNS).
- TTS voice replies in MVP — architectural hook only (trait stub).
- Google Calendar / Apple Reminders **write** integration. Post-MVP.
- Google Drive upload of Inbox files. Post-MVP.
- `/terminal` and `/music` commands. Excluded from MVP for safety/UX reasons.

## 2. Guiding principles

**Speed.** Rust-side LLM client (no IPC round-trips, no webview dependency). Whisper runs in a dedicated blocking task. SQLite writes batched where possible. Outbound sender is a single serial tokio task that respects Telegram rate limits (1 msg/s per chat).

**Convenience.** One place to enter the API key (existing AI tab — Telegram inherits). Free-text messages go to the AI assistant without users needing to remember commands. Slash commands are shortcuts, not the primary UX. Voice in → text to AI by default.

**Security.**
- Bot token + `chat_id` in macOS Keychain (`keyring` crate, service `com.stash.telegram`). Never in `settings.json`, never in logs.
- Every inbound update filtered by `chat_id` allowlist before any dispatch. Unknown senders receive no response (silent drop) to avoid confirming token validity.
- `/pair` is the **only** command accepted when unpaired, for a **5-minute window**, matched against a **6-digit code generated inside the app**.
- File downloads from Telegram capped: max 20 MB per file, max 50 MB/day cumulative (single-user, but still bounded). Configurable.
- Tool-use calls audited — every tool execution logged to `tracing` with a redacted argument snapshot.
- No secrets ever interpolated into log lines. No `chat_id` in logs beyond low cardinality counters.

## 3. Module architecture

Per existing Stash pattern: `src/modules/telegram/` (React) + `src-tauri/src/modules/telegram/` (Rust). Registered in `src/modules/registry.ts` and `src-tauri/src/lib.rs` `invoke_handler!`.

### 3.1 Rust layers

```
src-tauri/src/modules/telegram/
├── mod.rs                 — module glue
├── state.rs               — TelegramState (Arc<Mutex<…>>), connection status
├── keyring.rs             — token + chat_id read/write (keyring crate)
├── repo.rs                — rusqlite wrappers for the 4 tables below
├── backup.rs              — backup/restore hook (existing pattern)
├── commands.rs            — #[tauri::command]s exposed to frontend
│
├── transport.rs           — teloxide long-polling driver (tokio task)
├── dispatcher.rs          — route update → command handler OR AI
├── sender.rs              — serial outbound queue (rate-limited)
├── pairing.rs             — code generation, state machine
│
├── commands_registry.rs   — CommandRegistry trait + default handlers
├── inbox.rs               — file download, persistence, routing
├── voice.rs               — whisper-rs bridge (blocking_task)
│
├── llm/
│   ├── mod.rs             — LlmClient trait (provider-agnostic)
│   └── <providers>.rs     — one file per provider shape the `ai` module
│                           already supports (OpenAI-compatible, Anthropic,
│                           whatever else). New providers are added in the
│                           `ai` module and the Telegram assistant inherits.
├── assistant.rs           — orchestrates chat: load history + facts + tools → LLM
├── tools/
│   ├── mod.rs             — Tool trait + registry
│   ├── reminders.rs       — create / list / cancel
│   ├── memory.rs          — remember / list / forget
│   └── stash.rs           — battery, clipboard-peek, pomodoro, etc. (read-only or confirmed)
│
├── reminders.rs           — tokio interval ticker + RRULE handling
├── notifier.rs            — TelegramNotifier shared sink
└── calendar.rs            — EventKit bridge (objc2-event-kit) + 10-min lookahead tick
```

### 3.2 Frontend

```
src/modules/telegram/
├── index.tsx              — ModuleDefinition; React.lazy → TelegramShell
├── TelegramShell.tsx      — sub-tab router
├── api.ts                 — invoke wrappers (no direct invoke in components)
├── hooks.ts               — useTelegramStatus, useInbox, useReminders, useMemory
│
├── sections/
│   ├── ConnectionPanel.tsx     — token paste, pair flow, status
│   ├── InboxPanel.tsx          — list with routing buttons
│   ├── RemindersPanel.tsx      — view/cancel
│   ├── MemoryPanel.tsx         — view/delete facts
│   ├── NotificationsPanel.tsx  — toggle matrix
│   ├── AiPromptPanel.tsx       — editable system prompt
│   └── AdvancedPanel.tsx       — voice auto, context window, cleanup, rate limits
│
└── *.test.tsx             — colocated unit tests (Vitest + RTL)
```

All UI routed through `src/shared/ui/` primitives per CLAUDE.md (no ad-hoc buttons). Accent colour via `rgba(var(--stash-accent-rgb), α)`. No `ru` in any locale list.

### 3.3 Extensibility — adding a command / tool must be a one-liner

**New slash command:** implement `CommandHandler` and register in one place.

```rust
// src-tauri/src/modules/telegram/commands_registry.rs
pub trait CommandHandler: Send + Sync {
    fn name(&self) -> &'static str;         // "battery"
    fn description(&self) -> &'static str;  // shown in /help
    fn usage(&self) -> &'static str;        // "/battery"
    async fn handle(&self, ctx: &Ctx, args: &str) -> Result<Reply>;
}

// Registration — the ONLY place you touch when adding a command:
pub fn default_registry(state: &TelegramState) -> CommandRegistry {
    let mut r = CommandRegistry::new();
    r.register(HelpCmd);
    r.register(StatusCmd);
    r.register(BatteryCmd);
    r.register(ClipCmd::new(state.clipboard.clone()));
    r.register(NoteCmd::new(state.notes.clone()));
    // …add one line here for a new command
    r
}
```

`/help` auto-enumerates registered handlers — no separate list to keep in sync.

**New AI tool:** same pattern on the tool side.

```rust
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn schema(&self) -> serde_json::Value;   // JSON Schema for function-calling
    async fn invoke(&self, ctx: &Ctx, args: serde_json::Value) -> Result<serde_json::Value>;
}

pub fn default_tools(state: &TelegramState) -> ToolRegistry {
    let mut r = ToolRegistry::new();
    r.register(CreateReminder::new(state.reminders.clone()));
    r.register(RememberFact::new(state.memory.clone()));
    r.register(GetBattery);
    // …add one line here for a new tool
    r
}
```

**Reuse between command and tool:** where a slash command and an AI tool do the same thing (e.g. `/battery` and `get_battery`), the slash handler is a thin wrapper over the tool function. Single source of truth for the actual work.

### 3.4 Communication

- **Frontend → Rust:** via `api.ts` → `invoke('telegram_<action>', …)`. Commands: `telegram_set_token`, `telegram_clear_token`, `telegram_start_pairing`, `telegram_cancel_pairing`, `telegram_status`, `telegram_list_inbox`, `telegram_route_inbox_item`, `telegram_delete_inbox_item`, `telegram_list_reminders`, `telegram_cancel_reminder`, `telegram_list_memory`, `telegram_delete_memory`, `telegram_get_settings`, `telegram_set_settings`.
- **Rust → Frontend:** `telegram:status_changed`, `telegram:inbox_added`, `telegram:paired`, `telegram:error`.

## 4. Data & storage

### 4.1 Keychain

- `service = "com.stash.telegram"`, account `bot_token` — Telegram Bot API token.
- `service = "com.stash.telegram"`, account `chat_id` — paired user's chat id (i64 as string).
- `service = "com.stash.ai"` — **read-only** from the telegram module; the LLM API key is owned and managed by the existing `ai` module. The Telegram assistant reads it via the shared `SecretStore` trait. This keeps "one place to set the key" (AI tab). If no key is set there, the Telegram assistant replies with a banner "Set an API key in Stash → AI".

### 4.2 settings.json keys (non-secret)

```jsonc
{
  "telegram": {
    "enabled": false,
    "system_prompt": "You are a helpful assistant for Oleksandr inside Telegram…",
    "voice_auto_to_ai": true,
    "context_window": 50,
    "calendar_lead_minutes": 10,
    "battery_threshold": 20,
    "inbox_retention_days": 30,
    "notifications": {
      "calendar": true,
      "reminders": true,
      "battery_low": true,
      "pomodoro": true,
      "downloads": true
    },
    // LLM provider + model are NOT stored here — they are read from the
    // existing `ai` module's settings (single source of truth). Any provider
    // the AI module supports works for the Telegram assistant automatically.
    // last_update_id lives in telegram.sqlite kv table, NOT here
  }
}
```

### 4.3 SQLite — dedicated `telegram.sqlite`

Consistent with each module owning its own DB (ai.sqlite, notes.sqlite, pomodoro.sqlite …).

```sql
CREATE TABLE chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_recent ON chat(created_at DESC);

-- Singleton key-value (update_id for resume, misc hot-path counters). Kept in
-- SQLite instead of settings.json to avoid writing the settings file on every
-- incoming Telegram update.
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- known keys: 'last_update_id'

CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  repeat_rule TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(due_at) WHERE sent=0 AND cancelled=0;

CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_message_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','voice','photo','document','video','sticker')),
  text_content TEXT,
  file_path TEXT,          -- relative to inbox_dir
  mime_type TEXT,
  duration_sec INTEGER,
  transcript TEXT,
  caption TEXT,
  received_at INTEGER NOT NULL,
  routed_to TEXT
);
CREATE INDEX idx_inbox_recent ON inbox(received_at DESC);
```

### 4.4 Filesystem

`<AppData>/telegram/inbox/{yyyy-mm-dd}/{uuid}.{ext}` — one level of date partitioning keeps `ls` fast even after months of messages. Cleanup task on startup removes files older than `inbox_retention_days`.

## 5. Key data flows

### 5.0 Dispatcher decision table

For every incoming update, the dispatcher decides what to do based on auth state and message shape. Anything not in this table is silently dropped.

| State          | `/pair <code>`            | other `/cmd`                     | free text / voice / file                |
|----------------|---------------------------|----------------------------------|-----------------------------------------|
| Unconfigured   | — (no polling yet)        | —                                | —                                       |
| Pairing        | validate → Paired / NACK  | silent drop                      | silent drop                             |
| Paired (match) | reply "already paired"    | dispatch to CommandRegistry      | assistant.handle / inbox ingest         |
| Paired (other) | silent drop               | silent drop                      | silent drop                             |

"Paired (other)" = update's chat_id doesn't match stored allowlist — we never leak information to the wrong chat.

Re-pairing: user clicks "Unpair" in UI → chat_id cleared from Keychain → state goes to Unconfigured (token retained unless also removed). A fresh "Start Pairing" click must be explicit.

Concurrent pairing starts: clicking "Start Pairing" while a previous code is still alive **cancels the old code** and generates a new one (state replaced, not stacked).

### 5.1 Pairing

**Token validation policy:** on `telegram_set_token`, the Rust side calls `getMe()` **before** writing to Keychain. If it fails (bad token, network), the call returns error and nothing is saved — the UI stays on the "paste token" view with a clear error. Valid token → Keychain write → state=Unconfigured (awaiting Start Pairing).

```
UI: paste token → telegram_set_token → validate via getMe() → Keychain write
UI: Start Pairing → Rust generates 6-digit code → state=Pairing{code, +5min}
Rust: start transport long-polling (needed to receive /pair)
UI: displays code + countdown
User: sends "/pair 123456" in Telegram
Dispatcher: if state != Pairing → silent drop
Dispatcher: if /pair and code matches and not expired → save chat_id to Keychain,
            state=Paired, bot replies ✅ + /help, emit telegram:paired
```

Edge: retries limited to 5 bad codes per 5-minute window (then pairing auto-cancels, user must restart). Prevents brute-forcing a leaked token by someone else's chat.

### 5.2 Free-text → AI

```
update.text → dispatcher
  if starts_with('/') → commands_registry
  else → assistant.handle(text, chat_id)
    → load last N from chat table (configurable, default 50)
    → prepend system_prompt + "Known facts: …" from memory table
    → llm.chat(messages, tools=tool_registry.schema())
    → if tool_calls: execute each tool (concurrently where safe), append tool results, call llm again
    → final assistant text → sender.enqueue(SendMessage(chat_id, text))
    → INSERT user+assistant rows into chat
    → if row count > context_window * 4: DELETE oldest (keeps table bounded)
```

**Chat history pruning:** the `chat` table is the durable store for the rolling window. We keep up to `context_window × 4` rows (default 200) so that context reloads remain consistent even if the assistant loop produced interleaved tool/tool_result rows. Older rows are deleted on each assistant turn — bounded storage, zero maintenance.

Safeguards: tool calls wrapped in timeout (5s for local ops, 30s for LLM). Tool arg validation via `serde` deserialization — bad args = error result back to LLM (self-correcting loop), not a crash.

### 5.3 Voice

```
update.voice → transport downloads via getFile (with size cap)
  → inbox.record(kind='voice', file_path)
  → if settings.voice_auto_to_ai:
       spawn blocking whisper transcription (whisper-rs with active model from whisper module)
       → UPDATE inbox SET transcript
       → treat transcript as free-text → 5.2
       → bot replies "🎤 _heard: '{first 80}…'_\n\n{AI response}"
     else:
       react ✓; transcript lazy via Inbox → "Transcribe" button
```

**Download size caps** enforced before `getFile`: voice ≤ 20 MB, documents ≤ 20 MB, photos take Telegram's largest pre-compressed size. Daily cumulative cap: 50 MB (counter in `kv` table, resets at local midnight). Exceeded → bot replies with "⚠️ Daily file quota reached" and skips download; inbox row still recorded (without file).

Whisper model selection: reuse the active model set in the `whisper` module (no duplicate config). If none installed, reply "⚠️ No Whisper model installed — open Stash → Whisper to download one."

### 5.3.1 Inbox routing (cross-module)

One-click routing from Inbox items to other modules is implemented by **direct repo calls in Rust**, not by frontend mediation. Rationale: the popup may be closed when the user taps a routing button later; Rust can execute the action without waking the webview.

```
frontend: telegram_route_inbox_item(id, target: 'notes'|'clipboard'|'transcribe'|'open')
  Rust handler switches on target:
    'notes'     → NotesRepo.create(title, body = text_content or transcript)
    'clipboard' → ClipboardRepo.insert(text or file-as-image)
    'transcribe'→ voice::transcribe_existing(inbox_id) (voice only; idempotent)
    'open'      → tauri::api::shell::open(file_path) via tauri_plugin_opener
  UPDATE inbox SET routed_to = target
  emit 'telegram:inbox_updated'
```

The `NotesRepo` and `ClipboardRepo` are already exposed via managed Tauri state; the telegram module takes `Arc<>` handles at setup time (wired in `lib.rs` next to the telegram state). No new plumbing.

### 5.4 Outbound notifications

```
Module emits Event via TelegramNotifier::send(ev)
  → check settings.notifications.{category}
  → check dedup cache (e.g. battery_low: max 1/h; calendar: one per event_id)
  → if Paired → sender.enqueue(SendMessage(text))
  → sender serializes + retries (exponential backoff, 6 tries)
```

EventKit: tokio interval (60s) polls events in next `calendar_lead_minutes + 15`; sends alert when `starts_at - now ≤ lead_minutes` once per event_id. Permission requested lazily on first enable of `notifications.calendar` toggle; if denied, show persistent banner in NotificationsPanel.

### 5.5 Reminders

```
tokio::time::interval(30s)
  → SELECT id,text FROM reminders
     WHERE due_at <= now AND sent=0 AND cancelled=0 LIMIT 20
  → for each: sender.enqueue(f"⏰ {text}"); UPDATE sent=1
  → if repeat_rule: compute next due_at (rrule crate), INSERT new row
```

Missed reminders during sleep: on wake, ticker fires, past-due reminders send with a "(late)" marker. No silent drop — user always knows.

## 6. Command surface (MVP)

Core: `/help`, `/pair`, `/ai <q>`, `/remind <nl>`, `/reminders`, `/memory`, `/forget <id>`, `/status`
Modules: `/clip [N]`, `/note <text>`, `/battery`, `/dl <url>`, `/tr <text>`, `/pomodoro start|pause|stop`

Free text (no leading `/`) → AI assistant with tool access.

Out-of-scope: `/terminal`, `/music`.

## 6A. CLI (`stash` command)

The CLI is a second transport over the same `CommandRegistry` used by the Telegram bot. Adding a command once makes it reachable from Telegram, from the CLI, and (future) from URL schemes or Raycast — one source of truth.

### 6A.1 Architecture

```
src-tauri/
├── src/
│   └── modules/telegram/commands_registry.rs   — owns CommandRegistry
├── crates/
│   └── stash-cli/
│       ├── Cargo.toml
│       └── src/main.rs                         — thin IPC client
└── src/lib.rs                                  — starts IPC server on launch
```

- **Server side** (inside main Stash app): Unix domain socket at `~/Library/Application Support/stash/ipc.sock` with permissions `0600` (owner-only read/write). Started once at app setup, lives as a tokio task until app quit. Accepts JSON-line requests and dispatches through the shared `CommandRegistry`. macOS file ACLs already isolate per-user; no additional auth.
- **Client side** (`stash-cli` crate): produces a ~300 KB binary `stash` that connects to the socket, writes one JSON line, reads one JSON line, prints human output to stdout (or `--json` for raw). Exit code `0` on success, `1` on command error, `2` on "app not running" (socket absent or unconnectable).
- **Distribution:** binary is bundled inside `Stash.app/Contents/Resources/bin/stash` via Tauri's `resources` config. Always present; question is just whether it's on the user's PATH.

### 6A.2 IPC protocol

Request (newline-delimited JSON):
```json
{"cmd": "clip", "args": {"n": 1}}
```
Response:
```json
{"ok": true, "data": "last clipboard text here"}
```
Error:
```json
{"ok": false, "error": "no clipboard entry at index 1"}
```

One request per connection (server closes after reply) — keeps the protocol trivial; throughput isn't a concern for a human-driven CLI.

### 6A.3 First-launch prompt + Settings opt-in

**First launch after install:** on the very first app start (tracked via `first_launch_done: true` flag in settings.json, default `false`), Stash shows a one-screen modal:

> **Install `stash` command-line tool?**
> You'll be able to run things like `stash clip`, `stash remind "call dr at 10"`, or `stash pomodoro start` from any Terminal window — handy with Claude Code and shell scripts.
>
> [Install (requires admin password)]  [Not now]

- **Install** → `osascript -e 'do shell script "ln -sf <bundle-path> /usr/local/bin/stash" with administrator privileges'`. If `/usr/local/bin` doesn't exist (common on a fresh Apple Silicon machine without Homebrew), fall back to `~/.local/bin/stash` (no sudo) and show a toast: "Added to ~/.local/bin — make sure it's in your PATH."
- **Not now** → sets `first_launch_done=true` without installing. Never nagged again.

In both cases, a **"Command-line tool"** row appears in **Settings → Integrations** with:
- Status badge: `Installed at /usr/local/bin/stash` / `Not installed`
- Button: `Install` / `Uninstall` (toggles based on state)
- Link: "Learn more" → opens a short docs page listing available commands (auto-generated from `CommandRegistry::enumerate()`)

### 6A.4 Command parity with Telegram

MVP `stash` commands (same handlers as Telegram slash-commands — wired once, reused by both transports):
```
stash help
stash status
stash clip [N]                  # N=1 by default = most recent
stash note <text>
stash battery                   # human output; --json for scripting
stash dl <url>
stash tr <text>
stash pomodoro start|pause|stop [minutes]
stash remind <natural-language>
stash reminders                 # list
stash ai <question>             # streams response
stash memory                    # list facts
stash forget <id>
stash claude [path]             # launch Claude Code session (see §6A.7)
```

Not exposed via CLI in MVP: `/pair` (pairing is Telegram-only), `/help` slash variant (CLI has its own).

### 6A.5 `claude` launcher (special command)

`stash claude [path]` and the matching Telegram `/claude [path]` command spawn a fresh Claude Code session with `claude --dangerously-skip-permissions`. Stash's role is strictly "open the door" — after launch there is **no bridging, no output capture, no further interaction from Stash's side**. The user continues work through the Claude mobile / web app connected to their account.

**Behavior:**
- Opens a **new Terminal.app window** via `osascript` (visible, so the user sees if authentication is required on first run):
  ```applescript
  tell application "Terminal"
    do script "cd <cwd>; claude --dangerously-skip-permissions"
    activate
  end tell
  ```
- **Working directory precedence:**
  1. Explicit arg: `stash claude ~/PROG/foo` → `~/PROG/foo`
  2. CLI only: when invoked as `stash claude` from a terminal, the server receives the client's CWD (included in the IPC request) and uses it
  3. Telegram / arg-less CLI in non-cwd context → `settings.telegram.claude_default_cwd` (Settings field, default `~`)
- **Multiple sessions allowed.** Each invocation opens a new Terminal window — no locking, no "already running" check. Stash tracks active sessions only for `/claude list` (returns PIDs + cwd + started-at).
- **No output is read** by Stash. If `claude` binary is not on PATH, `osascript` returns success (Terminal opens, then shows `command not found`); Telegram reply is a simple "🚀 Opened Claude session in `<path>`" — the user sees the real error in Terminal.
- **`claude` binary discovery:** uses whatever `claude` resolves to in the user's login shell (`$PATH`). Stash does not ship or manage Claude Code itself. If not installed, the user sees a standard shell error.

**Telegram reply examples:**
```
User:  /claude
Bot:   🚀 Opened Claude session (cwd: ~/PROG/stash).
       Open Claude mobile/web app to continue.

User:  /claude ~/PROG/other
Bot:   🚀 Opened Claude session (cwd: ~/PROG/other).

User:  /claude list
Bot:   2 active sessions:
       • pid 12345 — ~/PROG/stash (started 10:42)
       • pid 12401 — ~/PROG/other (started 10:55)
```

**Why this is safe enough to include:** the command runs `claude`, not arbitrary input. The `[path]` argument is quoted via `osascript`'s `quoted form of` and validated as a real existing directory before the spawn (non-existent path → error, no spawn). The `--dangerously-skip-permissions` flag is Claude Code's own — its risk is owned by Claude Code, not by Stash.

**Note for §6A.6 (Security):** `claude` is the **only** command in the registry that launches an external process. All others read/write app state. When adding new commands, maintainers must evaluate whether a process spawn is needed or whether the logic should live inside Stash.

### 6A.6 Security

- Socket permissions `0600`, in per-user data dir — only the logged-in user can connect.
- The server accepts only commands in `CommandRegistry`. No "run this shell command" surface, ever.
- Rate limiting: 30 req/s per connection (generous for human use, stops runaway scripts).
- `/usr/local/bin/stash` is a symlink to the bundle's binary — uninstall removes the symlink, not the binary. Upgrading the app updates the target transparently.
- If the app is **not running**, the CLI exits with code 2 and stderr: `stash: Stash app is not running`. It does not attempt to launch the app (scripts/Claude Code should not silently spawn GUI apps).

### 6A.7 Shell completions

`stash completions {zsh|bash|fish}` prints a completion script. The Settings row offers a one-click "Install completions for your shell" that detects `$SHELL` and writes to the right location (`~/.zsh/completions/_stash`, etc.).

## 7. AI tool schema (for tool-use)

```
create_reminder(text: string, when: ISO8601, repeat?: RRULE) → {id, due_at}
list_reminders() → [{id, text, due_at, repeat}]
cancel_reminder(id: int) → {ok}
remember_fact(text: string) → {id}
list_facts() → [{id, text}]
forget_fact(id: int) → {ok}
get_battery() → {percent, charging}
get_last_clip() → {content}
pomodoro_status() → {phase, remaining_sec}
start_download(url: string) → {job_id}
```

All tool invocations audited via `tracing::info!(tool=..., args_sketch=...)` with arg redaction for free-text fields.

## 8. Performance notes

- Long polling: 25s timeout per `getUpdates` → idle CPU ~0% between messages.
- Outbound queue: single tokio task, semaphore of 1 per chat, respects 429 `retry_after`.
- Whisper: `tokio::task::spawn_blocking` — never blocks the Telegram runtime.
- LLM HTTP: `reqwest` with `rustls-tls` (already in deps), connection pool reused.
- SQLite: `telegram.sqlite` with WAL enabled; chat insertions in transactions when two rows follow (user + assistant).
- Cold start: Telegram transport lazy — only started if `settings.telegram.enabled && token present`. No penalty for users who never configure it.

## 9. Testing strategy

**Frontend (Vitest + RTL):**
- `ConnectionPanel.test.tsx` — token paste → invokes api; pair button shows code; countdown; error states.
- `InboxPanel.test.tsx` — list render, routing buttons call correct invoke.
- `RemindersPanel.test.tsx` — list + cancel.
- `MemoryPanel.test.tsx` — list + delete.
- `NotificationsPanel.test.tsx` — toggles persist via invoke.
- `api.test.ts` — thin wrapper signatures match backend.

**Rust (`cargo test`, in-memory SQLite):**
- `repo::tests` — CRUD for chat, memory, reminders, inbox. Reuse `Connection::open_in_memory()`.
- `pairing::tests` — code generation uniqueness; state transitions; TTL; retry limit.
- `dispatcher::tests` — slash routing vs AI routing; allowlist filter (unknown chat_id silent drop).
- `reminders::tests` — tick picks up due rows, RRULE advances correctly, cancelled rows skipped.
- `notifier::tests` — dedup cache behavior; settings toggle respected.
- `tools/*::tests` — schema validation, arg parsing, timeout behavior.
- `llm::tests` — `reqwest`-based with `mockito`-style HTTP mock for OpenAI and Anthropic shapes.
- `voice::tests` — stub whisper with a fake transcript for pipeline test.

Telegram itself is mocked at the `transport` trait boundary — a `MockTransport` drives fabricated updates in dispatcher tests. No real network in unit tests.

**E2E:** none new. Telegram involves network and a real bot, which is out of scope for Playwright headless.

TDD applies: every behavior listed above is test-first per project convention.

## 10. Dependencies to add

```toml
teloxide = { version = "0.13", default-features = false, features = ["rustls", "macros"] }
rrule = "0.12"                 # recurrence for /remind
tokio = { version = "1", features = ["full"] }  # likely already transitively; be explicit
# reqwest, rusqlite, keyring, uuid, whisper-rs, serde — already present
objc2-event-kit = "0.2"        # macOS calendar; behind cfg(target_os = "macos")
objc2-foundation = "0.2"       # transitively
```

Licence: all MIT/Apache — fine for bundling. teloxide is well-maintained and uses tokio, matching our existing async surface (used by downloader/reqwest).

## 11. Phased implementation plan

> **Status legend** — ✅ shipped, ⚠️ partial, ❌ not started.

### Shipped in 2026-04-21 / 04-22 session

- ✅ **Phase 0** — keyring + pairing state machine + transport + ConnectionPanel.
- ✅ **Phase 1** — sender with rate-limit + retry, text inbox persistence,
  /help /status /battery /clip /note /music /volume slash commands,
  InboxPanel with routing buttons, setMyCommands auto-publishes the
  command list to Telegram's autocomplete.
- ✅ **Phase 1.5+** — voice / photo / document / video downloads with
  per-file 20 MB and per-day 50 MB caps; files live at
  `<app_data>/telegram/inbox/YYYY-MM-DD/<uuid>.<ext>` with the
  relative path stored in the DB. "Open" button reveals in Finder.
- ✅ **Phase 2** — voice messages auto-transcribed via Whisper's active
  model; transcript stored on the inbox row; bot replies with a
  preview. `transcribe_with_active_model` public helper in the whisper
  module so the AI assistant (Phase 3) can reuse the same path.
- ✅ **Phase 4** — reminders engine: `/remind` parser (compact offsets,
  wall-clock, `tomorrow HH:MM`, absolute `YYYY-MM-DD HH:MM`), 30-second
  ticker, `/reminders` list, `/forget <id>` cancel, "(late)" marker on
  missed firings. RRULE recurrence deferred.
- ✅ **Phase 5** — outbound notifier with per-category cooldown:
  Pomodoro transitions, Download complete, Battery low (with settings-
  backed threshold). Calendar category added in Phase 6. Per-category
  toggles live in the Alerts sub-tab.
- ✅ **Phase 6** — Calendar.app events polled via `osascript` every 60 s,
  dedupe by event UID, "📅 <title> in N minutes" alert when an event
  crosses the user's lead window. First run prompts for Automation
  permission in macOS settings. **Note**: the original design called
  for `objc2-event-kit`; AppleScript ships without new deps or
  entitlement plumbing and is swap-in-compatible if a future phase
  wants finer-grained EventKit calls (attendees, recurrence etc.).

### Remaining

- ❌ **Phase 3 — AI assistant + tools**. Design remains as written:
  provider-agnostic LlmClient (reads the `ai` module's key + model),
  rolling 50-message chat history persisted in the `chat` table,
  editable system prompt, tool-use registry with `create_reminder` /
  `list_reminders` / `cancel_reminder` / `remember_fact` /
  `list_facts` / `forget_fact` / `get_battery` / `get_last_clip` /
  `pomodoro_status` / `start_download`. Memory-fact CRUD (`remember`
  as an explicit slash plus the tool) targets the already-migrated
  `memory` table. This is the largest remaining slice — ~500–1000
  lines. Start from a fresh session (context-cost reason).

- ❌ **Phase 7 — CLI transport**. Design unchanged: `stash-cli` crate,
  Unix socket at `ipc.sock` (0600), JSON-line protocol, bundled binary
  + first-launch install prompt, `stash claude [path]` launcher.
  Independent of Phase 3 — can ship in either order.

- **Deferred / post-MVP (unchanged)**: RRULE recurrence, Google
  Calendar / Apple Reminders *write* integration, Google Drive upload
  for inbox, TTS voice replies, multi-bot support.

### Phase 0 — Skeleton & pairing (end-to-end thinnest slice) — ✅ shipped
1. Rust `telegram` module scaffolding + registry wiring.
2. `keyring.rs` store; `state.rs`; `commands.rs` for token + status.
3. `transport.rs` with teloxide long-polling (just `/pair` handler + allowlist).
4. `pairing.rs` state machine, 6-digit code, TTL, retry limit.
5. Frontend `ConnectionPanel` + its tests.
6. DB migrations for all tables (even if unused — one-shot migration).
7. Smoke test: pair a real bot, verify `chat_id` landed.

### Phase 1 — Inbox & outbound basics — ✅ shipped (expanded)
1. `sender.rs` with serial queue + retry.
2. `inbox.rs` persistence; text/photo/document/voice file downloads with size cap.
3. `InboxPanel` UI + tests; one-click routing (`→ Notes`, `→ Clipboard`, `→ Transcribe`, `→ Finder`).
4. `commands_registry.rs` with core slash handlers (`/help`, `/status`,
   `/clip`, `/battery`, `/note`). Also shipped: `/music` (with inline
   keyboard buttons), `/volume`. `/tr` / `/dl` / `/pomodoro` deferred
   — pattern is proven, add on demand.

### Phase 2 — Voice → whisper → text — ✅ shipped
1. `voice.rs` bridge to whisper module's active model.
2. Inbox UI: Transcribe button; Advanced toggle wired.

### Phase 3 — AI assistant + tools — ❌ not started
1. `llm/*` client (OpenAI + Anthropic).
2. `assistant.rs` orchestration + system prompt / facts injection.
3. `tools/memory.rs`, `tools/reminders.rs`, `tools/stash.rs`.
4. `MemoryPanel`, `RemindersPanel`, `AiPromptPanel`.

### Phase 4 — Reminders engine — ✅ shipped (RRULE deferred)
1. `reminders.rs` ticker.
2. RRULE advancement.
3. Wake-from-sleep "(late)" marker.

### Phase 5 — Outbound notifications — ✅ shipped
1. `notifier.rs` bus; dedup; rate limits.
2. Wire battery, pomodoro, downloader modules to push events through it.
3. `NotificationsPanel` toggle matrix.

### Phase 6 — Calendar (via AppleScript, not EventKit) — ✅ shipped
1. `calendar.rs` bridge + permission request.
2. Lookahead ticker.
3. Error state UI when permission denied. *(Shipped change: used
   `osascript` + Calendar.app Automation permission rather than
   `objc2-event-kit`. The switch buys us zero new deps and no
   entitlement plumbing; we lose only finer-grained event metadata
   which the current single-line "📅 title in N minutes" doesn't use.
   Swap to EventKit later if an Attendees / Recurrence feature lands.)*

### Phase 7 — CLI transport — ❌ not started
1. `stash-cli` crate + bundled binary (`tauri.conf.json` resources).
2. IPC server tokio task on app startup (Unix socket, JSON lines).
3. Reuse `CommandRegistry` — no handler duplication.
4. First-launch modal; Settings → Integrations row with Install/Uninstall.
5. `stash completions` for zsh/bash/fish.
6. Tests: IPC request/response round-trip via in-proc socket; CLI binary smoke-test via subprocess; "app not running" exit code.

Each phase ships with tests green, a visible UI increment, and can be used standalone.

## 12. Post-MVP backlog

- Google Calendar / Apple Reminders **write** (user speaks reminder, app creates it in Calendar.app too).
- Google Drive upload for Inbox files.
- TTS voice replies (`objc2-avfoundation` `AVSpeechSynthesizer` locally; paid provider later).
- Inline keyboards for `/reminders` cancellation instead of re-typing IDs.
- Web-style URL preview for shared links via existing `LinkPreviewState`.
- Auto-fact-extraction from conversation (opt-in).
- Multi-bot support (personal + work chat).
- CLI URL scheme (`stash://command?...`) for integration with Raycast, Alfred, Shortcuts.app.
- CLI `--watch` mode for long-running events (e.g. `stash pomodoro --watch` prints phase transitions as they happen).

## 13. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Telegram drops updates > 24h old after sleep | Document, nothing we can do; rely on outbound reminders to catch up. |
| LLM API cost explodes from chatty tool-use loops | Tool-call depth limit = 5 per user message; hard stop otherwise. |
| Whisper transcription slow on large voice (>2 min) | Cap voice duration at 180s for auto-AI path; longer ones land in Inbox with manual Transcribe button. |
| Token leak | Keychain only; never log; validate `getMe()` after save; show masked token in UI. |
| Bot spammed by third parties with leaked token | Allowlist silent-drop; only `/pair` accepted pre-pair; 5-try cap on bad codes. |
| EventKit permission denied → silent breakage | Status pill in NotificationsPanel reflects permission state. |
| Reminders firing while app is sleeping | Document expected behavior: delivery on wake with "(late)" prefix. |
| CLI user expects `stash` to launch the app | Documented: exit 2 when not running. Settings row explains dependency. |
| `/usr/local/bin` absent on clean Apple Silicon | Fallback to `~/.local/bin` + PATH toast. |
| Symlink stale after app moved/renamed | On every app launch, if symlink exists but target mismatches bundle path, re-link (no sudo needed — only if pre-existing link was writable by user, else one-time re-prompt). |
| Popup auto-hide interfering with Telegram tab UI | None — Telegram panels have no native modals; N/A. |

## 14. Acceptance checklist (user-stated non-functional requirements)

- **Provider-agnostic AI:** the assistant inherits provider and model from the existing `ai` module settings (single source of truth). Any provider configured there — OpenAI-compatible, Anthropic, or another supported shape — works for Telegram without additional setup.
- **Speed:** Rust-native long polling + LLM client; no webview round-trip for bot messages; whisper in blocking task; serial outbound queue respects Telegram rate limits. Bot remains responsive when popup is closed.
- **Convenience:** API key configured once in AI tab — Telegram inherits. Free text → AI (no command memorisation needed). Slash commands and AI tools share handlers where they overlap, so the same ability is reachable two ways.
- **Security:** All secrets in Keychain (never in settings.json/logs). Strict allowlist (single chat_id). `/pair` window-limited and rate-limited. Token validated via `getMe()` before save. File-size and daily-quota caps on inbound downloads. Tool invocations audited with redacted args.
- **Extensibility:** Adding a slash command = implement `CommandHandler` + 1 line in `default_registry`. Adding an AI tool = implement `Tool` + 1 line in `default_tools`. `/help` auto-enumerates from the registry. New notification categories = new enum variant + new settings toggle (no cross-module rewiring).

## 15. Open questions (to resolve during implementation)

- Which LLM provider to wire first? Likely whichever is already configured in `ai` module (reuse key). If none, OpenAI first (commonest user key).
- Rate-limit strategy for abuse scenarios — current design assumes single-user trust. Revisit if multi-user lands.
- Whether to expose a command palette (`/?`) for fuzzy command search when > 20 commands accumulate post-MVP.

## 16. Implementation notes surfaced during 2026-04-21/22 build

These are post-fact reality checks worth keeping alongside the design
so a future session doesn't re-learn them the hard way.

- **Unsigned dev-build macOS Keychain** silently drops `set_password`
  writes. Solved with a canary-roundtrip probe in `file_secrets.rs` —
  if the probe fails, the module falls back to an AES-128-CBC-
  encrypted file at `<app_data>/telegram/.secrets.bin` keyed by the
  machine's hostname. Signed release builds hit the Keychain path
  normally. The probe uses a *fresh* `keyring::Entry` on the read leg
  because same-Entry in-process state can mask the failure.
- **Rehydrate paired state** at app setup — `TelegramState::new()`
  always starts `Unconfigured` otherwise, so every restart stranded
  a previously-paired bot offline. We now re-read `bot_token` +
  `chat_id` from secrets and auto-spawn transport + sender when both
  are present.
- **Long-poll idle timeout** must stay short (10 s used) — 25 s was
  getting reaped by intermediate NATs, spamming the log with three
  `getUpdates timed out` warnings per minute of idle.
- **tokio** was only transitively available via teloxide; we added
  it as a direct dep with `rt-multi-thread + macros + sync + time +
  fs + io-util` features for `spawn_blocking`, `fs::File` streaming,
  and `time::interval` in the watchers.
- **reqwest** in this repo is compiled without the `json` feature;
  we parse Telegram responses with `text().await` + `serde_json::from_str`.
- **Notes cross-module refresh** — the notes sidebar reloads on its
  own writes but had no trigger for external inserts. `/note` now
  emits `notes:changed`; `NotesShell` listens and calls `reload()`.
  Same pattern applies whenever another module mutates a repo the
  UI is holding summaries for.
- **Ctx carries `AppHandle`** — necessary for any handler that wants
  to `emit` cross-module events. Added after `/note` landed without
  a refresh signal.
- **CommandRegistry uses `RwLock`** so `lib.rs` can register cross-
  module commands (`/clip`, `/note`, `/music`) *after* `TelegramState`
  is constructed, once their target module states exist.
- **Local date math** is done without `chrono` via a hand-rolled
  `ymd_from_days` / `days_from_ymd` pair; the only platform coupling
  is `date +%z` for the local offset. Good enough for inbox day
  partitioning + reminder parsing; swap to `chrono` if we grow DST
  edge cases.
