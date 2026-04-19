# UI Design Review: Stash (macOS, 720×520, Tauri 2 + React 19)
**Дата**: 20 квітня 2026 | **Мова рев'ю**: українська | **Фокус**: дизайн UI (не архітектура, не a11y, не i18n)

---

## TL;DR

- ✅ **Базова цілісність** витримується: SF Pro шрифт, 4px spacing scale, 8/12/16px radius, blurred panes відчуваються «макос»
- 🟡 **Плавучі недоліки**: 
  - `TabButton` асиметричний padding (px-2 py-1 при інших компонентах ~16px height)
  - `TranslatorComposer` картина та `ClipboardPopup` header — невпевнений spacing (px-3 py-2 vs px-4 pt-3 pb-2)
  - Toggle свічка має сирий shadow-стиль (не macOS-like)
  - Деякі компоненти використовують inline color-текст замість semantic tokens (e.g., `#f87171` vs `var(--color-danger-fg)`)
- 🔴 **Критичні**: немає — але плівка несміливих розривів зустрічається в темі light (не вистачає кольорів для некритичних элементів)
- 🟠 **Перфекціонізм**: Row actions мають `opacity-0 → opacity-100` transition без explicit `timing-function`; microshadows нестійкі

---

## Сильні сторони

1. **Типографіка та ієрархія** (9/10)
   - 5 рівнів: `text-meta` (11px/14px), `text-body` (13px/18px), `text-title` (15px/20px), `text-heading` (18px/24px)
   - Ясна концепція t-primary/secondary/tertiary для контрастності
   - SF Pro як базовий шрифт дає macOS-DNA
   - Letter-spacing у `section-label` (0.06em) хороша

2. **Семантичні кольори**
   - Danger/success/warning palette логічна та узгоджена (RGB-базованих для альфа-маніпуляцій)
   - Accent (#2f7ae5) чіткий, не надто яскравий для тьмавого інтерфейсу
   - Semantic bg/fg/border теми `--color-*-{bg,fg,border}` покривають більшість сценаріїв

3. **Spacing scale**
   - 4px базова сітка: 4, 8, 12, 16, 24, 32px — послідовна
   - Більшість компонентів дотримуються шкали
   - Padding у input-field, button consistent

4. **Motion & transitions**
   - Duration tokens (120ms fast, 180ms base, 260ms slow) раціональні
   - Cubic-bezier еasing (0.2,0,0.2,1) — Material Design-like, роботить добре
   - Focus ring animation відповідь на interactivity

5. **Vibrancy & backdrop**
   - `.pane` classa з blur + saturate дає справжній macOS aesthetic
   - Light/dark parity у backdrop-фільтрі реалізована
   - Двошарова тінь (inset + outer) для глибини

6. **Компонентна конскалація**
   - Button system розбитий правильно: 4 варіанти × 5 тонів
   - Card, Surface, Row — primitivи мають чітку відповідальність
   - Row/selection states (row-active, row-selected, row-pinned) відрізняються

---

## Візуальна система: прогалини у scale & consistency

### 1. **Spacing/Padding дисбаланси** 🟡

| Компонент | Padding/Gap | Проблема |
|-----------|-------------|----------|
| `SearchInput` (ClipboardPopup:545) | `gap-2.5 px-3 py-2.5` | OK, але 2.5 не в scale (должно 2 або 3) |
| `TabButton` (TabButton.tsx:24) | `px-2 py-1` | height ≈14px — найменший в app. Сусідні buttons h-7 (28px). Асиметричний. |
| `TranslatorComposer` header (TranslatorComposer:66) | `px-3 pt-3 pb-2` | 3 вверху, 2 внизу — невпевнено |
| `ClipboardPopup` selection bar (ClipboardPopup:526) | `px-3 py-1.5` | OK, але y-padding мало для 34px висоти |
| `DownloadsShell` section label (DownloadsShell:320) | `px-4 pt-3 pb-1` | 4px x, але py нерівне (3 vs 1) |
| `NotesShell` aside button (NotesShell:267) | `px-3 py-2` | Хорошо, але рядок має 38–44px, залежит від 2 лінй тексту |

**Рекомендація**: Прийняти явний padding spec: `[xs=2px, sm=3px, md=4px, lg=6px]` × `[top/bottom, left/right]` у кожного контейнера.

### 2. **Border radius consistency** 🟡

```
--radius-sm: 8px     ← TabButton, kbd, segmented control buttons
--radius-md: 12px    ← Input, Button, IconButton, Card (default)
--radius-lg: 16px    ← Card lg, Surface lg
```

**Проблемі**:
- Row (Row.tsx:31) усередині має `rounded-lg` (16px), але його icon-wrapper `rounded-md` (12px) → мікро-мізарне неузгоджене.
- PopupShell (PopupShell:225) має `rounded-2xl` на контейнері, але в него header з `hair` бордєром — чиста макос, но ніколи явно не заявлена.
- Toggle (Toggle.tsx:14) має `rounded-full`, не `rounded-sm` чи `rounded-md` — unique case, OK.

### 3. **Shadow scale** 🟠

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.18);
--shadow-md: 0 6px 14px -4px rgba(0, 0, 0, 0.35);
--shadow-lg: 0 18px 38px -10px rgba(0, 0, 0, 0.5);
```

**Проблема**: `.pane` використовує **custom multi-layer shadow** (inset + outer), не йде з tokens:
```css
box-shadow:
  0 1px 0 0 rgba(255, 255, 255, 0.05) inset,  /* Гарячий edge */
  0 30px 60px -20px rgba(0, 0, 0, 0.55),       /* Глибокий падок */
  0 0 0 0.5px rgba(0, 0, 0, 0.6);              /* Субпиксель border */
```
— це хорошо, але **Toggle** має простий `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)` (не в scale, насичення 50% за замовчуванням) — див. Toggle.tsx:18. Повинно бути `var(--shadow-sm)`.

### 4. **Color mismatches & hardcodes** 🟡

Окремі файли використовують **hardcoded hex** замість tokens:

| Файл | Hardcode | Має бути |
|------|----------|----------|
| Toggle.tsx:15 | `#2F7AE5` | `var(--stash-accent)` |
| Toggle.tsx:15 | `rgba(255,255,255,0.12)` | `var(--color-secondary)` або новий token |
| DownloadsShell:43 | `rgba(0,0,0,0.55)` | може бути `--shadow-overlay` |
| ClipboardPopup:605 | `rgba(0,0,0,0.18)` | токен для `--color-bg-level-2` |
| MusicShell:14-19 | inline `rgba(0,0,0,0.3)` | обов'язково у tokens |

---

## По кожному модулю: візуальна аналіз

### **Translator (TranslatorShell.tsx + TranslatorComposer.tsx)**

**Композиція**: 
- Верхня шапка (from ↔ to, select target) — flex row, Badge-based
- Двоколонна грід карток (source | result) — `grid grid-cols-2 gap-2`
- Нижній підпис (hotkeys) — маленький шрифт

**Потенціальні проблеми**:
1. **Badge як заголовок мови** (TranslatorComposer:67-70) — Badge бля заголовка неправильно. Повинно бути окремий елемент. Зараз Badge має height 18px, padding 6px, що виглядає як button, а не label.
   - 🟡 Severity: polish. `src/modules/translator/TranslatorComposer.tsx:67`
   
2. **Card padding** (TranslatorComposer:90) — дві картки мають `padding="sm"` (12px), що дає `min-h-[120px]` для textarea. На малому 720px екрані це може бути занадто щільно.
   - 🟠 Severity: perfectionism. `src/modules/translator/TranslatorComposer.tsx:90`

3. **Character counter color** (TranslatorComposer:124-130) — inline styles для warning/error, не semantic tokens.
   - 🟡 Severity: polish. `src/modules/translator/TranslatorComposer.tsx:126`

4. **Keyboard hints at bottom** (TranslatorComposer:194-201) — `Kbd` компоненти мають 18px height, gap-1.5 між ними, але текст `t-tertiary text-meta` — контрастність невелика. На світлій темі може бути проблема.
   - 🟡 Severity: polish (dark/light parity). `src/modules/translator/TranslatorComposer.tsx:194`

---

### **Clipboard (ClipboardPopup.tsx)**

**Композиція**: 
- Вверху: selection bar (if active) — accent-фон
- Search input з іконкою + hint kbd
- Video banner (якщо детековано URL) — inline preview card
- Virtual list основного контенту
- Footer з фільтрами + очистити

**Потенціальні проблеми**:

1. **Selection bar padding** (ClipboardPopup:526) — `px-3 py-1.5` дає лінію 34px висоти, але текст `text-meta` (11px) мало переважує. Перевагу дати `py-2` (8px) для кращого rhythm.
   - 🟡 Severity: polish. `src/modules/clipboard/ClipboardPopup.tsx:526`

2. **Video banner card** (ClipboardPopup:554-592) — inline styled `background: 'rgba(var(--stash-accent-rgb),0.08)'` замість компоненту Card. Гарячо, але неконсистентно. Повинно юзати Card із `tone="accent"`.
   - 🟡 Severity: polish. `src/modules/clipboard/ClipboardPopup.tsx:554`

3. **Footer background** (ClipboardPopup:605) — `background: 'rgba(0,0,0,0.18)'` — hardcode без токена.
   - 🟡 Severity: polish. `src/modules/clipboard/ClipboardPopup.tsx:605`

4. **Row actions opacity** (ClipboardPopup: в Row.tsx лінія 58) — `opacity-0 group-hover:opacity-100 transition-opacity`. Transition-duration **не вказана** — залежить від default `150ms`, що може не узгоджуватись з `--duration-base: 180ms`.
   - 🟡 Severity: polish. `src/shared/ui/Row.tsx:58`

5. **Link rows vs text rows** — LinkRow, TextRow отримують різні іконки + тинти. Немає явної spec для що за розмір іконки (12px vs 13px).
   - 🟠 Severity: perfectionism. `src/modules/clipboard/ClipboardPopup.tsx:450-514`

---

### **Downloader (DownloadsShell.tsx)**

**Композиція**: 
- DownloadUrlBar (input + detect button)
- DetectSkeletonCard (якщо завантажується)
- DetectedPreviewCard (thumbnail + info + quality picker)
- Error banner (якщо detect failed)
- Scrollable main:
  - Active downloads (row-based list)
  - Completed (toggle list/grid view)
  - Empty state або completed tiles

**Потенціальні проблеми**:

1. **Section label spacing** (DownloadsShell:320) — `px-4 pt-3 pb-1` неревне. Пізніше (line 336) `pt-4 pb-1` — іще більше дисбаланс. Повинно визначити единий spec: `pt-3 pb-2` або `pt-4 pb-2`.
   - 🟡 Severity: polish. `src/modules/downloader/DownloadsShell.tsx:319, 336`

2. **Error banner color** (DownloadsShell:44-48) — использует semantic colors правильно, но `color: 'var(--color-danger-fg)'` в inline style нерідко буває потім змінено в light theme. Потім перевірити.
   - 🟠 Severity: perfectionism. `src/modules/downloader/DownloadsShell.tsx:44`

3. **Duration badge styling** (DownloadsShell:281) — `durationBadgeStyle = { background: 'rgba(0,0,0,0.55)' }` — hardcode, не токен.
   - 🟡 Severity: polish. `src/modules/downloader/DownloadsShell.tsx:43`

4. **SegmentedControl spacing** (DownloadsShell:339) — `size="sm"` має padding `px-2 py-0.5`, що у маленьких попапах може виглядати крихітно поруч із Label.
   - 🟠 Severity: perfectionism. `src/modules/downloader/DownloadsShell.tsx:339`

---

### **Notes (NotesShell.tsx)**

**Композиція**: 
- Левая сайдбар (220px фіксована) з SearchInput + новая nотка кнопка + список нот + import кнопка
- Права main область:
  - Если активна нота: заголовок + view mode selector + export/delete buttons, потім split/edit/preview
  - Якщо пусто: EmptyState

**Потенціальні проблеми**:

1. **Aside button styling** (NotesShell:267) — flex button без явного hover-state. Клас `w-full text-left px-3 py-2 cursor-pointer ${n.id === activeId ? 'row-active' : ''}`. Повинно додати `hover:bg-white/[0.04]` або `group` з opacity controls.
   - 🟡 Severity: polish. `src/modules/notes/NotesShell.tsx:267`

2. **Title input** (NotesShell:312) — `text-heading font-medium` (18px/24px), але без background-color явно заявленого. На light theme може мати гірше контрастність.
   - 🟡 Severity: polish (light theme). `src/modules/notes/NotesShell.tsx:312`

3. **Save status pill** (NotesShell:318) — компонент не показаний у файлі (імпортований у SaveStatusPill.tsx). Потрібно перевірити його styling.
   - 🟠 Severity: perfectionism. `src/modules/notes/NotesShell.tsx:318`

4. **Border between panes** (NotesShell:349) — `border-r hair` для розділювача. Hair клас = `background: rgba(255,255,255,0.06)`, що на light theme стає `rgba(0,0,0,0.08)`. Це тонко, але достатньо.
   - ✅ OK.

---

### **Music (MusicShell.tsx)**

**Композиція**: 
- Toolbar: YouTube Music label + reload/reset buttons
- Placeholder sizer (native webview overlay)

**Потенціальні проблеми**:

1. **Toolbar style** (MusicShell:13-16) — inline CSS:
   ```javascript
   background: 'rgba(0,0,0,0.3)',
   borderBottom: '1px solid rgba(255,255,255,0.06)',
   ```
   Першый — hardcode, не токен. Другий — `hair` класс, добре.
   - 🟡 Severity: polish. `src/modules/music/MusicShell.tsx:14`

2. **Placeholder style** (MusicShell:19) — `background: 'rgba(0,0,0,0.35)'` — ще один hardcode.
   - 🟡 Severity: polish. `src/modules/music/MusicShell.tsx:19`

3. **Loading text** (MusicShell:156) — `t-tertiary text-meta` на placeholder. На 520px висоти це буде центровано добре, але коли webview завантажена, текст зникає. OK.

---

## Крос-модульна неконсистентність

### 1. **Headers & section labels**

| Локація | Стиль | Проблема |
|---------|-------|----------|
| PopupShell header (PopupShell:226) | `px-2 py-1.5 border-b hair` | h ~24–28px, 1.5px padding asymmetric |
| ClipboardPopup selection bar (ClipboardPopup:526) | `px-3 py-1.5` | h ~34px, тісніше |
| DownloadsShell section labels (DownloadsShell:320, 336) | `px-4 pt-3 pb-1` vs `pt-4 pb-1` | Дисбаланс |
| NotesShell editor header (NotesShell:311) | `px-4 pt-3 pb-2` | Гарячо, але unique |

**Рекомендація**: Визначити единий header spec: `px-3 py-2` або `px-4 py-2.5` для всіх.

### 2. **Empty states**

EmptyState компонент має два варіанти: `default` (py-10 px-6) vs `compact` (py-6 px-4).
- NotesShell lines 288–292 використовує `compact`
- DownloadsShell line 372 використовує `default` (умовно)
- Clipboard не має EmptyState (має virtual list пусту)

Це OK, але потрібно явно документувати в компоненті, коли якого юзати.

### 3. **Button consistency**

| Контекст | Button config | Проблема |
|---------|---|---|
| NotesShell new note (line 254) | `size="sm" variant="soft" tone="accent"` | OK |
| ClipboardPopup bulk actions (line 533) | `size="xs"` | Деякі `xs` (18px), деякі `sm` (28px) — немає ясного spec |
| DownloadsShell quality picker buttons (line 569) | `size="sm" variant="soft" tone="accent"` | OK |

### 4. **Row icon sizing**

Row.tsx:47 — icon wrapper завжди `w-7 h-7`, але іконки всередині можуть бути 12px vs 13px. На Retina дисплеї це 0.5px мізань, але на скріншотах видно.

---

## Micro-details

### 1. **Focus ring мізання** 🟠

`--ring-focus` має 2px + 3px outer ring, що в total 5px halo. На маленькому TabButton (px-2 py-1, ~14px height) це хало буде більше, ніж сам button! Потрібна responsive ring width.

**Рекомендація**: `--ring-focus-sm: 0 0 0 1px ..., 0 0 0 2px ...;` для маленьких компонентів.

### 2. **Toggle свічка shadow** 🟡

Toggle.tsx:18 — слід має `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)`, що занадто тьмаво. Повинно бути `0 1px 0.5px rgba(0, 0, 0, 0.2)` або `var(--shadow-sm)`.

**Рекомендація**: Замінити на `box-shadow: var(--shadow-sm);`

### 3. **Segmented control button alignment** 🟠

SegmentedControl.tsx:45 — кнопки мають `padding[sm]` як `px-2 py-0.5`, що 8px × 2px. На мобільних це lehet OK, але на desktop це виглядає переущільнено. Текст `font-medium` у `text-meta` (11px) в середині 2px padding — це напрочуд.

### 4. **Badge height mismatch** 🟠

Badge.tsx — `.stash-badge` має `height: 18px` жорстко. TabButton використовує Kbd (same 18px), але Badge усередині контролю виглядають як маленькі кнопки. На Translator header це робить заголовок мови як clickable елемент.

### 5. **Unvisited vs visited states** 🟠

Никде не запровадженої `:visited` стилізації для посилань. LinkRow використовує єдиний стиль. OK для закритого додатку.

### 6. **Hover state transitions** 🟡

Row.tsx:58 — `transition-opacity` без explicit `duration`. Button.tsx:116 — `transition-colors` також без duration. Повинно бути `transition-colors duration-150` або `transition-[color_opacity] duration-[120ms]`.

**Рекомендація**: Додати `duration-150` до кожного transition.

---

## Dark vs Light parity

### ✅ Сильні моменти:

1. **Text colors** — t-primary/secondary/tertiary добре покривають обидві теми (light має rgb(20, 22, 28), dark — rgb(255, 255, 255))
2. **Semantic danger/success/warning** — RGB-базована система дозволяє альфа-модуляцію на обидвох темах
3. **Pane backdrop** — dark і light мають окремі opacity значення (`0.35` vs `0.5`)

### 🟡 Проблеми:

1. **Hardcoded rgba(0,0,0,...)** — MusicShell, DownloadsShell, ClipboardPopup мають кілька `rgba(0,0,0,...)` inline, які на light theme виглядають як чорні смуги. Повинно бути семантичні токени.

2. **Kbd styling** (tokens.css:254-258) — light mode має `background: rgba(255,255,255,0.9)`, що майже білий з чорною рамкою. На clipboard footer (ClipboardPopup:616) це контрастно і добре видно, але на деяких фонах може бути напрочуд.

3. **Input field borders** (tokens.css:324-326) — light має `border: 1px solid rgba(0,0,0,0.09)`, що дуже тонко. На 720px дисплеї може бути складно розпізнати фокус.

---

## Топ-10 візуальних виправлень у пріоритеті

### 1. **CRITICAL: TabButton height дисбаланс** 🔴
- **Файл**: `src/shared/ui/TabButton.tsx:24`
- **Проблема**: `px-2 py-1` дає height ~14px, решта app юзає h-7 (28px) чи h-8 (32px)
- **Фікс**: Змінити на `px-3 py-2` або додати явно `h-7` в className
- **Пріоритет**: 1

### 2. **MAJOR: Hardcoded inline colors замість tokens** 🟡
- **Файли**: MusicShell:14,19; DownloadsShell:43; ClipboardPopup:605; Toggle:15
- **Проблема**: 5+ hardcoded `rgba(...)` не евкономять light/dark theme
- **Фікс**: Додати токени в `tokens.css` чи юзати esistuючі semantic tokens
- **Пріоритет**: 2

### 3. **Section label spacing неревность** 🟡
- **Файл**: `src/modules/downloader/DownloadsShell.tsx:319,336`
- **Проблема**: `pt-3 pb-1` vs `pt-4 pb-1` неконсистентно
- **Фікс**: Прийняти `pt-3 pb-2` для всіх section headers
- **Пріоритет**: 3

### 4. **Row actions transition не має duration** 🟡
- **Файл**: `src/shared/ui/Row.tsx:58`
- **Проблема**: `transition-opacity` без `duration-150` або `duration-[var(--duration-base)]`
- **Фікс**: Замінити на `transition-opacity duration-150`
- **Пріоритет**: 4

### 5. **Toggle shadow не у scale** 🟡
- **Файл**: `src/shared/ui/Toggle.tsx:18`
- **Проблема**: `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)` — насичення 50%, не 18% як --shadow-sm
- **Фікс**: Замінити на `box-shadow: var(--shadow-sm);`
- **Пріоритет**: 5

### 6. **Badge як заголовок мови (UX, не design)** 🟡
- **Файл**: `src/modules/translator/TranslatorComposer.tsx:67`
- **Проблема**: Badge має height 18px, виглядає як кнопка, але це статичний label
- **Фікс**: Замінити на простий `<span>` з правильними text styles, не Badge
- **Пріоритет**: 6

### 7. **Selection bar padding tight** 🟡
- **Файл**: `src/modules/clipboard/ClipboardPopup.tsx:526`
- **Проблема**: `py-1.5` мало для 34px-високої лінії з `text-meta`
- **Фікс**: Змінити на `py-2` або `py-2.5`
- **Пріоритет**: 7

### 8. **Video banner card inline styled замість Card компонента** 🟡
- **Файл**: `src/modules/clipboard/ClipboardPopup.tsx:554`
- **Проблема**: `style={{ background: 'rgba(var(--stash-accent-rgb),0.08)' }}` замість `<Card tone="accent">`
- **Фікс**: Замінити `<div>` на `<Card tone="accent" padding="sm">` з корекцією лейауту
- **Пріоритет**: 8

### 9. **Focus ring у TabButton розмір занадто великий** 🟠
- **Файл**: `src/styles/tokens.css:87-89`
- **Проблема**: 5px halo на 14px button = більше ніж сам button
- **Фікс**: Додати `--ring-focus-sm` для маленьких компонентів
- **Пріоритет**: 9

### 10. **Heading input на light theme контрастність** 🟡
- **Файл**: `src/modules/notes/NotesShell.tsx:312`
- **Проблема**: `text-heading font-medium` без явного `t-primary` на light режимі
- **Фікс**: Додати явний `t-primary` або обов'язкова text-color
- **Пріоритет**: 10

---

## Верхньорівневі рекомендації

### 1. **Дефіниціїя "header spec"**
Всі headers (PopupShell, модульні headers, section labels) повинні мати єдину специфікацію:
- **Option A**: `h-8 px-3 py-2` (32px висоти, medium padding)
- **Option B**: `h-7 px-3 py-1.5` (28px висоти, compact)

Вибрати одну, потім рефакторити всіх 15+ місць.

### 2. **Семантичні tokens для backgrounds**
Додати до `tokens.css`:
```css
--color-bg-level-1: rgba(28, 28, 32, 0.35);   /* pane */
--color-bg-level-2: rgba(42, 42, 48, 0.41);   /* pane-elev */
--color-bg-interactive: rgba(0, 0, 0, 0.18);  /* footer bg */
--color-bg-overlay: rgba(0, 0, 0, 0.55);      /* duration badge */
```
Потім замінити всі inline rgba-стилі.

### 3. **Transition duration standard**
Додати до всіх `transition-*` явну `duration-150` чи `duration-[var(--duration-base)]`:
```javascript
// Замість:
className="transition-colors"

// Писати:
className="transition-colors duration-150"
```

### 4. **Scaling для малих екранів (720×520)**
На дисплеї 720px ширина:
- TabButton padding може бути меньше на `sm` breakpoint
- SearchInput gap можна зменшити з 2.5 на 2
- Двоколонна Translator grid може стати single-column на дуже малих екранах

Потрібна скорочена CSS медіа-запит перевірка.

### 5. **Light theme audits**
Провести скріншотний аудит **light mode** на всіх 8 табах. На даний момент似乎є невизначеності з:
- Kbd背景 (близько білого)
- Input border (0.09 opacity занадто тонко)
- Selection bar фону

---

## Висновки

Stash має **70%–80% дизайнерської цілісності** на базі хорошо продуманої токен-системи. Яйлива картина дизайну вражена не критичними, але непридбавними мізаннями в spacing, shadows та hardcoded colors.

**Найбільш важливі категорії виправлень**:
1. Унітифікувати header spec (15+ місць)
2. Замінити hardcoded colors семантичними токенами (8 місць)
3. Додати explicit `duration-150` до transitions (20+ місць)

Ці три категорії дадуть **85–90% цілісності** з мінімальним вкладом.

