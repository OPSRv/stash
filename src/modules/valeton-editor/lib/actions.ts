/* Високорівневі дії UI (порт обробників подій із app.js).
   Компоненти викликають їх; вони оновлюють стор і шлють команди на пристрій. */
import { getState, setState } from '../store/store';
import type { BlockKey } from '../store/types';
import { BLOCK_BY_KEY } from './blocks';
import {
  paramDefs,
  sendBlockChange,
  sendBlockStatus,
  sendCTL,
  sendEffectOrder,
  sendFootChange,
  sendGlobalChange,
  sendGlobalVol,
  sendParamChange,
  sendPatchSelect,
  sendPatchVol,
  sendSavePatch,
} from './protocol';
import { runtime } from './runtime';
import { sendCommand } from './transport';
import { roundToStep } from './utils';

/* ---------- debounce (порт slider.debounceTimer, 50 мс) ---------- */
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
function debounce(key: string, fn: () => void, ms = 50): void {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

const replace = <T>(arr: T[], i: number, v: T): T[] => {
  const next = arr.slice();
  next[i] = v;
  return next;
};

/* ---------- вибір пресету ---------- */
export function selectPatch(patch: number): void {
  setState({ currentPatchNumber: patch });
  runtime.userChangedPatch = true;
  sendPatchSelect(patch);
}

/* ---------- увімк/вимк блока ---------- */
export function toggleBlock(key: BlockKey, checked: boolean): void {
  const { index } = BLOCK_BY_KEY[key];
  setState((s) => ({ enabled: replace(s.enabled, index, checked) }));
  sendBlockStatus(index, checked ? '1' : '0');
}

/* ---------- зміна моделі ефекту ---------- */
export function changeModel(key: BlockKey, value: number): void {
  const { index } = BLOCK_BY_KEY[key];
  const defs = paramDefs(index, value);
  const params = defs.map((d) => d[2]);
  setState((s) => ({
    selected: replace(s.selected, index, value),
    params: replace(s.params, index, params),
  }));
  sendBlockChange(index, value);
}

/* ---------- зміна параметра ---------- */
export function changeParam(
  key: BlockKey,
  paramIndex: number,
  value: number,
): void {
  const { index } = BLOCK_BY_KEY[key];
  setState((s) => ({
    params: replace(
      s.params,
      index,
      replace(s.params[index], paramIndex, value),
    ),
  }));
  debounce(`param-${index}-${paramIndex}`, () =>
    sendParamChange(index, paramIndex, value),
  );
}

/* ---------- глобальні параметри ---------- */
export function changeGlobal(
  field: 'globalInput' | 'globalCab' | 'globalRec' | 'globalBt' | 'globalMon',
  effect: number,
  flag: number,
  value: number,
): void {
  setState({ [field]: value } as any);
  debounce(`global-${effect}-${flag}`, () =>
    sendGlobalChange(effect, flag, value),
  );
}

export function changeGlobalVol(value: number): void {
  setState({ globalVol: value });
  debounce('global-vol', () => sendGlobalVol(value));
}

export function changePatchVol(value: number): void {
  setState({ patchVOL: value });
  debounce('patch-vol', () => sendPatchVol(value));
}

export function changeFoot(value: number): void {
  setState({ globalFoot: value });
  sendFootChange(value);
}

/* ---------- CTL ---------- */
export function toggleCTL(key: BlockKey, checked: boolean): void {
  const { index } = BLOCK_BY_KEY[key];
  setState((s) => ({ ctl: replace(s.ctl, index, checked) }));
  sendCTL(index, checked ? '1' : '0');
}

/* ---------- порядок ефектів (drag&drop) ---------- */
export function reorderEffects(order: number[]): void {
  setState({ order });
  sendEffectOrder(order);
}

/* ---------- темп ---------- */
function setDly1(dt: number): void {
  setState((s) => ({
    delayTime: dt,
    params: replace(s.params, 7, replace(s.params[7], 1, dt)),
  }));
}

/** Зміна BPM (слайдер/±): delayTime з урахуванням поточного поділу. */
export function setBpm(bpm: number): void {
  const { tapDivision } = getState();
  let dt = Math.round(60000 / bpm);
  if (tapDivision === 'eighth') dt = Math.round(dt / 2);
  if (tapDivision === 'dotted') dt = Math.round((dt * 3) / 4);
  setState({ bpm });
  setDly1(dt);
  debounce('bpm', () => sendParamChange(7, 1, dt));
}

/** Вибір поділу (Qrtr/8th/Dotted) — перерахунок і миттєва відправка. */
export function setDivision(division: 'quarter' | 'eighth' | 'dotted'): void {
  const { bpm } = getState();
  setState({ tapDivision: division });
  let dt = Math.round(60000 / bpm);
  if (division === 'eighth') dt = Math.round(60000 / (2 * bpm));
  if (division === 'dotted') dt = Math.round((60000 * 3) / (4 * bpm));
  sendParamChange(7, 1, dt);
  setDly1(dt);
}

/** Tap-tempo: усереднення інтервалів (порт btn_tap). */
export function tapTempo(): void {
  const now = Date.now();
  runtime.taps.push(now);
  if (runtime.taps.length > 8) runtime.taps.shift();
  if (runtime.taps.length < 2) return;

  const intervals: number[] = [];
  for (let i = 1; i < runtime.taps.length; i++) {
    intervals.push(runtime.taps[i] - runtime.taps[i - 1]);
  }
  let avg = intervals.reduce((a, b) => a + b) / intervals.length;
  if (avg > 1000) avg = 1000;
  if (avg < 20) avg = 20;

  const { tapDivision } = getState();
  let dt = Math.round(avg);
  if (tapDivision === 'eighth') dt = Math.round(dt / 2);
  if (tapDivision === 'dotted') dt = Math.round((dt * 3) / 4);

  sendParamChange(7, 1, dt);
  setState({ bpm: Math.round(60000 / avg) });
  setDly1(dt);
}

export function toggleGlobalBPM(checked: boolean): void {
  setState({ globalBPMOn: checked });
}

/* ---------- збереження ---------- */
export function savePatchToDevice(): void {
  if (
    confirm(
      'The patch has been modified, do you want to save your changes? This will overwrite the current patch.',
    )
  ) {
    sendSavePatch();
    setState({ saveEnabled: false });
  }
}

export function saveFile(kind: 'gp5' | 'gp50'): void {
  if (kind === 'gp5') runtime.saveGp5 = true;
  else runtime.saveGp50 = true;
  sendCommand('000900010000000201020401');
}

/** Допоміжне: округлене значення параметра для відображення слайдера. */
export function displayParam(value: number, step: number): number {
  return roundToStep(value, step);
}
