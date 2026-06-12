/* Module-global vanilla store. Usable outside React (audio scheduling and the
 * AI panel read/write via getState/setState), while the useStore(selector)
 * hook gives components a reactive subscription through useSyncExternalStore
 * (React 19). Same tiny hand-rolled pattern as the Valeton editor store — no
 * zustand, no extra dependency. Selector results are compared with Object.is,
 * so stable references don't cause extra re-renders.
 *
 * `{ soundOn, bpm, tuningId }` persist to localStorage under
 * 'circle-of-fifths'; everything else is per-session. */

import { useSyncExternalStore } from 'react';
import { DEFAULT_TUNING_ID, TUNINGS } from '../../shared/music/tunings';
import { tunerGetState } from './api';
import type { Chord, Key, Mode } from './lib/theory';

/** Mode identifier, e.g. 'ionian' — derived from theory's `Mode` shape. */
export type ModeId = Mode['id'];

export type AiSuggestion = { chord: Chord; why: string };

export type CircleState = {
  /** Selected key — tonic pitch class + major/minor flag. */
  key: Key;
  mode: ModeId;
  /** Which CIRCLE slot sits at 12 o'clock. */
  rotation: number;
  /** Render chord chips as sevenths instead of triads. */
  seventh: boolean;
  progression: Chord[];
  /** Index of the chord sounding during playback, or null when idle. */
  playingIndex: number | null;
  bpm: number;
  soundOn: boolean;
  tuningId: string;
  fretboardView: 'scale' | 'chord';
  /** Limit the fretboard scale view to the pentatonic subset. */
  pentatonic: boolean;
  /** Chip under the pointer — drives the fretboard chord highlight. */
  hoveredChord: Chord | null;
  aiBusy: boolean;
  aiError: string | null;
  aiExplanation: string | null;
  aiSuggestions: AiSuggestion[] | null;
};

const STORAGE_KEY = 'circle-of-fifths';

/** Tempo bounds shared with the playback UI's BPM control. */
export const MIN_BPM = 40;
export const MAX_BPM = 240;

const PERSISTED_KEYS = ['soundOn', 'bpm', 'tuningId'] as const;
type PersistedState = Pick<CircleState, (typeof PERSISTED_KEYS)[number]>;

const readPersisted = (): Partial<PersistedState> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const out: Partial<PersistedState> = {};
    if (typeof parsed.soundOn === 'boolean') out.soundOn = parsed.soundOn;
    // Clamp so a corrupted value (0, negative, huge) can't break playback math.
    if (typeof parsed.bpm === 'number' && Number.isFinite(parsed.bpm)) {
      out.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, parsed.bpm));
    }
    // Unknown tuning ids fall back to the default via initialState.
    if (typeof parsed.tuningId === 'string' && TUNINGS.some((t) => t.id === parsed.tuningId)) {
      out.tuningId = parsed.tuningId;
    }
    return out;
  } catch {
    return {};
  }
};

const writePersisted = (s: CircleState): void => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ soundOn: s.soundOn, bpm: s.bpm, tuningId: s.tuningId }),
    );
  } catch {
    // localStorage unavailable (quota, private mode) — keep state in memory.
  }
};

const persisted = readPersisted();

export const initialState: CircleState = {
  key: { tonic: 0, minor: false }, // C major
  mode: 'ionian',
  rotation: 0,
  seventh: false,
  progression: [],
  playingIndex: null,
  bpm: 90,
  soundOn: true,
  tuningId: DEFAULT_TUNING_ID,
  fretboardView: 'scale',
  pentatonic: false,
  hoveredChord: null,
  aiBusy: false,
  aiError: null,
  aiExplanation: null,
  aiSuggestions: null,
  ...persisted,
};

type Listener = () => void;

let state: CircleState = { ...initialState };
const listeners = new Set<Listener>();

export const getState = (): CircleState => state;

export function setState(
  partial: Partial<CircleState> | ((state: CircleState) => Partial<CircleState>),
): void {
  const next = typeof partial === 'function' ? partial(state) : partial;
  const prev = state;
  state = { ...state, ...next };
  if (PERSISTED_KEYS.some((k) => state[k] !== prev[k])) writePersisted(state);
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStore<T>(selector: (s: CircleState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/* Seed `tuningId` from the tuner module's saved state when nothing was
 * persisted for this module yet (first run). Idempotent — the shell calls it
 * on first mount; later calls and later launches (once a choice is persisted)
 * are no-ops. */
let tuningSeeded = persisted.tuningId !== undefined;

export async function seedTuningFromTuner(): Promise<void> {
  if (tuningSeeded) return;
  tuningSeeded = true;
  try {
    const { tuning_id } = await tunerGetState();
    // Skip if the user already picked a tuning while we were waiting.
    if (getState().tuningId === DEFAULT_TUNING_ID && tuning_id !== DEFAULT_TUNING_ID) {
      setState({ tuningId: tuning_id });
    }
  } catch {
    // Tuner state unavailable (e.g. Vite-only dev) — keep the default.
  }
}
