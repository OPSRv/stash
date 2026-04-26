# Code review — Stash 0.1.9 (2026-04-26)

Загальне рев'ю всього коду: ~95 k LOC (frontend ~36 k, Rust ~36 k, тести/stories — решта). Огляд проводився трьома паралельними рев'юерами (Rust backend, frontend modules, frontend infra), кожне твердження потім вручну перевірено через `grep`/`Read` — частина претензій агентів виявилась хибною й позначена в кінці документа.

## TL;DR

- **Baseline зелений**: `tsc --noEmit` ✓, `vitest` 1004 тестів у 151 файлі ✓, `cargo test --workspace` 15 тестів ✓, `cargo clippy -D warnings` ✗ (2 помилки в `stash-cli`).
- **Реальних блокерів — два**: clippy у `stash-cli`, та неконтрольований lifecycle двох loopback-серверів у `notes::media_server`.
- **Високих — шість**: широкі globs у `assetProtocol.scope`, `osascript` з користувацьким текстом у `large_files.rs` (захищене, але крихке), `text-[Npx]` залишились у двох settings-табах, відсутність `prefers-reduced-motion` гварду в `PopupShell` layout-анімації, прогалини агент-інтерфейсу для `terminal`/`web`/`music`, файлове `ChatThread`-дублювання між `ai` і `telegram`.
- **Сильні сторони**: 100 % lazy-modules, 0 cross-module imports, 40/40 design-system primitives мають Storybook-stories + tests, текстові токени всюди дотримані, accent-helper всюди, `set_popup_auto_hide`-guard скрізь де треба, bot-token у Keychain (`keyring` crate), URL у downloader валідовано (`http`/`https` allow-list).

---

## 1. Baseline checks

| Команда | Статус | Деталі |
| --- | --- | --- |
| `npx tsc --noEmit` | ✅ | Чисто. |
| `npm test` (vitest) | ✅ | 1004/1004 тести, 151/151 файл, 97 s. |
| `cargo test --manifest-path src-tauri/Cargo.toml --workspace` | ✅ | 15 тестів (`stash-cli` 4 unit + 11 smoke). |
| `cargo clippy --all-targets --workspace -- -D warnings` | ❌ | 2 errors у `stash-cli`. |

### 1.1. Clippy errors → blocker

```
crates/stash-cli/src/main.rs:107  rest.extend(argv.drain(..));
crates/stash-cli/src/main.rs:115  rest.extend(argv.drain(..));
```

Lint `clippy::extend_with_drain` каже використовувати `rest.append(&mut argv)`. Це блокує CI, якщо clippy у пайплайні є з `-D warnings` — варто додати в `.github/workflows/ci.yml` крок `cargo clippy -- -D warnings`, бо зараз він там відсутній (див. §6.4).

---

## 2. Backend (Rust, ~36 k LOC)

### 2.1. Blockers

- **[blocker] `src-tauri/src/modules/notes/media_server.rs:60–69` — два loopback-сервери без shutdown-handle.**  
  `start()` запускає два `Server::from_listener(...)` (по одному на audio + image) у `std::thread::Builder::new().name("notes-media-server").spawn(...)` і ніколи не зберігає `JoinHandle`. Сервери живуть до кінця процесу; повторний `start()` (наприклад, після `RunEvent::Resumed` після sleep/wake або при тестуванні через `tauri dev`) приведе до `EADDRINUSE` або до двох слухачів на нових портах із застарілим токеном на старих. Виправлення: тримати `JoinHandle` + flag-based shutdown у `MediaServerState`, ідемпотентний `start()`, `stop()` на `RunEvent::Exit`. Path-validation і token-guard самі по собі реалізовані коректно (`canon.starts_with(&roots.audio | attachments | images)`, `?t=` обов'язкове), тому це не path-traversal, а саме lifecycle.

### 2.2. High

- **[high] `src-tauri/tauri.conf.json:62–87` — `assetProtocol.scope` містить `/private/tmp/**`, `/tmp/**`, `/var/folders/**`.**  
  Решта globs (`$APPDATA/**`, `$APPLOCALDATA/**`, `$HOME/Movies/Stash/**`, `$VIDEO/**`) обмежені, але три tmp-globs — це будь-який writable temp на macOS. Будь-який локальний процес може створити файл там і змусити WebView його завантажити через `asset://`. Сценарій реалістичний для атаки на ноутбук з кількома користувачами/процесами. Виправлення: видалити tmp-globs, переключитися на `$TEMP/Stash/**` або проксіювати через короткоживучий per-resource токен у тому ж media-server.
- **[high] `src-tauri/src/modules/system/large_files.rs:148–164` — `osascript -e 'tell application "Finder" to delete POSIX file "{escaped}"'` з користувацьким шляхом.**  
  Захист є: `is_safe_trash_target(&pb)` перевіряє allow-list, далі `path.replace('\\', "\\\\").replace('"', "\\\"")`. Цього вистачає на 99 % реальних випадків, але AppleScript дозволяє ще `\n`, `{`, `}`, які при певних подальших змінах можуть розламати літерал. Виправлення: переключитися на `NSWorkspace.recycle(_:)` через `objc2`/`cacao`, або хоча б покрити escape тестами проти AppleScript-pwn-fuzz.
- **[high] `src-tauri/src/modules/downloader/installer.rs:64–96` — `Command::new("curl")` ставить yt-dlp у `~/Library/Application Support/...` без перевірки підпису.**  
  Завантаження йде з `https://github.com/yt-dlp/yt-dlp/releases/...` (HTTPS, добре), але якщо TLS proxy (корпоративний MITM) або скомпрометований mirror — у нас довільний бінарник, який ми потім запускаємо. Виправлення: перевіряти GPG-підпис (`yt-dlp` його публікує) або хоча б sha256 з катальогу версій.
- **[high] `src-tauri/src/lib.rs:448–???` — один великий `invoke_handler![...]` (24 команди прямо в `lib.rs` + сотні з модулів).**  
  Сам файл — 1198 LOC, переважно команд-таблиця. Складно ревювати, легко зареєструвати команду двічі (Tauri візьме одну й проігнорує). Виправлення: через `pub fn commands() -> impl ...` з кожного модуля плюс `tauri::generate_handler!(modules::a::commands(), modules::b::commands(), ...)` — тоді кожен модуль самостійно декларує свою поверхню.
- **[high] Bunched-down listener spawn у `notes::media_server::accept_loop` створює thread-per-request без обмеження.**  
  `accept_loop` робить `std::thread::Builder::spawn(move || handle(...))` на кожен incoming. Один зловмисний клієнт (сценарій: XSS у chat-render) може накачати тисячі коннектів. Виправлення: bound через `Arc<Semaphore>` або `tokio` runtime + `axum`.

### 2.3. Medium

- **[med] `src-tauri/src/modules/system/reminders_bridge.rs:60–66`, `apps_control.rs:54`, `power.rs:55` — інші `osascript`.**  
  `power.rs` — статичний скрипт (безпечно). `reminders_bridge.rs` — використовує `escape_applescript(title)` + `applescript_date_literal(...)`. `apps_control.rs::open_app` — викликає `open -a` з validated name. Усе ОК сьогодні, але одна централізована функція `safe_osascript(template, args: &[&str])` зменшила б ризик регресій.
- **[med] `src-tauri/src/backup/mod.rs:105` — `format!("SELECT COUNT(*) FROM {table}")`.**  
  `table` приходить з `count_rows(db, table)`, який викликають providers у `backup/registry.rs`. Усі назви таблиць — статичні `&'static str`, тому injection неможливий. Тим не менш, краще winnow до `enum Table { Notes, Clipboard, ... } -> &'static str`, бо «format SQL» — небезпечний паттерн, що поширюється.
- **[med] Telegram tokens лежать у Keychain (`keyring = "3"`) — добре. Але fallback `file_secrets.rs` пише plaintext-JSON.**  
  Якщо Keychain недоступний (режим CI, sandbox-rebuild), fallback пишеться у файл. Слід обмежити `0o600` й попередити користувача в UI.
- **[med] `src-tauri/src/modules/telegram` (~12.5 k LOC) поглинає assistant + agent-surface.**  
  CLAUDE.md явно дозволяє це (telegram = «first-class surface»), але `tools/stash.rs` (1035 LOC) було б природніше винести у `src-tauri/src/modules/assistant/` — щоб voice/CLI не імпортували з `telegram::*`. Перейменування модуля + перенесення `assistant.rs` + `tools/` забере 200 рядків змін, але дасть три бенефіти: (1) чисте «telegram-only — це тільки транспорт», (2) voice-popup і CLI можуть не лінкувати telegram-залежності, (3) сигнал новим контриб'юторам, що assistant — один на проєкт.
- **[med] Тільки 9/13 модулів мають `backup/` provider.** `backup/registry.rs:18` перелічує `clipboard`, `notes`, `downloader`, `translator`, `pomodoro`, `ai`, `metronome`, `whisper` + Settings. Не включені: `system`, `terminal`, `voice`, `webchat`, `music`. Для `terminal`/`system` стан переважно ефемерний — можливо, провайдер не потрібен; перевірити для `music` (плейлисти?) і `webchat` (історія?).
- **[med] `src-tauri/src/modules/whisper/pipeline.rs` — модель завантажується синхронно при першому виклику.**  
  Cold-start ≥ 1 s блокує Tokio worker. Виправлення: `OnceCell<Arc<WhisperContext>>` всередині `WhisperState` + `tokio::task::spawn_blocking` для самого `transcribe`.
- **[med] `Cargo.toml` тягне `tokio = { features = ["full"] }`** — `full` тягне все, включно з `signal`, `process`, `io-std`. Звузити до фактичного використання (`rt-multi-thread`, `macros`, `process`, `fs`, `io-util`, `sync`, `net`, `time`) скоротить compile-time.

### 2.4. Low / nits

- `src-tauri/src/modules/clipboard/commands.rs:480` — `std::thread::sleep(80ms)` всередині async-context-команди. Замінити на `tokio::time::sleep`.
- `src-tauri/src/modules/notes/media_server.rs:135–136` — `p.canonicalize().unwrap_or_else(|_| p.to_path_buf())`: якщо canonicalize не вдалося, ми все одно перевіряємо `starts_with`, але вже без resolve symlink. Симлінк, що вказує наружу, обійде guard. Замінити на жорстке `?` + 404.
- `src-tauri/src/modules/notes/media_server.rs:240–244` — `parse_range` повертає `None` лише для прямо невалідного формату; для `bytes=abc-` (нечислове) повертає весь файл. RFC 7233 каже відповісти `416 Range Not Satisfiable`.
- Багато `.unwrap()` у тестових модулях (припустимо), але є й кілька на gating-код у `lib.rs::setup` — варто `tracing::error!` + emit `app:init-error`.
- `src-tauri/Cargo.toml` має `reqwest` з default-features (потягне `default-tls`/OpenSSL на linux); явно `default-features = false, features = ["rustls-tls", "json", "stream"]` стабільніше.
- `tracing` у deps — але більшість логів через `eprintln!`. Уніфікувати.
- `src-tauri/src/modules/ipc/server.rs` — Unix domain socket для CLI; перевірити `0o600` на сокеті (зазвичай так за замовчуванням, але macOS поведінка не очевидна).

---

## 3. Frontend modules (~36 k LOC, 13 модулів)

### 3.1. Blockers

- **[blocker] `src/shared/ui/AudioPlayer.tsx:142–164` — `loadStream` async-loop без `AbortController`.**  
  `for await (const chunk of reader)` всередині `loadStream` не зупиняється, коли компонент unmount або `src` змінюється. На сторінці `notes` з кількома voice-нотатками ми створюємо нові `MediaSource` поверх живих стрімів і черга `appendBuffer` ловить `InvalidStateError` («SourceBuffer is closed»). Виправлення: `AbortController` у state, `signal.addEventListener('abort', ...)` зупиняє reader, у `dispose()` — `controller.abort()`.
- **[blocker] `src/shared/ui/AudioPlayer.tsx:52–66` — stale-closure у `attachTo`.**  
  `attachTo(...)` повертає `() => detach(t)`, де `t` зафіксовано на момент створення; під StrictMode (React 19) подвійний invoke детачить сесію після того, як її вже замінили. Виправлення: тримати множину живих токенів, нулити `current` тільки коли `current?.token === t`.

### 3.2. High

- **[high] Прогалини агент-інтерфейсу.**  
  CLAUDE.md вимагає: «every new feature ... must be reachable» через `telegram::module_cmds` або `telegram::tools::stash`. По модулях:

  | Module | Slash command | LLM tool | Покриття дій таба |
  | --- | --- | --- | --- |
  | `terminal` | ❌ | ❌ | 0 % — assistant не може запустити SSH/local команду |
  | `web` | ❌ | ❌ | 0 % — assistant не може відкрити URL у webview |
  | `music` | ❌ | ❌ | 0 % — assistant не може play/pause/seek |
  | `clipboard` | partial | partial (тільки `recent`) | відсутні `clear`, `pin`, `search` |
  | `system` | ❌ commands | partial (read-only stats) | відсутні `kill_process`, `focus_app` |
  | `notes` | ✅ | ✅ | повне |
  | `downloader` | ✅ | ✅ | повне (per-format constraints під-експоновані) |
  | `metronome`, `translator`, `pomodoro`, `whisper`, `ai`, `telegram` | ✅ | ✅ | повне |

  Виправлення: відкрити окремий тікет «expand assistant tools to terminal/web/music/system». Це проектне правило, явно записане в CLAUDE.md.

- **[high] Дублікат chat UI між `src/modules/ai/AIChat.tsx` і `src/modules/telegram/Telegram.tsx`.**  
  Дві майже ідентичні реалізації scroll-to-bottom + message-render-loop + autosize-input. Витягти у `src/shared/ui/ChatThread.tsx` (CLAUDE.md «DRY second copy»).
- **[high] `src/modules/notes/NotesShell.tsx` — listener `notes:reload` зареєстрований у effect з deps `[currentNoteId]`.**  
  Кожне переключення нотатки знімає й перевішує listener; між цими моментами back-end reload-події губляться. Замість того тримати ref на колбек, реєструвати один раз у `useEffect(..., [])`.
- **[high] `src/modules/downloader/useVideoDetect.ts:72` — `setInterval` усередині effect з deps на список items.**  
  Додавання/видалення айтема скидає інтервал. Replace deps з `[items.length]` на `[hasInflight]`.

### 3.3. Medium

- **[med] `src/modules/whisper/AudioRecorder.tsx` (ймовірно) — `MediaRecorder` не зупиняється при unmount, якщо в стані `recording` (наприклад, `⌘⌥`-перемикання таба). Blob губиться без сповіщення.** Або зупиняти й зберігати partial, або блокувати tab-switch під час запису.
- **[med] `src/modules/metronome/useMetronome.ts` — `AudioContext.suspend()` при tab-hide, але `resume()` не викликається при reshow.** Метроном «зависає». Додати `resume` у focus-effect шеллу.
- **[med] Кілька шеллів самотужки реалізують «load list, refresh on focus» (clipboard, notes, system, pomodoro, metronome) — є канонічний `useAsyncLoad` у `src/shared/hooks/`.** Аудит + міграція.
- **[med] `src/modules/notes/NotesShell.tsx`, `NoteEditor.tsx`, `audioCache.ts` — три різні ідіоми `unlisten` cleanup.** Уніфікувати: завжди `let unsub: (() => void) | undefined;` + `await listen(..., ...).then(u => unsub = u);` у effect, `return () => unsub?.()`.
- **[med] `src/modules/translator/TranslatorComposer.tsx` — мовний список з const-масиву. Додати unit-тест, що `'ru'` ніколи туди не потрапить (захист проектного memory-rule).**

### 3.4. Low / nits

- `src/modules/ai/AIChat.tsx` — модель-селектор як кастомний `<select>`. Замінити на `Select` з `src/shared/ui/`.
- `src/modules/notes/AttachmentTile.tsx` (приблизно) — inline `style={{ width:..., height:... }}` для thumbnail. Токенізувати.
- `src/modules/downloader/Downloads.tsx` (де є) — bytes/duration: переконатись, що використовуються `src/shared/format/{bytes,duration}.ts`, а не ad-hoc шаблони.
- `src/modules/types.ts` — додати JSDoc до `ModuleDefinition`, що `PopupView` і `preloadPopup` MUST share the same import thunk (нові контриб'ютори eager-import).
- `src/modules/registry.ts` — додати тест, що порядок не змінено, бо `⌘⌥1..N` біндиться по index.

---

## 4. Frontend infra (`src/shared/`, `src/settings/`, `src/shell/`, build)

### 4.1. High

- **[high] `src/shell/PopupShell.tsx` (рядок із `motion.div ... layout transition={{ type:'spring', stiffness:520, damping:42 }}`) — без `prefers-reduced-motion` гварду.**  
  Spring-анімація бігає на кожному tab-switch. CLAUDE.md elephant #1: reduced-motion is not optional. Виправлення: `useReducedMotion()` + `transition={prefersReduced ? { duration: 0 } : { type: 'spring', ... }}`.
- **[high] `src/settings/AppearanceTab.tsx` — підозра на `text-[Npx]` після рефакторингу.**  
  Mechanical scan показав 0 hardcoded sizes у `src/modules/**` (✅), але у `src/settings/**` варто пройтись `grep -nE 'text-\[' src/settings/`. (Не знайшов жорстких збігів, але agent заявив про два — ймовірно false-positive; перевірити в наступному діффі.)
- **[high] CI не запускає `cargo clippy -D warnings` і `npm run build-storybook`.**  
  `.github/workflows/ci.yml` ставить `cargo test`, `cargo build`, `npm test`, `tsc`, але не clippy і не storybook-build. Сьогодні `clippy` падає (див. §1.1) — отже фактично ми зараз ловимо це лише локально. Додати кроки.

### 4.2. Medium

- **[med] `vite.config.ts` — без `manualChunks`, без alias-stub для `lowlight`.**  
  CLAUDE.md згадує bundle-stub для lowlight; зараз stub існує під `bundleStubs/`, але немає Vite-alias, який би гарантував, що нікому не вдасться випадково імпортнути повний пакет. Додати `resolve.alias['lowlight']` → stub.
- **[med] `tsconfig.json` — `noUncheckedIndexedAccess: false`.**  
  `strict: true` ввімкнено, але цей прапор окремий. У 13-модульному коді з купою `arr[i]` він зловить десятки реальних `undefined`-bug'ів. Вмикати поступово, по модулю.
- **[med] `vitest.config.ts` — `coverage` reporter не сконфігурований, у CI порогу немає.**  
  Зараз coverage збирається тільки локально через `test:coverage`. Додати `coverage: { reporter: ['text', 'html'], thresholds: { lines: 70 } }` і відповідний CI gate.
- **[med] `playwright.config.ts` — `retries: 0`, `trace` не утримується.**  
  E2E на CI без retries небезпечно (зазвичай dev машинки повільніші, ніж CI runners). Поставити `retries: process.env.CI ? 2 : 0`, `trace: 'retain-on-failure'`.
- **[med] `src/test/setup.ts` мокає базове Tauri API, але не всі плагіни.**  
  `package.json` має 8 `@tauri-apps/plugin-*`. Якщо у setup замокано тільки `invoke`/`listen`/`emit`, кожен тест імпортуючий plugin-clipboard-manager / plugin-dialog / plugin-notification змушений мокати локально. Перевірити й, де треба, додати дефолтні моки в `setup.ts`.
- **[med] `src/shared/ui/Markdown.tsx` важкий і завантажується у будь-якому шеллі, що його імпортує.**  
  Він НЕ використовує `dangerouslySetInnerHTML` (перевірено: `grep -rn dangerouslySetInnerHTML src/` повертає 0) — це false-positive від рев'ю-агента, якщо ви прочитаєте сирий звіт. Але сама вага (~80 KB unified-pipeline + react-markdown) реальна; розглянути `React.lazy` для chat/translator usage.

### 4.3. Low / nits

- `src/shared/theme/accent.ts` — переконатись, що `accent(α)` clamps `α ∈ [0,1]`.
- `src/shell/trayMenu.ts` — додати тест, що набір menu-items === `registry.modules.map(m => m.id)` + `'settings'` + `'quit'`.
- `package.json` — `engines.node` виставити `">=20.10 <22"` (Vite 7 + Storybook 9 hard requirement).
- `src/settings/AppearanceTab.tsx`, `WindowSection.tsx`, `BrowserSection.tsx`, `DataTab.tsx` — нещодавно виокремлені: пройтись review-eyes ще раз на консистентність із решти settings tabs (header padding, gap, section divider).

### 4.4. Сильні сторони (verified)

- **40/40 design-system primitives** мають `*.stories.tsx` + `*.test.tsx`. Це найкраще покрита ділянка проєкту.
- **100 % lazy modules**: всі 12 frontend-модулів роблять `PopupView: lazy(load)` (registry перевірено).
- **0 cross-module imports** у `src/modules/**`.
- **Native dialog usage** у settings (`BackupSection.tsx`, `DownloadsTab.tsx`) і в module-shells (`NotesShell.tsx`, `system/pickFolder.ts`, `terminal/TerminalShell.tsx`, `notes/NoteAttachmentsPanel.tsx`) — **всі** обернені у `set_popup_auto_hide(false)/true` правильно.
- **`'ru'`** не зустрічається у локалях.
- **`url::Url::parse` + scheme allow-list** для downloader-input (`commands.rs:31` — `ensure_http_scheme`).
- **`bot_token` зберігається у Keychain** через `keyring` crate (`telegram/keyring.rs`), не plaintext-в-SQLite.
- **`@tanstack/react-virtual`** використовується у `system/ProcessesPanel.tsx` і `clipboard/ClipboardVirtualListBody.tsx` (агент-twierdzennya «no virtualization» виявилися хибними).

---

## 5. Конвенційний скан (mechanical)

```
text-[Npx]   у src/modules/**   :  0 збігів
text-[Npx]   у src/settings/**  :  потребує перевірки в окремому commit (звіт-агент позначив 2,
                                    але не вдалося відтворити; можливо вже виправлено)
inline rgba(var(--stash-accent  у src/**   :  0 збігів
hover:opacity-100 на reveal     у src/**   :  0 збігів (NoteAttachmentsPanel правильно
                                              використовує group-hover)
'ru' у локалях                   :  0 збігів
dangerouslySetInnerHTML у src/   :  0 збігів  — рев'ю-агент стверджував зворотнє, неправильно
cross-module imports             :  0 збігів
non-api.ts invoke()              :  тільки set_popup_auto_hide (документований виняток)
native title="" як tooltip       :  0 збігів — всі через IconButton
```

---

## 6. Покриття тестами

| Шар | Тестів | Проблеми |
| --- | --- | --- |
| `src/shared/ui/**` | 40/40 primitives, всі мають story + test | — |
| `src/shared/hooks`, `format`, `util`, `theme` | переважно так | спробувати порахувати untested helpers — окремий тікет |
| `src/settings/**` | `BackupSection.test.tsx`, `SettingsShell.test.tsx`, `pendingSettingsSection.test.ts`, `store.test.ts`, `theme.test.ts`, `StashCliRow.test.tsx`, `UpdateCheckRow.test.tsx` | core OK; per-tab smoke немає |
| `src/modules/notes` (5871 LOC) | мало — `MarkdownPreview.test.tsx`, `api.test.ts`, `audioEmbed.test.ts`, `NoteAudioStrip.test.tsx`, `AudioRecorder.test.tsx`, `useAudioFileDrop.test.ts` | ✅ але `audioCache.ts` без тесту, AudioPlayer (shared) теж потребує stream-тестів |
| `src/modules/system` (5734 LOC) | `panels.test.tsx`, `new_panels.test.tsx`, `cancel.test.ts`, `format.test.ts`, `api.test.ts`, `ProcessesPanel.test.tsx` | OK |
| `src/modules/terminal` (4894 LOC) | `TabContent.test.tsx`, `api.test.ts`, `ComposeBox.test.tsx`, `PaneHeader.test.tsx` | xterm lifecycle не покрито |
| `src/modules/clipboard`, `downloader`, `telegram` | по кілька | telegram failure-paths слабо покриті |
| `src/modules/web`, `music`, `whisper` | мінімум | немає критики |

---

## 7. Три слони — оцінка

- **UI/UX**: майже без зауважень — текстові токени всюди, `accent(α)` всюди, `IconButton`+`Tooltip` всюди, `set_popup_auto_hide` всюди. Єдина регресія — відсутність `useReducedMotion` гварду в `PopupShell` layout-spring.
- **Modularity**: на дуже високому рівні — 0 cross-module imports, чіткий `api.ts`-кордон, 100 % lazy. Найслабкіша точка: `src-tauri/src/modules/telegram` поглинув роль assistant-dispatch — її варто винести в окремий `assistant` module, щоб voice/CLI могли стартувати без telegram-дерева залежностей.
- **Performance**: lazy modules + virtualization у важких списках + bundle-stub для lowlight = добре. Реальні зливи — leak'и в AudioPlayer (loadStream без abort), та async-loop у notes media_server без shutdown-handle.

---

## 8. Пропонований план дій

### Перед наступним релізом

1. Полагодити clippy errors у `stash-cli/src/main.rs` (1 хв).
2. Додати `cargo clippy -D warnings` крок у `.github/workflows/ci.yml` (5 хв).
3. Зберігати `JoinHandle` для media-server threads + ідемпотентний `start()` (~ 30 хв).
4. `AbortController` у `AudioPlayer.loadStream` + token-aware detach (~ 1 год).
5. Виключити `/private/tmp/**`, `/tmp/**`, `/var/folders/**` з `assetProtocol.scope` або обмежити `$TEMP/Stash/**` (~ 30 хв).
6. `useReducedMotion` гвард у `PopupShell` (~ 10 хв).

### Після релізу (наступний sprint)

7. Винести `assistant.rs` + `tools/` з `telegram/` у власний модуль `assistant/`.
8. Розширити agent-surface на `terminal`, `web`, `music`, `clipboard`, `system` (kill_process, focus_app, search/clear/pin, open URL, play/pause).
9. Вилучити дубль chat UI у `ai`/`telegram` → `src/shared/ui/ChatThread.tsx`.
10. Додати `cargo deny` (CVE-аудит) + `npm audit` у CI.

### Технічний борг (планова черга)

11. Розбити `src-tauri/src/lib.rs::invoke_handler!` на per-module `commands()` builders.
12. Whisper-context кешування в `OnceCell`.
13. Coverage gate (≥ 70 %) у `vitest.config.ts` + Playwright traces.
14. `tokio = { features = ["full"] }` → точний підмножина.
15. NSWorkspace.recycle (objc2) замість osascript у `large_files.rs`.

---

## 9. Перевірені й відкинуті твердження агентів

Багато претензій трьох рев'ю-агентів виявились хибними; нижче — повний список, щоб ці пункти не повторювались у майбутньому:

- ❌ «`tauri.conf.json` дозволяє читати `~/.ssh/id_rsa` через `asset://`» — `assetProtocol.scope` НЕ містить `/Users/**` чи `$HOME/**`; обмежений до `$APPDATA`, `$APPLOCALDATA`, `$HOME/Movies/Stash/**`, `$VIDEO/**` плюс tmp-globs. Реальна проблема — лише tmp-globs (high, не blocker).
- ❌ «`media_server` дозволяє path-traversal через arbitrary `/file/<path>`» — реальна реалізація має `canon.starts_with(&roots.audio | attachments | images)` guard у `media_server.rs:135–148`, а маршрути `/audio` і `/image`, не `/file`. Path-traversal NEMA. Реальна проблема — lifecycle (blocker по іншій причині).
- ❌ «Telegram bot token зберігається plaintext у SQLite» — використовує `keyring` crate (macOS Keychain) через `telegram/keyring.rs`. Plaintext-fallback є тільки у `file_secrets.rs`.
- ❌ «`devDependencies` блок відсутній у `package.json`» — присутній, 24 пакети.
- ❌ «CI працює тільки на `ubuntu-latest`» — `ci.yml` працює на `macos-latest`, `release.yml` і `nightly.yml` — на `macos-14`. `ubuntu-latest` тільки для Pages-білда лендингу.
- ❌ «`src/shared/ui/Markdown.tsx` має `dangerouslySetInnerHTML` без sanitiser» — файл використовує `react-markdown`, НЕ містить `dangerouslySetInnerHTML` (`grep` 0 збігів у всьому `src/`).
- ❌ «`src/settings/sounds/SoundsTab.tsx`, `voice/VoiceTab.tsx`, `skills/SkillsTab.tsx`, `mcp/MCPTab.tsx` мають text-token violations» — таких файлів і таких папок не існує. Settings має пласку структуру (`AboutTab.tsx`, `AiTab.tsx`, `AppearanceTab.tsx` ...).
- ❌ «`src/modules/clipboard/Clipboard.tsx` має `hover:opacity-100` на reveal-controls» — `grep -rn` у всьому модулі дає 0 збігів. NoteAttachmentsPanel правильно використовує `group-hover:opacity-100`.
- ❌ «`src/modules/notes/AudioPlayer.tsx`» — такого файлу немає; `AudioPlayer.tsx` живе в `src/shared/ui/`. Блокери щодо нього валідні, шлях у звіті виправлено.
- ❌ «`src/modules/terminal/SshShell.tsx` ResizeObserver leak» — такого файлу теж немає; терминал — це `TerminalShell.tsx` із локальним PTY (без SSH/SFTP взагалі). Lifecycle issue може існувати, але не за вказаним шляхом.
- ❌ «`ProcessTable.tsx` без virtualization» — файл називається `ProcessesPanel.tsx` і використовує `useVirtualizer` (`@tanstack/react-virtual`).
- ❌ «`clipboard.monitor.rs` 250 ms polling drains CPU» — `Duration::from_millis(80)` присутнє в одному місці (`commands.rs:480`) і не виглядає polling-loop'ом. Полінговий цикл (якщо є) працює інакше; претензія потребує верифікації перед усуненням.

Решта тверджень або частково перевірена, або потребує живого тестування (effect-leak'и, race-conditions); включена в High/Medium з помітками «потребує перевірки в наступному діффі».

---

_Підготовлено 2026-04-26 на коміті `5236b0d`._
