# Stash

**Menubar-хаб для дрібних задач — усе, що не варто окремого застосунку, живе в одному попапі.**

## Опис

Stash — macOS menubar-застосунок, який замінює десяток маленьких утиліт однією іконкою в треї. Попап 920×520 викликається глобальним шорткатом `⌘⇧V`, між вкладками — `⌘⌥1..9`. Усе offline-first, без акаунтів і хмари — дані лежать локально в SQLite.

Філософія — свідомий «Франкенштейн»: краще одна компактна скринька з інструментами під рукою, ніж зоопарк застосунків у доку. Кожен модуль самодостатній, вантажиться ліниво (`React.lazy` + preload-on-hover), не заважає іншим.

## Модулі

- **Clipboard** — історія буфера обміну з пошуком, пінами, швидким повторним копіюванням. Автовизначення URL → пропонує модулю Downloader.
- **Downloader** — завантаження відео й аудіо з YouTube та інших джерел (yt-dlp), автодетект посилання з буфера й Telegram, прев'ю, черга, нотифікація по завершенню.
- **Notes** — нотатки з markdown-редактором, inline аудіо-записами, зображеннями, **вкладеннями будь-якого типу файлів** (drag-and-drop), AI-чатом по кожній нотатці. Один клік — «Надіслати в Telegram».
- **Translator** — швидкий переклад між мовами прямо з попапу, історія перекладів.
- **AI** — чат з LLM (OpenAI / Anthropic / Gemini) для щоденних запитів, пояснень, генерації тексту.
- **Web** — вбудовані веб-чати (ChatGPT, Claude, Gemini тощо) з легкою панеллю-сайдбаром у стилі Arc, кольоровими favicon-іконками.
- **Telegram** — власний бот, спарений зі Stash. Вкладка показує **Inbox**: текст, голос, фото, відео, документи зі зручним перегляд­ачем (inline image-viewer, audio/video-плеєр, file chip). Voice автоматично транскрибується локальним Whisper, потім результат летить через AI-асистента. URL у повідомленнях — збагачені YouTube-embed або OG preview-картки, з кнопкою `⤓ Download` до Downloader. `/summarize`, `/note`, `/remind`, `/volume`, `/music` та інші слеш-команди доступні і з Telegram, і як AI-інструменти. Налаштування (bot token, pairing, alerts, system prompt, memory) живуть у Settings → Telegram.
- **Music** — локальний аудіо-плеєр для фонової музики без перемикання на Spotify.
- **Stems** — розкладка аудіо на 6 інструментальних стемів (vocals/drums/bass/**guitar**/piano/other) через Demucs + локальне визначення BPM через BeatNet. Drag-and-drop файла будь-якого формату (mp3, m4a, flac, ogg, wav, aac, aiff). Hand-off з Downloader: на готовому YouTube-аудіо одна кнопка → стеми. Python-runtime провайдиться через `uv` при першому Settings → Separator → Завантажити (uv → Python 3.11 → venv → demucs+BeatNet+torch, ~1.5 ГБ за 5–10 хв) + htdemucs_6s модель (~80 МБ). Жодного per-release тарболу не хоститься — все локально через pip.
- **Metronome** — метроном для музичних практик із налаштуванням темпу й розміру, режим тренажера, backing track.
- **Pomodoro** — таймер за технікою Pomodoro з кастомними пресетами, історією сесій, нотифікаціями у Stash + Telegram.
- **Terminal** — вбудований термінал (portable-pty) для швидких команд без переходу в iTerm.
- **System** — побутові системні утиліти: перегляд кошика з групуванням за томами, дублікати, статистика батареї.
- **Settings** — глобальні шорткати, тема/accent/прозорість панелей, мова, папки за замовчуванням, автостарт, конфіги для всіх модулів (Telegram, AI, Clipboard, Downloader тощо).

## Shared UI

Для консистентного вигляду всього застосунку шарнові компоненти в `src/shared/ui/`:

- `AudioPlayer` — єдиний плеєр для voice (Telegram), markdown-embed (Notes), attachment-rows; варіанти `compact | waveform`, завантажувачі `url | bytes`.
- `ImageThumbnail` + `Lightbox` — мініатюра-галерея з full-popup viewer (Esc/click-outside).
- `InlineVideo` — легкий `<video controls>` для списків; повноцінний модальний `VideoPlayer` з speed/subs/position-memory — для Downloads.
- `FileChip` + `formatBytes` — уніфікований file-row для документів/вкладень.
- `LinkifiedText` — автоматична лінкіфікація URL у довільному тексті, зовнішнє відкриття через `plugin-opener`.
- `LinkEmbed` — OG-картка з thumbnail/title/description, окремий шлях для YouTube (inline-плеєр).

## Стек

- **Frontend**: React 19, TypeScript, Tailwind 3, Vitest + React Testing Library.
- **Backend**: Rust (Tauri 2), SQLite через rusqlite, whisper.cpp для транскрибації, audiopus_sys + `ogg` crate для декодування OGG/Opus (Telegram voice).
- **IPC**: `invoke(...)` для фронт→бек, `app.emit(...)` + `listen(...)` для бек→фронт, `stash:navigate` CustomEvent для навігації між вкладками.

## Тестування

Unit/component-тести обов'язкові для кожної фічі й багфіксу. Поточне покриття: **414 Rust + 664 frontend = 1078 тестів**.
