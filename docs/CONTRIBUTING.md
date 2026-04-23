# Contributing to Stash

## Stack

- Tauri 2 · React 19 · TypeScript · Rust
- macOS menubar app. Single 920×520 popup hosts features as lazy tabs.

## Getting started

```bash
npm install
# One-time CLI helper used by prod builds
npm run build:cli

# Dev with hot reload (Vite + native webview)
npm run tauri dev
```

Secrets (OpenAI / Anthropic / Google / Telegram bot token) live in the macOS
Keychain under services `com.stash.ai` and `com.stash.telegram`. Add them via
**Settings → AI / Telegram** after first launch. In debug builds the app
additionally honours a plaintext fallback in `settings.json` for unsigned
binaries; **this fallback is disabled in release**.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite only (no Tauri shell) — for fast UI iteration. |
| `npm run tauri dev` | Full app in dev mode. |
| `npm run build` | `tsc` + production Vite bundle (required for `tauri build`). |
| `npm test` | Vitest run (all TS/TSX tests). |
| `npm run test:watch` | Vitest watch. |
| `npm run test:e2e` | Playwright against Vite dev (no Tauri IPC). |
| `npm run storybook` | Local Storybook (port 6006). |
| `npm run build-storybook` | Static Storybook build. |
| `cargo test --manifest-path src-tauri/Cargo.toml --workspace` | Rust unit tests. |
| `cargo check --manifest-path src-tauri/Cargo.toml --workspace` | Rust type check. |

## Project rules

All baseline conventions live in `/CLAUDE.md`. Summary:

- **Три слони**: UI/UX, модульність, перформанс — above DRY/KISS/YAGNI.
- Every feature lives in `src/modules/<name>/` + mirror under `src-tauri/src/modules/<name>/`.
- `PopupView` MUST be `React.lazy(...)`; `preloadPopup` MUST reuse the same thunk.
- Accent color → `accent(α)` from `src/shared/theme/accent.ts`, never hand-inlined `rgba(var(--stash-accent-rgb), …)` outside Tailwind arbitrary classes.
- Text sizing via tokens: `text-meta` / `text-body` / `text-title` / `text-heading`. No `text-[11px]` / `[13px]` / `[15px]` / `[18px]`.
- Use `src/shared/ui/*` primitives for buttons/inputs/dialogs. No ad-hoc `<button>`.
- Native dialogs must wrap the open call with `invoke('set_popup_auto_hide', { enabled: false/true })`.
- Never add Russian (`ru`) to locale/translator lists.
- Every primitive in `src/shared/ui/` needs a `*.stories.tsx`.
- Every feature/bugfix ships with a test.

## Pre-release checklist

Run every box green before cutting a release:

- [ ] `npx tsc --noEmit` — no TS errors
- [ ] `npm test` — all vitest passing
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --workspace` — all Rust tests passing
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml --workspace` — no warnings treated as errors
- [ ] `npm run build` — production bundle builds clean
- [ ] `npm run build-storybook` — Storybook builds clean
- [ ] `npm run test:e2e` — Playwright smoke passes
- [ ] Manual smoke in `npm run tauri dev`:
  - [ ] `⌘⇧V` toggles popup; `⌘⌥1..7` switches tabs
  - [ ] Clipboard receives new entries; reveal-secret TTL expires as expected
  - [ ] Downloader accepts a real URL (e.g. youtu.be), detects and starts a job
  - [ ] AI chat streams a response for each configured provider (check Keychain-only path in release builds)
  - [ ] Terminal opens a shell, runs `ls`, resizes without corruption
  - [ ] Settings → folder picker works (popup doesn't auto-hide)
- [ ] Bump `version` in `package.json` and `src-tauri/tauri.conf.json` (keep them in sync)
- [ ] Update `CHANGELOG.md` / release notes
- [ ] Tag the release commit

## Security notes

- `tauri.conf.json` ships with a restrictive CSP; embedded webviews (music, webchat) run in separate child webviews and are not constrained by it.
- Rust commands validate user-supplied URLs (`http`/`https` allowlist) before handing them to `yt-dlp` / `WebviewUrl::External`.
- `opener` capabilities target `$HOME/**` because clipboard history and filesystem scanners may reference any user file; all `open_path` calls originate from explicit user action.
- **API keys storage — threat model.** Keys land in two places:
  - **Keychain** (`com.stash.ai`, `com.stash.telegram`) — primary store for the Rust side. The telegram LLM path reads keys exclusively from here in release.
  - **`settings.json` under `$APPDATA`** — plaintext. The frontend AI chat (`AiShell`, notes Polish/Translate) reads keys from this file and passes them to the Vercel AI SDK directly. This is a deliberate trade-off for a **single-user desktop app** on macOS:
    - `$APPDATA` is a 0600 user-scoped directory — other local users can't read it.
    - It's excluded from iCloud Drive. Time Machine backups are the only leak vector, and that's the user's own machine.
    - Peer tools (VS Code, Cursor, Raycast, Claude Desktop) store API keys the same way. Keychain would marginally help *casual inspection* and *TM backups*, but wouldn't stop a compromised app bundle or any process with user-level file read.
  - A full refactor to Rust-proxied streaming (keys never in JS) was considered and **rejected for v0.1**: 1–2 days of work to re-implement SSE parsing for 3 providers, re-port abort handling, and rewrite tests — for a threat model that mostly doesn't apply to a desktop menubar app. Revisit if Stash ever grows a multi-user or web-accessible surface.
