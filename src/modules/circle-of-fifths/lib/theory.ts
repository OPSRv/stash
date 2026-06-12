/* Pure music theory for the Circle of Fifths module.
 *
 * Pitch classes are 0–11 with C = 0. A key is a tonic pitch class plus a
 * major/minor flag; everything else (signatures, scales, diatonic chords,
 * roman numerals, spelling) is derived from small interval tables. No DOM,
 * no React, no Tauri — this file must stay framework-free.
 */

export type Key = { tonic: number; minor: boolean };

/** A pitch class with its display spelling, e.g. { pc: 6, label: 'F#' }. */
export type KeyLabel = { pc: number; label: string };

export type ChordQuality = 'maj' | 'min' | 'dim' | 'maj7' | 'min7' | 'dom7' | 'm7b5';

export type Chord = {
  root: number;
  quality: ChordQuality;
  /** Key-aware spelling of the root, filled by `diatonicChords`. */
  rootLabel?: string;
};

export type Mode = { id: string; label: string; intervals: number[] };

export type KeySignature = { sharps: number; flats: number; notes: string[] };

/** Normalize any integer to a pitch class 0–11. */
export const pc = (n: number): number => ((n % 12) + 12) % 12;

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
/** Natural pitch class of each letter, aligned with LETTERS. */
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];

/** Spell a target pitch class on a given letter, e.g. letter E + pc 5 → 'E#'. */
const spellOnLetter = (letterIndex: number, target: number): string => {
  const i = letterIndex % 7;
  let accidentals = pc(target - LETTER_PCS[i]);
  if (accidentals > 6) accidentals -= 12;
  return LETTERS[i] + (accidentals >= 0 ? '#'.repeat(accidentals) : 'b'.repeat(-accidentals));
};

/** Major-tonic pitch class at each circle slot: slot i = (i * 7) % 12. */
const FIFTHS = Array.from({ length: 12 }, (_, i) => (i * 7) % 12);

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/** Accidentals accrue along the circle: F C G D A E B sharpen, reversed they flatten. */
const ACCIDENTAL_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const SHARP_NOTES = ACCIDENTAL_ORDER.map((n) => `${n}#`);
const FLAT_NOTES = [...ACCIDENTAL_ORDER].reverse().map((n) => `${n}b`);

export const relativeOf = (key: Key): Key =>
  key.minor
    ? { tonic: pc(key.tonic + 3), minor: false }
    : { tonic: pc(key.tonic + 9), minor: true };

export const parallelOf = (key: Key): Key => ({ tonic: key.tonic, minor: !key.minor });

/** Sharps grow clockwise from C (slots 1–6), flats counterclockwise (slots 11–7). */
export const keySignature = (key: Key): KeySignature => {
  const majorTonic = key.minor ? relativeOf(key).tonic : key.tonic;
  const slot = FIFTHS.indexOf(pc(majorTonic));
  if (slot >= 1 && slot <= 6) {
    return { sharps: slot, flats: 0, notes: SHARP_NOTES.slice(0, slot) };
  }
  const flats = slot === 0 ? 0 : 12 - slot;
  return { sharps: 0, flats, notes: FLAT_NOTES.slice(0, flats) };
};

/** Chromatic table name: flat names in flat keys, sharp names otherwise. */
const chromaticName = (pitch: number, key: Key): string =>
  (keySignature(key).flats > 0 ? FLAT_NAMES : SHARP_NAMES)[pc(pitch)];

/** Seven notes of the key's scale (major or natural minor), spelled for the key.
 * Walks seven consecutive letters from the tonic letter, attaching accidentals,
 * so every scale agrees with its signature (F# major gets E#, not F). */
export const scaleOf = (key: Key): KeyLabel[] => {
  const tonicLetter = LETTERS.indexOf(chromaticName(key.tonic, key)[0]);
  return (key.minor ? MINOR_SCALE : MAJOR_SCALE).map((step, degree) => {
    const target = pc(key.tonic + step);
    return { pc: target, label: spellOnLetter(tonicLetter + degree, target) };
  });
};

/** Spell a pitch class for a key: diatonic pitches take their scale-degree
 * spelling; chromatic ones fall back to the signature-matching table. */
export const spellPitch = (pitch: number, key: Key): string => {
  const target = pc(pitch);
  const degree = scaleOf(key).find((n) => n.pc === target);
  return degree ? degree.label : chromaticName(target, key);
};

const note = (pitch: number, key: Key): KeyLabel => ({
  pc: pc(pitch),
  label: spellPitch(pitch, key),
});

const MODE_LABELS = ['Ionian', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian', 'Locrian'];

/** The seven diatonic modes, intervals derived by rotating the major scale. */
export const MODES: Mode[] = MODE_LABELS.map((label, degree) => ({
  id: label.toLowerCase(),
  label,
  intervals: MAJOR_SCALE.map((_, i) => pc(MAJOR_SCALE[(degree + i) % 7] - MAJOR_SCALE[degree])),
}));

/** Mode scale from a tonic, spelled against the parent major key's signature. */
export const modeScale = (tonic: number, mode: Mode): KeyLabel[] => {
  const degree = MODES.findIndex((m) => m.id === mode.id);
  const parent: Key =
    degree === -1 ? { tonic: pc(tonic), minor: false } : { tonic: pc(tonic - MAJOR_SCALE[degree]), minor: false };
  return mode.intervals.map((step) => note(tonic + step, parent));
};

const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  m7b5: [0, 3, 6, 10],
};

export const chordPitches = (chord: Chord): number[] =>
  CHORD_INTERVALS[chord.quality].map((step) => pc(chord.root + step));

const triadQuality = (third: number, fifth: number): ChordQuality =>
  third === 4 ? 'maj' : fifth === 6 ? 'dim' : 'min';

const seventhQuality = (third: number, fifth: number, seventh: number): ChordQuality => {
  if (fifth === 6) return 'm7b5';
  if (third === 3) return 'min7';
  return seventh === 11 ? 'maj7' : 'dom7';
};

/** Stack thirds on each scale degree to get the key's seven diatonic chords. */
export const diatonicChords = (key: Key, sevenths: boolean): Chord[] => {
  const scale = scaleOf(key);
  return scale.map((root, i) => {
    const third = pc(scale[(i + 2) % 7].pc - root.pc);
    const fifth = pc(scale[(i + 4) % 7].pc - root.pc);
    const seventh = pc(scale[(i + 6) % 7].pc - root.pc);
    return {
      root: root.pc,
      quality: sevenths ? seventhQuality(third, fifth, seventh) : triadQuality(third, fifth),
      rootLabel: root.label,
    };
  });
};

const NAME_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  maj7: 'maj7',
  min7: 'm7',
  dom7: '7',
  m7b5: 'm7b5',
};

export const chordName = (chord: Chord): string =>
  `${chord.rootLabel ?? SHARP_NAMES[pc(chord.root)]}${NAME_SUFFIX[chord.quality]}`;

/** Reverse of `chordName`'s suffix table — quality by printable suffix — so
 * parsing and printing stay in lockstep by construction. */
const QUALITY_BY_SUFFIX = new Map<string, ChordQuality>(
  (Object.keys(NAME_SUFFIX) as ChordQuality[]).map((q) => [NAME_SUFFIX[q], q]),
);

/** Parse a chord name (`C`, `Bbm`, `C7`, `Ebmaj7`, `F#m7b5`, …) into a Chord.
 * `rootLabel` keeps the name's own root spelling so it survives round-trips
 * through `chordName`. Unknown roots or qualities (`H7`, `Csus4`) → null. */
export const parseChordName = (name: string): Chord | null => {
  const m = /^([A-G])(#{1,2}|b{1,2})?(.*)$/.exec(name.trim());
  if (!m) return null;
  const [, letter, accidentals = '', suffix] = m;
  const quality = QUALITY_BY_SUFFIX.get(suffix);
  if (quality === undefined) return null;
  const offset = accidentals.startsWith('#') ? accidentals.length : -accidentals.length;
  return {
    root: pc(LETTER_PCS[LETTERS.indexOf(letter)] + offset),
    quality,
    rootLabel: letter + accidentals,
  };
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const MINOR_QUALITIES: ChordQuality[] = ['min', 'dim', 'min7', 'm7b5'];

const ROMAN_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: '',
  dim: '°',
  maj7: 'maj7',
  min7: '7',
  dom7: '7',
  m7b5: 'm7b5',
};

/** Degree label within the key's scale; non-diatonic roots get a flat-degree prefix. */
export const romanNumeral = (chord: Chord, key: Key): string => {
  const pcs = scaleOf(key).map((n) => n.pc);
  const root = pc(chord.root);
  let degree = pcs.indexOf(root);
  let prefix = '';
  if (degree === -1) {
    // Every chromatic pitch sits one semitone below some degree of a major or
    // natural minor scale (no gap exceeds a whole step), so a flattened-degree
    // spelling always exists; prefer it (Bb in C major = bVII, not #VI).
    degree = pcs.findIndex((p) => pc(p - 1) === root);
    prefix = 'b';
  }
  const numeral = MINOR_QUALITIES.includes(chord.quality)
    ? ROMAN[degree].toLowerCase()
    : ROMAN[degree];
  return `${prefix}${numeral}${ROMAN_SUFFIX[chord.quality]}`;
};

/** The 12 circle slots: majors by fifths from C, each with its relative minor. */
export const CIRCLE: { major: KeyLabel; minor: KeyLabel }[] = FIFTHS.map((majorPc) => {
  const majorKey: Key = { tonic: majorPc, minor: false };
  const minorPc = pc(majorPc + 9);
  return {
    major: { pc: majorPc, label: spellPitch(majorPc, majorKey) },
    minor: { pc: minorPc, label: `${spellPitch(minorPc, majorKey)}m` },
  };
});

/** Key at a circle slot (wraps), major or its relative minor. */
export const keyAt = (slot: number, minor: boolean): Key => {
  const entry = CIRCLE[pc(slot)];
  return { tonic: (minor ? entry.minor : entry.major).pc, minor };
};
