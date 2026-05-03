# CLAUDE.md

## Project

Stash — macOS menubar app, **Tauri 2 + React 19 + TS + Rust**. Single 920×520 popup hosts features as tabs. Global toggle `⌘⇧V`; tab switch `⌘⌥1..7`.

`npm run dev` = Vite only (UI work / e2e). `npm run tauri dev` = full app. Rust tests live under `src-tauri/` (`cargo test --manifest-path src-tauri/Cargo.toml`).

## Three elephants (project values)

On top of the usual **DRY / KISS / YAGNI**, every decision in Stash is judged against the **three elephants**:

1. **UI/UX** — every interaction must be predictable, focus management never breaks, feedback is instant, dark/light theme + reduced-motion + accessibility are not optional.
2. **Modularity** — each module in `src/modules/*` is standalone: its own `api.ts`, tests, `index.tsx` with a lazy popup. No direct cross-module imports — go through `shared/` or `stash:navigate` events.
3. **Performance** — lazy tabs, prefetch on hover, nothing heavy in the popup-open path, no unnecessary re-renders, bundle-stub heavy deps (e.g. `lowlight`).

When you propose a change, consciously calibrate it against these three. If one regresses, it must be an explicit trade-off, not accidental.

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

### Out-of-process sidecars (Demucs, sherpa-onnx, anything heavy)

Keep ML / heavyweight runtimes **outside** the macOS bundle. Two flavours, depending on whether the runtime needs Python:

**Native (Rust / C / dylib)** — `crates/stash-diarize/` is the canonical example.

1. Separate workspace member under `src-tauri/crates/stash-<name>/`.
2. Main app downloads it lazily into `$APPLOCALDATA/<name>/` on first opt-in via Settings, behind a per-asset catalog.
3. `release.yml` builds the sidecar once per tag and uploads it as a release asset. The catalog's `resolve_url` for runtime artefacts targets `https://github.com/<owner>/<repo>/releases/latest/download/<filename>` so a clean install always pulls a sidecar built against the matching app release.

**Python (uv-managed venv)** — `crates/stash-separator/` is the canonical example. Don't use PyInstaller — it forces a per-release tarball-host nobody wants to maintain.

1. Source tree under `src-tauri/crates/stash-<name>/` containing `src/main.py` + `requirements.txt`. Both are baked into the main app via `include_str!`, staged on disk during install.
2. `installer.rs` orchestrates the runtime: download `uv` (single static binary from Astral) → `uv python install 3.11` → `uv venv` → `uv pip install -r requirements.txt`. Each step emits a phase tick on `<module>:install` so Settings renders a staged progress card.
3. Pipeline spawns `<venv>/bin/python <staged-main.py>` instead of a frozen exe. Nothing per-release to host.

**Both flavours** spawn the sidecar via `std::process::Command`, stream progress over stderr lines like `progress\t<f>\t<phase>`, and parse a single-line JSON result on stdout. Failures still exit 0 with `{"error":"…"}` — the parent never has to interpret an exit code.

## Agent surface (Telegram + CLI + voice popup)

The Telegram bot and AI assistant are a **first-class surface** for every module, not an option. Any new feature (command, tab, timer, action) **must** be reachable via:

1. A **slash command** in `src-tauri/src/modules/telegram/module_cmds.rs` (when a deterministic quick action makes sense), and/or
2. An **LLM tool** in `src-tauri/src/modules/telegram/tools/stash.rs`, registered in `assistant.rs` → so the assistant (Telegram, CLI via `stash ai "…"`, future voice popup) can invoke the action from a natural-language prompt.

The single assistant dispatch point is `telegram::assistant::handle_user_text(app, state, prompt)`. All transports (Telegram, CLI, voice) go through it — never duplicate the LLM/tool loop elsewhere.

A tool must expose the **full functionality of its tab**, not fixed presets: the assistant itself maps natural-language parameters (BPM, duration, time signature, etc.) onto args. If you add a new field to a module, extend the tool schema in the same change.

## Communication

- **Frontend → Rust**: module-local `api.ts` wrapper calls `invoke(...)`. Never call `invoke` directly from components.
- **Rust → Frontend**: `app.emit("<module>:<event>", payload)` + `listen<T>(...)` in a `useEffect`.
- **Cross-tab in frontend**: `window.dispatchEvent(new CustomEvent('stash:navigate', { detail: tabId }))`.

## Testing (on demand)

- **Tests are written when the user asks for them, not by default.** Implementation lands first, the user click-tests in `npm run tauri dev`, and only then — on a separate command ("напиши тести", "test coverage", etc.) — do we add or extend `*.test.ts(x)`. Visual / UX changes are easier to validate by eye than through RTL, and bundling tests with every diff slows iteration on this project.
- **Existing tests are non-negotiable.** If a change breaks a `*.test.ts(x)` that already lives in the tree, fix the test in the same commit — that's *maintenance*, not new coverage.
- **Rust pure-logic with non-trivial computation gets a `#[cfg(test)]` test even without a request.** Backend logic has no UI to click through, so a regression test there is the only safety net.
- Stack: Vitest + RTL co-located `*.test.ts(x)`; Tauri mocks in `src/test/setup.ts` (override per-test with `vi.mocked(...)`); Rust repos via `Connection::open_in_memory()`; E2E in `tests/e2e/` runs Playwright against Vite dev with **no Tauri IPC**.
- Prefer role-based queries (`role="tab"`, `aria-pressed`, `aria-checked` on toggleable controls).
- **Storybook**: every new primitive in `src/shared/ui/` must ship a co-located `*.stories.tsx` — with `tags: ['autodocs']`, `argTypes` for every enum prop, and at least one story per state (tones/sizes/disabled/invalid, etc.). Check with `npm run storybook` (or `npm run build-storybook`). Stories are excluded from `tsc`/`vitest` — they complement unit tests, not replace them.
  - **Keep stories in sync.** Any prop/design change on a component that has `*.stories.tsx` must update the stories in the same commit (argTypes, args, cases for added/removed states). Run `npm run build-storybook` before commit — it catches references to removed props earlier than review.

## Conventions easy to get wrong

- **Popup auto-hide**: native modals (folder/save dialogs) must wrap the open call with `invoke('set_popup_auto_hide', { enabled: false })` before and `true` after, otherwise blur hides the popup and cancels the dialog. See `SettingsShell` folder picker.
- **Accent colour**: use `accent(α)` from `src/shared/theme/accent.ts` — never inline the `rgba(var(--stash-accent-rgb), α)` template. Tailwind arbitrary classes (`bg-[rgba(…)]`) are the one exception.
- **DRY the second copy**: before hand-rolling a formatter, hook, or layout block, grep `src/shared/` (`format/`, `hooks/`, `util/`, `ui/`, `theme/`). Canonical helpers already exist for bytes / duration, set-selection, async-load, reveal-in-Finder, copy-to-clipboard, panel headers, list rows, centered spinner. Extending one beats adding a fourth.
- **Language**: the app is **English-only**. All UI copy, labels, tooltips, error messages, logs and code comments are written in English — no localisation layer, no second-language strings, no mixed-language UI. Never add Russian (`ru`) to locale/translator lists either (those lists exist for user-facing translation features, not for the app's own UI).
- **No ad-hoc buttons/inputs**: route through `src/shared/ui/` primitives (`Button`, `Input`, `NumberInput`, `SearchInput`, `Textarea`, `Select`, `SegmentedControl`, `Checkbox`, `SelectionHeader`, `Toggle`, `TabButton`, `IconButton`, `ConfirmDialog`, `Modal`, `Drawer`, `StatCard`, `Toast`, `Cheatsheet`, `GlobalSearch`). No inline RGBA hex — use CSS variables or `accent(α)`.
- **Text sizing via tokens only**: use `text-meta` / `text-body` / `text-title` / `text-heading`. Hard-coded `text-[11px]`/`[13px]`/`[15px]`/`[18px]` are forbidden in `src/modules/**` and `src/settings/**`. Shared primitives may keep magic values only when a token would break height invariants (e.g. `h-8`).
- **Icon-only actions → `IconButton` + `title`, always**: every bare-icon control (reveal, remove, embed, copy, open-in-new, pin, etc.) goes through `src/shared/ui/IconButton.tsx`. Pass a human-readable `title` — it is wired to both `aria-label` and the shared CSS `Tooltip` (fade-in bubble), so users can hover to learn what the icon does. Never hand-roll a `<button>` with an SVG and no label. Never rely on the browser's native `title=""` attribute — the custom `Tooltip` is the project standard.
- **Hover-reveal overlays use `group` / `group-hover:`**: when a row exposes controls only on hover (list rows, attachment cards, chat bubbles), the parent gets `group relative` and the controls wrapper gets `opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity`. Do NOT put `hover:opacity-100` directly on the controls — that requires hovering the invisible controls themselves, which users can't find. Canonical examples: `src/shared/ui/Row.tsx`, `src/shared/ui/Markdown.tsx`.
