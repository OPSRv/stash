# CLAUDE.md

## Project

Stash — macOS menubar app, **Tauri 2 + React 19 + TS + Rust**. Single 920×520 popup hosts features as tabs. Global toggle `⌘⇧V`; tab switch `⌘⌥1..7`.

## Три слони (project values)

Окрім стандартних **DRY / KISS / YAGNI**, усі рішення в Stash оцінюються через **три слони**:

1. **UI/UX** — кожна взаємодія має бути передбачувана, фокус-менеджмент не ламається, feedback миттєвий, темна/світла тема, reduced-motion, accessibility не опційні.
2. **Модульність** — кожен модуль у `src/modules/*` стендалон: свої `api.ts`, тести, `index.tsx` з lazy popup. Ніяких крос-модульних імпортів напряму, тільки через `shared/` або `stash:navigate` події.
3. **Перформанс** — lazy tabs, prefetch on hover, нічого важкого в popup-open path, без зайвих ре-рендерів, bundle-stub для важких залежностей (як `lowlight`).

Коли пропонуєш правку — свідомо калібруй проти цих трьох. Якщо одна з них просідає — це має бути явний trade-off, а не випадкове.

## Module system

Each feature = self-contained module plugged into `src/modules/registry.ts`.

- **Frontend**: `src/modules/<name>/index.tsx` exports a `ModuleDefinition`. **`PopupView` MUST be `React.lazy(...)` and `preloadPopup` MUST be the same import thunk** — this is how tabs stay off-heap until first opened:
  ```ts
  const load = () => import('./FooShell').then((m) => ({ default: m.FooShell }));
  export const fooModule: ModuleDefinition = {
    id: 'foo', title: 'Foo',
    PopupView: lazy(load),
    preloadPopup: load,
  };
  ```
  Never eager-import the view at the top of `index.tsx` — it defeats code-splitting. `PopupShell` renders each visited tab inside `<Suspense>`, hiding inactive ones via `hidden` (state preserved; unopened tabs never mount). Hover on `TabButton` calls `preloadPopup()`.
- **Rust**: mirror under `src-tauri/src/modules/<name>/`. Wire `<Name>State` as managed state and register all commands in `invoke_handler!` in `src-tauri/src/lib.rs`.

## Communication

- **Frontend → Rust**: module-local `api.ts` wrapper calls `invoke(...)`. Never call `invoke` directly from components.
- **Rust → Frontend**: `app.emit("<module>:<event>", payload)` + `listen<T>(...)` in a `useEffect`.
- **Cross-tab in frontend**: `window.dispatchEvent(new CustomEvent('stash:navigate', { detail: tabId }))`.

## Testing (mandatory)

- Unit/component tests required for every feature and bugfix. Vitest + RTL, co-located `*.test.ts(x)`.
- Global Tauri mocks live in `src/test/setup.ts` — override per-test with `vi.mocked(...)`.
- Prefer role-based queries. When a button is a tab/toggle, use proper ARIA (`role="tab"`, `aria-pressed`, `aria-checked`).
- Rust repos tested with `Connection::open_in_memory()`.
- E2E (`tests/e2e/`) runs Playwright against Vite dev — **no Tauri IPC in e2e**.
- **Storybook**: кожен новий примітив у `src/shared/ui/` мусить мати поруч `*.stories.tsx` — з `tags: ['autodocs']`, argTypes на всі enum-пропси і принаймні однією сторі на кожен стан (tones/sizes/disabled/invalid тощо). Перевірити: `npm run storybook` (або `npm run build-storybook`). Сторі виключені з `tsc`/`vitest` — вони не замінюють юніт-тести, а доповнюють їх.
  - **Тримати синхронним.** Будь-яка зміна в компоненті з наявним `*.stories.tsx` зобов’язує оновити сторі тим самим коммітом. Зокрема:
    - **додав/видалив/перейменував проп** → оновити `argTypes`, `args`, і сторі-кейси, які його демонструють (нова сторі для нового стану; видалити мертві кейси для прибраного пропу). Зміна дефолту — оновити `args`.
    - **зміна дизайну** (паддінги, кольори, іконки, розміри, emerging варіанти) → пройтись по всіх існуючих сторі цього компонента в Storybook візуально (`npm run storybook`) і переконатися, що жоден кейс не зламаний і покриває нові стани.
    - **перевірка перед комітом**: `npm run build-storybook` не мусить додавати нових помилок — якщо сторі посилається на прибраний проп, білд покаже це раніше за ревʼю.

## Conventions easy to get wrong

- **Popup auto-hide**: native modals (folder/save dialogs) must wrap the open call with `invoke('set_popup_auto_hide', { enabled: false })` before and `true` after, otherwise blur hides the popup and cancels the dialog. See `SettingsShell` folder picker.
- **Accent colour**: use `accent(α)` from `src/shared/theme/accent.ts` — never inline the `rgba(var(--stash-accent-rgb), α)` template. Tailwind arbitrary classes (`bg-[rgba(…)]`) are the one exception.
- **DRY the second copy**: before hand-rolling a formatter, hook, or layout block, grep `src/shared/` (`format/`, `hooks/`, `util/`, `ui/`, `theme/`). Canonical helpers already exist for bytes / duration, set-selection, async-load, reveal-in-Finder, copy-to-clipboard, panel headers, list rows, centered spinner. Extending one beats adding a fourth.
- **Language**: never add Russian (`ru`) to locale/translator lists.
- **No ad-hoc buttons/inputs**: route through `src/shared/ui/` primitives (`Button`, `Input`, `NumberInput`, `SearchInput`, `Textarea`, `Select`, `SegmentedControl`, `Checkbox`, `SelectionHeader`, `Toggle`, `TabButton`, `IconButton`, `ConfirmDialog`, `Modal`, `Drawer`, `StatCard`, `Toast`, `Cheatsheet`, `GlobalSearch`). No inline RGBA hex — use CSS variables or `accent(α)`.
- **Text sizing via tokens only**: use `text-meta` / `text-body` / `text-title` / `text-heading`. Hard-coded `text-[11px]`/`[13px]`/`[15px]`/`[18px]` are forbidden in `src/modules/**` and `src/settings/**`. Shared primitives may keep magic values only when a token would break height invariants (e.g. `h-8`).
