/* Imperative actions over the circle store, shared by several components:
 * progression playback, quiet previews, and the ⌥-click transpose. The
 * playback {stop} handle lives at module scope — the progression bar is a
 * singleton, and edits made outside it (transpose, assistant pushes) must
 * be able to silence a sounding run before they reshape the progression. */

import { getState, setState } from '../store';
import { chordMidis, playChord, playProgression } from './audio';
import { transposeProgression } from './progressions';
import { keyAt, pc, type Chord } from './theory';

/** One shared gain for implicit chip auditions (quieter than playback). */
const PREVIEW_GAIN = 0.14;

/** Quiet chip audition; silent while sound is off. */
export const previewChord = (chord: Chord): void => {
  if (!getState().soundOn) return;
  playChord(chordMidis(chord), { gain: PREVIEW_GAIN });
};

/** Append a chord to the progression, with a quiet audition. Appending is
 * safe during playback — the sounding run plays its captured snapshot and
 * existing chip indexes keep lining up. */
export const addChord = (chord: Chord): void => {
  setState((s) => ({ progression: [...s.progression, chord] }));
  previewChord(chord);
};

/* ── Progression playback ──────────────────────────────────────────────── */

let handle: { stop: () => void } | null = null;

/** Stop the active run (no-op when idle). `playingIndex` clears through the
 * run's own onStep(null), so every consumer sees the same signal. */
export const stopProgression = (): void => {
  handle?.stop();
  handle = null;
};

/** Play the current progression from the top, replacing any active run.
 * Play is explicit user intent, so it ignores `soundOn` — that toggle gates
 * only the implicit previews. */
export const playCurrentProgression = (): void => {
  stopProgression();
  const { progression, bpm } = getState();
  if (progression.length === 0) return;
  handle = playProgression(progression, bpm, (i) => {
    setState({ playingIndex: i });
    if (i === null) handle = null; // finished or stopped — release the handle
  });
};

/** "Transpose here": move the whole progression into the key at circle
 * `slot`, keeping the current major/minor flavour, and select that key
 * (rotating it to 12 o'clock like a normal selection). CircleShell passes
 * this to CircleSvg's `onAltSelect` (⌥-click on a sector). Stops playback
 * first — a sounding run would keep the old key under relabelled chips. */
export const transposeTo = (slot: number): void => {
  stopProgression();
  const wrapped = pc(slot);
  const { key, progression } = getState();
  const to = keyAt(wrapped, key.minor);
  setState({
    key: to,
    rotation: wrapped,
    progression: transposeProgression(progression, key, to),
  });
};
