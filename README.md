<div align="center">

<img src="logo.svg" alt="Stash" width="96" height="96" />

# Stash

**Menubar-хаб для дрібних задач. Усе, що не варто окремого застосунку, живе в одному попапі.**

[![macOS](https://img.shields.io/badge/macOS-13%2B-000?logo=apple&logoColor=white)](#)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Tests](https://img.shields.io/badge/tests-1078-22c55e)](#тестування)
[![Offline-first](https://img.shields.io/badge/offline--first-✓-0ea5e9)](#філософія)

</div>

---

## Що це

`⌘⇧V` — і перед тобою компактний попап 920×520, у якому під рукою **14 модулів**: буфер обміну, нотатки, перекладач, AI-чат, Pomodoro, метроном, термінал, завантажувач відео, музика, розкладка треків на стеми + BPM, вбудовані web-чати, Telegram-бот, системні утиліти й налаштування.

Жодних акаунтів. Жодної хмари. Жодної телеметрії. Усе локально, у SQLite, на твоєму маку.

```
          ⌘⇧V                      ⌘⌥1..9
    відкрити / сховати         перемикати таби
```

## Філософія

Stash — свідомий **«Франкенштейн»**. Не тому, що не вміємо фокусуватись, а тому, що реальний день виглядає саме так: ти хочеш швидко перекласти речення, згадати, що копіював 20 хвилин тому, запустити Pomodoro, скинути голосове в Telegram і стягнути відео з ютуба. Заводити під кожне діло окремий застосунок — саботаж уваги.

Кожне рішення зважується через **три слони**:

1. 🎯 **UI/UX** — передбачувана взаємодія, миттєвий feedback, нормальний focus-management, темна/світла тема, reduced-motion, a11y.
2. 🧱 **Модульність** — кожен модуль стендалон: власний `api.ts`, тести, lazy popup. Без крос-модульних імпортів.
3. ⚡ **Перформанс** — lazy tabs, prefetch on hover, нічого важкого в popup-open path, bundle-stubs для важких залежностей.

Над цим — звичайні **DRY / KISS / YAGNI**.

## Модулі

| | Модуль | Що робить |
|---|---|---|
| 📋 | **Clipboard** | Історія буфера з пошуком, пінами, швидким повторним копіюванням. Автодетект URL → пропонує Downloader. |
| 📝 | **Notes** | Markdown-редактор з inline аудіо-записами, зображеннями, вкладеннями будь-якого типу (drag-and-drop) і AI-чатом по кожній нотатці. Один клік — «Надіслати в Telegram». |
| 🌐 | **Translator** | Швидкий переклад між мовами прямо з попапу, з історією. |
| 🤖 | **AI** | Чат з LLM (OpenAI / Anthropic / Gemini) для щоденних запитів. |
| 🧭 | **Web** | Вбудовані веб-чати (ChatGPT, Claude, Gemini) у стилі Arc sidebar. |
| ✈️ | **Telegram** | Власний бот, спарений зі Stash. Inbox для тексту/фото/відео/voice, локальний Whisper-транскриб, OG-preview і YouTube-embed у лінках, slash-команди й AI-tools — один асистент, три транспорти (Telegram, CLI `stash ai "…"`, voice popup). |
| ⬇️ | **Downloader** | yt-dlp під капотом: відео й аудіо з YouTube та інших джерел, прев'ю, черга, нотифікація по завершенню. Автодетект посилання з буфера й Telegram. |
| 🎵 | **Music** | Локальний аудіо-плеєр для фонової музики без перемикання на Spotify. |
| 🎚 | **Stems** | Розкладка треку на 6 інструментальних стемів (vocals/drums/bass/**guitar**/piano/other) через Demucs + локальне визначення BPM через BeatNet. Drag-and-drop або hand-off з Downloader. Python-runtime ставиться через `uv` (ні наших тарболів, ні per-release host-у) — `Settings → Separator → Завантажити` тягне uv → Python 3.11 → venv → demucs+BeatNet+torch локально. |
| 🥁 | **Metronome** | Метроном з регульованим темпом, розміром такту, режимом тренажера й backing track. |
| 🍅 | **Pomodoro** | Таймер з кастомними пресетами, історією сесій, нотифікаціями у Stash + Telegram. |
| 💻 | **Terminal** | Вбудований термінал (`portable-pty`) для швидких команд. Кнопка «Claude Code» — запуск агентної сесії в два кліки. |
| 🖥️ | **System** | Кошик з групуванням за томами, пошук дублікатів, статистика батареї. |
| ⚙️ | **Settings** | Глобальні шорткати, тема/accent/прозорість, мова, папки за замовчуванням, автостарт, конфіги модулів. |

## Агентний шар

AI-асистент — **first-class surface** для кожного модуля. Усе, що робить UI-таб, доступно з:

- **Slash-команди Telegram** — детерміністичні швидкі дії (`/summarize`, `/note`, `/remind`, `/volume`, `/music`…).
- **LLM tools** — асистент сам мапить natural-language параметри на args модуля (BPM метронома, тривалість Pomodoro, формат запису Downloader, текст нотатки тощо).
- **CLI** — `stash ai "нагадай через 20 хвилин випити води"` ходить через той самий dispatcher.

Єдина точка — `telegram::assistant::handle_user_text`. Telegram, CLI, майбутній voice popup — усі транспорти використовують один tool-loop, жодного дублювання LLM-коду.

## Стек

- **Frontend** — React 19, TypeScript, Tailwind 4, Vitest + RTL, Storybook 9.
- **Backend** — Rust (Tauri 2), SQLite через `rusqlite`, `whisper.cpp` для локальної транскрибації, `audiopus_sys` + `ogg` для декодування Telegram voice (OGG/Opus), `portable-pty` для терміналу.
- **IPC** — `invoke(...)` фронт→бек, `app.emit(...)` + `listen(...)` бек→фронт, `CustomEvent('stash:navigate')` для навігації між вкладками.
- **AI** — Vercel AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`).

## Швидкий старт

```bash
# передумови: Node 20+, Rust stable, Xcode CLT (macOS)
git clone https://github.com/<you>/stash.git
cd stash
npm install

# dev-режим з hot reload
npm run tauri dev

# продакшн-збірка (.dmg / .app)
npm run tauri build
```

Опційні залежності для повного функціоналу:

- `yt-dlp` — для модуля Downloader
- `ffmpeg` — для конвертацій та thumbnail-ів
- Telegram Bot Token — вставити в `Settings → Telegram`, бот спарує себе сам

## Shared UI

`src/shared/ui/` містить готові примітиви, через які **зобов'язаний** ходити кожен модуль — ніяких ad-hoc кнопок, інпутів, рядків списку:

`Button`, `Input`, `NumberInput`, `SearchInput`, `Textarea`, `Select`, `SegmentedControl`, `Checkbox`, `Toggle`, `TabButton`, `IconButton`, `ConfirmDialog`, `Modal`, `Drawer`, `StatCard`, `Toast`, `Cheatsheet`, `GlobalSearch`, `AudioPlayer`, `ImageThumbnail`, `Lightbox`, `InlineVideo`, `VideoPlayer`, `FileChip`, `LinkifiedText`, `LinkEmbed`, `Markdown`.

## Тестування

Юніт- і компонентні тести — **обов'язкові** для кожної фічі й багфіксу.

```bash
npm test                 # vitest, frontend
npm run test:coverage    # покриття
npm run test:e2e         # Playwright (Vite dev, без Tauri IPC)
npm run storybook        # візуальні сторі для shared/ui

cargo test --manifest-path src-tauri/Cargo.toml  # Rust
```

Поточне покриття: **414 Rust + 664 frontend = 1078 тестів.**

## Додати свій модуль

```ts
// src/modules/foo/index.tsx
import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () => import('./FooShell').then((m) => ({ default: m.FooShell }));

export const fooModule: ModuleDefinition = {
  id: 'foo',
  title: 'Foo',
  PopupView: lazy(load),
  preloadPopup: load,   // запуститься на hover по табу
};
```

Підключити в `src/modules/registry.ts`, віддзеркалити Rust-частину в `src-tauri/src/modules/foo/`, зареєструвати команди в `invoke_handler!`. Готово — новий таб live, ліниво вантажиться, prefetch-на-hover безплатно.

## Ліцензія

TBD.

---

<div align="center">

Made with ☕, 🦀 and уважним ставленням до нервів користувача.

</div>
