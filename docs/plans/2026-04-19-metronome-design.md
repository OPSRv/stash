# Metronome module — design

**Date:** 2026-04-19
**Module id:** `metronome`
**Tab position:** after `music`, shortcut `⌘⌥7`
**Popup size:** 720×520 (standard)

## Goal

Guitar-practice metronome with a radial dial, animated pulse, per-beat accents,
and a backing-track player (local audio file or hidden YouTube IFrame). Designed
to be extended later into a “practice trainer” (BPM ramp, presets, session timer).

## Scope (v1)

- BPM 40–240, time signatures 2/4 · 3/4 · 4/4 · 6/8
- Subdivisions ♩ · ♪♪ · ♪♪♪ · ♬♬
- Click sounds (synthesised): Click / Wood / Beep
- First-beat accent on by default; tap any beat dot to toggle accent
- Independent volume sliders for click vs. accent vs. backing track
- Tap tempo (sliding average of last 4 taps)
- Backing track: local file (drag-drop / picker) **or** YouTube link via hidden
  IFrame Player API
- Persisted state (last BPM, signature, subdivision, sound, volumes, accents)

## Non-goals (v1)

- Named presets / setlists
- BPM ramp, practice timer, bar counter
- 5/4, 7/8, 12/8 (extend later)
- Loop sections / playback-rate change on backing track
- BPM auto-detect

## Architecture

### Frontend — `src/modules/metronome/`

```
index.tsx                 ModuleDefinition (lazy)
MetronomeShell.tsx        layout
metronome.constants.ts    BPM bounds, tempo names, sound presets, defaults
api.ts                    invoke wrappers
components/
  BpmDial.tsx             SVG radial dial + pulse
  BeatStrip.tsx           beat dots, accent toggle
  Controls.tsx            time sig / subdivision / sound / volumes
  BackingTrack.tsx        drop-zone + URL bar + player + hidden YT iframe
hooks/
  useMetronomeEngine.ts   Web Audio scheduler (lookahead 25 ms / ahead 100 ms)
  useTapTempo.ts          rolling average of last 4 taps
  useYouTubePlayer.ts     IFrame API wrapper
*.test.tsx                Vitest + RTL
```

### Rust — `src-tauri/src/modules/metronome/`

```
mod.rs           module wiring
state.rs         MetronomeState + JSON persistence
commands.rs      get_state / save_state
```

`MetronomeState`:

```rust
struct MetronomeState {
  bpm: u32,
  numerator: u8,
  denominator: u8,
  subdivision: u8,        // 1, 2, 3, 4
  sound: String,          // "click" | "wood" | "beep"
  click_volume: f32,      // 0..1
  accent_volume: f32,
  track_volume: f32,
  beat_accents: Vec<bool>,
}
```

Stored as JSON in `app_data_dir/metronome.json`.

### Registry

Add `metronomeModule` to `src/modules/registry.ts` after `musicModule`. Tauri
commands registered in `src-tauri/src/lib.rs` `invoke_handler!`.

## Visual design (screen 720×520)

- Top zone (~400 px): centred 320×320 SVG dial.
  - Outer arc 270° representing 40→240 BPM (hairline track + accent fill)
  - Pulse ring on each tick (`scale 1→1.04, opacity .6→0` 150 ms; accent: `scale
    1.06, opacity .9`)
  - Centre: BPM number (96 px, 300 weight, tabular nums, −0.04 em tracking),
    tempo name beneath (`text-meta uppercase t-tertiary`, 0.1 em tracking)
  - Drag along arc, scroll, ↑/↓ to change BPM (`Shift` step 5)
  - Beat strip inside dial (~y 210): dots, accent rendered as 12 px diamond,
    active dot `accent` solid + glow. Click toggles accent.
- Play FAB (56×56, accent fill) to the left of dial. `Space` toggles.
- Tap-tempo bar under dial (200×32, `seg` style). `T` triggers.
- Bottom controls bar (56 px high, full width, `border-top hair`):
  segments separated by hair lines:
  1. Time signature `SegmentedControl` 2/4 · 3/4 · 4/4 · 6/8 (`[`/`]` cycle)
  2. Subdivision `IconButton`s ♩ ♪♪ ♪♪♪ ♬♬ (`1`/`2`/`3`/`4`)
  3. Sound `Select` + preview ▸
  4. Volume sliders (click / accent), small `font-mono` value labels
- Backing-track panel below, two states:
  - Collapsed (32 px): hint “Drag MP3 here or paste YouTube link”
  - Expanded (64 px): icon · title · play/pause · scrub · time · volume · close

Drag-over the popup highlights the panel with an accent dashed border.

## Audio engine

Classic Chris Wilson lookahead pattern:

```
scheduler():
  while (nextNoteTime < currentTime + 0.1):
    scheduleNote(nextNoteTime, beatIndex)
    nextNoteTime += 60 / bpm / subdivision
    advance beatIndex
setInterval(scheduler, 25)
```

`scheduleNote` plays an oscillator with the chosen preset + envelope. The first
beat (or any accented beat) uses `accent_volume` and a higher pitch. Visual
pulse is fired via `requestAnimationFrame` aligned with `(scheduledTime −
currentTime) × 1000` ms.

`AudioContext.resume()` is called on the first user-gesture Play to satisfy
macOS autoplay policy.

## YouTube backing track

- Pasted URL is parsed for `videoId` (regex covering `youtube.com/watch?v=`,
  `youtu.be/…`, `youtube.com/shorts/…`, `youtube.com/embed/…`).
- IFrame is rendered off-screen (`position: absolute; left: -9999px`) and
  controlled via the official YT IFrame API (`postMessage`).
- `https://www.youtube.com/iframe_api` script is lazy-loaded the first time.
- `tauri.conf.json` CSP must allow `frame-src https://www.youtube.com`.

Local files use `<input type=file>` (no extra capability) or HTML5 drag-drop;
file is read into an object URL and played through `<audio>` →
`MediaElementAudioSourceNode` so the track-volume slider routes through the
same audio graph as the metronome.

## Persistence

- All state changes debounced (200 ms) and saved through
  `metronome_save_state`.
- `MetronomeState` is loaded on shell mount; defaults if file missing.
- `beat_accents` is reshaped on numerator change: keep prefix, pad with
  `[true, false, false, …]`.

## Tests (mandatory)

| File | Covers |
|------|--------|
| `useMetronomeEngine.test.ts` | scheduler interval at 120 BPM = 500 ms; accent on beat 1 at 4/4 |
| `useTapTempo.test.ts` | 4 taps × 500 ms ⇒ 120 ± 2 BPM |
| `BpmDial.test.tsx` | drag updates BPM, Shift+scroll step 5, clamps to [40, 240] |
| `BeatStrip.test.tsx` | click toggles `aria-pressed` accent state |
| `Controls.test.tsx` | segmented control, subdivision buttons, slider ranges |
| `BackingTrack.test.tsx` | YT URL parses to `videoId`, iframe `src` updated |
| Rust `state_test.rs` | round-trip JSON, defaults |

Tauri mocks via `vi.mocked(invoke)` (already global in `src/test/setup.ts`).

## Risks & notes

- **Timer drift** — `setTimeout` is unreliable; engine uses `audioContext.currentTime` math.
- **AudioContext suspension** — resume on first user gesture; if user reopens
  the tab while playing, no special handling needed.
- **Hidden tab** — popup hides inactive tabs via `hidden`. Audio continues; we
  pause `requestAnimationFrame` while `document.hidden` to avoid wasted frames.
- **CSP** — verify `frame-src` change does not break other modules.
- **Backing-track volume parity** — both file and YT routes expose `0..1` volume.

## Estimate

~600–800 LoC TypeScript, ~80 LoC Rust, ~200 LoC tests. One PR.
