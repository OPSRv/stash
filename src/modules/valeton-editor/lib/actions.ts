/* Високорівневі дії UI (порт обробників подій із app.js).
   Компоненти викликають їх; вони оновлюють стор і шлють команди на пристрій. */
import { setPopupAutoHide } from '../api';
import { getState, setState } from '../store/store';
import type { BlockKey } from '../store/types';
import { BLOCK_BY_KEY } from './blocks';
import type { ParsedPreset } from './presetIO';
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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

/* ---------- імпорт пресета (JSON → live-стан + пристрій) ---------- */
/** Застосовує розібраний пресет на поточний патч: оновлює стор і шле всі
    команди на пристрій. Повертає false (синхронно) якщо офлайн, інакше
    Promise, що завершується коли вся пачка відправлена.

    Чому розріджено (а не пачкою): зміна моделі (`sendBlockChange`) на пристрої
    АСИНХРОННО скидає параметри блока в дефолти. Якщо одразу слати param-значення,
    скид прилітає пізніше і затирає їх → у збереженому патчі параметри = дефолти.
    Тому: спершу всі моделі, пауза на скид, далі значення/статуси з паузами, щоб
    USB-MIDI sysex не переповнювався (звичайне редагування шле по одній команді —
    тут їх десятки поспіль). */
export function importPreset(preset: ParsedPreset): false | Promise<true> {
  const s = getState();
  if (s.locked) return false;

  const enabled = s.enabled.slice();
  const selected = s.selected.slice();
  const params = s.params.map((p) => p.slice());
  const ctl = s.ctl.slice();

  for (const b of preset.blocks) {
    enabled[b.index] = b.on;
    selected[b.index] = b.model;
    params[b.index] = b.params.slice();
    if (b.ctl !== undefined) ctl[b.index] = b.ctl;
  }

  const order = preset.order ?? s.order;
  const patchNames =
    preset.name !== undefined
      ? replace(s.patchNames, s.currentPatchNumber, preset.name)
      : s.patchNames;

  setState({
    enabled,
    selected,
    params,
    ctl,
    order,
    patchNames,
    currentPatchName: patchNames[s.currentPatchNumber] ?? s.currentPatchName,
    ...(preset.patchVOL !== undefined ? { patchVOL: preset.patchVOL } : {}),
    ...(preset.bpm !== undefined ? { bpm: preset.bpm } : {}),
  });

  const STEP = 14; // пауза між sysex-командами (USB-MIDI throttle)
  const RESET = 60; // довша пауза після зміни моделі (поки пристрій скине параметри)

  return (async () => {
    // 1) Спершу всі моделі — кожна скидає параметри блока на пристрої.
    for (const b of preset.blocks) {
      sendBlockChange(b.index, b.model);
      await sleep(STEP);
    }
    await sleep(RESET);
    // 2) Тепер значення параметрів (скиди вже відбулися), статуси й CTL.
    for (const b of preset.blocks) {
      for (let pi = 0; pi < b.params.length; pi++) {
        sendParamChange(b.index, pi, b.params[pi]);
        await sleep(STEP);
      }
      sendBlockStatus(b.index, b.on ? '1' : '0');
      await sleep(STEP);
      if (b.ctl !== undefined) {
        sendCTL(b.index, b.ctl ? '1' : '0');
        await sleep(STEP);
      }
    }
    sendEffectOrder(order);
    await sleep(STEP);
    if (preset.patchVOL !== undefined) {
      sendPatchVol(preset.patchVOL);
      await sleep(STEP);
    }
    return true as const;
  })();
}

/* ---------- збереження ---------- */
/** Записати поточний edit-buffer у патч на пристрої.
    `skipConfirm` — коли намір уже явний (кнопка «Apply & Save» в модалці),
    щоб не показувати зайвий нативний діалог.
    Інакше показуємо `confirm`, але спершу пінимо попап (`set_popup_auto_hide`),
    бо нативний діалог краде фокус → blur ховає попап і скасовує підтвердження,
    через що `sendSavePatch` ніколи не виконувався. Див. CLAUDE.md. */
export async function savePatchToDevice(opts?: {
  skipConfirm?: boolean;
}): Promise<void> {
  if (!opts?.skipConfirm) {
    await setPopupAutoHide(false);
    const ok = confirm(
      'The patch has been modified, do you want to save your changes? This will overwrite the current patch.',
    );
    await setPopupAutoHide(true);
    if (!ok) return;
  }
  sendSavePatch();
  setState({ saveEnabled: false });
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
