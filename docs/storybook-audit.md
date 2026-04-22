# Storybook / Shared-UI аудит фронтенду

Станом на 2026-04-22. Мета: (1) зафіксувати примітиви в `src/shared/ui/`, які мусять мати `*.stories.tsx` за проєктним правилом, але ще не мають; (2) виявити місця в `src/modules/**` і `src/settings/**`, де замість примітивів рендеряться нативні елементи чи дубльовані JSX-блоки — кандидати на витяг у `src/shared/ui/` з подальшим сторі-покриттям.

## Прогрес виконання

- **Phase 1** ✅ зроблено — додано сторі для 11 примітивів (`CenterSpinner`, `Row`, `ListItemRow`, `ToastCard`, `LiveRegion`, `RevealButton`, `SendToTranslatorButton`, `AskAiButton`, `LinkifiedText`, `FileChip`, `Markdown`).
- **Phase 2** ✅ зроблено — додано сторі для 12 примітивів (`AudioPlayer`, `VideoPlayer`, `InlineVideo`, `ImageThumbnail`, `Lightbox`, `Modal`, `Cheatsheet`, `GlobalSearch`, `ContextMenu`, `FilePreview`, `CodePreview`, `LazyMarkdown`).
- **Phase 3** ✅ частково — inline `rgba(...)` у `downloader/*` переведено на Tailwind-класи (7 файлів). `SmartScanPanel` box-shadow лишено як виняток (нетривіальна градієнтна тінь). Pills у `CachesPanel`/`PrivacyPanel`/`TranslationRow`/`TranslationBanner` **не чіпано** — потребують додавання `Badge size="xs"` + `customColor` у шаблоні, бо поточний `Badge` має fixed padding. Це тягне на Phase 4.
- **Phase 4** ⏸ відкладено — `Skeleton`/`MediaChip`/`VerticalTabList`/`Badge size="xs"` потребують нових публічних API і оновлення кожного колсайту. Зона ризику > ніж користь за один пас — робити разом з власником модуля.
- **Phase 5** ✅ зроблено — сторі для `PlatformBadge`, `PostureBadge`.
- **Phase 6** ❌ не застосовне — при рев’ю `role="button"`-обгорток у `NowPlayingBar`, `WebchatNowPlayingBar`, `NotesShell` виявилось, що кожна з них містить **вкладені `IconButton`**. Нативний `<button>` не може вміщати інший `<button>`, тож `role="button"` + `tabIndex` + Enter/Space handler — це **правильна** ARIA-розмітка для цього випадку, а не ad-hoc. Свою ж рекомендацію з §2.1 слід вважати помилковою. Лишити як є.

---


---

## 1. Наявні примітиви без `*.stories.tsx`

CLAUDE.md: «кожен новий примітив у `src/shared/ui/` мусить мати поруч `*.stories.tsx`». Наразі цим правилом не покриті:

| Компонент | Коментар щодо сторі |
| --- | --- |
| `AskAiButton` | Варіанти: `tone` (якщо є), `disabled`, стан «без тексту → кнопка не показується». |
| `AudioPlayer` | Сторі з mock-URL/Blob + довге/коротке аудіо, зіпсоване джерело. |
| `CenterSpinner` | Базова + з `label`. Тривіальна, робиться за 2 хвилини. |
| `Cheatsheet` | Принаймні дві сторі: коротка й довга розкладка, порожня. |
| `CodePreview` | По сторі на популярні мови (ts, rust, bash) + довгий/короткий сніпет + лінія перенесення. |
| `ContextMenu` | Сторі зі стандартним меню, з `danger`-пунктом, із сабменю (якщо підтримує). |
| `FileChip` | Сторі: різні розширення, довге імʼя (truncate), з кнопкою закриття/без неї. |
| `FilePreview` | Картинка / відео / pdf / unknown. |
| `GlobalSearch` | Відкритий / закритий стан, з результатами / без, з клавішним підсвіченням. |
| `ImageThumbnail` | Розміри (sm/md/lg), fallback коли `src` немає, lazy-load state. |
| `InlineVideo` | Playing / paused / без постера. |
| `LazyMarkdown` / `Markdown` | Сторі з типовим MD (таблиця, код, чеклисти, посилання). Зараз покрито лише `Markdown.test.tsx`, але візуальний сторі відсутній. |
| `Lightbox` | Сторі з одним і багатьма зображеннями, вертикальне/горизонтальне фото. |
| `LinkifiedText` | Кілька посилань, довгий рядок, mention/email. |
| `ListItemRow` | Згідно з API: стани hover / selected / with actions / right slot. |
| `LiveRegion` | Polite / assertive, демо-тригер. |
| `Modal` | Sizes, з/без заголовка, з кастомним футером. |
| `RevealButton` | Дефолт + `label` варіанти, disabled. |
| `Row` | Рядок списку з різним комбо слотів (left/middle/right). |
| `SendToTranslatorButton` | Дефолт, disabled, стан-передача. |
| `ToastCard` | Усі варіанти тонів (`success`/`error`/`info`/`warning`), з `action`, довгий текст. |
| `VideoPlayer` | Playing / paused / muted. |

Додатково звірити: `icons.tsx` / `Icons.stories.tsx` — наразі є `Icons.stories.tsx`, але не всі піктограми з `icons.tsx` відображені; після ревізії додати відсутні, щоб сторі-галерея була вичерпною.

---

## 2. Нативні елементи замість примітивів

### 2.1 `role="button"` / `<div onClick>` замість `Button`/`IconButton`
CLAUDE.md прямо забороняє ад-хок кнопки.

- `src/modules/web/WebchatNowPlayingBar.tsx:37` — `role="button"` на `<div>`. Перевести на `IconButton`/`Button`.
- `src/modules/notes/NotesShell.tsx:705, 734` — дві ad-hoc «кнопки» (рядки з `role="button"`), одна з `aria-pressed`. Мінімум — `IconButton` із `pressed` prop.
- `src/modules/music/NowPlayingBar.tsx:36` — `role="button"` обгортка плеєра. Кандидат на зведення з `WebchatNowPlayingBar` у спільний примітив (див. §3).

### 2.2 `role="tab"` / `role="tablist"` без `TabButton`
`TabButton` уже є в `shared/ui`, але в кількох місцях катається власна розмітка:

- `src/modules/web/WebShell.tsx:513, 618, 661, 683` — вкладки браузерних табів. Якщо `TabButton` надто «тонкий» — ввести `VerticalTabButton` / варіант `orientation`.
- `src/settings/SettingsShell.tsx:259, 267` — бічний tablist налаштувань. Аналогічно.
- `src/modules/system/ProcessesPanel.tsx:225`, `NetworkPanel.tsx:124` — `role="table"` на `<div>`, побудовано з нуля. Потенційно — примітив `DataTable` (див. §3), але тут менш пріоритетно.

### 2.3 Дублікати «pill/badge» з ad-hoc CSS (див. `Badge`)
Існує `Badge`, але:

- `src/modules/system/CachesPanel.tsx:15–22, 198` — словник `pill/dot/label` з rgba. Перетворити на `Badge` з `tone` props, занести кольори в `theme/accent.ts` або нові токени.
- `src/modules/system/PrivacyPanel.tsx:81` — дубль стилю `CachesPanel`.
- `src/modules/translator/TranslationRow.tsx:44` — `.translator-pill` CSS-клас. Замінити на `Badge`.
- `src/modules/clipboard/TranslationBanner.tsx:17, 38` — інлайновий `pillStyle`. Замінити на `Badge` + `tone="info"`.
- `src/modules/pomodoro/PostureBadge.tsx` — домене обгортання, але сам шаблон уже повторний. Якщо більше одного «бейджу з емоджі», ввести `Badge` з `icon`/`emoji` slot.

### 2.4 Дубльовані блоки стилів (inline rgba) в downloader
CLAUDE.md: «No inline RGBA hex». Проте весь `src/modules/downloader/` засмічений:

- `CompletedDownloadTile.tsx:21–26`
- `CompletedDownloadRow.tsx:28, 30, 34, 96`
- `ActiveDownloadRow.tsx:15–17`
- `DetectedPreviewCard.tsx:17`
- `DetectSessionCard.tsx:13–18`
- `DetectSkeletonCard.tsx:32, 38, 43`
- `CompletedList.tsx:13`
- `terminal/TerminalShell.tsx:29, 33, 345`
- `system/SmartScanPanel.tsx:286–309`

Дві осі роботи:
1) Перевести ці `rgba(...)` на Tailwind-класи `bg-white/[0.05]`, `border-white/[0.08]` тощо (вже є прецедент у `DownloadUrlBar.tsx:65`).
2) Там, де форма повторюється (thumbnail-обгортка, status-pill з rgba) — винести у `src/shared/ui/` (див. §3).

### 2.5 Інші дрібниці
- `src/modules/downloader/DetectSessionCard.tsx:173` — `{false && <button ... />}` мертвий код, прибрати.
- `src/modules/notes/MarkdownPreview.tsx:119` — `<input type="checkbox">` всередині markdown-рендера. Окремий випадок (markdown → reactify), нативний елемент виправданий. Залишити.
- `src/modules/ai/ChatComposer.tsx:48` — у коментарі, не код.

---

## 3. Кандидати у нові примітиви `src/shared/ui/` + Storybook

Правило з памʼяті: «extract on second use». Поточні дублі:

### 3.1 `Skeleton` / `SkeletonLine`
Повторно: `downloader/DetectSkeletonCard.tsx`, `notes/AudioRecorder.tsx`, `downloader/DetectSessionCard.tsx`. Зараз кожен катає `animate-pulse` + inline `rgba`. Примітив: `<Skeleton variant="line|block|circle" width height />`. Сторі — по варіанту + група «завантаження картки».

### 3.2 `NowPlayingBar` / `MediaChip`
`music/NowPlayingBar.tsx` і `web/WebchatNowPlayingBar.tsx` — майже повний клон (класи однакові, `role="button"`, 7×7 мініатюра, text slots). Витягнути в `shared/ui/MediaChip.tsx`. Сторі: з обкладинкою / без, playing / paused, довгий title.

### 3.3 Status-pill (downloader)
`CompletedDownloadRow.tsx:30, 34` — «успіх»/«помилка» бейдж з rgba. Цей шаблон уже покривається `Badge` — прибрати inline-стилі, додати `tone="success" | "danger"` у сторі.

### 3.4 `Thumbnail`
`CompletedDownloadTile.tsx`, `DetectedPreviewCard.tsx`, `DetectSessionCard.tsx`, `ActiveDownloadRow.tsx` всі мають однаковий прямокутник із `background: rgba(0,0,0,.4-.6)` під превʼю. Або використати наявний `ImageThumbnail`, або додати його варіант `tone="dim"`. В Storybook — сторі «з зображенням / з іконкою / broken src».

### 3.5 `Toolbar` / `Row toolbar`
`EmbeddedWebChat.tsx:448, 475, 495, 556`, `terminal/TerminalShell.tsx:379`, `WebShell.tsx:551, 578` — однакові 7×7 `rounded-md flex center hover:bg-white/[0.06]` кнопки-іконки. Це повинен бути `IconButton` (він вже існує!) зі `size="xs"` / `size="sm"`. Перевірити API `IconButton`, додати сторі з цими розмірами і замінити інлайн.

### 3.6 Вертикальний `TabList`
`WebShell.tsx` (табки браузера) та `SettingsShell.tsx` (бічна панель) відрізняються лише іконкою/текстом. Примітив `VerticalTabList` + сторі з пінами / без, групами.

### 3.7 `Pill` (label-only badge)
`system/CachesPanel.tsx:198` і `system/PrivacyPanel.tsx:81` мають ідентичний клас `"shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] t-secondary font-normal"`. Виглядає як відсутній `size="xs"` варіант у `Badge` — додати, описати у сторі.

### 3.8 `SaveStatusPill`
`notes/SaveStatusPill.tsx` — модульний, але шаблон (pill + live-статус + cancel) може знадобитись в інших місцях (translator, downloader «скасувати»). Поки лишити в модулі, але додати `stories` (він зараз без них), щоб зафіксувати стани `idle/saving/saved/error/cancelling`.

### 3.9 `DomainBadge`-сімейство
`downloader/PlatformBadge.tsx`, `telegram/TelegramKindBadge.tsx`, `pomodoro/PostureBadge.tsx` — це три варіанти одного патерну (кольорний pill + іконка/емоджі). `TelegramKindBadge` і `BlockRow` вже мають сторі (в git-статусі видно), `PlatformBadge` і `PostureBadge` — ні. Додати.

---

## 4. Пропонований порядок виконання

1. **Швидкі сторі (півдня роботи)**: `CenterSpinner`, `Kbd` (перевірити покриття), `Row`, `ListItemRow`, `ToastCard`, `LiveRegion`, `RevealButton`, `SendToTranslatorButton`, `AskAiButton`, `LinkifiedText`, `Markdown`, `FileChip`. Логіки не чіпаємо, тільки стори.
2. **Середні сторі**: `AudioPlayer`, `VideoPlayer`, `InlineVideo`, `Lightbox`, `Modal`, `Cheatsheet`, `GlobalSearch`, `ContextMenu`, `FilePreview`, `ImageThumbnail`. Потребують моків блобів/подій.
3. **Рефактор інлайн rgba в downloader → Tailwind-класи** + сторі на нові/оновлені `Badge` tone-и.
4. **Витяг нових примітивів** у порядку: `Skeleton` → `MediaChip` → `VerticalTabList`. Кожен — з тестом і сторі одночасно.
5. **Домен-бейджі** (`PlatformBadge`, `PostureBadge`) — додати сторі.
6. **Заміна `role="button"`-обгорток на `IconButton`/`Button`** у `NotesShell`, `WebchatNowPlayingBar`, `NowPlayingBar`.

---

## 5. Ризики / нотатки

- Зміна `IconButton` API (додавання `size="xs"`) потребує оновлення всіх наявних викликів і відповідних сторі (правило синхронізації з CLAUDE.md).
- `Markdown`/`LazyMarkdown` — великі залежності; стори мусять бути у світлому та темному режимах, інакше візуально деградують лише в одному.
- `WebShell`/`SettingsShell` — різний стайлінг «активного» табу. Перед уніфікацією у `VerticalTabList` пройтися по обох скрінах і зафіксувати, який візуальний стандарт лишаємо.
- Під час перенесення `rgba(...)` на Tailwind-класи — перевірити `shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]` у `SmartScanPanel.tsx`: там на `rgba` зав’язаний `boxShadow` з кастомним градієнтом, прямий Tailwind-еквівалент може бути неможливим — залишити як виняток і задокументувати в коментарі до файлу.
