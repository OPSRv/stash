/* Chord-progression presets, transposition and text export for the Circle of
 * Fifths module. Builds entirely on `theory.ts` — no DOM, no React, no Tauri.
 */

import {
  type Chord,
  type ChordQuality,
  type Key,
  chordName,
  diatonicChords,
  pc,
  scaleOf,
  spellPitch,
} from './theory';

/** One step of a preset: a scale degree (1–7) with an optional quality
 * override; without one the key's diatonic triad quality is used. */
export type PresetDegree = { degree: number; quality?: ChordQuality };

export type Preset = {
  id: string;
  label: string;
  /** Resolve degrees against the (parallel) minor of the requested tonic. */
  minor?: boolean;
  /** Resolve degrees as the key's diatonic seventh chords instead of triads. */
  sevenths?: boolean;
  degrees: PresetDegree[];
};

const d = (degree: number, quality?: ChordQuality): PresetDegree => ({ degree, quality });

export const PRESETS: Preset[] = [
  {
    // Sevenths follow the key (major: iim7 V7 Imaj7; minor: iim7b5 V7 im7);
    // only the dominant is forced to dom7 — a no-op in major, the
    // harmonic-minor V7 in minor.
    id: 'ii-v-i',
    label: 'ii–V–I',
    sevenths: true,
    degrees: [d(2), d(5, 'dom7'), d(1)],
  },
  {
    id: 'axis',
    label: 'Axis (I–V–vi–IV)',
    degrees: [d(1), d(5), d(6), d(4)],
  },
  {
    id: 'pop-50s',
    label: "'50s pop (I–vi–IV–V)",
    degrees: [d(1), d(6), d(4), d(5)],
  },
  {
    id: 'blues-12',
    label: '12-bar blues',
    degrees: [1, 1, 1, 1, 4, 4, 1, 1, 5, 4, 1, 5].map((deg) => d(deg, 'dom7')),
  },
  {
    // Degrees against the natural minor scale: i, bVII, bVI sit on plain
    // scale steps; the dominant V is forced major (harmonic-minor cadence).
    id: 'andalusian',
    label: 'Andalusian (i–bVII–bVI–V)',
    minor: true,
    degrees: [d(1), d(7), d(6), d(5, 'maj')],
  },
  {
    id: 'pachelbel',
    label: 'Pachelbel (I–V–vi–iii–IV–I–IV–V)',
    degrees: [d(1), d(5), d(6), d(3), d(4), d(1), d(4), d(5)],
  },
];

/** Resolve a preset's degrees in a key into concrete chords (with key-aware
 * root spellings). Minor presets resolve against the parallel minor when a
 * major key is given, so e.g. the Andalusian cadence in C yields Cm–Bb–Ab–G. */
export const presetChords = (presetId: string, key: Key): Chord[] => {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);
  const resolved: Key = preset.minor ? { tonic: key.tonic, minor: true } : key;
  const diatonic = diatonicChords(resolved, preset.sevenths ?? false);
  return preset.degrees.map(({ degree, quality }) => {
    const base = diatonic[degree - 1];
    if (!base) throw new Error(`Degree out of range: ${degree}`);
    return quality ? { ...base, quality } : { ...base };
  });
};

/* Proxy keys whose `spellPitch` covers the whole chromatic with flat (F major)
 * or sharp (G major) names — both scale degrees and the signature-driven
 * chromatic fallback agree with that direction. */
const FLAT_SPELLER: Key = { tonic: 5, minor: false };
const SHARP_SPELLER: Key = { tonic: 7, minor: false };

/** Spell a transposed root in the destination key. Diatonic roots take the
 * key spelling; chromatic ones keep the accidental direction of the source
 * label, so a borrowed Bb stays a flat even when moved into a sharp key. */
const respellRoot = (root: number, to: Key, sourceLabel: string | undefined): string => {
  if (scaleOf(to).some((n) => n.pc === root)) return spellPitch(root, to);
  if (sourceLabel?.includes('b')) return spellPitch(root, FLAT_SPELLER);
  if (sourceLabel?.includes('#')) return spellPitch(root, SHARP_SPELLER);
  return spellPitch(root, to);
};

/** Shift every root by the interval between the two tonics; qualities stay
 * unchanged, roots are respelled for the destination key (chromatic roots
 * keep their source accidental direction — see `respellRoot`). */
export const transposeProgression = (chords: Chord[], from: Key, to: Key): Chord[] => {
  const shift = to.tonic - from.tonic;
  return chords.map((chord) => {
    const root = pc(chord.root + shift);
    return { ...chord, root, rootLabel: respellRoot(root, to, chord.rootLabel) };
  });
};

/** Plain-text rendering of a progression. A chord's own `rootLabel` wins;
 * the key-based respelling applies only to chords that carry no label. */
export const progressionText = (chords: Chord[], key: Key): string =>
  chords
    .map((chord) => chordName({ ...chord, rootLabel: chord.rootLabel ?? spellPitch(chord.root, key) }))
    .join(' – ');
