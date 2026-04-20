# CLAUDE.md

## Project

Stash — macOS menubar app, **Tauri 2 + React 19 + TS + Rust**. Single 920×520 popup hosts features as tabs. Global toggle `⌘⇧V`; tab switch `⌘⌥1..7`.

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

## Conventions easy to get wrong

- **Popup auto-hide**: native modals (folder/save dialogs) must wrap the open call with `invoke('set_popup_auto_hide', { enabled: false })` before and `true` after, otherwise blur hides the popup and cancels the dialog. See `SettingsShell` folder picker.
- **Accent colour**: `rgba(var(--stash-accent-rgb), α)` — never hardcode.
- **Language**: never add Russian (`ru`) to locale/translator lists.
- **No ad-hoc buttons/inputs**: route through `src/shared/ui/` primitives (`Button`, `Input`, `SearchInput`, `Select`, `SegmentedControl`, `Toggle`, `TabButton`, `IconButton`, `ConfirmDialog`, `Toast`, `Cheatsheet`, `GlobalSearch`). No inline RGBA hex.
