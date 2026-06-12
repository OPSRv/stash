import { describe, expect, it } from 'vitest';
import { PRESETS, presetChords, transposeProgression, progressionText } from './progressions';
import { chordName } from './theory';

it('ii-V-I preset in C', () =>
  expect(presetChords('ii-v-i', { tonic: 0, minor: false }).map(chordName))
    .toEqual(['Dm7', 'G7', 'Cmaj7']));

it('axis preset I-V-vi-IV in G', () =>
  expect(presetChords('axis', { tonic: 7, minor: false }).map(chordName))
    .toEqual(['G', 'D', 'Em', 'C']));

it('transposes a progression by degrees C→D', () => {
  const am = { root: 9, quality: 'min' as const };
  const f = { root: 5, quality: 'maj' as const };
  expect(
    transposeProgression([am, f], { tonic: 0, minor: false }, { tonic: 2, minor: false })
      .map(chordName),
  ).toEqual(['Bm', 'G']);
});

it('renders progression text', () => {
  expect(progressionText([{ root: 9, quality: 'min7' }], { tonic: 0, minor: false }))
    .toBe('Am7');
});

it('every preset resolves in every major key without throwing', () => {
  for (const p of PRESETS)
    for (let t = 0; t < 12; t++) presetChords(p.id, { tonic: t, minor: false });
});

// --- Additional coverage beyond the plan ---

describe('presets (extra)', () => {
  it('pop-50s preset I-vi-IV-V in C', () =>
    expect(presetChords('pop-50s', { tonic: 0, minor: false }).map(chordName))
      .toEqual(['C', 'Am', 'F', 'G']));

  it('12-bar blues in C is all dominant sevenths', () =>
    expect(presetChords('blues-12', { tonic: 0, minor: false }).map(chordName))
      .toEqual(['C7', 'C7', 'C7', 'C7', 'F7', 'F7', 'C7', 'C7', 'G7', 'F7', 'C7', 'G7']));

  it('ii-V-i in a minor key uses the half-diminished ii and dominant V', () =>
    expect(presetChords('ii-v-i', { tonic: 9, minor: true }).map(chordName))
      .toEqual(['Bm7b5', 'E7', 'Am7']));

  it('andalusian cadence resolves against the minor key with a major V', () =>
    expect(presetChords('andalusian', { tonic: 9, minor: true }).map(chordName))
      .toEqual(['Am', 'G', 'F', 'E']));

  it('andalusian in a major key uses its parallel minor', () =>
    expect(presetChords('andalusian', { tonic: 0, minor: false }).map(chordName))
      .toEqual(['Cm', 'Bb', 'Ab', 'G']));

  it('pachelbel preset in D', () =>
    expect(presetChords('pachelbel', { tonic: 2, minor: false }).map(chordName))
      .toEqual(['D', 'A', 'Bm', 'F#m', 'G', 'D', 'G', 'A']));

  it('spells preset roots with flats in flat keys', () =>
    expect(presetChords('axis', { tonic: 3, minor: false }).map(chordName))
      .toEqual(['Eb', 'Bb', 'Cm', 'Ab']));

  it('every preset also resolves in every minor key without throwing', () => {
    for (const p of PRESETS)
      for (let t = 0; t < 12; t++) presetChords(p.id, { tonic: t, minor: true });
  });

  it('throws on an unknown preset id', () =>
    expect(() => presetChords('nope', { tonic: 0, minor: false })).toThrow(/unknown preset/i));
});

describe('transposeProgression (extra)', () => {
  it('keeps qualities and respells roots for the target key', () => {
    // ii-V-I in C moved to F: every root lands diatonic in F, qualities carry over.
    const inC = presetChords('ii-v-i', { tonic: 0, minor: false });
    expect(
      transposeProgression(inC, { tonic: 0, minor: false }, { tonic: 5, minor: false })
        .map(chordName),
    ).toEqual(['Gm7', 'C7', 'Fmaj7']);
  });

  it('respells roots with flats when moved into a flat key', () => {
    // ii-V-I in C moved to Eb: roots must render Bb/Eb, never A#/D#.
    const inC = presetChords('ii-v-i', { tonic: 0, minor: false });
    expect(
      transposeProgression(inC, { tonic: 0, minor: false }, { tonic: 3, minor: false })
        .map(chordName),
    ).toEqual(['Fm7', 'Bb7', 'Ebmaj7']);
  });

  it('keeps flat spellings of borrowed chords when moved into a sharp key', () => {
    // Andalusian resolved in C (Cm Bb Ab G) moved to D: bVII/bVI stay flat (C, Bb), not A#.
    const inC = presetChords('andalusian', { tonic: 0, minor: false });
    const moved = transposeProgression(inC, { tonic: 0, minor: false }, { tonic: 2, minor: false });
    expect(progressionText(moved, { tonic: 2, minor: false })).toBe('Dm – C – Bb – A');
  });

  it('transposing to the same key is identity on roots', () => {
    const chords = presetChords('axis', { tonic: 7, minor: false });
    expect(
      transposeProgression(chords, { tonic: 7, minor: false }, { tonic: 7, minor: false })
        .map((c) => c.root),
    ).toEqual(chords.map((c) => c.root));
  });
});

describe('progressionText (extra)', () => {
  it('joins chords with an en dash and spells for the key', () =>
    expect(
      progressionText(
        [
          { root: 10, quality: 'maj' },
          { root: 3, quality: 'maj' },
          { root: 5, quality: 'dom7' },
        ],
        { tonic: 10, minor: false },
      ),
    ).toBe('Bb – Eb – F7'));

  it('renders an empty progression as an empty string', () =>
    expect(progressionText([], { tonic: 0, minor: false })).toBe(''));
});
