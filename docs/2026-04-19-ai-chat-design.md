# AI Chat — Design

**Date:** 2026-04-19
**Status:** Agreed, not implemented
**Language:** Ukrainian (per project convention)

## Goal

Додати в Stash модуль **AI Chat** — окремий таб у popup (920×520), з Markdown/code-підсвіткою, історією сесій у стилі ChatGPT, локальним voice input (Whisper) та інтеграцією через Vercel AI SDK. Одночасно підготувати інфраструктуру, яку зможуть використовувати інші табки (Notes у першу чергу) для власних AI-фіч.

Весь **provider-based AI**-функціонал у додатку покрито **єдиним глобальним toggle** (`ai_enabled`) — коли вимкнено, таб AI Chat зникає, AI-контроли в Notes і майбутніх модулях приховуються.

**Whisper (voice-to-text)** — окрема незалежна інфраструктура з власним toggle (`voice_enabled`), бо вона:
- працює локально офлайн, не вимагає жодного provider-ключа;
- юзається не тільки в AI Chat, а й у Notes (диктування) і в Downloader (транскрибція скачаних audio/video);
- може бути ввімкнена без AI chat і навпаки.

## Scope MVP

**У скоупі:**
- Tab AI Chat (text + code з підсвіткою).
- Sessions з ChatGPT-style sidebar (collapsible).
- Vercel AI SDK з 4 провайдерами: OpenAI, Anthropic, Google, Custom (OpenAI-compatible).
- API key у OS keyring.
- Settings → AI таб: toggle, provider, model, key, baseURL, system prompt, Test Connection.
- Settings → Voice таб: toggle, auto-recommendation Whisper-моделі, download manager.
- Shared `<VoiceRecorder>` React-компонент (mic-кнопка + MediaRecorder + waveform) — юзається в AI Chat, Notes, і (через file-варіант) у Downloader.
- Локальний Whisper через `whisper-rs` як shared infrastructure (`src-tauri/src/modules/whisper/`), незалежна від AI-модуля.
- Інтеграція Whisper у Downloader: транскрипція скачаних audio/video-файлів (ця частина окрема фаза, див. нижче).
- Shared `useAiSettings()` хук для майбутніх AI-інтеграцій; shared `useVoiceSettings()` — для voice.

**Поза скоупом (YAGNI):**
- Tool-calling / function-calling.
- Image/file attachments в чаті.
- Multi-config profiles, per-session model snapshot.
- Token usage / вартість.
- Export/import, search по історії, tags.
- Regenerate / edit попередніх повідомлень.
- Model-picker у самому чаті (модель завжди беремо з Settings).

## Архітектура

### Структура файлів

```
src/modules/ai/
  index.tsx              # ModuleDefinition (умовна реєстрація)
  AiShell.tsx            # sidebar + chat area + keyboard
  ChatThread.tsx         # стрічка + streaming buffer
  ChatComposer.tsx       # textarea + send/stop + <VoiceRecorder/>
  SessionSidebar.tsx     # collapsed 44px ↔ expanded 240px overlay
  MessageBubble.tsx      # role-based styling + copy
  api.ts                 # invoke() wrapper (AI chat специфічне)
  provider.ts            # фабрика Vercel AI SDK моделі
  useAiSettings.ts       # shared hook (чат + Notes)
  *.test.tsx

src/shared/ui/
  Markdown.tsx           # винесений з notes/MarkdownPreview.tsx
  VoiceRecorder.tsx      # mic-кнопка + MediaRecorder + waveform + transcribe
                         # юзається в AI Chat composer + Notes composer

src/shared/whisper/
  api.ts                 # invoke wrappers (list/download/transcribe/recommend)
  useVoiceSettings.ts    # shared hook — enabled + active model
  *.test.ts

src-tauri/src/modules/ai/
  mod.rs, state.rs       # AiState (SqlitePool, AiConfig cache)
  repo.rs                # sessions/messages CRUD
  commands.rs            # ai_* invoke-команди
  keyring.rs             # OS keyring wrapper

src-tauri/src/modules/whisper/
  mod.rs, state.rs       # WhisperState (Arc<Mutex<Option<WhisperContext>>>)
  commands.rs            # whisper_list_models, download, delete, recommend,
                         # transcribe_bytes, transcribe_file
  recommend.rs           # hardware-based model recommendation
  audio.rs               # webm/mp4/mp3/... → 16kHz mono PCM через symphonia
```

### Потік одного запиту

1. User пише в `ChatComposer`, натискає `Enter`.
2. `AiShell` персистить user message → `invoke('ai_append_message', …)`.
3. `ChatThread` викликає `invoke('ai_get_api_key', { provider })` → Rust читає з keyring, повертає в renderer.
4. Перед streaming: `invoke('set_popup_auto_hide', { enabled: false })`.
5. AI SDK `streamText({ model: buildModel(cfg, key), system, messages })` стрімить напряму з webview до provider endpoint.
6. Кожен chunk → state update → rerender `MessageBubble` з `<Markdown>`.
7. `onFinish` / `onAbort` → персистимо assistant message (з `stopped=0/1`), вмикаємо auto-hide назад.
8. API key випадає зі state, як тільки stream завершився.

### Security

- API key — тільки в OS keyring (`keyring` crate), service `com.stash.ai`, account = назва provider'а або `whisper`.
- Ключ у памʼяті renderer-процесу лише на час активного запиту.
- Ніякого plaintext-збереження на диску.

## Схема даних

### SQLite (нова міграція)

```sql
CREATE TABLE ai_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ai_sessions_updated ON ai_sessions(updated_at DESC);

CREATE TABLE ai_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  stopped     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_messages_session ON ai_messages(session_id, created_at);
```

System role **не зберігається** як message — живе в Settings, прикладається на льоту.

### Settings (persistent config)

```
ai_enabled       BOOLEAN
ai_provider      TEXT    ('openai'|'anthropic'|'google'|'custom')
ai_model         TEXT    (free text)
ai_base_url      TEXT    (nullable, required для custom)
ai_system_prompt TEXT    (nullable)
voice_enabled    BOOLEAN
voice_active_model TEXT  ('tiny'|'base'|'small'|'medium')
```

API keys — окремо в keyring.

### Rust state

- `AiState { pool: SqlitePool, config: Arc<Mutex<AiConfig>> }`.
- Кеш конфігу, щоб `ai_get_settings` не стукав у БД.
- Whisper: ліниве завантаження моделі, в памʼяті тримається `Arc<Mutex<Option<WhisperContext>>>`.

## UI деталі

### Клавіатура

- `Enter` — send (ChatGPT-style).
- `Shift+Enter` — newline.
- `Esc` під час streaming — stop (abort).
- `⌘N` (коли активний таб AI) — нова сесія.
- `⌘⌥<N>` — стандартний tab switch Stash.

### Session sidebar

- Default `width: 44px`, тільки іконки (+ для новий чат, кружечки ініціалів для сесій).
- Клік "expand" або hover 300ms → `position: absolute` overlay 240px з backdrop-blur та scrim (з наявних токенів), поверх chat area.
- Items: title (truncate), relative date.
- Hover item → kebab: rename (inline, double-click), delete (через `ConfirmDialog`).
- Empty state: "No conversations yet".

### Messages

- `user` — правий край, фон `rgba(var(--stash-accent-rgb), 0.12)`.
- `assistant` — лівий край, нейтральний surface.
- Hover → floating `IconButton` copy (plain text).
- Code-block (всередині `<Markdown>`) — copy-кнопка в right-top.
- Auto-scroll до низу під час streaming, якщо user не проскролив вгору вручну.

### Composer

- Textarea (auto-resize, max 8 рядків), mic-кнопка зліва, Send справа.
- Send → Stop (quadrate) під час streaming.
- Під час transcription — spinner замість mic, composer lock.

### Empty states

- Пустий чат → hero "Ask anything" + 3 клікабельні chip-підказки.
- Sidebar порожній → "No conversations yet".
- AI toggle on, ключ порожній/недійсний → плейсхолдер "Configure AI in Settings → AI".

### Model у хедері чату

Pill: `provider · model-name` (наприклад `Google · gemini-2.5-pro`). Не збережений snapshot, показує поточну активну.

## Settings → AI таб

### Chat section

1. Toggle "Enable AI" — коли OFF, решта grayed-out.
2. Provider — `SegmentedControl` (OpenAI / Anthropic / Google / Custom).
3. Model name — `Input` (free text), placeholder залежно від provider'а.
4. API key — `Input type="password"` з toggle "show". Save → `ai_set_api_key` → keyring. Placeholder `••••••••` якщо ключ уже є.
5. Base URL — тільки для Custom, `Input`.
6. System prompt — textarea 4 рядки, optional.
7. **Test Connection** — `Button`. Клік → мінімальний `streamText` (ping), показує `✓ Connected in 420ms` або `✗ 401 Unauthorized`.

## Settings → Voice таб (окрема вкладка)

Не плутати з AI — Voice незалежна, працює офлайн.

1. Toggle "Enable voice input" (`voice_enabled`).
2. Recommended block: `whisper_recommend_model()` повертає `{ recommended, reason, alternatives }`.
   ```
   ✨ Recommended: small (244 MB)
   Your Mac has 16 GB RAM and Apple M-series — small gives the best quality/speed balance.
   [ Download recommended ]
   ```
3. Other sizes (expandable): радіо-кнопки tiny/base/small/medium зі статусом (downloaded / not downloaded) + `[Download]` / `[Delete]`.
4. Active model — радіо-кнопка серед скачаних (та, що юзається для транскрибу).
5. Під час download — progress bar з емітними % (Rust → frontend через `ai:whisper-progress` event).

**Правила auto-recommendation:**

| CPU | RAM | → Recommended |
|-----|-----|---------------|
| Apple Silicon | ≥ 48 GB | medium |
| Apple Silicon | 16–32 GB | small |
| Apple Silicon | 8 GB | base |
| Intel | ≥ 32 GB | small |
| Intel | < 32 GB | base |

Якщо `free_disk < 1 GB` — downgrade на крок.

### Інтеграція Voice у модулі

**AI Chat (`ChatComposer`):** `<VoiceRecorder onTranscribed={(text) => setInput(prev => prev + text)} />` зліва від Send. Mic-кнопка disabled, якщо `!voiceSettings.enabled || !voiceSettings.activeModel`.

**Notes:** той самий `<VoiceRecorder>` в тулбарі notes-composer'а. На transcribe — текст вставляється в поточну caret-позицію markdown-редактора. Нічого module-специфічного не треба — чистий drop-in.

**Downloader → transcribe downloaded file:** окрема фаза. Context-menu item'а → "Transcribe audio/video":
- Викликає `invoke('whisper_transcribe_file', { path, lang })`.
- Rust: `audio.rs` декодує container через `symphonia` (mp4/webm/mkv демукс → audio track → PCM 16kHz mono), прогоняє через whisper-rs з `print_timestamps=true`.
- Повертає `{ text: String, segments: Vec<{ start_ms, end_ms, text }> }`.
- Прогрес через emit `whisper:transcribe-progress` (% від загальної тривалості).
- UI: modal з waveform/progress → по завершенню показує transcript, кнопки "Copy", "Save as .txt", "Save as .srt" (генерується з segments). Save location — поруч з оригінальним файлом.
- Коли задовга файла — неблокувальний: modal можна закрити, задача триває в фоні, toast по завершенню.

## Global toggle wiring

```ts
// src/modules/ai/useAiSettings.ts
export const useAiSettings = () => {
  const [settings, setSettings] = useState<AiSettings>(defaultAiSettings);
  useEffect(() => {
    invoke<AiSettings>('ai_get_settings').then(setSettings);
    const un = listen<AiSettings>('ai:settings-changed', (e) => setSettings(e.payload));
    return () => { un.then(f => f()); };
  }, []);
  return settings;
};
```

```ts
// src/modules/registry.ts
export const getRegistry = (prefs: Preferences) => [
  ...(prefs.aiEnabled ? [aiModule] : []),
  // …інші модулі
];
```

`PopupShell` слухає `ai:settings-changed` і перерендерить tab-bar.

**Notes у майбутньому:**
```ts
const { enabled } = useAiSettings();
if (!enabled) return null; // AI-кнопки не видно
```

**Вимикання toggle під час streaming:**
- `AiShell` слухає `ai:settings-changed`; якщо `enabled` стало false → `abortController.abort()`, персистимо частковий assistant-msg з `stopped=1`, toast "AI disabled".

## Помилки і стійкість

| Ситуація | UX |
|---|---|
| 401/invalid key | Toast "Invalid API key. Check Settings." + inline block у чаті. |
| 429/rate limit | Toast з retry-after секундами. |
| Network / timeout | Toast + "Retry" кнопка біля останнього user message. |
| CORS блокує provider | Fallback: Rust `ai_proxy_stream` через `reqwest`, emits chunks. |
| Whisper модель не скачана | Mic-кнопка disabled, tooltip "Download a voice model in Settings". |
| Mic permission denied | Toast "Grant microphone access in System Settings → Privacy." |

## Залежності

**npm:**
```
ai
@ai-sdk/openai
@ai-sdk/anthropic
@ai-sdk/google
```

**Cargo:**
```
whisper-rs (feature = "metal" на macOS)
keyring
sysinfo         # для recommend (якщо ще немає)
symphonia       # декод webm/mp4/mkv/mp3/wav → PCM (demux + decode)
rubato          # resampling до 16kHz (whisper-required)
reqwest         # streaming proxy fallback + download моделей з HuggingFace
```

**Info.plist:**
- `NSMicrophoneUsageDescription` (якщо ще не доданий recorder-модулем).

## Тестування

### Frontend (Vitest + RTL)

- `provider.test.ts` — `buildModel` правильний клієнт на provider; custom без baseURL кидає.
- `useAiSettings.test.ts` — оновлюється при `ai:settings-changed`.
- `AiShell.test.tsx` — empty state, create/switch/delete session.
- `ChatComposer.test.tsx` — Enter send, Shift+Enter newline, Stop, mic flow (mock MediaRecorder + invoke).
- `MessageBubble.test.tsx` — copy, code-block copy, role styling.
- `SessionSidebar.test.tsx` — collapsed/expanded, inline rename, kebab actions.
- `AiSettingsPanel.test.tsx` — toggle ховає поля, Test Connection path, custom baseURL validation, voice recommend block.

### Rust (`Connection::open_in_memory()`)

- `repo.rs` — CRUD, cascade delete, `updated_at` бампиться.
- `keyring.rs` — set/get/delete з in-memory fallback за фічер-флагом `test`.
- `whisper.rs::recommend_model` — різні RAM/CPU combo дають очікуваний результат.
- `commands.rs` — integration через `tauri::test`.

### Регресії

- `PopupShell.test.tsx` — AI tab зʼявляється/зникає від toggle.
- Notes тести — жодних AI-елементів коли toggle OFF (коли AI в Notes буде додано).

## Фази імплементації (окремі PR)

| # | Назва | Обсяг |
|---|-------|-------|
| 1 | **Foundation** | SQLite міграції, Rust state/repo/commands, keyring, `ai_settings` persistence. |
| 2 | **Settings UI (chat)** | `AiSettingsPanel` chat-секція, Test Connection. Global toggle + registry. |
| 3 | **Shared Markdown** | Винести в `src/shared/ui/Markdown.tsx`, notes мігрує. Code-block copy. |
| 4 | **Chat MVP** | `AiShell` без sidebar, одна сесія, streaming, persist, auto-hide toggle, Stop. |
| 5 | **Sessions** | Collapsible sidebar, create/rename/delete, `⌘N`, model pill у хедері. |
| 6 | **Polish** | Empty states, error toasts, retry, scroll, a11y. |
| 7 | **Whisper infrastructure** | `whisper-rs` інтеграція, download manager, recommendation, `audio.rs` decoder, `<VoiceRecorder>` shared component. Settings → Voice таб. |
| 8 | **Voice input в AI Chat + Notes** | Інтеграція `<VoiceRecorder>` у `ChatComposer` і Notes composer. Транскрипція з мікрофона. |
| 9 | **Transcribe в Downloader** | `whisper_transcribe_file` з `symphonia` decode, context-menu, modal з progress, export `.txt`/`.srt`. |

## Ризики і невідомі

- **Vercel AI SDK + Tauri webview CORS** — перевірити на фазі 4 для кожного provider'а. OpenAI/Anthropic/Google явно дозволяють browser-side з корректними CORS headers; якщо щось блокує — Rust `ai_proxy_stream` через `reqwest` з `app.emit`.
- **`whisper-rs` + Metal** — CMake build flags; треба затестити на чистій системі.
- **`keyring` на CI** — OS keyring може бути недоступний → in-memory fallback за фічер-флагом `test`.
- **Popup висота 520px** — sidebar overlay має поміщатись і не перекривати composer.
- **Ukrainian якість Whisper** — `small` прийнятна, `tiny` слабка; recommendation має це враховувати.

## Відкриті запитання до першої фази

- Чи є у нас уже `sysinfo` в `Cargo.toml` (для recorder)? Перевірити — якщо так, переюзаємо.
- Чи є централізована система міграцій SQLite? Як реєструвати нові таблиці.
- Як саме у нас зберігаються preferences сьогодні (JSON/SQLite) — додати `ai_*` туди ж.
- Який примітив для dropdown/popover kebab-меню юзається в проєкті (переглянути `src/shared/ui/`).
