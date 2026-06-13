/* Імпорт пресета з JSON (формат, який повертає LLM — див.
   docs/valeton-preset-prompt.md). Тут лише розбір + валідація у проміжну
   структуру `ParsedPreset`; застосування на стан/пристрій — у actions.importPreset.

   Параметри задаються за людським підписом ('Gain', 'VOL', 'Time (ms)' …),
   а не позицією — підпис стабільний між моделями, а індекс у масиві патча
   включає приховані слоти. Резолвимо підпис → індекс через paramDefs(). */
import { BLOCK_BY_KEY } from './blocks';
import { effectsLIST } from './constants';
import { paramDefs } from './protocol';
import type { AppState, BlockKey } from '../store/types';
import { cleanName, roundToStep } from './utils';

export interface ParsedBlock {
  key: BlockKey;
  index: number;
  on: boolean;
  model: number;
  /** Повний масив параметрів моделі (включно з прихованими — дефолти). */
  params: number[];
  ctl?: boolean;
}

export interface ParsedPreset {
  name?: string;
  /** Коротка примітка від моделі (наближення, обрана найближча модель тощо). */
  note?: string;
  /** Впевненість моделі у відповідності 0..1 (для іменованих тонів). */
  confidence?: number;
  blocks: ParsedBlock[];
  order?: number[];
  patchVOL?: number;
  bpm?: number;
  /** Підписи параметрів, яких немає в обраній моделі (проігноровані). */
  warnings: string[];
}

const BLOCK_KEYS: BlockKey[] = [
  'nr',
  'pre',
  'dst',
  'amp',
  'cab',
  'eq',
  'mod',
  'dly',
  'rvb',
  'ns',
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Витягти JSON-обʼєкт із відповіді моделі: знімає ```json-огорожу, якщо є,
    інакше бере підрядок від першої `{` до останньої `}`. Повертає вхід без
    змін, коли нічого не знайдено (хай parsePreset видасть зрозумілу помилку). */
export function extractJsonObject(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

export type ParseResult =
  | { ok: true; preset: ParsedPreset }
  | { ok: false; error: string };

export function parsePreset(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!isObj(raw)) return { ok: false, error: 'Top-level value must be an object.' };

  const blocksIn = raw.blocks;
  if (!isObj(blocksIn))
    return { ok: false, error: 'Missing "blocks" object.' };

  const warnings: string[] = [];
  const blocks: ParsedBlock[] = [];

  for (const key of BLOCK_KEYS) {
    const b = blocksIn[key];
    if (b === undefined) continue; // блок не згаданий — лишаємо як є
    if (!isObj(b)) return { ok: false, error: `Block "${key}" must be an object.` };

    const { index } = BLOCK_BY_KEY[key];
    const modelCount = Object.keys(effectsLIST[index]).length;

    let model = 0;
    if (b.model !== undefined) {
      if (typeof b.model !== 'number' || !Number.isInteger(b.model))
        return { ok: false, error: `Block "${key}": "model" must be an integer.` };
      if (b.model < 0 || b.model >= modelCount)
        return {
          ok: false,
          error: `Block "${key}": model ${b.model} out of range (0..${modelCount - 1}).`,
        };
      model = b.model;
    }

    const defs = paramDefs(index, model);
    const params = defs.map((d) => d[2]); // дефолти моделі

    const pIn = b.params;
    if (pIn !== undefined) {
      if (!isObj(pIn))
        return { ok: false, error: `Block "${key}": "params" must be an object of label→value.` };
      for (const [label, value] of Object.entries(pIn)) {
        if (typeof value !== 'number') continue;
        const pi = defs.findIndex((d) => d[1] === label);
        if (pi < 0) {
          warnings.push(`${key}: unknown param "${label}" ignored`);
          continue;
        }
        params[pi] = roundToStep(clamp(value, defs[pi][3], defs[pi][4]), defs[pi][5]);
      }
    }

    blocks.push({
      key,
      index,
      on: b.on === undefined ? true : Boolean(b.on),
      model,
      params,
      ctl: b.ctl === undefined ? undefined : Boolean(b.ctl),
    });
  }

  if (!blocks.length)
    return { ok: false, error: 'No recognised blocks in "blocks".' };

  const preset: ParsedPreset = { blocks, warnings };

  if (typeof raw.name === 'string') preset.name = cleanName(raw.name);
  if (typeof raw.note === 'string' && raw.note.trim())
    preset.note = raw.note.trim().slice(0, 200);
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence))
    preset.confidence = clamp(raw.confidence, 0, 1);

  if (raw.order !== undefined) {
    const o = raw.order;
    const valid =
      Array.isArray(o) &&
      o.length === 10 &&
      [...o].sort((a, b) => a - b).every((v, i) => v === i);
    if (!valid)
      return { ok: false, error: '"order" must be a permutation of 0..9 (10 items).' };
    preset.order = o as number[];
  }

  if (typeof raw.patchVOL === 'number')
    preset.patchVOL = Math.round(clamp(raw.patchVOL, 0, 100));
  if (typeof raw.bpm === 'number')
    preset.bpm = Math.round(clamp(raw.bpm, 40, 240));

  return { ok: true, preset };
}

/** Серіалізувати поточний live-стан патча у той самий JSON-формат, який читає
    `parsePreset` — повний round-trip і дзеркало `importPreset` у зворотний бік.
    Для кожного блока виводимо лише видимі (підписані) параметри обраної моделі;
    приховані слоти `parsePreset` відновить із дефолтів. `ctl` пишемо лише коли
    увімкнено (як у генераторі). Зручно як стартова точка для ручних правок або
    щоб скопіювати поточний тон. */
export function serializePreset(s: AppState): string {
  const blocks: Record<string, Record<string, unknown>> = {};

  for (const key of BLOCK_KEYS) {
    const { index } = BLOCK_BY_KEY[key];
    const model = s.selected[index] ?? 0;
    const values = s.params[index] ?? [];

    const params: Record<string, number> = {};
    paramDefs(index, model).forEach(([show, label, , , , step], pi) => {
      if (!show || !label) return; // приховані слоти мають порожній підпис
      const v = values[pi];
      if (typeof v === 'number') params[label] = roundToStep(v, step);
    });

    const block: Record<string, unknown> = {
      on: Boolean(s.enabled[index]),
      model,
    };
    if (Object.keys(params).length) block.params = params;
    if (s.ctl[index]) block.ctl = true;
    blocks[key] = block;
  }

  const name = cleanName(s.patchNames[s.currentPatchNumber] ?? '').trim();
  const preset: Record<string, unknown> = {};
  if (name) preset.name = name;
  preset.patchVOL = s.patchVOL;
  preset.bpm = s.bpm;
  preset.order = s.order;
  preset.blocks = blocks;

  return JSON.stringify(preset, null, 2);
}
