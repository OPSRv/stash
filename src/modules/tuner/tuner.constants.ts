/* Tuner model — tuner-specific thresholds, persisted state, chromatic note
 * matching and fretboard geometry. The tunings themselves (notes, frequencies,
 * the generated standard/drop list) live in `src/shared/music/tunings.ts` so
 * other modules can reuse them. */

import { A4_HZ, DEFAULT_TUNING_ID, midiToFreq, midiToName, type Tuning } from '../../shared/music/tunings';

export {
  A4_HZ,
  midiToFreq,
  midiToName,
  TUNINGS,
  DEFAULT_TUNING_ID,
  tuningById,
} from '../../shared/music/tunings';
export type { Tuning, GuitarString, TuningCategory } from '../../shared/music/tunings';

/** Within this many cents of a string's pitch the note reads "in tune". */
export const IN_TUNE_CENTS = 5;

export type TunerState = {
  tuning_id: string;
  /** Preferred audio-input device id, or null/undefined for the system default. */
  device_id?: string | null;
};

export const DEFAULT_STATE: TunerState = {
  tuning_id: DEFAULT_TUNING_ID,
  device_id: null,
};

/** Nearest equal-tempered semitone to `freq`, independent of any tuning. This
 *  is what makes the tuner genuinely *chromatic*: it names whatever note it
 *  hears — every pitch class, every octave — rather than snapping the readout
 *  to the closest open string of the selected tuning. The tuning is then only
 *  an overlay of targets on the fretboard. */
export type ChromaticMatch = {
  /** Nearest MIDI note (A4 = 69). */
  midi: number;
  /** Scientific pitch name, e.g. "E2". */
  name: string;
  /** Signed cents from that note (+ sharp, − flat), within [-50, 50]. */
  cents: number;
  /** Target frequency of that note in Hz. */
  freq: number;
};

export const matchChromatic = (freq: number): ChromaticMatch | null => {
  if (!Number.isFinite(freq) || freq <= 0) return null;
  // Continuous MIDI value, snapped to the nearest integer semitone; the
  // fractional remainder is the cents offset.
  const exact = 69 + 12 * Math.log2(freq / A4_HZ);
  const midi = Math.round(exact);
  return {
    midi,
    name: midiToName(midi),
    cents: (exact - midi) * 100,
    freq: midiToFreq(midi),
  };
};

/** Frets the neck diagram spans (0 = open/nut). A full octave guarantees every
 *  detected note shows at least one position on every string it can reach. */
export const FRETBOARD_FRETS = 12;

/** Single-dot fret-inlay positions; 12 is rendered as the octave double-dot. */
export const FRET_MARKERS = [3, 5, 7, 9] as const;

/** A playable spot on the neck. */
export type FretPosition = {
  /** Index into `tuning.strings` (lowest string first). */
  stringIndex: number;
  /** Fret number (0 = open). */
  fret: number;
};

/** Every (string, fret) within `frets` where `midi` is playable on `tuning` —
 *  i.e. all the places the detected note lives on the fretboard. */
export const fretPositionsForMidi = (
  midi: number,
  tuning: Tuning,
  frets: number = FRETBOARD_FRETS,
): FretPosition[] => {
  const out: FretPosition[] = [];
  tuning.strings.forEach((s, stringIndex) => {
    const fret = midi - s.midi;
    if (fret >= 0 && fret <= frets) out.push({ stringIndex, fret });
  });
  return out;
};
