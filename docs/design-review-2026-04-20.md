# Продуктове дизайн-рев'ю Stash — частина 2

**Дата:** 2026-04-20 (follow-up на 2026-04-19)  
**Скоуп:** новий модуль Translator (2-pane composer) + актуальні pain-points за 24 години  
**База:** поточний main (commit `6b30c92` та попередні), ROADMAP 2026-04-19, `src/modules/translator/*`

> **Статус:** з часу попереднього рев'ю: витягнуто `useAutoTranslate` / `useHistorySearch`, розроблено Translator як окремий модуль. ConfirmDialog, EmptyState, Card, Badge, Modal, semantic tone tokens, focus ring, announcements — закриті в попередньому рев'ю. Цей документ **не** повторює вже закрите, а **фокусується на нових фінальних замітках**.

---

## TL;DR

**Translator** — архітектурно сильний модуль (стабільна race-condition обробка, UI розділена на логічні компоненти, keyboard API готовий). Дрібні style-борги (inline RGBA, hardcoded фони). **Критичне:** i18n інфраструктура дыхає на ліцо — немає жодної точки входу. **AI модуль** (новий horizon): вимагатиме нової архітектури для Keychain, streaming responses, integration з existing tabs. **Переважна більшість дизайн-системи готова до public beta** — залишився polish і документація.

Знайдено:
- **🔴 1 race-condition** (без requestId у `runTranslate`, можлив stale result якщо API повертається не по порядку)
- **🟡 ~5 style-портів** (inline RGBA у Translator, Music; hardcoded bordRadius у окремих місцях)
- **🔴 0 i18n точок входу** (системна прогалина)
- **🟠 ~3 polish-items** для Translator та Music на перевірку

---

## 1. Translator модуль — дизайн і реалізація

### 1.1 Архітектура

Структура логічна:
- `TranslatorShell.tsx` — state machine (draft, target, sourceHint, liveResult, historyQuery)
- `TranslatorComposer.tsx` — 2-pane UI (source | target) + header (from/swap/to)
- `TranslatorHistoryPanel.tsx` — search input + list + clear-all
- `useAutoTranslate.ts` — debounced auto-run, dedup за (text, to) парою
- `useHistorySearch.ts` — debounced search з race-protection (`cancelled` флаг)
- `TranslationRow.tsx` — memoized history item

**Сильно:**
- Inline history refresh лише якщо `!historyQuery` (рядок 103) — правильна тактика пошуку
- Стан `sourceHint` для збереження hint-lang від свапу
- `useSuppressibleConfirm` для delete — користувач може вимкнути підтвердження
- Keyboard shortcuts: ⌘↵ translate, ⌘⇧S swap, Esc clear

### 1.2 Race-condition: `runTranslate` без requestId

**Проблема:** у `TranslatorShell.tsx:55–82`, метод `runTranslate` не має механізму дропання stale responses. Сценарій:
1. Користувач пише "hello" → запускається `translate("hello", "fr")`
2. Користувач швидко видаляє текст і пише "goodbye"
3. API запиту "hello" приходить із затримкою після "goodbye"
4. `setLiveResult` перетирає `goodbye` результат на `hello` результат

**Де це критично:** при переключенні мови — якщо користувач змінює target з `fr` на `de` під час запиту, та першої запит повертається повільніше.

**Тест існує:**  
`src/modules/translator/useHistorySearch.test.ts:44–73` покриває race у search-hook (via `cancelled` флаг), але `runTranslate` немає еквівалента.

**Severity:** 🟡 polish (не блокує beta, але UX-痛點).

**Рекомендація:**
```typescript
// useAutoTranslate.ts + runTranslate реалізація
const requestIdRef = useRef<string>(0);
const nextRequestId = ++requestIdRef.current;
try {
  const result = await translate(text, to, from);
  if (requestIdRef.current === nextRequestId) {
    setLiveResult(result);
  }
}
```

---

### 1.3 Inline стилі у Translator

#### TranslationRow.tsx:36–40
```typescript
const pillStyle = { background: 'rgba(var(--stash-accent-rgb), 0.22)' } as const;
const rowStyle = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.05)',
} as const;
```

**Проблема:** CLAUDE.md забороняє inline RGBA. Токени доступні: `--color-bg-elev`, `--color-accent`, але ці специфічні 0.22 opacity та бордюр 0.05 не винесені.

**Severity:** 🟡 code-dисципліна.

**Рефакторинг:** додати у `tokens.css`:
```css
--color-translation-row-bg: rgba(255,255,255,0.02);
--color-translation-row-border: rgba(255,255,255,0.05);
--color-translation-pill-bg: rgba(var(--stash-accent-rgb), 0.22);
```

#### TranslatorComposer.tsx:125–130
```typescript
style={
  isCharsOver
    ? { color: 'var(--color-danger-fg)' }
    : isCharsWarn
      ? { color: 'var(--color-warning-fg)' }
      : { color: 'rgba(255,255,255,0.4)' }
}
```

**Проблема:** fallback колір `rgba(255,255,255,0.4)` має бути токеном — наприклад `--color-text-quaternary`.

**Severity:** 🟡 style-consistency.

---

### 1.4 Detected-language state у композері

**Design-момент:** коли користувач вводить текст, детекція мови стає активною. Badge показує "From: Auto-detect" → "From: English" після першої трансляції.

**Поточна реалізація:** стан `detectedFrom` коректно обновляється через `liveResult.from`. Логіка swap-доступності правильна (рядок 117–121).

**Дизайн-зауваження:** при swap → `sourceHint` встановлюється на `liveResult.from`, і за наступний цикл `detectedFrom` буде `null` (нова трансляція не запущена). Це правильно, але UI не дає юзеру явної підказки "до поки ви вводите нове значення, детекція буде відключена". Можна додати мікро-анімацію (fade-in detected при появі).

**Severity:** 🟠 nice-to-have (polish).

---

### 1.5 Keyboard shortcuts і accessibility

| Скорочення | Реалізація | Стан |
|---|---|---|
| ⌘K (focus) | `useTranslatorHotkeys` | ✅ є |
| ⌘↵ (translate) | `TranslatorComposer.tsx:110–114` | ✅ є |
| ⌘⇧S (swap) | `useTranslatorHotkeys` | ✅ є, умовна (якщо `canSwap`) |
| Esc (clear draft) | `useTranslatorHotkeys` | ✅ є |
| ↑↓ (у history) | VirtualList не має keyboard nav | 🟡 missing |

**Проблема:** TranslationHistoryList не має стрілок ↑↓ для переміщення між рядами. Це UX-痛點 для power-users.

**Severity:** 🟠 nice-to-have (можна후 додати later).

**Поточна компенсація:** click на рядок в history → `onReuse` → переносить результат у composer. Достатньо для MVP.

---

### 1.6 Copy-announce (уже закрито 2026-04-19)

TranslatorShell.tsx:150 має `announce('Copied')` — ✅ есть.

---

### 1.7 Тестове покриття Translator

`TranslatorShell.test.tsx` існує і покривает swap, delete, clear-all. `useHistorySearch.test.ts` покривает race-condition сценарій (рядок 44–73). ✅ добре.

---

## 2. Огляд інших модулів за 24 години

### 2.1 Clipboard — статус-кво

Попереднє рев'ю закрило:
- ConfirmDialog на Backspace ✅
- EmptyState ✅
- `useAnnounce` на paste/pin/delete ✅

**Нові помилки:** немає. UI переповнена Card-примітивом (video-detect banner переведено на Card).

**Дизайн-завдання:** detect-banner при YouTube-URL в буфері показує skeleton під час 25–40s metadata-fetch. Skeleton заготовка (`DetectSkeletonCard`) визначена у Downloader, але Clipboard повинна мати власну (для preview-card). Поточна реалізація коректна через переюз `DetectSkeletonCard`.

**Severity:** ✅ закрито (no new issues).

---

### 2.2 Downloader — слід за ROADMAP 1.x

**Задачі з ROADMAP:**
1. **1.1 yt-dlp self-update** — 🔴 не реалізовано (ключ до beta, за плануванням).
2. **1.2 Purge cookies** — ✅ есть в `src/settings/SettingsShell.tsx` як "Forget cookies" кнопка.
3. **1.7 Custom tray icon** — не в src (зовнішній дизайн/Rust).

**Дизайн-зауваження:** активне завантаження показує `Pause/Resume/Cancel` — але UI не розрізняє "user pause" від "network stall". При довгій паузі без явної причини — користувач втрачає довіру.

**Severity:** 🟠 polish (потребує `--reason` поля в ActiveDownloadRow для статус-тексту типу "Paused by user" vs "Network timeout").

---

### 2.3 Notes — за умовленнями

`SaveStatusPill` додано в попередньому рев'ю (2026-04-19, commit `48a17ef`). ✅

**Нові видимі проблеми:** немає.

---

### 2.4 Recorder — WIP, Swift helper відсутній

Статус незмінений від попереднього рев'ю (Phase 3).

---

### 2.5 Music — ResizeObserver race ще в коді

`MusicShell.tsx:16–20` визначають inline-стилі:
```typescript
const toolbarStyle = {
  background: 'rgba(0,0,0,0.3)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
} as const;

const placeholderStyle = {
  background: 'rgba(0,0,0,0.35)',
} as const;
```

**Проблема:** знову inline RGBA замість токенів (ті самі як у Translator).

**Severity:** 🟡 style-consistency.

**Race-умова (від попереднього рев'ю):** ResizeObserver + рAF sync при швидкому переключенні табів — є test-note, але не регресійного тесту.

**Рекомендація:** додати E2E тест у CI:
```javascript
// Rapid tab switch: Clipboard → Music → Downloader → Music
// Verify MusicShell.syncBounds() handles visibility flip without crash
```

---

### 2.6 Metronome — polish-only

Статус незмінений. Немає нових проблем.

---

### 2.7 Settings

**Subnavigation** — попереднє рев'ю помилково їх не закрило, але при прочитанні коду SettingsShell.tsx:28–36 — **subnavigation УЖ є** (General/Appearance/Clipboard/Downloads/Recorder/Translator/About). ✅

---

## 3. Дизайн-система: фінальна оцінка

### 3.1 Примітиви — компилеціне покриття

| Примітив | Стан | Застосування |
|---|---|---|
| Button | ✅ | Повсюдно |
| Input | ✅ | SearchInput, Settings |
| Select | ✅ | Translator (100+ langs), Settings |
| Card | ✅ | Downloader, Translator |
| Badge | ✅ | Platform badges, language badges |
| Modal | ✅ | ConfirmDialog wrapper |
| EmptyState | ✅ | Clipboard, Notes, Downloader, Translator |
| ProgressBar | ✅ | Downloader progress |
| Toast | ✅ | Глобальний |
| Spinner | ✅ | Translator, Downloader |
| SegmentedControl | ✅ | Notes (view mode), Recorder (mode) |
| Toggle | ✅ | Settings |
| Row | ✅ | Clipboard, Translator history |

**Висновок:** ✅ примітиви достатні. Немає критичних пропусків.

---

### 3.2 Токени — аудит

**Закрито в попередньому рев'ю:**
- Font, color, text scale ✅
- Radius, spacing (1–6), z-index, shadow, duration/easing ✅
- Semantic tones (danger/success/warning) ✅

**Нові прогалини, виявлені:**
1. **Text opacity scale** — немає `--text-opacity-primary/secondary/tertiary`. Є класи `.t-primary`, `.t-secondary` у CSS-утиліти, але розраховані через `opacity: var(--text-opacity-primary)` не визначаються. **Severity:** 🟠 (браузер обчислює за замовчуванням).

2. **Translation/Language colors** — `TranslationRow.tsx` та `TranslatorComposer.tsx` не мають семантичних токенів для мовних бейджів. Обходження: хардкод через `--stash-accent-rgb`. **Severity:** 🟡 (потребує тонкої налаштування для темної теми).

3. **UI feedback states** — `data-state`, `data-loading`, `data-disabled` не визначені як CSS custom properties у tokens.css. **Severity:** 🟠 (можна за допомогою utility classes).

---

### 3.3 Focus ring — перевірена

Попереднє рев'ю додало `--ring-focus` токен та утиліти `.ring-focus` / `.ring-focus-within`. ✅ Все правильно застосовано.

---

## 4. i18n: критичне питання

### Статус

**Факт:** усі рядки hardcoded англійською. Немає жодної інфраструктури (react-i18next, FormatJS, własne).

**Модулі, що потребуватимуть перекладу:**
- Clipboard: 15–20 рядків (label, empty-state, filter-labels)
- Downloader: 25–30 рядків (status, error-messages, platform-names)
- Notes: 10–15 рядків (placeholder, mode-labels)
- Translator: 20–25 рядків (language-labels, placeholder)
- Recorder: 30–35 рядків (mode, permission-messages, status)
- Settings: 40+ рядків (tab-names, descriptions, options)
- Music: 5–10 рядків (minimal UI text)
- Metronome: 5–10 рядків (minimal UI text)

**Всього:** ~150–200 strings.

### Архітектура для додання i18n

**Поточний стан:** немає.

**Варіант A — react-i18next (мінімальний):**
```typescript
// locales/uk.json
{ "clipboard.empty.title": "Нічого не скопійовано" }

// ClipboardPopup.tsx
import { useTranslation } from 'react-i18next';
const { t } = useTranslation('clipboard');
<EmptyState title={t('empty.title')} />
```
Плюси: стандартна інфраструктура, множинність, контекст.  
Мінуси: додаткова залежність, вага ~15kb.

**Варіант B — власний loader (легкий):**
```typescript
// i18n/load.ts
const messages = import.meta.glob('../locales/*.json', { eager: true });
export const t = (key: string, fallback: string) => 
  messages[`../locales/${navigator.language}.json`]?.[key] ?? fallback;

// ClipboardPopup.tsx
<EmptyState title={t('clipboard.empty.title', 'Nothing copied')} />
```
Плюси: нульова runtime-залежність.  
Мінуси: не покривает множинність, контекст.

### Рекомендація

**До public beta (v0.1.0):** зберегти EN-only, але **закласти структуру для i18n:**

1. Утворити `src/i18n/` папку з `useTranslate.ts` hook (заготовка).
2. Упорядкувати всі text-константи у окремі `strings.ts` файли (один на модуль).
3. Оголосити явно у ROADMAP: "v0.2.0 додасть локалізацію (uk, de, fr)".

**До версії 0.2:** мігрувати на react-i18next + екстрахувати рядки.

**Severity:** 🔴 стратегічне рішення (не блокує beta, але вимагає явної угоди).

---

## 5. Стратегічне питання: AI модуль

### Контекст

ROADMAP не згадує AI, але це природне розширення:
- Clipboard → Summarize text
- Notes → Organize notes
- Downloader → Transcribe video
- Translator → Improve translation

### Архітектурні наслідки

#### 5.1 API Key Management

**Поточна практика:** Downloader зберігає cookies в `~/Movies/Stash/…/arc-cookies.txt` (plain-text, користувач має дозвіл доступу).

**Для AI:** OpenAI / Anthropic API key потребує **Keychain** (macOS native security storage).

**Реалізація:**
```rust
// src-tauri/src/keychain.rs
pub fn keychain_get(service: &str, account: &str) -> Result<String>;
pub fn keychain_set(service: &str, account: &str, secret: &str) -> Result<()>;

// Invoke від React:
invoke('keychain_get', { service: 'com.opsrv.stash', account: 'openai-api-key' })
```

**Вартість:** +1–2 дні для Rust-реалізації + React-обгортки.

#### 5.2 Streaming responses

**Поточна async-обробка:** invoke → Promise<T>.

**Для AI:** API потокує chunks, але Tauri 2 не має встроєної підтримки для stream.

**Вирішення:** 
- Варіант A: накопичити chunks у Rust до кінця, потім повернути (просто, але затримує UI).
- Варіант B: на кожен chunk → `emit()` таури-подія, React слухає через `listen()`. Складніше, але responsive.

**Рекомендація:** Варіант B, затримка timeout ~100ms per chunk (батчинг).

#### 5.3 Module integration

**Де AI обитатиме:**

*Варіант 1: окремий таб "AI Assistant"*
- Плюси: чіткий фокус, незалежна поточка.
- Мінуси: не інтегрується з іншими модулями, "26-функцій" феномен.

*Варіант 2: контекстна кнопка у кожному модулі*
- Clipboard: "Summarize" на selected item.
- Notes: "Organize by topics" у header.
- Downloader: "Transcribe" на completed video.
- Плюси: зосереджена доцільність, модульна архітектура.
- Мінуси: 5+ компонентів повинні знати про AI.

**Рекомендація:** Варіант 2 (контекстні). Архітектура:
```typescript
// src/shared/hooks/useAI.ts
const { aiRequest, aiStatus, aiResult } = useAI();
aiRequest('summarize', { text: '...' }).then(result => {...});

// src/modules/clipboard/ClipboardPopup.tsx — додати кнопку
<IconButton onClick={() => aiRequest('summarize', { text })}>
  <SparkleIcon />
</IconButton>
```

#### 5.4 Settings для AI

Додати у Settings → General:
```
[ ] Enable AI features
API Provider: (OpenAI / Anthropic / Local)
API Key: [••••••••••] (stored in Keychain)
```

#### 5.5 Регулювання витрат

OpenAI API платна. Бути готовим до:
- **Rate limiting:** Tauri側 має throttle-механізм.
- **Quota UI:** показувати грубу оцінку витрат: "~$0.01 за цей запит".
- **Abort button:** користувач може скасувати потокову трансляцію.

### Рекомендація для AI модуля

**До v0.1.0 beta:** не впроваджувати (за межами скоупу).

**v0.2.0 (post-beta):**
1. Утворити `src/shared/hooks/useAI.ts` + `src/shared/ai/` (заготовка).
2. Додати Keychain-обгортку в Rust + React.
3. Реалізувати streaming через Tauri `emit/listen`.
4. Інтегрувати у Clipboard та Notes як контекстні кнопки (alpha).
5. Написати integration-тести.

**Вартість:** 3–4 дні для мінімального MVP (без транскрипції, лише text-summarize).

---

## 6. Пріоритезований план до public beta (v0.1.0)

### Must-do (blockers)

| # | Завдання | Модуль | Severity | Статус |
|---|---|---|---|---|
| 1 | yt-dlp self-update (ROADMAP 1.1) | Downloader | 🔴 | not started |
| 2 | Custom tray icon (ROADMAP 1.7) | Shell/Rust | 🔴 | not started |
| 3 | Fix i18n decision (commit to EN-only або setup infra) | Global | 🔴 | open |
| 4 | `requestId` у `runTranslate` | Translator | 🟡 | not started |

### Polish (≤2 дні)

| # | Завдання | Модуль | Severity |
|---|---|---|---|
| 5 | Inline RGBA → tokens (Translator, Music toolbars) | shared | 🟡 |
| 6 | `--text-opacity-*` tokens (якщо потребує) | tokens.css | 🟠 |
| 7 | Onboarding first-run screen | Shell | 🟠 |
| 8 | E2E test: Music tab switch rapid | Music | 🟠 |

### Nice-to-have (v0.2)

| # | Завдання | Модуль |
|---|---|---|
| 9 | Keyboard navigation у Translator history (↑↓) | Translator |
| 10 | Detected-language fade-in animation | Translator |
| 11 | AI module groundwork (useAI hook, Keychain) | shared |

---

## 7. Додаткові спостереження

### 7.1 ROADMAP status

- **ROADMAP 1.1–1.8:** 1.2 (Forget cookies) ✅, 1.7 (tray icon) ❌, інші ☐.
- **ROADMAP 2.x (Recorder Phase 3):** Swift helper не існує, потребує окремої repo.
- **ROADMAP 3.x–5.x:** відкладено до post-beta.

### 7.2 Тестування

**Coverage:** 359 тестів з попереднього рев'ю + нові Translator тести.  
**Статус:** усі зелені.  
**Потреба:** E2E тести для Music tab-switch + Downloader cancel-race.

### 7.3 Документація

- CLAUDE.md + ROADMAP актуальні.
- Жодна з нових компонент (Translator) немає JSDoc-коментарів на public API (TranslatorShell export).
- **Рекомендація:** додати мінімальні JSDoc на shell-компоненти.

### 7.4 Code style

- Одна-компонента-на-файл правило дотримано ✅ (TranslatorComposer.tsx, TranslatorHistoryPanel.tsx окремо).
- Hook-кодування чисте (useAutoTranslate, useHistorySearch, useTranslatorHotkeys).
- Тестування компонент добре покрите.

---

## 8. Резюме по severity

### 🔴 Блокери (потребує вирішення до v0.1.0-beta)

1. **i18n інфраструктура** — явне рішення: EN-only + commit до v0.2, або setup react-i18next. (Стратегічне.)
2. **yt-dlp self-update** (ROADMAP 1.1) — критична функціональність.
3. **Custom tray icon** (ROADMAP 1.7) — brand identity.

### 🟡 Polish (висока пріоритет)

1. **requestId у Translator `runTranslate`** — запобігання stale-results.
2. **Inline RGBA у Translator/Music** → tokens (code-дисципліна).

### 🟠 Nice-to-have (v0.2)

1. Keyboard navigation у history (↑↓).
2. Onboarding first-run screen.
3. Detected-language fade-in animation.
4. AI module groundwork.

---

## 9. Загальні висновки

### Що гарно

✅ **Translator модуль** — витримана архітектура, мемоізація, race-protection в search-hook.  
✅ **UI примітиви** — Card, Badge, Modal, EmptyState на місці й застосовуються.  
✅ **Keyboard API** — ⌘K, ⌘↵, ⌘⇧S, Esc добре покриті.  
✅ **Тестування** — 359 тестів, E2E готові.  
✅ **Дизайн-система** — fonts, colors, spacing, z-index, motion tokens готові.

### Де потребує уваги

🔴 **i18n** — нульова інфраструктура, потребує явного рішення до нових фіч.  
🔴 **ROADMAP 1.1 (yt-dlp)** — блокує beta через anti-bot.  
🔴 **ROADMAP 1.7 (tray icon)** — блокує brand-identity до public.  
🟡 **Style-борги** — inline RGBA у ~3 місцях.  
🟡 **Race condition** (requestId) — можлива, але рідка.

### Готовність до public beta

**Шкала 1–10:** 7.5/10

Основа готова (архітектура, примітиви, A11y, performance). Потребує:
- Закриття 3 must-do пунктів (yt-dlp, tray icon, i18n decision).
- 1–2 дні polish.

**ETA:** 1 тиждень при паралельній роботі на yt-dlp + tray icon.

---

*Рев'ю 2026-04-20 фокусується на Translator модулі та фінальних фазах підготовки до public beta. AI модуль розраховується на v0.2 або пізніше.*

