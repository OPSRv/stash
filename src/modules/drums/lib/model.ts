/* Drum-machine data model. Mirrors Rust `DrumsState`
 * (`src-tauri/src/modules/drums/state.rs`) field-for-field — snake_case on
 * the wire. Pure helpers only: no React, no Web Audio. */

export const VOICES = ['kick', 'snare', 'chh', 'ohh', 'clap', 'tom', 'rim', 'crash'] as const;
export type DrumVoice = (typeof VOICES)[number];

export const VOICE_LABELS: Record<DrumVoice, string> = {
  kick: 'Kick',
  snare: 'Snare',
  chh: 'Hat',
  ohh: 'Open hat',
  clap: 'Clap',
  tom: 'Tom',
  rim: 'Rim',
  crash: 'Crash',
};

/** 0 = off, 1 = hit, 2 = accent. */
export type Step = 0 | 1 | 2;

export const METERS = ['4/4', '3/4', '6/8', '12/8'] as const;
export type Meter = (typeof METERS)[number];

/** Grid geometry per meter. `stepsPerBeat` is how many grid steps one
 *  counted beat (the unit BPM refers to) spans: a 16th grid for x/4, the
 *  16ths of a dotted quarter for 6/8, a triplet-8th grid for 12/8. */
export const METER_GRID: Record<Meter, { stepsPerBar: number; stepsPerBeat: number }> = {
  '4/4': { stepsPerBar: 16, stepsPerBeat: 4 },
  '3/4': { stepsPerBar: 12, stepsPerBeat: 4 },
  '6/8': { stepsPerBar: 12, stepsPerBeat: 6 },
  '12/8': { stepsPerBar: 12, stepsPerBeat: 3 },
};

/** Sound source: two recorded acoustic kits (samples, see lib/samples.ts)
 *  or the synthesized analog drum machine (lib/voices.ts). */
export const KITS = ['acoustic', 'rock', 'electronic'] as const;
export type DrumKit = (typeof KITS)[number];
export const KIT_LABELS: Record<DrumKit, string> = {
  acoustic: 'Acoustic',
  rock: 'Rock kit',
  electronic: 'Electronic',
};

export const BPM_MIN = 40;
export const BPM_MAX = 240;
export const SWING_MAX = 0.6;
export const EXPORT_BARS = [1, 2, 4, 8, 16] as const;
export type ExportFormat = 'wav' | 'mp3';

export type VoiceMix = { volume: number; muted: boolean };

export type DrumsState = {
  kit: DrumKit;
  bpm: number;
  meter: Meter;
  bars: 1 | 2;
  /** 0..SWING_MAX — fraction of a step the off-16th is delayed by. */
  swing: number;
  steps: Record<DrumVoice, Step[]>;
  mix: Record<DrumVoice, VoiceMix>;
  master_volume: number;
  /** Preset the pattern came from; null once edited by hand. */
  preset_id: string | null;
  export_bars: number;
  export_format: ExportFormat;
};

export const patternLength = (s: Pick<DrumsState, 'meter' | 'bars'>): number =>
  METER_GRID[s.meter].stepsPerBar * s.bars;

/** Seconds per grid step. */
export const stepDuration = (bpm: number, meter: Meter): number =>
  60 / bpm / METER_GRID[meter].stepsPerBeat;

/** Offset of step `i` inside its loop, in seconds, with swing applied to
 *  every odd step (16th swing). Swing is skipped on triplet grids, where
 *  the feel is already written into the pattern. */
export const stepOffset = (i: number, bpm: number, meter: Meter, swing: number): number => {
  const d = stepDuration(bpm, meter);
  const swung = meter !== '12/8' && i % 2 === 1 ? swing * d : 0;
  return i * d + swung;
};

export const clampBpm = (v: number): number =>
  Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v)));

/** Resize a step row to `len`, tiling a shorter row (so a 1-bar groove
 *  becomes 2 identical bars) and truncating a longer one. */
export const fitRow = (row: Step[], len: number): Step[] => {
  if (row.length === len) return row;
  if (row.length === 0) return new Array<Step>(len).fill(0);
  const out: Step[] = [];
  for (let i = 0; i < len; i++) out.push(row[i % row.length]);
  return out;
};

/** Parse step notation: `x` hit, `X` accent, `.`/`-`/space off. Unknown
 *  characters count as off — the Rust side already validated remote input. */
export const parseSteps = (s: string): Step[] =>
  [...s].map((c) => (c === 'X' ? 2 : c === 'x' ? 1 : 0));

export const formatSteps = (row: Step[]): string =>
  row.map((v) => (v === 2 ? 'X' : v === 1 ? 'x' : '.')).join('');

const emptyRows = (len: number) =>
  Object.fromEntries(VOICES.map((v) => [v, new Array<Step>(len).fill(0)])) as Record<DrumVoice, Step[]>;

export const DEFAULT_MIX: Record<DrumVoice, VoiceMix> = Object.fromEntries(
  VOICES.map((v) => [v, { volume: 0.8, muted: false }]),
) as Record<DrumVoice, VoiceMix>;

/** Bring arbitrary (persisted / remote-patched) state into shape: clamps,
 *  every voice present, every row exactly `patternLength` long. */
export const normalizeState = (s: Partial<DrumsState>, fallback: DrumsState): DrumsState => {
  const meter = (METERS as readonly string[]).includes(s.meter ?? '') ? (s.meter as Meter) : fallback.meter;
  const bars: 1 | 2 = s.bars === 2 ? 2 : s.bars === 1 ? 1 : fallback.bars;
  const len = METER_GRID[meter].stepsPerBar * bars;
  const steps = emptyRows(len);
  const mix = { ...DEFAULT_MIX };
  for (const v of VOICES) {
    const row = (s.steps?.[v] ?? fallback.steps[v] ?? []).map((x) => (x >= 2 ? 2 : x >= 1 ? 1 : 0)) as Step[];
    steps[v] = fitRow(row, len);
    const m = s.mix?.[v] ?? fallback.mix[v] ?? DEFAULT_MIX[v];
    mix[v] = { volume: Math.max(0, Math.min(1, m.volume)), muted: !!m.muted };
  }
  const exportBars = (EXPORT_BARS as readonly number[]).includes(s.export_bars ?? -1)
    ? (s.export_bars as number)
    : fallback.export_bars;
  return {
    kit: (KITS as readonly string[]).includes(s.kit ?? '') ? (s.kit as DrumKit) : fallback.kit,
    bpm: clampBpm(s.bpm ?? fallback.bpm),
    meter,
    bars,
    swing: Math.max(0, Math.min(SWING_MAX, s.swing ?? fallback.swing)),
    steps,
    mix,
    master_volume: Math.max(0, Math.min(1, s.master_volume ?? fallback.master_volume)),
    preset_id: s.preset_id === undefined ? fallback.preset_id : s.preset_id,
    // An export shorter than the pattern would cut the groove in half.
    export_bars: Math.max(exportBars, bars),
    export_format: s.export_format === 'mp3' ? 'mp3' : s.export_format === 'wav' ? 'wav' : fallback.export_format,
  };
};
