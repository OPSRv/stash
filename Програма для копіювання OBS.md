# Бриф: macOS-утиліта "все-в-одному"

## Що будуємо
Менюбар-додаток для macOS з трьома функціями:
1. **Clipboard history** — історія буфера обміну з пошуком, пінами, гарячою клавішею для виклику.
2. **Video downloader** — завантаження відео з YouTube, Instagram, TikTok, Twitter/X, Reddit через `yt-dlp`.
3. **Screen + webcam recording** — запис екрану з picture-in-picture вебки (додаємо в останню чергу).

## Стек
- **Tauri 2.x** (Rust backend + WebView frontend)
- **Frontend**: React 18 + TypeScript + Zustand + Tailwind CSS
- **Storage**: SQLite через `rusqlite` (clipboard history, download history)
- **yt-dlp** — як sidecar binary, викликаємо через `tokio::process::Command`
- **Для recording (фаза 3)**: Swift helper binary з ScreenCaptureKit + AVFoundation, IPC через stdin/stdout JSON

## Rust crates
- `arboard` — читання/запис clipboard
- `clipboard-master` або polling — detection змін
- `rusqlite` + `serde` + `tokio`
- `tauri-plugin-global-shortcut` — глобальна hotkey
- `tauri-plugin-shell` — для yt-dlp

## MVP scope (фаза 1 — вихідні)
Тільки clipboard manager:
- Menubar icon + popup-вікно
- Global hotkey (⌘⇧V) для виклику
- SQLite-зберігання останніх N записів (текст, зображення окремо)
- Пошук по історії (fuzzy)
- Пін записів
- Paste at cursor через симуляцію ⌘V

## Фаза 2 — downloader
- Вкладка "Downloads" у головному вікні
- Input для URL, автодетект платформи
- Вибір якості/формату (парсимо `yt-dlp --list-formats`)
- Прогрес зі stdout yt-dlp (regex на `[download] X%`)
- yt-dlp пакується як sidecar, окрема команда "Update yt-dlp"
- Папка збереження — configurable

## Фаза 3 — recording
- Swift helper (окремий проєкт): ScreenCaptureKit для екрану, AVCaptureSession для камери, AVAssetWriter для енкодингу в один H.264 mp4
- Композиція PiP через Core Image або Metal
- Rust спілкується зі Swift helper через JSON-команди (start/stop/status)
- Запит permissions (Screen Recording + Camera) обробляє Swift

## Структура проєкту
```
/src-tauri        — Rust backend + Tauri config
  /src
    /clipboard    — clipboard monitor + SQLite
    /downloader   — yt-dlp wrapper
    /recorder     — IPC з swift helper
/src              — React frontend
  /features
    /clipboard
    /downloads
    /recorder
  /shared         — UI компоненти, Zustand stores
/helpers
  /recorder-swift — окремий Swift Package, збирається в бінарник
```

## Важливі рішення
- **Menubar-first**: головний UI — це popup з menubar, окреме вікно відкривається для downloads/settings.
- **Permissions**: Accessibility (для paste), Screen Recording, Camera, Microphone — запитуємо on-demand.
- **Signing & notarization** — залишаємо на потім, спочатку ad-hoc sign для локальних тестів.
- **Autoupdate** — Tauri updater через GitHub Releases (додати в фазі 2).

## Чого НЕ робимо в MVP
- Синк між девайсами
- Cloud backup
- OCR для зображень з clipboard
- Стрімінг (це вже OBS територія, не наша)

## Запит до Claude Code
1. Склади детальний план по фазах з розбивкою на таски.
2. Створи скелет проєкту (Tauri init + React + Tailwind + базова menubar-конфігурація).
3. Реалізуй фазу 1 (clipboard manager) end-to-end.
4. Після фази 1 — зупинись і попроси review перед фазою 2.
