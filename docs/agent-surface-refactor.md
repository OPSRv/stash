# Agent surface refactor — move plan

Goal: every module owns its Telegram/assistant surface in
`src-tauri/src/modules/<m>/agent.rs` (slash `CommandHandler`s + LLM `Tool`s +
`register_commands` / `register_tools`), as already done in `downloader/`,
`translator/`, `system/`. `telegram/module_cmds.rs` and `telegram/tools/stash.rs`
end up empty and are deleted.

## What is already in place (prep commit)

- **`telegram/agent_util.rs`** — every helper used by more than one module group:
  `now_ms`, `now_secs`, `truncate_preview` (also replaces the identical
  `tools/stash.rs::truncate`), `tokenize_quoted`, `KNOWN_TABS`, `reveal_tab`,
  `emit_with_ack`, `require_app`, `run_slash`, `BatterySnapshot` / `read_battery`,
  volume (`VolumeAction`, `VolumeSnapshot`, `apply_volume`, `read_volume`,
  `volume_bar`), `format_pomodoro_status` (dashboard), `enqueue_separator` /
  `await_separator_job` (downloader + `/stems`). Test fixtures:
  `agent_util::test_support::{all_callbacks, assert_fits, tool_ctx}`.
  `module_cmds.rs` keeps `pub use` re-exports for now.
- **Group markers.** `module_cmds.rs`, `tools/stash.rs`, the registration block in
  `lib.rs` and the tool block in `telegram/assistant.rs` are reordered into
  `// ═══ BEGIN Gn ═══` … `// ═══ END Gn ═══` sections. Mixed test modules are
  split per group (`g1_audio_tests`, `g2_productivity_tests`, `g3_system_tests`,
  `g1..g4_tool_tests`).
- **Stub targets, already wired.** Every target file below exists with empty
  `register_commands(&Arc<TelegramState>, &AppHandle)` /
  `register_tools(&mut ToolRegistry, &AppHandle)`, is declared in its `mod.rs`, is
  called from inside the owning group's block in `lib.rs` / `assistant.rs`, and is
  listed in the `every_command_is_categorised` test (`commands_registry.rs`). That
  test now only counts `impl CommandHandler for` blocks, so `Tool` names in the
  same file don't trip it.

## Rules for each group agent

1. Edit **only**: your target files; the lines strictly between your own
   `BEGIN`/`END` markers in `module_cmds.rs`, `tools/stash.rs`, `lib.rs`,
   `assistant.rs`; plus the extra lines listed for your group below. Never
   delete or move the marker lines. Don't touch `agent_util.rs`, the file heads
   (imports, re-exports, `#![allow(unused_imports)]`) or another group's block.
2. Move code verbatim. Behaviour, command names, tool names, schemas and
   callback payloads stay exactly the same. Private helpers in your block go
   with the handler that uses them. Shared helpers come from
   `crate::modules::telegram::agent_util`. Never import from another module's
   `agent.rs`.
3. Get module state in `register_commands` / `register_tools` from `app`
   (`app.state::<…>()` / `try_state`, the same way `assistant.rs` gates tools today)
   instead of the old `lib.rs` locals.
4. Delete the old `register_command(module_cmds::…)` / `tools.register(stash::…)`
   lines inside your block and register the same items from your stubs. If a stub
   fn stays empty, delete that fn together with its call line (inside your block).
5. Move each test with the code it covers into a `#[cfg(test)] mod tests` in the
   target file.
6. Done when `cargo test --manifest-path src-tauri/Cargo.toml --lib` passes, `cargo check`
   shows no new warnings, and your blocks hold only the two marker lines.

## G1 audio

| Item | Kind | Target |
|---|---|---|
| `MusicCmd` (/music), `MusicControl` | cmd, tool | `music/agent.rs` |
| `MetronomeCmd` (/metronome), `MetronomeRemote/Args`, `MetronomeControl` (+ `metronome_slash_args`, `quote_slash_value`) | cmd, tool | `metronome/agent.rs` |
| `TunerCmd` (/tuner), `TunerRemote`, `TunerControl` | cmd, tool | `tuner/agent.rs` |
| `RecordCmd` (/record), `RecorderRemote`, `RecordControl` | cmd, tool | `recorder/agent.rs` |
| `ValetonCmd` (/valeton), `ValetonRemote`, `ValetonSetTone`, `ValetonControl` | cmd, tools | `valeton/agent.rs` |
| `CircleProgression` | tool | `circle/agent.rs` |

## G2 productivity

| Item | Kind | Target |
|---|---|---|
| `NoteCmd` (/note), `NotesListCmd` (/notes), `delete_note`; `SaveNote`, `ListNotes`, `SearchNotes`, `GetNote`, `AppendToNote`, `UpdateNote`, `DeleteNote` | cmds, tools | `notes/agent.rs` |
| `ClipCmd` (/clip), `clip_copy_to_mac`; `GetLastClip`, `ClipboardSearch`, `ClipboardPin`, `ClipboardClear`, `ClipboardDelete`, `ClipboardCopyToMac` | cmd, tools | `clipboard/agent.rs` |
| `PomodoroCmd` (/pomodoro), `pomodoro_skip_next`, `reuse_block_ids`, `parse_pomodoro_blocks`; `PomodoroStatus/Start/Stop/SavePreset/Control/EditBlocks/Presets/History` | cmd, tools | `pomodoro/agent.rs` |
| `RemindCmd`, `RemindersCmd`, `ForgetCmd`, `RememberCmd`, `MemoryCmd`, `ForgetFactCmd` | cmds | `telegram/memory_cmds.rs` |

Reminders stay telegram-owned: `telegram/reminders.rs`, `tools/reminders.rs` and
`tools/memory.rs` don't move, and their registrations above the G1 block stay put.
Extra line owned by G2: `lib.rs` `let notes_repo_for_telegram = …` (≈ line 991),
which becomes dead once `/note(s)` read `NotesState` from `app`.

## G3 system

| Item | Kind | Target |
|---|---|---|
| `BatteryCmd`, `VolumeCmd`, `ScreenshotCmd`, `DisplayCmd`, `SleepCmd`, `ShutdownCmd` (+ `handle_power_cmd` and the other power helpers), `FocusCmd`, `WeatherCmd`, `AppCmd`; `GetBattery`, `VolumeControl` | cmds, tools | `system/agent.rs` (exists: append, and leave the unrelated code alone) |
| `KeepAwakeCmd` | cmd | `keepawake/agent.rs` |
| `DashboardCmd`, `NavigateCmd`, `UpdateCmd`; `NavigateTab`, `InvokeCommand` | cmds, tools | `telegram/core_cmds.rs` (cross-cutting) |

`/help`, `/menu`, `/confirm`, `/start`, `/digest` stay where they are.
`PowerTimers` gets created inside `register_commands`. G3 may change
`system::agent::register_commands` / `register_tools` signatures: both call lines
already sit in the G3 blocks. Also update the `system/agent.rs` header comment
that points at `module_cmds.rs`.

## G4 media / AI

| Item | Kind | Target |
|---|---|---|
| `SeparateStemsCmd` (/stems), `DetectBpmCmd` (/bpm), `parse_separator_args*`; `SeparateStems`, `DetectBpm`, `GetSeparatorJob`, `parse_run_args` | cmds, tools | `separator/agent.rs` |
| `ConvertMedia`, `TranscribeToFile`, `GetConverterJob` | tools | `converter/agent.rs` |
| `OcrCmd` (/ocr), `CanvasOcr` | cmd, tool | `ocr/agent.rs` |
| `AiCmd` (/ai), `SummarizeCmd` (/summarize), `VoiceActionCmd` (voice), `voice_action_keyboard` | cmds | `ai/agent.rs` |
| `NpmListScripts`, `NpmRunScript`, `NpmStopScript` | tools | `npm_scripts/agent.rs` |
| `LaunchClaudeCmd` (/claude_code) | cmd | `terminal/agent.rs` |
| `SendCmd` (/send), `SendTelegram` | cmd, tool | `telegram/send_cmds.rs` |

Extra line owned by G4: `telegram/transport.rs` ≈ line 1073
(`super::module_cmds::voice_action_keyboard`), which should point at
`crate::modules::ai::agent::voice_action_keyboard`.

## Registration lines per group (already isolated)

- `lib.rs`: each `BEGIN/END Gn` block holds that group's old
  `register_command(module_cmds::…)` lines followed by the stub
  `modules::<m>::agent::register_commands(&telegram_state, app.handle());` calls.
  Replace the former with registrations inside the latter.
- `telegram/assistant.rs` (`build_runtime_assistant`): same layout with
  `tools.register(super::tools::stash::…)` lines and `…::register_tools(&mut tools, app);`.

## Final cleanup (after all four groups merge)

Delete what is left of `module_cmds.rs` / `tools/stash.rs` (head, re-exports,
markers, `#![allow(unused_imports)]`) and their `mod` lines. Drop
`include_str!("module_cmds.rs")` from `every_command_is_categorised`, and remove
the markers in `lib.rs` / `assistant.rs`. Fix stale `module_cmds` mentions
(`reminders.rs`, `downloader/agent.rs`, `translator/agent.rs` doc comments). In
CLAUDE.md "Agent surface", replace the `module_cmds.rs` / `tools/stash.rs` paths
with `modules/<m>/agent.rs`.
