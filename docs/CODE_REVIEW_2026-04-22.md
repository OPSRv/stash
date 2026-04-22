# Code Review — Stash (2026-04-22)

Перед релізом. Документ складений для подальших Claude-сесій: кожен пункт містить файл:рядок, severity і конкретну інструкцію як виправити. Пункти впорядковані в порядку виконання (зверху вниз).

## Базовий стан (snapshot)

- `cargo test` — **443 passed / 0 failed**.
- `vitest run` — **830 passed / 1 failed** (flaky `PopupShell` timeout 5000 ms).
- `npm run build` — **FAIL** через 3 TS помилки.
- `npm run build-storybook` — OK.

---

## Блок 1 — Release blockers (виправити в першу чергу)

### 1.1 TS build errors

| # | Файл:рядок | Проблема | Fix |
|---|---|---|---|
| 1 | `src/modules/notes/NoteAttachmentsPanel.tsx:104` | Доступ до `event.paths` на union без narrowing (`type: "over"` не має `paths`). | Додати guard `if (event.type !== 'enter') return;` перед доступом, або dispatch за `event.type`. |
| 2 | `src/modules/system/SmartScanPanel.tsx:301` | `bucket.title` — поля немає в типі `Bucket`. | Або розширити `Bucket` полем `title?: string`, або замінити на існуюче поле (перевірити, який label уже визначений у типі). |
| 3 | `src/shared/ui/NumberInput.tsx:6` | `useRef` імпортований, але не використаний (TS6133). | Видалити з імпорту. |

### 1.2 Flaky тест

- `src/shell/PopupShell.test.tsx:31` — `keeps previously opened tabs mounted (hidden) to preserve state` упирається в `testTimeout: 5000 ms`. **Severity: Medium**. Fix: читати тест, зʼясувати що зависає (ймовірно очікування на lazy chunk). Правильне рішення — явний `await screen.findBy…` замість `waitFor`, або прибрати штучний suspense у моках.

---

## Блок 2 — Security (pre-production)

### 2.1 Plaintext API-keys fallback — High

- `src/settings/store.ts:55` — `aiApiKeys: Partial<Record<AiProvider, string>>` в plaintext `settings.json`.
- `src-tauri/src/modules/telegram/llm/factory.rs:85-95, 113` — fallback на цей Store, коли Keychain порожній.
- **Fix**: у release-білді fallback повністю вимкнути (`#[cfg(debug_assertions)]`), у UI показати banner, якщо key береться не з Keychain. Keychain має лишитись єдиним джерелом у продакшені.

### 2.2 URL scheme allowlist — Medium

- `src-tauri/src/modules/webchat/commands.rs:255` — `url::Url::parse` приймає будь-яку схему (`file:`, `data:`, `javascript:`).
- `src-tauri/src/modules/downloader/commands.rs:29, 67` — `dl_detect_quick/full` передають URL у `yt-dlp` без валідації схеми.
- **Fix**: додати helper `fn ensure_http_scheme(url: &str) -> Result<Url, String>` у `shared` чи у кожному модулі; відхиляти все, що не `http`/`https`.

### 2.3 Tauri capabilities надто широкі — Medium

- `src-tauri/capabilities/default.json` — `opener:allow-open-path` scope `$HOME/**`.
- **Fix**: звузити до `$HOME/Downloads/**`, `$HOME/Movies/Stash/**`, `$APPDATA/**`, `$APPLOCALDATA/**`. Якщо модулю треба доступ до іншої директорії — додавати її окремо.

### 2.4 CSP null — Medium

- `src-tauri/tauri.conf.json` — `"csp": null`.
- **Fix**: додати мінімальну policy — `default-src 'self' ipc: asset: tauri: https: data:` (перевірити, що wbview підвантажує шрифти/accent). Embedded webviews (child windows) ходять своїм роутом, не обмежені.

### 2.5 Clipboard секрет-subtype у plaintext історії — Medium

- `clipboard_history` SQLite містить plaintext навіть для `secret` subtype.
- **Fix** (окремо від цього релізу, закласти задачу): не зберігати `secret` у історію за замовчуванням + setting «redact secrets».

---

## Блок 3 — CLAUDE.md convention violations

### 3.1 `text-[12px]` замість `text-meta`

- `src/modules/notes/NoteAttachmentsPanel.tsx:203,227`
- `src/modules/telegram/sections/InboxPanel.tsx:317,348,357,618`

**Fix**: замінити на `text-meta` (12px — дефолтний розмір токена `meta`). CLAUDE.md забороняє 11/13/15/18, але для консистентності 12px теж краще через токен.

### 3.2 Inline `rgba(var(--stash-accent-rgb), …)`

- `src/shared/ui/Markdown.tsx:87` — допустимо, це Tailwind arbitrary (`text-[color:…]`).
- `src/shared/ui/Button.tsx:54, 74` — аналогічно arbitrary, прийнятно.
- `src/modules/telegram/sections/inbox/MediaItems.tsx:109` — arbitrary class, формально дозволено, але ліпше рефакторити у токен-клас (`bg-accent-muted`), якщо такий зʼявиться.

Не блокер, але занотовано.

---

## Блок 4 — Test coverage gaps

### Frontend модулі без тестів або зі слабким покриттям

| Модуль | Статус | Що додати |
|---|---|---|
| `src/modules/terminal/` | **0 тестів** | Smoke `TerminalShell` (рендер без краху, invoke mocks), api.ts happy-path. |
| `src/modules/ai/` | 2 теста | Компоненти `AiShell`, `useAiChat`, `ChatComposer` — streaming + cancel. |
| `src/modules/music/` | 2 теста | `api.ts` + listen-events. |
| `src/modules/whisper/` | 1 тест | `api.ts`, download/cancel. |
| `src/modules/web/` | 3 теста | `EmbeddedWebChat.tsx` — focus bridge + shortcuts. |
| `src/modules/telegram/` | 6 тестів | `TelegramShell`, pairing, reminders на frontend. |

### Rust модулі без unit тестів

- `src-tauri/src/modules/ai/commands.rs`, `ai/state.rs`, `ai/backup.rs`
- `src-tauri/src/modules/telegram/notifier.rs`, `calendar.rs`, `battery_watcher.rs`
- `src-tauri/src/modules/webchat/commands.rs`, `webchat/mod.rs`
- `src-tauri/src/modules/pomodoro/commands.rs`, `driver.rs`, `state.rs`, `model.rs`
- `src-tauri/src/modules/metronome/commands.rs`
- `src-tauri/src/modules/system/commands.rs`, `quick_actions.rs`

### E2E

- `tests/e2e/smoke.spec.ts` покриває тільки навігацію. Додати сценарії: downloader drop URL, clipboard copy/reveal, translator input, AI chat message.

---

## Блок 5 — Production readiness (не критично для цього релізу)

- `.env.example` / onboarding docs — відсутні. Написати CONTRIBUTING.md з описом: Keychain-based keys, як запустити dev, як білдити.
- `package.json` version `0.1.0` — підняти до `0.2.0` або semver згідно зі змінами перед тегом.
- Storybook chunk 1.2 MB warning — бутафорія, не блокер.

---

## Порядок виправлення

1. **Блок 1** (build errors + flaky test) — 30–60 хв.
2. **Блок 2** (security hardening) — 60–90 хв.
3. **Блок 3** (convention cleanup) — 20 хв.
4. **Блок 4** (terminal тести як мінімум) — 30 хв. Решта — окремі задачі після релізу.
5. Фінальна валідація: `npm run build && cargo test && npm test && npm run build-storybook`.

## Критерії готовності до production

- [ ] `npm run build` зелений (TS errors = 0)
- [ ] `cargo test` зелений
- [ ] `vitest run` зелений (1 flaky test зафіксовано)
- [ ] `npm run build-storybook` зелений
- [ ] API keys у release беруться **тільки** з Keychain
- [ ] URL-схеми валідуються на Rust-боці у webchat/downloader
- [ ] CSP установлений
- [ ] `opener` capabilities звужені
- [ ] terminal модуль має мінімум smoke test
