/* Спільні кроки синку (однакові для USB та BLE): побудова списку пресетів
   із dumpPatchNames і прийом розібраного патча у стор. */
import { getState, log, setState } from '../store/store';
import { savePresetFile } from './presets';
import { parsePatchInfo, sendParamChange } from './protocol';
import { runtime } from './runtime';
import { getName } from './utils';

/** Зібрати список 100 пресетів із dumpPatchNames у стор. */
export function buildPatchList(): void {
  const d = runtime.dumpPatchNames.flat(1);
  const names: string[] = [];
  let t = 12;
  for (let index = 0; index < 100; index++) {
    names.push(getName(d, t));
    t += 40;
  }
  setState({ patchNames: names });
}

/** Прийняти розібраний патч у стор. finalStep=false — крок initialSync (рахуємо BPM,
   синк триває далі), true — фінальний прийом (globalBPM / збереження файлу). */
export function applyPatch(finalStep: boolean): void {
  const data = runtime.dumpPatchInfo.flat(1);
  const partial = parsePatchInfo(data);
  const params = partial.params as number[][];

  if (!finalStep) {
    const bpm = Math.round(60000 / params[7][1]);
    setState({ ...partial, bpm, tapDivision: 'quarter' });
    return;
  }

  const s = getState();
  if (s.globalBPMOn) {
    sendParamChange(7, 1, s.delayTime);
    params[7][1] = s.delayTime;
    setState({ ...partial, saveEnabled: false });
  } else {
    const bpm = Math.round(60000 / params[7][1]);
    setState({ ...partial, bpm, tapDivision: 'quarter', saveEnabled: false });
  }
  if (runtime.saveGp5 || runtime.saveGp50) void savePresetFile();
  runtime.userChangedPatch = false;
  log('Preset synced.');
}
