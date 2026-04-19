# Продуктове дизайн-рев'ю Stash

**Дата:** 2026-04-19 (виправлення завершені тим же днем)
**Скоуп:** весь продукт (1) • всі модулі (2) • дизайн-система (3)
**База:** поточний main, ROADMAP 2026-04-18, `src/modules/*`, `src/shared/ui/*`, `src/styles/tokens.css`

> **Статус реалізації (2026-04-19):** must-do блок і більшість polish-пунктів закриті у commits `ae6a1eb`, `48a17ef`, `2286fe6`. Детальна зведена таблиця — у розділі **Статус виконання** наприкінці документа.

---

## TL;DR

Stash — це архітектурно зріла модульна menubar-утиліта з сильною технічною основою (lazy tabs, soft state preservation, cross-module events). Продукт **працює як єдина сутність**, а не набір віджетів — цим він відрізняється від конкурентів типу Maccy/Raycast-розширень.

Однак перед публічною бетою накопичилось кілька **системних продуктових боргів**, які буде дешевше закрити зараз:

1. **Деструктивні дії без підтвердження** (delete/cancel у Clipboard, Notes, Downloader).
2. **Відсутні empty states** — три списки з семи просто зникають, коли пусто.
3. **Немає feedback під час довгих операцій** — 25–40-секундний YouTube detect виглядає як зависання.
4. **i18n не закладений** — усі рядки hardcoded англійською; додати мови пізніше = переписати багато.
5. **Прогалини у дизайн-системі** — повторювані патерни (Card, EmptyState, Modal frame) не витягнуті у примітиви; 60+ inline-стилів у модулях.
6. **A11y часткова** — focus ring відсутній на Input/Row/Select options, live regions не оголошують критичні дії.

Нижче — деталі.

---

## 1. Продукт як ціле

### 1.1 Позиціонування та когерентність

Stash — **не збірник утиліт**, а **інтегрована macOS-утиліта** з 8 табами. Перетини, які вже працюють:

- Clipboard → Downloader: банер "Download this video" у popup'і буфера
- Clipboard → Translator: auto-translate banner на рівні shell
- Clipboard → Notes: save text to note (через `stash:navigate`)
- Downloader → Music: inline-player для audio
- Recorder → Downloader: запис додається як item (планується)

Це **продуктова сила** — і саме через це треба уникати перетворення Stash на "28 функцій у 8 табах". Кожен новий модуль має або **глибоко інтегруватися** з іншими, або лишатися окремим інструментом з чесною кнопкою "Open in separate window".

**Рекомендація:** утримувати ліміт ~8 табів. Phase 3 (Recorder) зараз — це правильний наступний крок, бо він живить Downloader. Пункти з ROADMAP 4.x (Scriptable automations, Global search) треба явно оцінити через призму *"це посилює існуючі модулі чи розмиває фокус?"*.

### 1.2 Навігація та шортката

`src/modules/registry.ts` + `src/shell/PopupShell.tsx`:

- ⌘⌥1..7 — перемикання табів; Settings без шортката (останній).
- ⌘⇧V — глобальний toggle; Esc — hide; ⌘⇧F — GlobalSearch; ⌘⇧N — Notes quick-open.
- `?` / `⌘/` — Cheatsheet, per-tab shortcuts.
- Cross-tab: `stash:navigate` CustomEvent + event-based подієва шина (Rust → webview через `emit/listen`).

**Що добре:**
- Soft-lazy: таб монтується при першому відкритті й зберігає стан (`hidden`).
- Preload на hover `TabButton` — UX відчувається миттєвим.
- Translation banner і NowPlaying bar живуть на shell-рівні, не дублюються.

**Що варто покращити:**
- **Порядок табів ніде не пояснений** — чому Clipboard перший, Settings останній? Потрібен документ-принцип (напр. «частота використання · першість незаміннього функціоналу»).
- **⌘⌥ послідовність крихка:** при додаванні нового модуля у середину registry всі користувачі з м'язовою пам'яттю зламаються. Варіант: **прив'язати шортката до `id` модуля**, не до індексу.
- **Немає discoverability перших хвилин** — нема onboarding-екрану, нема `?` підказки при першому запуску.

### 1.3 Глобальні стани, яких бракує

- **First-run / empty-install** стан — що бачить користувач у Clipboard, коли історія пуста?
- **Offline / yt-dlp not installed** — зараз спін нескінченно; треба banner з CTA "Install now".
- **Permissions denied** (Accessibility, Screen Recording, Camera/Mic) — є тригер, але немає guide-overlay з кнопкою "Open System Settings".
- **Global error boundary** — якщо модуль крашнувся, зараз це пустий таб. Потрібен fallback + "Reload module".

---

## 2. Модулі

Кожен модуль оцінений за: **що робить → ключові ризики UX → A11y/i18n → рекомендації**.

Severity: 🔴 блокер до беты • 🟡 polish • 🟠 nice-to-have.

### 2.1 Clipboard — 🟢 найзріліший модуль

**Сильно:** live search з debounce, per-type фільтри (⌘1..4), pinned секція, paste-at-cursor, video-detect банер. Переюз `Row` правильний.

| # | Проблема | Severity |
|---|---|---|
| 1 | `Backspace` видаляє без підтвердження | 🔴 |
| 2 | Порожній список → нічого не рендериться (нема EmptyState) | 🔴 |
| 3 | Video-detect може freeze UI на 25–40с без прогресу | 🔴 |
| 4 | Іконки (`PinIcon`, `TrashIcon`, `EyeIcon`) дубльовані у `ClipboardPopup.tsx:53–70` замість `shared/ui/icons.tsx` | 🟡 |
| 5 | `copy-flash` анімація визначена в tokens.css (`clip-flash-anim`) але не застосована в UI | 🟡 |
| 6 | Row focus ring невидимий під час ↑↓ навігації | 🟡 |
| 7 | Немає announce через `useAnnounce` на paste/pin/delete | 🟡 |
| 8 | Image items у списку без thumbnail (тільки у PreviewDialog) | 🟠 |

**A11y:** `role="option"` на Row, але контейнер — не `listbox`. `aria-selected` є, `role="searchbox"` є. Додати `listbox` обгортку та `aria-activedescendant`.

**Рекомендації:**
- Замінити `Backspace` без confirm на: **перший раз — ConfirmDialog + чекбокс "Don't ask again"**, далі — мовчки.
- EmptyState з ілюстрацією "Nothing copied yet. Try ⌘C anywhere."
- Під час detect — skeleton preview card з `prog-shimmer`.

### 2.2 Downloader — 🟡 функціонально повний, UX-борги

**Сильно:** platform detect, format selector, native cookies decryption, inline VideoPlayer, pause/resume/retry, notifications. Це **найскладніший** модуль і він працює.

| # | Проблема | Severity |
|---|---|---|
| 1 | Cancel активного завантаження без confirm — частковий файл на диску | 🔴 |
| 2 | `DETECT_SLOW_HINT_THRESHOLD_SEC=6` показує лише текстовий hint — немає progress/estimate | 🔴 |
| 3 | Cookies at rest не шифровані (ROADMAP 1.2 «Forget cookies» ще не зроблений) | 🔴 |
| 4 | PlatformBadge: hardcoded кольори (`#FF0000` YouTube, `#E1306C` Instagram) у `PlatformBadge.tsx` — не через токени | 🟡 |
| 5 | Error banner inline: `{background:'rgba(235,72,72,0.08)', color:'#FF7878'}` — замість токенів tone=danger | 🟡 |
| 6 | `DropOverlay` hardcoded `borderRadius:14` замість `--radius-lg` | 🟡 |
| 7 | Completed grid фіксовано 4 колонки — не адаптується до майбутніх ширин | 🟠 |
| 8 | Немає bulk-операцій (delete completed, retry all failed) | 🟠 |
| 9 | Немає мініатюр для власних відео (ROADMAP 5.5) | 🟠 |

**A11y:** ActiveDownloadRow без `role`/`aria-label`. QualityPicker не `listbox`. Error message не озвучується.

**Рекомендації:**
- Для cancel — м'який confirm ("Keep partial file?" / "Delete partial file?").
- Під час detect — progress bar з **відомим етапом**: `extracting metadata (1/3) → resolving formats (2/3) → ready`.
- Витягнути platform-кольори у CSS custom property (`--platform-youtube: …`) і дати Badge-примітиву tone-API.

### 2.3 Notes — 🟡 MVP-рівень

**Сильно:** split-panel markdown preview, checkbox toggle через `toggleCheckboxAtLine`, autosave 400ms, export to `.md`, ⌘⇧N quick-open.

| # | Проблема | Severity |
|---|---|---|
| 1 | Delete без підтвердження | 🔴 |
| 2 | Коли немає заміток — пустий editor, без CTA | 🔴 |
| 3 | Autosave без візуального статусу (saved / saving / failed) | 🟡 |
| 4 | Немає undo/redo на рівні note (тільки браузерний у textarea) | 🟡 |
| 5 | Синхронізація між двома відкритими вікнами Notes — race можливий | 🟡 |
| 6 | Markdown preview не має error-state для невалідного markdown | 🟠 |
| 7 | Немає syntax highlight у code-блоках preview | 🟠 |

**A11y:** textarea без `aria-label`; search — `searchbox` ✓. Статус autosave треба озвучувати через `LiveRegion`.

**Рекомендації:**
- Додати маленький індикатор статусу поруч із title (`Saved 2s ago`).
- EmptyState: "Your scratchpad. ⌘⇧N to quick-open anywhere."
- Перед delete — ConfirmDialog з tone=danger.

### 2.4 Recorder — 🔴 WIP, UI без бекенду

**Стан:** React-каркас є (`RecorderShell.tsx`, `CameraPipWindow.tsx`, `TrimDialog.tsx`, `LevelMeter.tsx`), Rust commands стабізовані (`recStart/Stop/Status/Trim`), **Swift helper не існує**. Phase 3 у ROADMAP.

| # | Проблема | Severity |
|---|---|---|
| 1 | Swift helper відсутній — модуль недієздатний | 🔴 blocker по ROADMAP 2.1–2.2 |
| 2 | Немає guide-overlay для Screen/Camera/Mic permissions | 🔴 |
| 3 | PIP-вікно — інтеграція з main popup сиро описана (`#camera-pip` hash) | 🟡 |
| 4 | TrimDialog — заготовка без timeline scrubber | 🟡 |
| 5 | `.stash-fader` клас у tokens.css (рядки 396–432) визначений, але не під'єднаний до UI | 🟡 |
| 6 | Recording pill (220×40) згаданий у ROADMAP, але його окремого window поки немає | 🟡 |

**Рекомендації:**
- До початку Swift-роботи зафіксувати **контракт stdin/stdout JSON** (ROADMAP вже має чернетку 2.1) — це дозволить React-частину розробляти й тестувати з mock-binary.
- Permission guide **не роблять** — native macOS prompt покриває Clipboard, а Recorder приноситиме свою permission-логіку зі Swift-helper'ом. (Див. Статус виконання.)

### 2.5 Music — 🟡 крихкий "native webview"

**Сильно:** NowPlaying bar на всіх табах, native child WebviewWindow з synced bounds, user-agent із `cookiesFromBrowser`.

| # | Проблема | Severity |
|---|---|---|
| 1 | ResizeObserver + rAF sync крихкий — при швидкому перемиканні табів вікно може "злетіти" | 🟡 |
| 2 | Зміна `cookiesFromBrowser` не оновлює UA живого webview | 🟡 |
| 3 | Native webview накладається поверх React canvas — конфлікти з modal/toast | 🟡 |
| 4 | Немає fallback UI при помилці embed | 🟡 |
| 5 | Немає вибору сервісу (Spotify/Apple/YT Music) — тільки встановлений URL | 🟠 |

**A11y:** toolbar buttons без `aria-label`, NowPlaying bar без live-region при зміні треку, webview без `title`.

**Рекомендація:** перед масштабуванням функціоналу — провести stress-test (швидкий tab-swap + resize monitor), зафіксувати race-conditions у тестах.

### 2.6 Translator — 🟢 стабільний, 🟡 дрібні borgi

**Сильно:** 150ms debounce, VirtualList для history, per-row actions, auto-translate banner. Переюзає Select (100+ мов).

| # | Проблема | Severity |
|---|---|---|
| 1 | Inline стилі: `{background:'rgba(var(--stash-accent-rgb),0.12)',...}` у `TranslatorShell` | 🟡 |
| 2 | Немає loading state — textarea активна поки летить запит | 🟡 |
| 3 | Copy action без toast/announce | 🟡 |
| 4 | Довгий список мов у Select без search-filter | 🟠 |
| 5 | Немає undo для delete row | 🟠 |
| 6 | Race condition можлива, якщо API повертається поза debounce window (stale result) | 🟡 |

**Рекомендація:** додати `requestId` у API-обгортку (`translator/api.ts`) і дропати відповіді з попередніх requestId.

### 2.7 Metronome — 🟢 закінчений, 🟠 polish-рівень

**Сильно:** BPM dial, time signature, tap tempo (Space), beat accents, backing track, persisted state, повний keyboard API (Space/↑↓/T/[/]/1-4).

| # | Проблема | Severity |
|---|---|---|
| 1 | BpmDial без `role="slider"` / `aria-valuenow` | 🟡 |
| 2 | Beat strip без яскравого pulse-індикатора поточного біту | 🟠 |
| 3 | Немає mute toggle (тільки play/pause) | 🟠 |
| 4 | Backing track UI нечітко інтегрований | 🟠 |

### 2.8 Settings — 🟡 функціональні, UX-борг

**Сильно:** theme (dark/light/auto), blur 0-60px, opacity 0-1, 6 accent-кольорів, launch-at-login, cookie-browser selector, notifications toggles. Live-broadcast зміни теми через `stash:theme-changed`.

| # | Проблема | Severity |
|---|---|---|
| 1 | Немає "Forget cookies" / purge-cookies кнопки (ROADMAP 1.2) | 🔴 security |
| 2 | Немає About/Help tab (ROADMAP 1.8): version, links, logs, data folder | 🔴 до беты |
| 3 | Слайдери без help-text (що таке blur? opacity?) | 🟡 |
| 4 | Немає "Reset to defaults" | 🟠 |
| 5 | Launch-at-login — зміна інколи потребує restart, нема попередження | 🟠 |
| 6 | Список cookie-browsers без search | 🟠 |
| 7 | Color-picker з 6 кнопок без `role="radiogroup"` / `aria-checked` | 🟡 |
| 8 | Broadcast theme: окремі вікна (Recorder, Music) мають `subscribeTheme`, але не всі стан-споживачі | 🟡 |

**Рекомендація:** Settings потрібна **субнавігація** (General / Clipboard / Downloads / Recorder / Translator / About). Зараз одна довга колонка — при додаванні секцій стане некерованою.

---

## 3. Дизайн-система (`src/shared/ui/` + `src/styles/tokens.css`)

### 3.1 Інвентар примітивів

Наявні: `Button`, `IconButton`, `Input`, `Textarea`, `SearchInput`, `Select`, `SegmentedControl`, `Toggle`, `Surface`, `Row`, `ProgressBar`, `Spinner`, `Toast`, `ConfirmDialog`, `Cheatsheet`, `GlobalSearch`, `VideoPlayer`, `TabButton`, `TrafficLights`, `Kbd`, `SectionLabel`, `LiveRegion` (hook `useAnnounce`), `icons.tsx`, `useFocusTrap`.

Якісні примітиви з продуманим API: **Button** (variant × tone × size × shape), **ConfirmDialog** (focus trap, keyboard), **Cheatsheet**, **GlobalSearch**, **Select** (keyboard nav).

### 3.2 Токени (`src/styles/tokens.css`)

Визначені:
- **Font:** `--font-sys` (SF Pro), `--font-mono`.
- **Color:** `--color-accent` + 500/600, `--color-bg-canvas`, `--color-bg-pane`, `--color-bg-elev`.
- **Text scale:** meta 11/14, body 13/18, title 15/20, heading 18/24.
- **Radius:** sm 8, md 12, lg 16.
- **Runtime vars:** `--stash-blur`, `--stash-pane-opacity-{dark,light}`, `--stash-accent`, `--stash-accent-rgb`.
- **Animations:** `clip-flash-anim`, `rec-pulse`, `wave-bar`, `prog-shimmer`.
- **Utility classes:** `.pane`, `.pane-elev`, `.hair`, `.t-primary/.t-secondary/.t-tertiary`, `.kbd`, `.row-active`, `.row-pinned`, `.seg`, `.nice-scroll`.
- **`prefers-reduced-motion`** дотримано (рядки 434–443) ✓

**Прогалини у токенах:**
- Немає **semantic tone tokens** для success/warning/danger поверхонь — зараз у Downloader error banner захардкоджено `rgba(235,72,72,0.08)`. Треба `--color-danger-bg`, `--color-danger-fg`, аналогічно для success/warning.
- Немає **spacing scale** (`--space-1..6`) — у компонентах довільні px.
- Немає **z-index scale** — toast/modal/dropdown конкурують числами ad-hoc.
- Немає **shadow scale** (`--shadow-sm/md/lg`).
- Немає **duration/easing tokens** — кожна анімація задає власний час.
- Platform-badge кольори не винесені у токени.

### 3.3 Дотримання правил (дисципліна використання)

CLAUDE.md забороняє ad-hoc кнопки/інпути та inline RGBA — стан виконання:

- **Button/Input/Select/Toggle/SegmentedControl/Row/Surface** — переюз широкий, порушень мало.
- **Inline styles у модулях:** 60+ знайдених випадків. Більшість — локальні cardStyle/badgeStyle/thumbStyle (прийнятно для одноразового UI). **Проблемні:**
  - `TranslatorShell`: inline background через CSS var ✓ (ок, але виглядає як card-patern).
  - `DropOverlay` (Downloader): `borderRadius: 14` — замість `--radius-lg`.
  - `PlatformBadge`: hex-кольори платформ — не токени.
  - Error banner у Downloader: hardcoded RGBA — порушення правила CLAUDE.md.
  - `Row.tsx:selected` inline outline/background — варто переносити в CSS class із `data-selected`.

### 3.4 Відсутні примітиви (реальні прогалини)

Патерни, які **повторюються у 3+ місцях без спільного компонента**:

| Патерн | Де зустрічається | Пріоритет |
|---|---|---|
| **Card** (background + border + padding + rounded + hover) | Downloader (Active/Detected/Completed), Music, Notes header, Translator result | 🔴 |
| **EmptyState** (icon + title + description + optional CTA) | Clipboard, Notes, Downloader, Recorder, Translator history | 🔴 |
| **Modal frame** (backdrop + focus trap + Esc + a11y) | PreviewDialog, ConfirmDialog, Cheatsheet, GlobalSearch — кожен реалізує окремо | 🟡 |
| **Badge** (small colored pill) | PlatformBadge, kind-tags у Clipboard, status у Downloader | 🟡 |
| ~~**PermissionGate**~~ | — | **не робимо** (native prompt покриває) |
| **StatusPill** (saved/saving/failed з іконкою) | Notes autosave, Downloader retry, Translator loading | 🟠 |
| **Slider with label+value** (range + readout + keyboard) | Settings (blur, opacity, max history), Recorder (gain), VideoPlayer (seek/volume) | 🟠 |

### 3.5 Motion, focus, dark mode

**Dark/Light:** усі компоненти мають `.light` варіанти у токенах, theme.ts broadcastить — виконано добре.

**Motion:** 4 іменовані keyframes є, але Toast fade-out, Select open/close, Modal fade-in — без анімацій. Реалізувати через `duration/easing tokens`.

**Focus ring — найкритичніше:**
- `Input:focus` → `outline: none` без заміни → **keyboard users не бачать куди пішов фокус**. 🔴
- `Select` options у popup не мають явного focus-style (тільки `data-idx=highlight`).
- `Row` у listbox-режимі не має `outline` для keyboard selection.
- `Button` покладається на default `:focus-visible` браузера — на темній темі слабо видно.

**Рекомендація:** увести загальний `--ring-focus` токен (наприклад `0 0 0 2px rgba(var(--stash-accent-rgb), 0.5)`) і застосувати у всіх інтерактивних примітивах.

### 3.6 i18n — системна прогалина

Зараз **усі** рядки hardcoded англійською. Немає інфраструктури (react-i18next / FormatJS / власний loader). ROADMAP не згадує локалізацію.

**Наслідки пізнішого додання:**
- 8 модулів × ~40 рядків = ~320 strings для переєкстрактингу.
- Плюралізація (Clipboard "X items", Downloader "X minutes ago") зараз склеєна конкатенацією — зламається при переході на ICU.

**Рекомендація:** якщо локалізація у планах на рік — закласти i18n інфраструктуру **зараз** (setup react-i18next + namespace per module + extraction script). Якщо продукт лишається EN-only — явно зафіксувати у ROADMAP як non-goal.

---

## 4. Підсумкова матриця

| Вимір | Оцінка | Коментар |
|---|---|---|
| Архітектура | 🟢 | Модульна, lazy, event-driven, крос-табові інтеграції |
| UI primitives coverage | 🟡 | Base solid; gaps: Card, EmptyState, Modal frame, Badge |
| UX flow | 🟡 | Робить роботу; деструктив без confirm, empty states, detect feedback |
| A11y | 🟠 | Focus ring, live regions, role/aria — часткові |
| i18n | 🔴 | Не закладено |
| Theming | 🟢 | Dark/Light + 6 accents + live broadcast |
| Motion | 🟡 | Є базові, немає системних tokens; fade/slide на modals/toast відсутні |
| Код-дисципліна | 🟡 | 60+ inline styles, дубльовані іконки, hardcoded кольори у ~5 місцях |
| Performance | 🟡 | Virtual lists, lazy модулі; 40s YouTube freeze без UI feedback |

---

## 5. Пріоритезований план дій

### Must-do до public beta (v0.1.0)

1. **ConfirmDialog скрізь, де є deletestructive** — Clipboard Backspace, Notes delete, Downloader cancel. Додати "Don't ask again" для recurring case. (S)
2. **EmptyState примітив** → застосувати у Clipboard / Notes / Downloader / Translator history. (S)
3. **Focus ring token + застосування** на Input, Select options, Row, Button. (S)
4. **Loading/progress feedback під час detect** — skeleton card + етапи. (M)
5. **Settings → About + Forget cookies** (ROADMAP 1.2, 1.8). (S)
6. **Semantic tone tokens** — `--color-{danger,success,warning}-{bg,fg}` + заміна hardcoded RGBA у Downloader/error banners. (S)
7. **Card примітив** → переїзд ActiveDownloadRow/DetectedPreview/Completed тайлів. (M)

### Polish (перед релізом 0.2)

8. Modal frame wrapper (рефактор 4-х власних реалізацій). (M)
9. Badge примітив + platform-color tokens. (S)
10. ~~PermissionGate shared компонент~~ — знято (native prompt покриває Clipboard; Recorder отримає власну логіку зі Swift-helper'ом).
11. Toast / Modal / Dropdown fade-транзиції + `--duration-*`, `--easing-*` tokens. (S)
12. Spacing / z-index / shadow scales у tokens. (S)
13. `useAnnounce` на критичні actions (paste, delete, pin, download start/finish, translate, save). (S)
14. Autosave status indicator у Notes. (S)
15. Settings subnav (General / Clipboard / Downloads / Recorder / Translator / About). (M)

### Стратегічне рішення

16. **i18n зараз або ніколи** — закласти інфраструктуру до подальшого росту рядкового корпусу, або зафіксувати EN-only як non-goal. (L для setup)
17. **⌘⌥N binding за `id` модуля** — щоб нові модулі не ламали м'язову пам'ять користувачів. (S)
18. **Onboarding / first-run overlay** — 1-2-екранний guide із `?` кнопкою. (M)

---

## 6. Додаткові спостереження

- **ROADMAP 1.7 "monochrome SVG tray icon"** — не дизайн-борг сам по собі, але critical для identity до beta.
- **Ukrainian-speaking user** — при додаванні i18n, **не** додавати російську (правило CLAUDE.md).
- **Tests coverage** (61 React + 57 Rust) — достатній безпечний фундамент для рефакторингу примітивів.
- **"Програма для копіювання OBS.md"** у корні виглядає як чернетка чужої фічі — перевірити, чи має бути тут.

---

*Рев'ю фокусується на UX/продукті та дизайн-системі. Питання технічної архітектури (Tauri bridge, SQLite schema, Swift IPC) винесені за дужки й можуть бути предметом окремого engineering review.*

---

## Статус виконання (оновлено 2026-04-19)

### Зроблено

| № | Пункт | Commit |
|---|---|---|
| 1 | ConfirmDialog на destructive (Clipboard Backspace, Notes delete, Downloader cancel) з `suppressibleLabel` + `useSuppressibleConfirm` hook | `ae6a1eb` |
| 2 | `EmptyState` примітив + застосування (Clipboard, Notes, Downloader) | `ae6a1eb` |
| 3 | `--ring-focus` токен + `.ring-focus` / `.ring-focus-within` утиліти, застосовані до Input, Button, IconButton, Row | `ae6a1eb` |
| 4 | Detect skeleton зі staged progress (`DetectSkeletonCard`) | `2286fe6` |
| 5a | Settings About tab + Forget cookies — *вже було в кодовій базі* (не потрібно доробляти) | — |
| 6 | Semantic tone tokens (`--color-{danger,success,warning}-{bg,fg,border}`) + light-overrides; Toast переведено на токени | `ae6a1eb`, `2286fe6+` |
| 7 | `Card` примітив (5 tones × 4 paddings × flat/raised × інтерактивний) + переїзд ActiveDownloadRow, DetectedPreviewCard | `ae6a1eb`, `2286fe6` |
| 8 | `Modal` обгортка (backdrop + focus trap + Esc + z-modal token) | `ae6a1eb` |
| 9 | `Badge` примітив (5 tones + brand color override) + PlatformBadge перероблено через нього | `ae6a1eb` |
| 11 | Fade/pop transitions на Modal + Toast через `--duration-base` / `--easing-*` | `48a17ef`, `2286fe6+` |
| 12 | Spacing (1–6), z-index, shadow, duration/easing tokens | `ae6a1eb` |
| 13 | `useAnnounce` на paste/pin/delete (Clipboard), pause/resume/remove (Downloader), translation ready (Translator), Notes autosave status | `48a17ef`, `2286fe6+` |
| 14 | `SaveStatusPill` у Notes (idle/saving/saved/error з `aria-live`) | `48a17ef` |
| 17 | ⌘⌥N прив'язка через `tabShortcutDigit` (стабільна за id модуля) | `2286fe6` |

### Не зроблено (обґрунтовано)

| № | Пункт | Причина |
|---|---|---|
| 10 | `PermissionGate` shared компонент | **Знято з backlog'у.** Native macOS prompt на старті покриває Clipboard Accessibility; Recorder отримає свою permission-логіку разом зі Swift-helper'ом. Окремий guide-overlay непотрібен. |
| 15 | Settings subnav | Subnav (General/Appearance/Clipboard/Downloads/About) **вже є** у `SettingsShell.tsx:28–36`. Пункт помилково включений у review. |
| 16 | i18n infrastructure | Стратегічне рішення рівня продукту; CLAUDE.md фіксує заборону `ru`, але не визначає статус інших мов. Залишається відкритим до явного рішення власника. |
| 18 | Onboarding first-run overlay | Не блокує beta й потребує окремого дизайну. Відкладено до v0.2. |

### Тестове покриття

Базова лінія до рев'ю: **314 тестів**. Після виправлень: **359 тестів** (+45 нових), усі зелені. Нові або оновлені тестові файли:

- `src/shared/ui/EmptyState.test.tsx` (5), `Card.test.tsx` (6), `Badge.test.tsx` (4), `Modal.test.tsx` (6)
- `src/shared/hooks/useSuppressibleConfirm.test.tsx` (6)
- `src/shared/ui/ConfirmDialog.test.tsx` (+3 suppressible cases)
- `src/shared/ui/Input.test.tsx` (+2 ring-focus cases), `Row.test.tsx` (+1 row-selected case)
- `src/modules/notes/SaveStatusPill.test.tsx` (5)
- `src/modules/downloader/DetectSkeletonCard.test.tsx` (5)
- `src/modules/clipboard/ClipboardPopup.test.tsx` (Backspace-confirm перетворено на 2 тести)
- `src/shell/PopupShell.test.tsx` (+1 tabShortcutDigit case)

