# Stash 0.1.10

Перший release після code review (`docs/CODE_REVIEW_2026-04-26.md`) — фокус на безпеці, lifecycle і test infrastructure. Жодних breaking changes.

## Highlights

### 🔒 Security & lifecycle (#1)
- **Loopback media server** тепер має повний lifecycle: shutdown flag, `JoinHandle`, ідемпотентний `stop()`, hook на `RunEvent::Exit`. Concurrent connection handlers обмежені (`MAX_INFLIGHT=16`, 503 на overflow). Symlink rejection (`canonicalize → 404`), RFC-7233 416 на bad Range header.
- **`assetProtocol.scope`** звужено: видалено `/private/tmp/**`, `/tmp/**`, `/var/folders/**` (можливий локальний attack vector). Залишено `$TEMP/Stash/**`.
- **Trash flow** перевели з `osascript "tell Finder to delete..."` на native `NSFileManager.trashItem` (`trash` crate). Прибрали AppleScript escape-семи для шляхів з `\n`/`{`/`}`.
- **yt-dlp downloader** тепер верифікує SHA-256 проти `SHA2-256SUMS` манифесту після curl-завантаження. Mismatch → видалення partial-файлу. Захищає від TLS-MITM / mirror compromise.

### 🧹 Hooks & UI (#2, #4)
- `AudioPlayer` bytes/stream loaders переведено на `AbortController` для symmetric cleanup.
- `NotesShell.notes:changed` listener тепер реєструється раз на mount через ref pattern — раніше re-bind на кожну зміну search-query губив події.
- `useVideoDetect` interval depends on derived `hasInflight` boolean — adding/completing card більше не перестворює timer mid-tick.
- **AudioRecorder**: `cleanup()` тепер зупиняє `MediaRecorder` при unmount mid-recording (раніше recorder продовжував писати у detached chunk array).
- **Metronome**: новий `visibilitychange` handler resume-ить `AudioContext` коли таб стає visible — без цього метроном замовкав після `⌘⇧V` toggle.

### 🤖 Agent surface (#1)
- Нові LLM tools для асистента: `clipboard_search`, `clipboard_pin`, `clipboard_clear`. Закриває §3.2 gap у code review.

### 💾 Backup (#5)
- Telegram модуль тепер експортується у backup: `telegram.sqlite` (paired chat-id, voice settings, AI settings, inbox, memory facts, reminders) + `telegram/inbox/` media. Bot tokens лишаються в Keychain (re-pair на новому Mac за дизайном).
- В `backup/registry.rs` задокументовано чому `system`/`terminal`/`voice`/`music`/`webchat` не мають провайдерів.

### 🧪 CI & tooling (#1, #3)
- `cargo clippy --all-targets --workspace -- -D warnings` тепер у CI. Workspace `[lints.clippy]` config + 14 manual fixes.
- Vitest coverage gate: `thresholds: { lines: 70 }` (актуальне покриття ~87 %).
- Playwright: `retries: process.env.CI ? 2 : 0`, `trace: 'retain-on-failure'`.

## Verified false positives in the review (no code change)
- `framer-motion` / `motion.div` — не використовується; `prefers-reduced-motion` вже глобально вимикає всі transitions у `tokens.css:982`.
- `loadStream` / `attachTo` функції в `AudioPlayer.tsx` — не існують; cancellation-flag pattern був коректним і modernised до `AbortController`.
- "Duplicate chat UI between AI і Telegram" — `TelegramShell` лише inbox, `ChatThread` вже виокремлений у `ai/`.

## Upgrade notes
Жодних migrations. Існуючі backup-zip-и без `telegram/` стрічки залишаються валідні (restore просто пропустить відсутню секцію).

---

_Підготовлено разом із 5 окремими PR'ами (#1-#5)._
