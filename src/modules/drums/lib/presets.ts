/* Genre presets in step notation (`x` hit, `X` accent, `.` off). Ids are
 * mirrored in Rust (`drums/agent.rs`) for validation + the LLM tool docs —
 * keep both lists in sync. */

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
  name: string;
  meter: Meter;
  bpm: number;
  swing?: number;
  steps: Partial<Record<DrumVoice, string>>;
};

export const PRESETS: DrumPreset[] = [
  {
    id: 'rock',
    name: 'Rock',
    meter: '4/4',
    bpm: 100,
    steps: {
      kick: 'X.....x.X.......',
      snare: '....X.......X...',
      chh: 'X.x.X.x.X.x.X.x.',
    },
  },
  {
    id: 'pop',
    name: 'Pop',
    meter: '4/4',
    bpm: 110,
    steps: {
      kick: 'X.....x...x.....',
      snare: '....X.......X...',
      clap: '....x.......x...',
      chh: 'XxxxXxxxXxxxXxxx',
    },
  },
  {
    id: 'funk',
    name: 'Funk',
    meter: '4/4',
    bpm: 98,
    steps: {
      kick: 'X..x..x...X..x..',
      snare: '....X..x.x..X...',
      chh: 'XxxxXxxxXxxxXx.x',
      ohh: '..............x.',
    },
  },
  {
    id: 'disco',
    name: 'Disco',
    meter: '4/4',
    bpm: 118,
    steps: {
      kick: 'X...X...X...X...',
      clap: '....X.......X...',
      chh: 'x...x...x...x...',
      ohh: '..x...x...x...x.',
    },
  },
  {
    id: 'shuffle',
    name: 'Shuffle / Blues',
    meter: '12/8',
    bpm: 90,
    steps: {
      kick: 'X.....X.x...',
      snare: '...X.....X..',
      chh: 'X.xx.xX.xx.x',
    },
  },
  {
    id: 'halftime',
    name: 'Half-time',
    meter: '4/4',
    bpm: 140,
    steps: {
      kick: 'X.......x.x.....',
      snare: '........X.......',
      chh: 'X.x.x.x.X.x.x.x.',
    },
  },
  {
    id: 'metal',
    name: 'Metal (double kick)',
    meter: '4/4',
    bpm: 160,
    steps: {
      kick: 'XxxxXxxxXxxxXxxx',
      snare: '....X.......X...',
      chh: 'x.x.x.x.x.x.x.x.',
      crash: 'X...............',
    },
  },
  {
    id: 'reggae',
    name: 'Reggae (one drop)',
    meter: '4/4',
    bpm: 75,
    steps: {
      kick: '........X.......',
      rim: '........X.......',
      chh: 'x.X.x.X.x.X.x.X.',
    },
  },
  {
    id: 'bossa',
    name: 'Bossa nova',
    meter: '4/4',
    bpm: 130,
    steps: {
      kick: 'X..xX..xX..xX..x',
      rim: 'X..X..X...X..X..',
      chh: 'xxxxxxxxxxxxxxxx',
    },
  },
  {
    id: 'hiphop',
    name: 'Hip-hop',
    meter: '4/4',
    bpm: 90,
    swing: 0.25,
    steps: {
      kick: 'X......x.xX.....',
      snare: '....X.......X...',
      chh: 'x.x.x.x.x.x.x.x.',
    },
  },
  {
    id: 'waltz',
    name: 'Waltz',
    meter: '3/4',
    bpm: 120,
    steps: {
      kick: 'X...........',
      snare: '....x...x...',
      chh: 'X.x.x.x.x.x.',
    },
  },
  {
    id: 'ballad68',
    name: '6/8 ballad',
    meter: '6/8',
    bpm: 60,
    steps: {
      kick: 'X.......x...',
      snare: '......X.....',
      chh: 'X.x.x.x.x.x.',
    },
  },
];

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

const ROCK = PRESETS[0];
export const DEFAULT_STATE: DrumsState = applyPreset(
  {
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
