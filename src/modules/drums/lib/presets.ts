/* Genre presets in step notation (`x` hit, `X` accent, `.` off), grouped
 * into genres with several variations each. Ids are mirrored in Rust
 * (`drums/state.rs` PRESET_IDS) for validation + the LLM tool docs — keep
 * both lists in sync (a test there checks the count). */

import {
  DEFAULT_MIX,
  type DrumVoice,
  type DrumsState,
  type Meter,
  normalizeState,
  parseSteps,
} from './model';

export type DrumPreset = {
  id: string;
  /** Variation name inside its genre, e.g. "Driving 8ths". */
  name: string;
  meter: Meter;
  bpm: number;
  swing?: number;
  steps: Partial<Record<DrumVoice, string>>;
};

export type DrumGenre = { id: string; name: string; variants: DrumPreset[] };

/* Variation 1 of every genre keeps the genre's bare id (`rock`, `funk`, …)
 * so persisted state and older assistant calls keep resolving. */
export const GENRES: DrumGenre[] = [
  {
    id: 'rock',
    name: 'Rock',
    variants: [
      { id: 'rock', name: 'Basic', meter: '4/4', bpm: 100, steps: {
        kick: 'X.....x.X.......', snare: '....X.......X...', chh: 'X.x.X.x.X.x.X.x.' } },
      { id: 'rock-2', name: 'Driving 8ths', meter: '4/4', bpm: 128, steps: {
        kick: 'X.x...x.X.x...x.', snare: '....X.......X...', chh: 'X.X.X.X.X.X.X.X.', crash: 'X...............' } },
      { id: 'rock-3', name: 'Open hats', meter: '4/4', bpm: 112, steps: {
        kick: 'X.....x.X.....x.', snare: '....X.......X...', ohh: 'X.x.X.x.X.x.X.x.', crash: 'X...............' } },
      { id: 'rock-4', name: 'Four on the floor', meter: '4/4', bpm: 120, steps: {
        kick: 'X...X...X...X...', snare: '....X.......X...', chh: 'x.x.x.x.x.x.x...', ohh: '..............x.' } },
    ],
  },
  {
    id: 'pop',
    name: 'Pop',
    variants: [
      { id: 'pop', name: 'Radio', meter: '4/4', bpm: 110, steps: {
        kick: 'X.....x...x.....', snare: '....X.......X...', clap: '....x.......x...', chh: 'XxxxXxxxXxxxXxxx' } },
      { id: 'pop-2', name: 'Ballad', meter: '4/4', bpm: 72, steps: {
        kick: 'X.......x.x.....', snare: '....X.......X...', chh: 'x.x.x.x.x.x.x.x.' } },
      { id: 'pop-3', name: 'Dance-pop', meter: '4/4', bpm: 122, steps: {
        kick: 'X...X...X...X...', clap: '....X.......X...', chh: 'x...x...x...x...', ohh: '..x...x...x...x.' } },
    ],
  },
  {
    id: 'funk',
    name: 'Funk',
    variants: [
      { id: 'funk', name: 'Classic', meter: '4/4', bpm: 98, steps: {
        kick: 'X..x..x...X..x..', snare: '....X..x.x..X...', chh: 'XxxxXxxxXxxxXx.x', ohh: '..............x.' } },
      { id: 'funk-2', name: 'Ghost notes', meter: '4/4', bpm: 94, steps: {
        kick: 'X.x....x..X.....', snare: '..x.X..x.x.xX..x', chh: 'XxxxXxxxXxxxXxxx' } },
      { id: 'funk-3', name: 'Linear', meter: '4/4', bpm: 100, steps: {
        kick: 'X.....X...X.....', snare: '....X.....x.X...', chh: '.xx.x..x.x.x.x.x' } },
    ],
  },
  {
    id: 'disco',
    name: 'Disco / House',
    variants: [
      { id: 'disco', name: 'Disco', meter: '4/4', bpm: 118, steps: {
        kick: 'X...X...X...X...', clap: '....X.......X...', chh: 'x...x...x...x...', ohh: '..x...x...x...x.' } },
      { id: 'disco-2', name: 'Nu-disco', meter: '4/4', bpm: 120, steps: {
        kick: 'X...X...X...X...', clap: '....X.......X...', chh: 'xx.xxx.xxx.xxx.x', ohh: '..x...x...x...x.' } },
      { id: 'disco-3', name: 'House', meter: '4/4', bpm: 124, steps: {
        kick: 'X...X...X...X...', clap: '....X.......X...', ohh: '..X...X...X...X.', rim: '...x..x....x..x.' } },
    ],
  },
  {
    id: 'shuffle',
    name: 'Blues / Shuffle',
    variants: [
      { id: 'shuffle', name: 'Shuffle', meter: '12/8', bpm: 90, steps: {
        kick: 'X.....X.x...', snare: '...X.....X..', chh: 'X.xX.xX.xX.x' } },
      { id: 'shuffle-2', name: 'Slow blues', meter: '12/8', bpm: 60, steps: {
        kick: 'X.....x.....', snare: '...X.....X..', chh: 'XxxXxxXxxXxx' } },
      { id: 'shuffle-3', name: 'Texas shuffle', meter: '12/8', bpm: 120, steps: {
        kick: 'X..X..X..X..', snare: '...X.....X..', chh: 'X.xX.xX.xX.x' } },
      { id: 'jazz', name: 'Jazz swing', meter: '12/8', bpm: 140, steps: {
        kick: 'x.....x.....', chh: 'X..X.xX..X.x', rim: '...x.....x..' } },
    ],
  },
  {
    id: 'halftime',
    name: 'Half-time / Trap',
    variants: [
      { id: 'halftime', name: 'Half-time', meter: '4/4', bpm: 140, steps: {
        kick: 'X.......x.x.....', snare: '........X.......', chh: 'X.x.x.x.X.x.x.x.' } },
      { id: 'halftime-2', name: 'Trap', meter: '4/4', bpm: 140, steps: {
        kick: 'X......x..x.....', clap: '........X.......', chh: 'x.x.x.x.x.x.xxxx' } },
      { id: 'halftime-3', name: 'Half-time groove', meter: '4/4', bpm: 150, steps: {
        kick: 'X.x.......x..x..', snare: '........X.......', chh: 'x.x.x.x.x.x.x.x.', ohh: '......x.........' } },
    ],
  },
  {
    id: 'metal',
    name: 'Metal',
    variants: [
      { id: 'metal', name: 'Double kick', meter: '4/4', bpm: 160, steps: {
        kick: 'XxxxXxxxXxxxXxxx', snare: '....X.......X...', chh: 'x.x.x.x.x.x.x.x.', crash: 'X...............' } },
      { id: 'metal-2', name: 'Gallop', meter: '4/4', bpm: 150, steps: {
        kick: 'X.xxX.xxX.xxX.xx', snare: '....X.......X...', crash: 'X...X...X...X...' } },
      { id: 'metal-3', name: 'Thrash skank', meter: '4/4', bpm: 200, steps: {
        kick: 'X...X...X...X...', snare: '..X...X...X...X.', crash: 'X...X...X...X...' } },
      { id: 'metal-4', name: 'Blast beat', meter: '4/4', bpm: 180, steps: {
        kick: 'x.x.x.x.x.x.x.x.', snare: '.x.x.x.x.x.x.x.x', crash: 'X...X...X...X...' } },
    ],
  },
  {
    id: 'punk',
    name: 'Punk',
    variants: [
      { id: 'punk', name: 'Straight 8ths', meter: '4/4', bpm: 180, steps: {
        kick: 'X.X...X.X.X...X.', snare: '....X.......X...', chh: 'X.X.X.X.X.X.X.X.' } },
      { id: 'punk-2', name: 'Skate punk', meter: '4/4', bpm: 200, steps: {
        kick: 'X...X...X...X...', snare: '..X...X...X...X.', ohh: 'x.x.x.x.x.x.x.x.' } },
    ],
  },
  {
    id: 'reggae',
    name: 'Reggae',
    variants: [
      { id: 'reggae', name: 'One drop', meter: '4/4', bpm: 75, steps: {
        kick: '........X.......', rim: '........X.......', chh: 'x.X.x.X.x.X.x.X.' } },
      { id: 'reggae-2', name: 'Steppers', meter: '4/4', bpm: 80, steps: {
        kick: 'X...X...X...X...', rim: '........X.......', chh: 'x.x.x.x.x.x.x.x.' } },
      { id: 'reggae-3', name: 'Rockers', meter: '4/4', bpm: 78, steps: {
        kick: 'X.......X.......', snare: '....X.......X...', chh: 'x.X.x.X.x.X.x.X.' } },
    ],
  },
  {
    id: 'bossa',
    name: 'Latin',
    variants: [
      { id: 'bossa', name: 'Bossa nova', meter: '4/4', bpm: 130, steps: {
        kick: 'X..xX..xX..xX..x', rim: 'X..X..X...X..X..', chh: 'xxxxxxxxxxxxxxxx' } },
      { id: 'bossa-2', name: 'Samba', meter: '4/4', bpm: 100, steps: {
        kick: 'x..Xx..Xx..Xx..X', rim: '..X..X.X..X..X..', chh: 'xxxxxxxxxxxxxxxx' } },
      { id: 'bossa-3', name: 'Cha-cha', meter: '4/4', bpm: 120, steps: {
        kick: 'X.......X.......', rim: '....X.....x.X...', chh: 'X.X.X.X.X.X.X.X.', tom: '............x.x.' } },
    ],
  },
  {
    id: 'hiphop',
    name: 'Hip-hop',
    variants: [
      { id: 'hiphop', name: 'Classic', meter: '4/4', bpm: 90, swing: 0.25, steps: {
        kick: 'X......x.xX.....', snare: '....X.......X...', chh: 'x.x.x.x.x.x.x.x.' } },
      { id: 'hiphop-2', name: 'Boom bap', meter: '4/4', bpm: 92, swing: 0.3, steps: {
        kick: 'X.....x...x.....', snare: '....X.......X...', chh: 'x.x.x.x.x.x.x.x.' } },
      { id: 'hiphop-3', name: 'Lo-fi', meter: '4/4', bpm: 80, swing: 0.4, steps: {
        kick: 'X......x..x.....', rim: '....X.......X...', chh: 'x.x.x.x.x.x.x.x.' } },
    ],
  },
  {
    id: 'waltz',
    name: 'Waltz / 6/8',
    variants: [
      { id: 'waltz', name: 'Waltz', meter: '3/4', bpm: 120, steps: {
        kick: 'X...........', snare: '....x...x...', chh: 'X.x.x.x.x.x.' } },
      { id: 'waltz-2', name: 'Jazz waltz', meter: '3/4', bpm: 140, steps: {
        kick: 'X...........', chh: 'X...x.xx....', rim: '....x...x...' } },
      { id: 'ballad68', name: '6/8 ballad', meter: '6/8', bpm: 60, steps: {
        kick: 'X.......x...', snare: '......X.....', chh: 'X.x.x.x.x.x.' } },
      { id: 'ballad68-2', name: '6/8 rock', meter: '6/8', bpm: 70, steps: {
        kick: 'X.....X.x...', snare: '......X.....', chh: 'X.x.x.X.x.x.', crash: 'X...........' } },
    ],
  },
];

/** Flat list of every variation (lookup, Rust mirror, assistant docs). */
export const PRESETS: DrumPreset[] = GENRES.flatMap((g) => g.variants);

/** Genre owning preset `id`. */
export const genreOf = (id: string | null): DrumGenre | undefined =>
  GENRES.find((g) => g.variants.some((v) => v.id === id));

export const findPreset = (id: string | null): DrumPreset | undefined =>
  PRESETS.find((p) => p.id === id);

/** Load a preset into `current`, keeping the mixer, master volume and
 *  export settings. Presets are 1-bar grooves; a 2-bar pattern gets the
 *  groove tiled into both bars. */
export const applyPreset = (current: DrumsState, preset: DrumPreset): DrumsState =>
  normalizeState(
    {
      ...current,
      bpm: preset.bpm,
      meter: preset.meter,
      swing: preset.swing ?? 0,
      preset_id: preset.id,
      steps: Object.fromEntries(
        Object.entries(preset.steps).map(([v, s]) => [v, parseSteps(s)]),
      ) as DrumsState['steps'],
    },
    // Voices the preset doesn't mention fall back to silence.
    { ...current, steps: emptySteps() },
  );

const emptySteps = (): DrumsState['steps'] =>
  ({ kick: [], snare: [], chh: [], ohh: [], clap: [], tom: [], rim: [], crash: [] });

const ROCK = GENRES[0].variants[0];
export const DEFAULT_STATE: DrumsState = applyPreset(
  {
    kit: 'acoustic',
    bpm: ROCK.bpm,
    meter: '4/4',
    bars: 1,
    swing: 0,
    steps: emptySteps(),
    mix: DEFAULT_MIX,
    master_volume: 0.8,
    preset_id: null,
    export_bars: 4,
    export_format: 'wav',
  },
  ROCK,
);
