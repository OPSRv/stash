# Pomodoro Module Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `pomodoro` tab — named timer blocks with posture (sit / stand / walk), preset library, on-the-fly session editing, soft mid-block nudges.

**Architecture:** Rust engine owns the tick loop (1Hz) and emits events; frontend is a pure projection of engine state. Presets + session history live in SQLite (stash's existing DB). Frontend is split into two primary surfaces — Session Player (active timer, current block big-and-clear, next-up peek) and Preset Library / Editor. Session can be started from a preset OR as an ad-hoc list; during a run the user can insert/rename/reorder blocks without restarting.

**Tech Stack:** Tauri 2, Rust, React 19 + TS, Vitest + RTL, existing `shared/ui` primitives (Button, Input, Select, SegmentedControl, Toggle, IconButton, ConfirmDialog, Toast, Tooltip).

---

## Key design decisions

1. **Walk is first-class.** Posture is an enum `Sit | Stand | Walk`. Transition messages are posture-aware: Sit→Stand = "підніми стіл"; Stand→Sit = "сядь"; *→Walk = "стартуй доріжку"; Walk→Sit = "злізь з доріжки". No generic "move!" text.
2. **Mid-block nudges are opt-in per block.** Default: Sit blocks ≥20m get a silent nudge toast halfway. Stand/Walk — none (the posture itself is the activity).
3. **Engine ticks in Rust.** Frontend doesn't drive time; it listens to `pomodoro:tick` (≤1Hz) for the remaining-ms value, `pomodoro:block_changed` for transitions, `pomodoro:nudge` for mid-block hints, `pomodoro:session_done`. This keeps the timer accurate when the popup is hidden and cheap when visible.
4. **Everything time-critical lives in the Rust main process, never in the webview.** Stash is a menubar app — the popup webview is routinely hidden and may be fully unloaded (cf. existing "Unload inactive tabs" behavior in shell). That means:
   - Tick loop is a `std::thread::spawn` in Rust, owning `Arc<PomodoroState>`, started in tauri `setup()` and living for the app lifetime.
   - **System notifications are emitted from Rust** on the tick thread (via `tauri-plugin-notification`), not from the frontend. A closed webview must still get the "підніми стіл" notification.
   - Frontend is a *projection*: on mount/remount, hook calls `pomodoro_get_state` and subscribes to events. If the webview was unloaded and comes back mid-session, state is rehydrated — no drift.
   - No `setInterval` on the JS side. The frontend re-renders only on `pomodoro:tick` / `pomodoro:state`.
5. **Sleep/wake resilience.** Tick thread reads `SystemTime::now()` each iteration and feeds `now_ms` deltas into `EngineCore.advance()`. Never accumulates "1 second each tick" — if the Mac sleeps for 10 minutes and wakes, the next `advance` sees a 600s delta and correctly fires all intermediate transitions (or, if we've blown past the session, emits `SessionDone` with the right blocks marked complete).
6. **Persistence scope for v1**: presets (crud) + completed sessions (append-only for future stats). No charts yet.
7. **Notifications**: in-app `Toast` (when webview is alive) + system notification from Rust (always). Nudges are in-app only; transition notifications always fire from Rust so posture prompts land even with the popup closed.

---

## Data model

### Rust (`src-tauri/src/modules/pomodoro/model.rs`)

```rust
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum Posture { Sit, Stand, Walk }

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Block {
    pub id: String,           // UUID, stable across edits
    pub name: String,         // user label, e.g. "Deep work — auth refactor"
    pub duration_sec: u32,
    pub posture: Posture,
    pub mid_nudge_sec: Option<u32>,  // None = no nudge; Some(N) = nudge at N sec elapsed
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Preset {
    pub id: i64,
    pub name: String,
    pub blocks: Vec<Block>,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum SessionStatus { Running, Paused, Idle }

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SessionSnapshot {
    pub status: SessionStatus,
    pub blocks: Vec<Block>,
    pub current_idx: usize,
    pub remaining_ms: i64,      // of current block
    pub started_at: i64,        // unix sec of session start (None when Idle)
    pub preset_id: Option<i64>, // source preset, if any
}
```

### SQLite schema (`pomodoro_presets`, `pomodoro_sessions`)

```sql
CREATE TABLE IF NOT EXISTS pomodoro_presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  blocks_json TEXT NOT NULL,      -- JSON-serialized Vec<Block>
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id   INTEGER,             -- nullable; null = ad-hoc
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,             -- null while in-flight
  blocks_json TEXT NOT NULL,       -- frozen blocks as executed
  completed_idx INTEGER NOT NULL DEFAULT 0  -- how many blocks fully finished
);
```

---

## Events (Rust → Frontend)

- `pomodoro:state` — full `SessionSnapshot`, emitted on any state change (start/pause/skip/edit)
- `pomodoro:tick` — `{ remaining_ms: i64 }`, emitted once per second while running
- `pomodoro:block_changed` — `{ from_idx, to_idx, from_posture, to_posture, block_name }`
- `pomodoro:nudge` — `{ block_idx, text }`
- `pomodoro:session_done` — `{ total_sec, blocks_completed }`

---

## Commands (Rust)

- `pomodoro_list_presets() -> Vec<Preset>`
- `pomodoro_save_preset(name: String, blocks: Vec<Block>) -> Preset` (create or update by name — if name exists, overwrite; keeps preset count small)
- `pomodoro_delete_preset(id: i64)`
- `pomodoro_get_state() -> SessionSnapshot`
- `pomodoro_start(blocks: Vec<Block>, preset_id: Option<i64>)` — replaces any current session
- `pomodoro_pause()`, `pomodoro_resume()`
- `pomodoro_skip_to(idx: usize)` — jump to any block; also used for "skip current"
- `pomodoro_stop()` — cancel session, leave state Idle, persist partial session row with `ended_at` = now
- `pomodoro_edit_blocks(blocks: Vec<Block>)` — replace the in-flight block list; engine clamps `current_idx` and retains remaining_ms for the current block if its id still exists
- `pomodoro_list_history(limit: u32) -> Vec<SessionRow>` (for future stats UI; included now so we can smoke-test persistence)

---

## Frontend structure (`src/modules/pomodoro/`)

```
index.tsx                      ModuleDefinition with lazy PomodoroShell
PomodoroShell.tsx              top-level; renders SessionPlayer | PresetLibrary
SessionPlayer.tsx              big clock, current block chip, next-up strip, controls
BlockRow.tsx                   shared row (used in editor + session up-next list)
PresetLibrary.tsx              list of saved presets + "New preset" button
PresetEditor.tsx               block list with add/remove/reorder/rename/duration/posture
PostureBadge.tsx               small pill: Sit / Stand / Walk with icon + color
StartSessionBar.tsx            "Start from preset" dropdown + "Ad-hoc" entry point
api.ts                         invoke wrappers + TS types mirroring Rust
hooks/usePomodoroEngine.ts     listen to events, expose { state, remainingMs, transition }
constants.ts                   default mid-nudge threshold, Walk posture icons, etc.
*.test.tsx                     colocated vitest
```

Dedicated-tab icon slot: add `pomodoro` to the tab registry with ⌘⌥N shortcut (next free slot).

---

## Task breakdown

> Each task is TDD-first. @test-driven-development skill applies to every step. Commit after each passing task.

### Task 1: Rust model + repo (presets CRUD + sessions append)

**Files:**
- Create: `src-tauri/src/modules/pomodoro/mod.rs`
- Create: `src-tauri/src/modules/pomodoro/model.rs`
- Create: `src-tauri/src/modules/pomodoro/repo.rs`
- Modify: `src-tauri/src/modules/mod.rs` (add `pub mod pomodoro;`)

**Step 1.** Write `repo.rs` tests with `Connection::open_in_memory()`:
- `insert_preset` + `list_presets` returns inserted row with parsed blocks
- `save_preset` upserts by name (unique key on `name`)
- `delete_preset` removes row
- `insert_session_start` / `update_session_end` round-trip
- `list_sessions` returns newest first, bounded by limit

**Step 2.** Run tests → FAIL.

**Step 3.** Implement `model.rs` (Posture, Block, Preset, session row struct) with serde.

**Step 4.** Implement `repo.rs` with CREATE TABLE IF NOT EXISTS in `init()`, plus all CRUD methods.

**Step 5.** Run `cargo test -p stash pomodoro::repo` → PASS.

**Step 6.** Commit: `feat(pomodoro): add repo with presets + sessions tables`.

---

### Task 2: Rust engine (tick loop + event emission)

**Files:**
- Create: `src-tauri/src/modules/pomodoro/engine.rs`
- Create: `src-tauri/src/modules/pomodoro/engine_test.rs` (unit tests for the pure state machine)

**Key decision.** Engine is split into a **pure state machine** (`EngineCore` — no I/O, no time; takes `now_ms: i64` as input to every call) and a **driver** (a thread that ticks 1× per second and calls into the core). Pure core lets us test transitions without threads.

**Core API:**
```rust
impl EngineCore {
    pub fn new() -> Self;
    pub fn snapshot(&self, now_ms: i64) -> SessionSnapshot;
    pub fn start(&mut self, blocks: Vec<Block>, preset_id: Option<i64>, now_ms: i64);
    pub fn pause(&mut self, now_ms: i64);
    pub fn resume(&mut self, now_ms: i64);
    pub fn stop(&mut self, now_ms: i64);
    pub fn skip_to(&mut self, idx: usize, now_ms: i64);
    pub fn edit_blocks(&mut self, blocks: Vec<Block>, now_ms: i64);
    // Advances time; returns list of transitions/nudges/dones that fired.
    pub fn advance(&mut self, now_ms: i64) -> Vec<EngineEvent>;
}
```

**Step 1.** Tests for `EngineCore`:
- `start` → `snapshot` shows Running, idx 0, `remaining_ms` == first block duration
- `advance` by one second decrements `remaining_ms`
- `advance` past first block's end → emits `BlockChanged { to_idx: 1 }` and continues
- `advance` past final block → emits `SessionDone`
- `pause` freezes `remaining_ms` across subsequent `advance` calls
- `resume` after pause resumes at the frozen `remaining_ms`
- `skip_to` switches block and resets `remaining_ms`
- `edit_blocks` keeps `current_idx` pointing to the same block id if present; otherwise clamps to last
- `mid_nudge_sec` on the active block fires `Nudge` exactly once at the threshold
- Blocks with posture transitions produce `BlockChanged` carrying the right `from_posture` / `to_posture`

**Step 2.** Implement `EngineCore`. Use `deadline_ms` (monotonic-ish — fed from caller) + accumulator for `remaining_ms` so pause/resume is lossless. Track `fired_nudge_for_idx: HashSet<usize>` to dedupe.

**Step 3.** Run → PASS.

**Step 4.** Add driver: `start_tick_thread(state: Arc<PomodoroState>, app: AppHandle)` in its own module.
- Owned by the Rust main process; lives for the app lifetime (spawned in tauri `setup()`).
- Loop: sleep 500ms, lock core, call `advance(now_ms())`, get `Vec<EngineEvent>`, release lock, then for each event:
  - Emit `pomodoro:*` through `app.emit(...)` (webview may or may not be listening — fine).
  - **For `BlockChanged`**: also trigger a system notification via `tauri-plugin-notification` so posture prompts fire even when the popup is closed. Notification text is posture-pair aware (Sit→Stand = "Підніми стіл", *→Walk = "Стартуй доріжку", etc.) and assembled in Rust, not frontend.
  - **For `SessionDone`**: also system notification ("Сесія завершена · 3 блоки").
- Never holds the lock across an emit/notify call. Lock, drain events into a local Vec, release, then emit/notify outside.
- Uses `SystemTime::now()` per iteration — sleep/wake safe (no accumulator).
- Panic-safe: wrap body in `catch_unwind` so a panic in one tick doesn't kill the thread.

**Step 5.** Commit: `feat(pomodoro): pure state machine + tick driver`.

---

### Task 3: Rust state + commands + wiring

**Files:**
- Create: `src-tauri/src/modules/pomodoro/state.rs` — holds `Mutex<EngineCore>` + `Mutex<Repo>` + `AppHandle` for emit
- Create: `src-tauri/src/modules/pomodoro/commands.rs`
- Modify: `src-tauri/src/lib.rs` — register state, spawn tick thread, add every `pomodoro_*` command to `invoke_handler!`

**Step 1.** Tests for commands (where possible without AppHandle — use the pure core directly for logic; keep commands as thin wrappers).

**Step 2.** Implement `state.rs` with `PomodoroState { core: Mutex<EngineCore>, repo: Mutex<Repo> }`.

**Step 3.** Implement `commands.rs`:
- Each command locks core, performs op, emits `pomodoro:state`, releases lock. No awaiting inside the lock.
- `pomodoro_start` / `pomodoro_stop` also write to `pomodoro_sessions` (start row / end row).

**Step 4.** Wire into `lib.rs`:
- Build `PomodoroState` after `ClipboardState`
- Spawn `start_tick_thread` in a background thread
- Extend `invoke_handler!` with all commands

**Step 5.** Smoke test: `cargo build` passes; `cargo test -p stash` all green.

**Step 6.** Commit: `feat(pomodoro): tauri state + commands`.

---

### Task 4: Frontend scaffolding + registry integration

**Files:**
- Create: `src/modules/pomodoro/index.tsx`
- Create: `src/modules/pomodoro/PomodoroShell.tsx` (stub returning an empty layout)
- Create: `src/modules/pomodoro/api.ts`
- Create: `src/modules/pomodoro/constants.ts`
- Modify: `src/modules/registry.ts` — add `pomodoroModule` with next free ⌘⌥ shortcut
- Modify: popup keyboard-shortcut handler if needed

**Step 1.** Write `api.ts` unit tests (mirror `notes/api.test.ts` pattern): every invoke wrapper sends the right command name + payload. Use `vi.mocked(invoke)`.

**Step 2.** Run → FAIL.

**Step 3.** Implement `api.ts` with types mirroring the Rust model (Posture enum, Block, Preset, SessionSnapshot, etc.) and one wrapper per command.

**Step 4.** Implement `PomodoroShell.tsx` stub (just renders "Pomodoro" header + `<EmptyState>`).

**Step 5.** Implement `index.tsx` with `lazy(load)` pattern per CLAUDE.md (both `PopupView` and `preloadPopup` use the same import thunk).

**Step 6.** Add to `src/modules/registry.ts` between existing modules. Verify tab appears and switches.

**Step 7.** Run all tests → PASS. Run `pnpm tauri dev` briefly to confirm popup renders a Pomodoro tab with no console errors.

**Step 8.** Commit: `feat(pomodoro): module scaffolding + registry wiring`.

---

### Task 5: usePomodoroEngine hook

**Files:**
- Create: `src/modules/pomodoro/hooks/usePomodoroEngine.ts`
- Create: `src/modules/pomodoro/hooks/usePomodoroEngine.test.ts`

**Behavior:**
- On mount: calls `pomodoro_get_state`, stores snapshot
- Subscribes to `pomodoro:state`, `pomodoro:tick`, `pomodoro:block_changed`, `pomodoro:nudge`, `pomodoro:session_done`
- Exposes: `{ snapshot, remainingMs, onTransition(cb), onNudge(cb), onDone(cb) }` — callbacks as refs so the shell can render toasts / native notifications
- On unmount: unsubscribe all listeners

**Step 1.** Test: hook loads initial snapshot from mocked `invoke`.

**Step 2.** Test: hook updates `remainingMs` when a mocked `listen` callback fires `pomodoro:tick`.

**Step 3.** Test: hook routes `pomodoro:block_changed` through `onTransition` callback.

**Step 4.** Implement.

**Step 5.** Commit: `feat(pomodoro): engine subscription hook`.

---

### Task 6: PresetEditor + BlockRow + PostureBadge

**Files:**
- Create: `src/modules/pomodoro/PostureBadge.tsx` + test
- Create: `src/modules/pomodoro/BlockRow.tsx` + test
- Create: `src/modules/pomodoro/PresetEditor.tsx` + test

**BlockRow responsibilities:**
- Edit mode: name (Input), duration (Input with `m` suffix), posture (SegmentedControl: Sit / Stand / Walk), "nudge at" toggle (Toggle → reveals an Input)
- Reorder handles (drag: use native HTML5 DnD to stay dep-free; test the reorder callback directly, not the DnD)
- Delete button

**PresetEditor responsibilities:**
- Preset name Input at top
- List of BlockRow
- "Add block" button appending a default {name:"Focus", duration:1500, posture:Sit}
- "Save preset" button calling `saveCurrentPreset`
- Reorder support via handler

**Step 1.** TDD each component — see react-conventions skill.

**Step 2-N.** Write tests → implement → pass → commit per component.

---

### Task 7: PresetLibrary

**Files:**
- Create: `src/modules/pomodoro/PresetLibrary.tsx` + test

- Fetches presets on mount + after saves
- Shows a list of presets with: name, block count, total minutes, dominant posture summary (e.g. "2× Sit · 1× Walk")
- Each preset has: "Start" primary button, "Edit" → opens PresetEditor, "Delete" (ConfirmDialog)
- "New preset" button opens an empty PresetEditor

**Commit after.**

---

### Task 8: SessionPlayer

**Files:**
- Create: `src/modules/pomodoro/SessionPlayer.tsx` + test

**UI:**
- Big mono digit clock — mm:ss, font-size ~84px
- Current block name prominent under clock (editable inline — click to rename, commits via `pomodoro_edit_blocks`)
- PostureBadge next to block name
- Progress bar showing elapsed within current block
- "Up next" strip — compact horizontal list of upcoming BlockRows
- Controls: Pause/Resume (Button primary), Skip → (IconButton), Stop (IconButton with Confirm)
- "Add block" (+) button inserting after current

**Posture transition banner:** when `onTransition` fires, show a full-width posture-tinted banner for 6 seconds with the transition text ("Підніми стіл → Stand" etc.) and a "Got it" dismiss.

**Mid-block nudge:** show as a soft `Toast`, not a banner.

**Tests cover:** layout renders snapshot; clock formats remaining_ms; clicking pause calls `pomodoro_pause`; transition banner text for each posture pair.

**Commit after.**

---

### Task 9: PomodoroShell composition

**Files:**
- Modify: `src/modules/pomodoro/PomodoroShell.tsx`

**Logic:**
- If `snapshot.status === 'Idle'` → render PresetLibrary (+ "Ad-hoc session" entry point that jumps to PresetEditor with an unsaved draft and a "Start without saving" button)
- Otherwise → render SessionPlayer

**Native notifications:** *not* fired from the shell — they're already fired by the Rust tick thread (Task 2). The shell only handles in-window cues (banner on `onTransition`, toast on `onNudge`).

**Commit.**

---

### Task 10: Smoke test in dev + README snippet

**Step 1.** Run `pnpm tauri dev`. Manually: create a preset (Sit 25m + Walk 15m + Sit 25m), start it, let the first block expire (use short dev durations), verify transition banner + system notification, verify pause/resume, verify skip.

**Step 2.** Verify in the Stash popup: hide the popup mid-session, reopen — state restored correctly via `pomodoro_get_state`, remaining time continued. Also verify "Unload inactive tabs": switch to another tab long enough that Pomodoro tab is unloaded, then back — timer still advanced and state re-syncs on remount.

**Step 2a.** Verify system notification fires while the popup is fully hidden: start a 1-min block, hide popup, wait for transition — macOS notification appears with the posture-pair text.

**Step 2b.** Verify sleep/wake: start a session, close laptop lid for 2+ minutes, wake — engine has advanced through intermediate transitions and notifications for missed transitions have fired (or at minimum the final state is correct; we do NOT spam a notification per skipped block — see Task 2 driver note).

**Step 3.** Update `ROADMAP.md` (canonical spec, Ukrainian) adding a short Pomodoro section.

**Step 4.** Commit: `docs(pomodoro): roadmap entry`.

---

## Out-of-scope (planned next)

- Stats view ("today I sat 2h 10m / walked 45m / stood 30m")
- Linking current block to an in-progress Note ("save a log of this block to notes")
- Audio schemes (soft bell vs gong per block) — structure already supports it; just needs a `sound_id` on Block plus a `Howler`-style player
- Tray-icon badge with minutes-remaining
- Global hotkey "pause session"
- Drag-reorder blocks in SessionPlayer (v1 allows edit via PresetEditor-style inline editing)

## Risks

- **Tick-thread accuracy during sleep**: when the Mac sleeps, `SystemTime::now` jumps on wake; engine must reconcile by looking at the delta rather than ticking at a fixed 1s. Use `now_ms` deltas, not accumulators.
- **Popup hide / unload = engine must survive.** All tick + notification logic lives in the Rust process, not in the webview. `set_popup_auto_hide` is not touched anywhere in this module (no native dialogs opened).
- **Over-notification when webview is visible**: at block transitions we fire both the in-window banner AND a system notification. That's intentional (the banner is richer; the system notification is the fallback). If it feels noisy, tie system notifications to `app.webview_windows()` visibility — send only if popup is not focused. Left as a v2 toggle.
- **Sleep-through-session edge case**: if sleep spans multiple block boundaries, we must not spam N notifications on wake. Driver coalesces: if the `advance()` call produced ≥2 `BlockChanged` events in one tick, emit only the latest transition as a system notification (the in-app banner still cycles through all of them if the webview is live).
