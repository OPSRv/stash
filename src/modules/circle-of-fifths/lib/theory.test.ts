import { describe, expect, it } from 'vitest';
import {
  CIRCLE, keyAt, keySignature, scaleOf, MODES, modeScale,
  diatonicChords, chordName, romanNumeral, relativeOf, parallelOf,
  spellPitch, chordPitches,
} from './theory';

describe('circle layout', () => {
  it('orders majors by fifths from C', () => {
    expect(CIRCLE.map((s) => s.major.label)).toEqual([
      'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F',
    ]);
  });
  it('pairs each major with its relative minor', () => {
    expect(CIRCLE[0].minor.label).toBe('Am');
    expect(CIRCLE[1].minor.label).toBe('Em');
    expect(CIRCLE[11].minor.label).toBe('Dm');
  });
});

describe('keySignature', () => {
  it('C major has no accidentals', () =>
    expect(keySignature({ tonic: 0, minor: false })).toEqual({ sharps: 0, flats: 0, notes: [] }));
  it('A major has 3 sharps F# C# G#', () =>
    expect(keySignature({ tonic: 9, minor: false })).toEqual({
      sharps: 3, flats: 0, notes: ['F#', 'C#', 'G#'],
    }));
  it('Eb major has 3 flats Bb Eb Ab', () =>
    expect(keySignature({ tonic: 3, minor: false })).toEqual({
      sharps: 0, flats: 3, notes: ['Bb', 'Eb', 'Ab'],
    }));
  it('minor uses its relative major signature (F# minor = A major)', () =>
    expect(keySignature({ tonic: 6, minor: true })).toEqual(
      keySignature({ tonic: 9, minor: false })));
});

describe('scales & modes', () => {
  it('G major scale', () =>
    expect(scaleOf({ tonic: 7, minor: false }).map((n) => n.label))
      .toEqual(['G', 'A', 'B', 'C', 'D', 'E', 'F#']));
  it('A natural minor scale', () =>
    expect(scaleOf({ tonic: 9, minor: true }).map((n) => n.label))
      .toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']));
  it('D dorian = C major notes from D', () =>
    expect(modeScale(2, MODES[1]).map((n) => n.pc)).toEqual([2, 4, 5, 7, 9, 11, 0]));
});

describe('diatonic chords', () => {
  it('C major triads I..vii°', () =>
    expect(diatonicChords({ tonic: 0, minor: false }, false).map(chordName))
      .toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']));
  it('C major sevenths', () =>
    expect(diatonicChords({ tonic: 0, minor: false }, true).map(chordName))
      .toEqual(['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5']));
  it('A minor triads i..VII', () =>
    expect(diatonicChords({ tonic: 9, minor: true }, false).map(chordName))
      .toEqual(['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']));
});

describe('roman numerals', () => {
  it('labels degrees in major', () => {
    const chords = diatonicChords({ tonic: 0, minor: false }, false);
    expect(chords.map((c) => romanNumeral(c, { tonic: 0, minor: false })))
      .toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  });
  it('labels non-diatonic chord with accidental degree', () => {
    // Bb major chord in C major = bVII
    expect(romanNumeral({ root: 10, quality: 'maj' }, { tonic: 0, minor: false })).toBe('bVII');
  });
});

describe('relative / parallel / spelling', () => {
  it('relative of C is Am and back', () => {
    expect(relativeOf({ tonic: 0, minor: false })).toEqual({ tonic: 9, minor: true });
    expect(relativeOf({ tonic: 9, minor: true })).toEqual({ tonic: 0, minor: false });
  });
  it('parallel of C is Cm', () =>
    expect(parallelOf({ tonic: 0, minor: false })).toEqual({ tonic: 0, minor: true }));
  it('spells F# in sharp keys and Gb in flat keys', () => {
    expect(spellPitch(6, { tonic: 7, minor: false })).toBe('F#');
    expect(spellPitch(6, { tonic: 1, minor: false })).toBe('Gb');
  });
});

// --- Additional coverage beyond the plan ---

describe('keyAt', () => {
  it('returns the major key at a circle slot', () => {
    expect(keyAt(0, false)).toEqual({ tonic: 0, minor: false });
    expect(keyAt(1, false)).toEqual({ tonic: 7, minor: false });
  });
  it('returns the relative minor at a circle slot', () => {
    expect(keyAt(0, true)).toEqual({ tonic: 9, minor: true });
    expect(keyAt(11, true)).toEqual({ tonic: 2, minor: true });
  });
  it('wraps slots outside 0..11', () => {
    expect(keyAt(12, false)).toEqual({ tonic: 0, minor: false });
    expect(keyAt(-1, true)).toEqual({ tonic: 2, minor: true });
  });
});

describe('sharp-key spelling agrees with the signature', () => {
  it('F# major scale uses E#, not F', () =>
    expect(scaleOf({ tonic: 6, minor: false }).map((n) => n.label))
      .toEqual(['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#']));
  it('F# major triads end in E#dim', () =>
    expect(diatonicChords({ tonic: 6, minor: false }, false).map(chordName))
      .toEqual(['F#', 'G#m', 'A#m', 'B', 'C#', 'D#m', 'E#dim']));
  it('D# minor scale spelling', () =>
    expect(scaleOf({ tonic: 3, minor: true }).map((n) => n.label))
      .toEqual(['D#', 'E#', 'F#', 'G#', 'A#', 'B', 'C#']));
});

describe('keySignature edge keys', () => {
  it('F# major has 6 sharps up to E#', () =>
    expect(keySignature({ tonic: 6, minor: false })).toEqual({
      sharps: 6, flats: 0, notes: ['F#', 'C#', 'G#', 'D#', 'A#', 'E#'],
    }));
  it('Db major has 5 flats', () =>
    expect(keySignature({ tonic: 1, minor: false })).toEqual({
      sharps: 0, flats: 5, notes: ['Bb', 'Eb', 'Ab', 'Db', 'Gb'],
    }));
  it('D minor borrows F major signature (1 flat)', () =>
    expect(keySignature({ tonic: 2, minor: true })).toEqual({
      sharps: 0, flats: 1, notes: ['Bb'],
    }));
});

describe('flat-key spelling flows into scales and chords', () => {
  it('Eb major scale uses flat names', () =>
    expect(scaleOf({ tonic: 3, minor: false }).map((n) => n.label))
      .toEqual(['Eb', 'F', 'G', 'Ab', 'Bb', 'C', 'D']));
  it('Eb major triads spell roots with flats', () =>
    expect(diatonicChords({ tonic: 3, minor: false }, false).map(chordName))
      .toEqual(['Eb', 'Fm', 'Gm', 'Ab', 'Bb', 'Cm', 'Ddim']));
  it('spells flats in minor keys via the relative major (D minor)', () =>
    expect(spellPitch(10, { tonic: 2, minor: true })).toBe('Bb'));
});

describe('chordPitches', () => {
  it('builds triads and sevenths from intervals', () => {
    expect(chordPitches({ root: 0, quality: 'maj' })).toEqual([0, 4, 7]);
    expect(chordPitches({ root: 7, quality: 'dom7' })).toEqual([7, 11, 2, 5]);
    expect(chordPitches({ root: 11, quality: 'm7b5' })).toEqual([11, 2, 5, 9]);
  });
});

describe('roman numerals (extra)', () => {
  it('labels seventh chords in major', () => {
    const chords = diatonicChords({ tonic: 0, minor: false }, true);
    expect(chords.map((c) => romanNumeral(c, { tonic: 0, minor: false })))
      .toEqual(['Imaj7', 'ii7', 'iii7', 'IVmaj7', 'V7', 'vi7', 'viim7b5']);
  });
  it('labels degrees in natural minor', () => {
    const chords = diatonicChords({ tonic: 9, minor: true }, false);
    expect(chords.map((c) => romanNumeral(c, { tonic: 9, minor: true })))
      .toEqual(['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']);
  });
});

describe('modes (extra)', () => {
  it('exposes the 7 diatonic modes in brightness order from Ionian', () => {
    expect(MODES.map((m) => m.label)).toEqual([
      'Ionian', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian', 'Locrian',
    ]);
  });
  it('Ionian intervals match the major scale', () =>
    expect(MODES[0].intervals).toEqual([0, 2, 4, 5, 7, 9, 11]));
  it('E phrygian spells as C major notes from E', () =>
    expect(modeScale(4, MODES[2]).map((n) => n.label))
      .toEqual(['E', 'F', 'G', 'A', 'B', 'C', 'D']));
});
