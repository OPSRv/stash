/* Конфіг блоків ефектів + статичні списки моделей (для пікерів іконок).
   Дані витягнуто з index.html. Індекс = позиція в blocksLIST. */
import type { BlockKey } from '../store/types';

export interface ModelOption {
  value: number;
  text: string;
  title?: string;
}

export interface BlockConfig {
  index: number;
  key: BlockKey;
  label: string; // підпис перемикача (NR, PRE, …, N>S)
  hasPicker: boolean; // показувати пікер моделей
  dynamic: boolean; // список моделей наповнюється з пристрою (cab IR, ns)
  defaultIcon: boolean; // без per-model арту → дефолтна іконка блока
  grid: boolean; // широка сітка пікера (amp, cab)
  draggable: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  models: ModelOption[]; // статичні моделі
}

const preModels: ModelOption[] = [
  { value: 0, text: 'COMP', title: 'Based on Ross Compressor' },
  { value: 1, text: 'COMP4', title: 'Based on Keeley C4 4knob compressor' },
  { value: 2, text: 'Boost', title: 'Based on Xotic EP Booster pedal' },
  { value: 3, text: 'Micro Boost', title: 'Based on MXR M133 Micro Amp pedal' },
  { value: 4, text: 'B-Boost', title: 'Based on Xotic BB Preamp pedal' },
  {
    value: 5,
    text: 'Toucher',
    title: 'Control the wah sound by playing intensity',
  },
  { value: 6, text: 'Crier', title: 'Auto wah effect' },
  { value: 7, text: 'OCTA', title: 'Polyphonic octave effect' },
  { value: 8, text: 'Pitch', title: 'Polyphonic pitch shifter/harmonizer' },
  { value: 9, text: 'Detune', title: 'A detuning effect' },
];

const dstModels: ModelOption[] = [
  { value: 0, text: 'Green OD', title: 'Based on Ibanez TS-808 Tube Screamer' },
  {
    value: 1,
    text: 'Yellow OD',
    title: 'Based on a classic yellow 2 knob overdrive pedal',
  },
  {
    value: 2,
    text: 'Super OD',
    title: 'Based on a classic yellow 3 knob overdrive pedal',
  },
  {
    value: 3,
    text: 'SM Dist',
    title: 'Based on a classic orange three-knob distortion pedal',
  },
  {
    value: 4,
    text: 'Plustortion',
    title: 'Based on MXR M104 Distortion + distortion pedal',
  },
  {
    value: 5,
    text: 'La Charger',
    title: 'Based on MI Audio Crunch Box distortion pedal',
  },
  {
    value: 6,
    text: 'Darktale',
    title: 'Based on ProCo The Rat distortion pedal',
  },
  {
    value: 7,
    text: 'Sora Fuzz',
    title: 'Based on Sola Sound Tone Bender fuzz pedal',
  },
  {
    value: 8,
    text: 'Red Haze',
    title: 'Based on Dallas Arbiter Fuzz Face fuzz pedal',
  },
  { value: 9, text: 'Bass OD', title: 'An bass overdrive effect' },
];

const ampNames = [
  'Tweedy',
  'Bellman 59N',
  'Dark Twin',
  'Foxy 30N',
  'J-120 CL',
  'Match CL',
  'L-Star CL',
  'UK 45',
  'UK 50JP',
  'UK 800',
  'Bellman 59B',
  'Foxy 30TB',
  'SUPDual OD',
  'Solo100 OD',
  'Z38 OD',
  'Bad-KT OD',
  'Juice R100',
  'Dizz VH',
  'Dizz VH+',
  'Eagle 120',
  'EV 51',
  'Solo100 LD',
  'Mess DualV',
  'Mess DualM',
  'Power LD',
  'Flagman+',
  'Bog RedV',
  'Classic Bass',
  'Foxy Bass',
  'Mess Bass',
  'AC Pre1',
  'AC Pre2',
];

const cabNames = [
  'TWD CP 1x8',
  'Dark VIT  1x12',
  'Foxy 1x12',
  'L-Star 1x12',
  'Dark CS 2x12',
  'Dark Twin 2x12',
  'SUP Star 2x12',
  'J-120 2x12',
  'Foxy 2x12',
  'UK GRN 2x12',
  'UK GRN 4x12',
  'Bog 4x12',
  'Dizz 4x12',
  'EV 4x12',
  'Solo 4x12',
  'Mess 4x12',
  'Eagle 4x12',
  'Juice 4x12',
  'Bellman 2x12',
  'AMPG 4x10',
];

const eqNames = [
  'Guitar EQ 1',
  'Guitar EQ 2',
  'Bass EQ 1',
  'Bass EQ 2',
  'Mess EQ',
];

const modNames = [
  'A-Chorus',
  'B-Chorus',
  'Jet',
  'N-Jet',
  'O-Phase',
  'M-Vibe',
  'V-Roto',
  'Vibrato',
  'O-Trem',
  'Sine Trem',
  'Bias Trem',
];

const dlyNames = [
  'Pure',
  'Analog',
  'Slapback',
  'Sweet Echo',
  'Tape',
  'Tube',
  'Rev Echo',
  'Ring Echo',
  'Sweep Echo',
  'Ping Pong',
];

const rvbNames = [
  'Air',
  'Room',
  'Hall',
  'Church',
  'Plate L',
  'Plate',
  'Spring',
  'N-Star',
  'Deepsea',
  'Sweet Space',
];

const named = (names: string[]): ModelOption[] =>
  names.map((text, value) => ({ value, text }));

export const BLOCKS: BlockConfig[] = [
  {
    index: 0,
    key: 'nr',
    label: 'NR',
    hasPicker: false,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: true,
    dropBefore: true,
    dropAfter: true,
    models: [
      {
        value: 0,
        text: 'GATE',
        title: 'Based on ISP Decimator noise gate pedal.',
      },
    ],
  },
  {
    index: 1,
    key: 'pre',
    label: 'PRE',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: true,
    dropBefore: true,
    dropAfter: true,
    models: preModels,
  },
  {
    index: 2,
    key: 'dst',
    label: 'DST',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: false,
    dropBefore: true,
    dropAfter: false,
    models: dstModels,
  },
  {
    index: 3,
    key: 'amp',
    label: 'AMP',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: true,
    draggable: false,
    dropBefore: false,
    dropAfter: false,
    models: named(ampNames),
  },
  {
    index: 4,
    key: 'cab',
    label: 'CAB',
    hasPicker: true,
    dynamic: true,
    defaultIcon: false,
    grid: true,
    draggable: false,
    dropBefore: false,
    dropAfter: false,
    models: named(cabNames),
  },
  {
    index: 5,
    key: 'eq',
    label: 'EQ',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: false,
    dropBefore: false,
    dropAfter: true,
    models: named(eqNames),
  },
  {
    index: 6,
    key: 'mod',
    label: 'MOD',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: true,
    dropBefore: true,
    dropAfter: true,
    models: named(modNames),
  },
  {
    index: 7,
    key: 'dly',
    label: 'DLY',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: true,
    dropBefore: true,
    dropAfter: true,
    models: named(dlyNames),
  },
  {
    index: 8,
    key: 'rvb',
    label: 'RVB',
    hasPicker: true,
    dynamic: false,
    defaultIcon: false,
    grid: false,
    draggable: true,
    dropBefore: true,
    dropAfter: true,
    models: named(rvbNames),
  },
  {
    index: 9,
    key: 'ns',
    label: 'N>S',
    hasPicker: true,
    dynamic: true,
    defaultIcon: true,
    grid: false,
    draggable: false,
    dropBefore: false,
    dropAfter: false,
    models: [],
  },
];

export const BLOCK_BY_KEY: Record<BlockKey, BlockConfig> = Object.fromEntries(
  BLOCKS.map((b) => [b.key, b]),
) as Record<BlockKey, BlockConfig>;

/** Повний список моделей блока з урахуванням динамічних (cab IR, ns) із стану. */
export function modelsFor(
  block: BlockConfig,
  cabModels: string[],
  nsModels: string[],
): ModelOption[] {
  if (block.key === 'cab') {
    return [
      ...block.models,
      ...cabModels.map((text, i) => ({ value: 20 + i, text })),
    ];
  }
  if (block.key === 'ns') {
    return nsModels.map((text, value) => ({ value, text }));
  }
  return block.models;
}

/* Усі SVG моделей/блоків зібрані у бандл через Vite glob (eager → лише URL-и,
   не інлайняться). Ключ — шлях відносно lib/, значення — фінальний asset-URL.
   Замінює рантайм-фетч `img/...` із vanilla-версії. */
const ICON_URLS = import.meta.glob('../img/**/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const asset = (rel: string): string => ICON_URLS[`../img/${rel}`] ?? '';

/** Дефолтна іконка блока (fallback, коли немає per-model арту). */
export function fallbackIcon(key: string): string {
  return asset(`${key}.svg`);
}

/** URL іконки моделі (порт iconpicker.iconSrc) — резолвиться через бандл. */
export function iconSrc(block: BlockConfig, value: number): string {
  const rel = block.defaultIcon
    ? `${block.key}.svg`
    : `blocks/${block.key}/${value}.svg`;
  return asset(rel) || fallbackIcon(block.key);
}
