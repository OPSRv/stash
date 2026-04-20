# Stash — Roadmap

Живий документ. Верхня частина — те що вже є, нижня — що плануємо. Кожна задача
відмічена приблизним обсягом (S ≤ 2 год, M — день, L — 2-3 дні, XL — тиждень+).

---

## 0. Поточний стан (квітень 2026)

### Що працює
- **Єдине menubar-вікно** 720×520 під tray-іконкою, `⌘⇧V` глобальний toggle,
  `⌘⌥1/2/3` перемикання табів, Esc / click-outside ховають.
- **Clipboard** (фаза 1 MVP завершена):
  - SQLite репо з dedup, pinned, kind=text|image, meta JSON
  - `arboard` polling 500 мс; monitor пише текст і зображення
  - Sha256-хеш для image dedup; PNG у `~/Library/Application Support/.../clipboard-images/`
  - Paste-at-cursor через `enigo` + auto-hide popup
  - Authorization prompt macOS Accessibility на старті
  - Tauri commands: list/search/toggle_pin/delete/paste/copy-only/clear
  - React UI: pinned/recent секції, live search, ⌘1-4 фільтри по типу
    (link/code/image/text з per-type іконками), hover pin/delete buttons,
    Shift+Enter = copy-only, Backspace delete, auto-trim 1000 items раз на хв
  - Live refresh через `clipboard:changed` event
  - Банер "Download this video" коли останнiй item — video URL (з мініатюрою і
    кнопками якостей)
- **Downloader** (фаза 2 MVP завершена, з nuances):
  - yt-dlp sidecar у `~/Movies/Stash/bin/`, auto-install при першому detect +
    warm-up у фоні на старті
  - Platform detector (YouTube, Instagram, TikTok, X, Reddit, Vimeo, Twitch,
    Facebook, Generic)
  - `--dump-json` метадата → preview-card з thumbnail, uploader, duration,
    quality tiers (2160/1440/1080/720/480/360 + Audio)
  - In-memory detect cache (10 хв TTL); cancel під час detect
  - Job manager: SQLite таблиця, stdout парсер прогресу, `downloader:progress`
    / `completed` / `failed` events
  - Height-based format selector (`bestvideo[height<=H]+bestaudio/best`)
  - Native notifications при completed/failed (з toggle)
  - Configurable download folder, drag-n-drop URL, auto-detect URL при вході
    в таб Downloads (якщо в буфері)
  - Inline video player з scrub/volume/fullscreen, клавіші `space/←→/F/M/Esc`
  - Completed view: список або grid (4 стовпці з play-overlay)
  - **Authorization cookies**: native Arc cookie decryption (PBKDF2 + AES-CBC
    + Keychain), експорт у Netscape cookies.txt; інші браузери через
    `--cookies-from-browser`
- **Settings**: Launch at login (autostart), max history, downloads folder,
  notify toggle, cookies browser dropdown (None / Arc / Safari / Chrome /
  Firefox / Edge / Brave / Vivaldi / Chromium). Persist через `tauri-plugin-store`.
- **Тести**: 61 React (Vitest + RTL), 57 Rust, `cargo test` + `npm test` всі
  зелені, CI-ready.

### Відомі проблеми / обмеження
- **YouTube anti-bot + Instagram blocks**: yt-dlp постійно б'ється з PO Tokens,
  n-challenge, "empty media response". Іноді треба вручну оновити yt-dlp.
- **Cold-detect slow**: YouTube 25-40s при першому fetch через їхню
  extraction logic. Нічого не можу зробити окрім кеша.
- **Безпека файлу cookies**: `arc-cookies.txt` містить живі session-tokens
  без обмежень доступу в додатку. Поки не шкідливо — всі файли у
  `~/Movies/Stash/bin/` належать користувачу. Але шифрування at rest було б
  краще.
- Кілька `#[allow(dead_code)]` на заготовках майбутніх фіч.
- Немає Swift helper'а — Phase 3 Recorder не розпочато.

---

## 1. Короткострокове (до тижня) — стабілізація та UX

### 1.1 yt-dlp self-update (S)
- Кнопка у **Settings → Downloads → "Update yt-dlp now"**
- Rust команда `dl_update_binary` яка викликає `yt-dlp -U` або
  перезавантажує бінарник із GitHub Release (fallback якщо `-U` падає на
  підписаному бінарі)
- Показати версію поточну + останню доступну; прогрес-індикатор
- Автоматична перевірка раз на 24 години з неблокуючим banner-ом у Downloads
  якщо є новіша

### 1.2 Purge cookies file on exit / on demand (S)
- Кнопка "Forget cookies" у Settings (видаляє `arc-cookies.txt` і скидає
  `cookiesFromBrowser = null`)
- Опціональний setting: **Regenerate cookies every N hours** (Arc export
  running на livecycle scheduler)
- Опція: шифрувати cookies.txt з паролем Keychain (зайвий, але можна)

### 1.3 Multi-select + bulk actions у clipboard (S)
- Shift+click виділяє діапазон, Cmd+click — toggle
- Bulk delete, bulk pin
- Header повідомляє "X selected · Delete · Pin"

### 1.4 Keyboard shortcut cheatsheet (S)
- `?` (або `Cmd+/`) показує overlay зі списком всіх shortcut-ів для поточного
  таба, з групуванням (Global / Clipboard / Downloads)

### 1.5 Downloads resume / pause (M)
- Pause: `kill -STOP` дочірнього yt-dlp (macOS), resume: `-CONT`. Повторний
  старт на тому ж URL з `--continue`
- UI: замість `×` на active row — pause/resume toggle + cancel окремо
- Зберігати стан `paused` в БД, відображати

### 1.6 Retry policy (S)
- При `downloader:failed` пропонувати Retry (re-invoke `dl_start` з тими ж
  параметрами)
- Автоматичний retry з exponential backoff для transient помилок (HTTP 5xx,
  network errors), але не для format/auth помилок

### 1.7 UI polish (S)
- Custom **monochrome SVG tray icon** (наразі дефолт Tauri, виглядає
  непрофесійно)
- Dock іконка — на Stash brand замість дефолту (для DMG bundle)
- Про-flash ефект при copy → clipboard popup пульсує рамкою (візуальний
  feedback що щось записалось в історію)

### 1.8 Help / About tab (S)
- В Settings → About додати:
  - Версію app + yt-dlp
  - Посилання на GitHub
  - "Send logs" → збирає останні ~200 рядків stderr у файл для bug report
  - "Open data folder" → відкриває `~/Library/Application Support/com.opsrv.stash`

---

## 2. Середньострокове (1-3 тижнi) — Phase 3 Recorder

### 2.1 Архітектура Recorder (L)
- **Swift helper бінарник** у `/helpers/recorder-swift/` — окремий Swift Package
  Manager проєкт
- API через stdin/stdout JSON команди (як у брифі):
  ```
  {"cmd": "start", "mode": "screen|screen+cam|cam", "display_id": "...",
   "mic": true, "fps": 60, "output": "/path/to/out.mp4"}
  {"cmd": "stop"}
  {"cmd": "status"}
  ```
- Відповіді у форматі `{"event": "recording_started", "pid": ...}`,
  `{"event": "level", "rms": 0.3}`, `{"event": "stopped", "path": "..."}`
- Rust `modules/recorder/helper.rs` спілкується з Swift через `tokio::process`
  + line-buffered JSON frames

### 2.2 Swift helper — core (L)
- `ScreenCaptureKit` для screen (macOS 12.3+)
- `AVCaptureSession` для webcam
- `AVAssetWriter` H.264/HEVC mp4 encoder
- **PiP composition**: Metal або Core Image — overlay камери в кут
  відео екрану (round mask, drop shadow)
- Mic capture + mix з system audio (optional)
- Прогрес RMS → events для waveform UI

### 2.3 Recorder модуль у Stash (M)
- Третя вкладка **Recorder** (додати в registry)
- States за дизайном (з HTML-прототипу):
  - **Pre-record**: mode segmented (Screen / Screen+Cam / Cam), display picker,
    mic toggle з live waveform
  - **Countdown**: 3-2-1 з можливістю Esc-Cancel
  - **Recording pill**: компактна 220×40 панель з таймером + waveform + stop
- Collapse popup до pill після старту запису (floating завжди-on-top)
- Settings → Recorder: resolution, FPS, audio bitrate, default save folder

### 2.4 Permissions flow (M)
- Screen Recording permission — запит через Swift helper (TCC)
- Camera + Microphone — те саме
- Guide overlay у Stash якщо якийсь з permissions відсутній (з кнопкою
  "Open Settings")

### 2.5 Post-recording (S)
- Завершений запис додається в Downloads тaba як item з video playback
  (переюзати VideoPlayer component)
- Trim: inline trim UI на `<video>` з двома handlers; зберегти як новий file
  через `ffmpeg -ss ... -to ... -c copy`

---

## 3. Середньострокове — інфраструктура

### 3.1 Code signing + notarization (L)
- Apple Developer ID для підпису
- `tauri build` з `notarize: true`
- DMG artefact для релізу
- Auto-update через Tauri updater + GitHub Releases
- Перший public release: `v0.1.0-beta`

### 3.2 CI (M)
- GitHub Actions:
  - `npm test` + `cargo test` на PR
  - Build DMG на tag push
  - Release з changelog з commit messages

### 3.3 E2E тестування (M)
- Playwright у Tauri dev mode (або через webdriver)
- Сценарії:
  - Copy text → appears in clipboard popup
  - Paste via Enter → system clipboard має це значення
  - Detect public video URL → preview card рендериться

### 3.4 Logs + crash reporting (S)
- Структуровані логи через `tracing` у Rust, rotating file у app_data_dir
- Можна інтегрувати Sentry або вбудований "Send report"

---

## 4. Довгострокове — нові модулі

### 4.0 Pomodoro (реалізовано, у подальшій ітерації)
- Таб `⌘⌥3`: таймер з іменованими блоками (Deep work · Walk · Stand і т.д.)
- **Поза — властивість блока**: `sit` / `stand` / `walk`. Переходи генерують
  posture-aware повідомлення ("Підніми стіл", "Стартуй доріжку",
  "Злізь з доріжки та сядь" тощо) — і в in-app банер, і в system
  notification.
- Engine (`EngineCore` у Rust) — чиста стейт-машина, тестована 13 юніт-
  тестами. 1Hz тік-тред у `std::thread` читає `SystemTime` і передає
  delta, тому:
  - таймер продовжує йти коли попап схований або webview unload-нутий
  - sleep/wake безпечний — після довгого сну engine "прокручує" всі
    пропущені блоки, а system notification коалесується в одну
    (фінальну) щоб не спамити
- Пресети: бібліотека з upsert-by-name + можливість редагувати сесію на
  льоту без перезапуску (editBlocks зберігає `remaining_ms` якщо id
  поточного блока лишився в новому списку).
- Mid-block nudge (soft toast): опціонально на блок, за замовчуванням
  виключений.
- Історія сесій (append-only `pomodoro_sessions`) — закладена під майбутню
  статистику "сьогодні: Xh Sit · Yh Stand · Zh Walk".

**Що далі (наступні ітерації):**
- Статистика по позах / блоках за день і тиждень
- Linking блока до активної нотатки ("що я робив під цей focus")
- Звукові схеми (soft bell / gong / silent) per-block
- Tray-icon бейдж з хвилинами до кінця поточного блока
- Глобальний хоткей "pause/resume session"

### 4.1 Notes / quick snippets (M)
- Четвертий таб: markdown-нотатки з локальним збереженням
- Hotkey ⌘⇧N швидко відкрити scratchpad
- Export у `.md` файли у папці

### 4.2 OCR clipboard для зображень (M)
- Коли copy image → Vision framework (Swift helper) запускається в фоні,
  видобуває текст; додається до item як пошуковий індекс
- "Extract text" button у image row

### 4.3 Clipboard sync across devices (XL)
- End-to-end шифроване (libsodium)
- Власний relay-сервер або через iCloud Drive shared folder як transport
- Conflict resolution (last-write-wins за timestamp)

### 4.4 Scriptable automations (L)
- Hook framework: "when clipboard receives URL matching regex, do X"
- Pre-built recipes: Strip tracking params з URLs (fbclid, utm_*), конвертувати
  HTML → markdown при paste, decode base64 тощо
- UI: JSON editor з prebuilt prerepsets у Settings

### 4.5 Global search (L)
- Cmd+Space-like opener: unified пошук по clipboard + downloads + notes
- Fuzzy search на SQLite FTS5 індексі

---

## 5. Довгострокове — refinement

### 5.1 Player upgrade (M)
- Picture-in-picture через browser PiP API (`requestPictureInPicture()`)
- Keyboard shortcuts: + / - speed control, F frame forward, 0-9 seek %
- Subtitles: якщо yt-dlp зкачав `.vtt` — показати track
- Continue-watching: зберігати `currentTime` per file

### 5.2 Downloads queue & concurrency (S)
- Setting: "Max parallel downloads" (default 3)
- Queue у runner: якщо active.len() >= max — нові жобі stay в `pending` доки
  не звільниться слот
- Priority drag-reorder у UI

### 5.3 Bandwidth limit (S)
- Setting: max download speed (MB/s)
- yt-dlp `--limit-rate`

### 5.4 Download history aging (S)
- Auto-delete completed jobs DB records старіші за N днів (не файли)
- Це розрулить довгі списки через пів року

### 5.5 Thumbnail generation для власних відео (M)
- Для Recorder output: витягнути кадр через ffmpeg на 10% довжини
- Зберегти як `~/.../downloads/.thumbs/<hash>.jpg`
- Grid view показуватиме справжні мініатюри замість placeholder

---

## 6. Ідеї на випадок «є час»

- **Right-click на tray**: швидкий доступ до останнього скопійованого item
- **Menu bar label**: показувати обрізану версію останнього clipboard item
  біля іконки (як це роблять Maccy)
- **Markdown / rich-text preservation**: зберігати HTML formatting окремо
  від plain text, вставляти як формат потрібний
- **Audio waveform thumbnails** для audio-only downloads
- **.webloc generator** для clipboard URL items (перетягнути в Finder як
  shortcut)
- **Plugin system**: зовнішні скрипти в TypeScript для обробки clipboard
  items (наприклад, "format JSON", "URL-decode")

---

## 7. Явні non-goals

Щоб не роздувати scope. **НЕ** робимо:
- Windows / Linux port (наразі macOS-only)
- Stream recording (OBS territory)
- Cloud backup / full-text search-server
- Mobile companion app (без Tauri iOS on desktop-first focus)
- Заміну yt-dlp (див. "чому не поміняти" нижче)

### Чому не міняти yt-dlp
1. yt-dlp підтримує 1864+ extractor'ів — альтернативи (lux, you-get, annie) на
   рівні 50-100, і ті не оновлюються регулярно
2. Проблеми "format not available" / "login required" / "API not granting
   access" — це anti-bot платформ (YouTube, Instagram), а не лімітації
   бібліотеки. Переходити на іншу = отримати ті самі бар'єри + менше сайтів
3. Всі комерційні video downloader'и (4K Video Downloader, JDownloader,
   StreamFab) використовують yt-dlp усередині або тримають свої extractor'и
   що ламаються щотижня
4. Єдина надійна тактика — **регулярно оновлювати yt-dlp** (див. задачу 1.1)

---

## 8. Порядок виконання

Пропозиція по пріоритету (M = must-have для public beta):

1. **M** 1.1 yt-dlp self-update — критично, бо anti-bot
2. **M** 1.7 Custom tray icon — identity
3. **M** 1.2 Purge cookies — privacy
4. 1.5 Downloads pause/resume
5. 1.3 Clipboard multi-select
6. 1.6 Retry policy
7. 1.4 Keyboard cheatsheet
8. 1.8 About / Send logs
9. **M** 2.x Recorder (Swift helper + UI)
10. 3.1 Signing + notarization → **v0.1.0-beta release**
11. далі — 4.x нові модулі / 5.x refinement

---

Останнє оновлення: 2026-04-18
