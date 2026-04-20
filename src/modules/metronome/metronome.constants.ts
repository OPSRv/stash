export const BPM_MIN = 40;
export const BPM_MAX = 240;

export const NUMERATOR_MIN = 1;
export const NUMERATOR_MAX = 16;
export const DENOMINATORS = [2, 4, 8] as const;
export type Denominator = (typeof DENOMINATORS)[number];

export type SoundId = 'click' | 'wood' | 'beep';

export type SoundPreset = {
  id: SoundId;
  label: string;
  /** Base oscillator frequency for non-accent beats. */
  baseHz: number;
  /** Higher frequency used on accented beats. */
  accentHz: number;
  /** Oscillator type. */
  type: OscillatorType;
  /** Decay envelope length in seconds. */
  decay: number;
};

export const SOUND_PRESETS: readonly SoundPreset[] = [
  { id: 'click', label: 'Click', baseHz: 1000, accentHz: 1500, type: 'sine', decay: 0.1 },
  { id: 'wood', label: 'Wood', baseHz: 600, accentHz: 900, type: 'triangle', decay: 0.12 },
  { id: 'beep', label: 'Beep', baseHz: 800, accentHz: 1200, type: 'square', decay: 0.08 },
];

export type TimeSignature = { numerator: number; denominator: number };

/** Common signatures offered as quick-picks. The numerator stepper can reach
 *  anything from 1..16, but these cover the 95% case. */
export const TIME_SIGNATURES: readonly TimeSignature[] = [
  { numerator: 2, denominator: 4 },
  { numerator: 3, denominator: 4 },
  { numerator: 4, denominator: 4 },
  { numerator: 5, denominator: 4 },
  { numerator: 6, denominator: 8 },
  { numerator: 7, denominator: 8 },
  { numerator: 9, denominator: 8 },
];

export const SUBDIVISIONS: readonly { value: 1 | 2 | 3 | 4; label: string; title: string }[] = [
  { value: 1, label: '♩', title: 'Quarter' },
  { value: 2, label: '♪♪', title: 'Eighths' },
  { value: 3, label: '♪♪♪', title: 'Triplets' },
  { value: 4, label: '♬♬', title: 'Sixteenths' },
];

/** Italian tempo names — used as a small subtitle under the BPM. */
export const tempoName = (bpm: number): string => {
  if (bpm < 60) return 'Largo';
  if (bpm < 76) return 'Adagio';
  if (bpm < 108) return 'Andante';
  if (bpm < 120) return 'Moderato';
  if (bpm < 168) return 'Allegro';
  if (bpm < 200) return 'Vivace';
  return 'Presto';
};

export type TrainerConfig = {
  enabled: boolean;
  /** BPM added per step. */
  step_bpm: number;
  /** How many bars between steps. */
  every_bars: number;
  /** Stop auto-increasing at this BPM. */
  target_bpm: number;
};

export const DEFAULT_TRAINER: TrainerConfig = {
  enabled: false,
  step_bpm: 4,
  every_bars: 4,
  target_bpm: 160,
};

export const TRAINER_STEP_MIN = 1;
export const TRAINER_STEP_MAX = 50;
export const TRAINER_BARS_MIN = 1;
export const TRAINER_BARS_MAX = 64;

export type Preset = {
  id: string;
  name: string;
  bpm: number;
  numerator: number;
  denominator: number;
  subdivision: 1 | 2 | 3 | 4;
  sound: SoundId;
  beat_accents: boolean[];
};

export const DEFAULT_STATE = {
  bpm: 100,
  numerator: 4,
  denominator: 4,
  subdivision: 1 as 1 | 2 | 3 | 4,
  sound: 'click' as SoundId,
  click_volume: 0.7,
  accent_volume: 0.9,
  track_volume: 0.8,
  beat_accents: [true, false, false, false] as boolean[],
  trainer: DEFAULT_TRAINER,
  presets: [] as Preset[],
};

export type MetronomeState = typeof DEFAULT_STATE;
