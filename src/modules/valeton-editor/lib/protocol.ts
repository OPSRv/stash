/* Спільне ядро протоколу GP-5 — однакове для BLE та USB-MIDI.
   Відправники формують тіло команди і делегують обрамлення транспорту.
   parsePatchInfo() розкладає зібраний масив патча у Partial<AppState>
   (зміщення однакові для обох транспортів). */
import { enableSaveButton, getState } from '../store/store';
import type { AppState } from '../store/types';
import {
  AMPEffectsList,
  CABEffectsList,
  DLYEffectsList,
  DSTEffectsList,
  defaultsLIST,
  EQEffectsList,
  effectsLIST,
  MODEffectsList,
  NSEffectsList,
  PREEffectsList,
  RVBEffectsList,
} from './constants';
import { sendCommand } from './transport';
import {
  addzero,
  cleanName,
  floatToHexBytes,
  generateVerifier,
  getEffectId,
  hexBytesToFloat,
  hexToSignedInt,
  signedIntToHex,
  stringToHexArray,
} from './utils';

const sum = (code: string): string =>
  generateVerifier(code).toString(16).padStart(2, '0').toUpperCase();

/* ---------- відправники (тіло команди → transport.sendCommand) ---------- */

export function sendParamChange(
  block: number,
  nparam: number,
  value: number,
): void {
  const code = `01000e1148${block.toString().padStart(2, '0')}000000${nparam
    .toString()
    .padStart(2, '0')}000000${floatToHexBytes(value).join('')}`;
  enableSaveButton(true);
  sendCommand(addzero(sum(code) + code));
}

export function sendBlockStatus(effect: number, val: string): void {
  const code = `01000a11490${effect}0000000${val}000000`;
  enableSaveButton(true);
  sendCommand(addzero(sum(code) + code));
}

export function sendCTL(effect: number, val: string): void {
  const code = `010005114d000${effect}0${val}`;
  sendCommand(addzero(sum(code) + code));
  enableSaveButton(true);
}

export function sendGlobalChange(
  effect: number,
  flag: number,
  value: number | string,
): void {
  const val = Number.parseInt(String(value), 10);
  const code = `01000a11110${effect}0${flag}0000${signedIntToHex(val)}000000`;
  sendCommand(addzero(sum(code) + code));
}

export function sendBlockChange(block: number, effect: number): void {
  let effectFlag = '';
  for (const [key, value] of Object.entries(effectsLIST[block])) {
    if (value === effect) effectFlag = key;
  }
  const code = `01000e11470${block}0000000${block}000000${effectFlag}`;
  enableSaveButton(true);
  sendCommand(addzero(sum(code) + code));
}

export function sendFootChange(value: number | string): void {
  const val = Number.parseInt(String(value), 10);
  const code = `010004111500${signedIntToHex(val)}`;
  sendCommand(addzero(sum(code) + code));
}

export function sendGlobalVol(value: number | string): void {
  const val = Number.parseInt(String(value), 10);
  const code = `01000a111102020000${val.toString(16).padStart(2, '0')}000000`;
  sendCommand(addzero(sum(code) + code));
}

export function sendPatchVol(value: number | string): void {
  const val = Number.parseInt(String(value), 10);
  const code = `01000a114201200000${val.toString(16).padStart(2, '0')}000000`;
  enableSaveButton(true);
  sendCommand(addzero(sum(code) + code));
}

export function sendEffectOrder(order: number[]): void {
  let code = '01000c1144';
  for (const o of order) code = `${code}0${o}`;
  enableSaveButton(true);
  sendCommand(addzero(sum(code) + code));
}

/** Запит конкретного патча (спільний для дропдауна та BLE-кроку prev/next). */
export function sendPatchSelect(patch: number): void {
  const code = `0100061143${patch.toString(16).padStart(2, '0')}000000`;
  sendCommand(addzero(sum(code) + code));
}

/** Зберегти поточний патч на пристрій. */
export function sendSavePatch(): void {
  const s = getState();
  const code = `010010114a${signedIntToHex(s.currentPatchNumber)}000000${stringToHexArray(
    cleanName(s.patchNames[s.currentPatchNumber] ?? '').padEnd(10, ' '),
  ).join('')}`;
  sendCommand(addzero(sum(code) + code));
}

/* ---------- розбір зібраного патча (однаковий для обох транспортів) ---------- */

export function parsePatchInfo(data: number[]): Partial<AppState> {
  const bit = (byte: number, n: number): boolean =>
    Boolean(data[byte] & (1 << n));
  const f = (o: number): number =>
    hexBytesToFloat([
      data[o],
      data[o + 1],
      data[o + 2],
      data[o + 3],
      data[o + 4],
      data[o + 5],
      data[o + 6],
      data[o + 7],
    ]);
  const lookup = (map: Record<string, number>, start: number): number =>
    map[getEffectId(data, start)] ?? 0;

  const enabled = [
    bit(141, 0), // nr
    bit(141, 1), // pre
    bit(141, 2), // dst
    bit(141, 3), // amp
    bit(140, 0), // cab
    bit(140, 1), // eq
    bit(140, 2), // mod
    bit(140, 3), // dly
    bit(143, 0), // rvb
    bit(143, 1), // ns
  ];

  const selected = [
    0, // nr
    lookup(PREEffectsList, 192),
    lookup(DSTEffectsList, 200),
    lookup(AMPEffectsList, 208),
    lookup(CABEffectsList, 216),
    lookup(EQEffectsList, 224),
    lookup(MODEffectsList, 232),
    lookup(DLYEffectsList, 240),
    lookup(RVBEffectsList, 248),
    lookup(NSEffectsList, 256),
  ];

  const params: number[][] = [
    [f(272)], // nr
    [f(336), f(344), f(352), f(360), f(368), f(376)], // pre
    [f(400), f(408), f(416), f(424), f(432)], // dst
    [f(464), f(472), f(480), f(488), f(496), f(504), f(512)], // amp
    [f(528)], // cab
    [f(592), f(600), f(608), f(616), f(624), f(632)], // eq
    [f(656), f(664), f(672), f(680), f(688)], // mod
    [f(720), f(728), f(736), f(744), f(752), f(760), f(768), f(776)], // dly
    [f(784), f(792), f(800), f(808), f(816), f(824), f(832)], // rvb
    [f(848), f(856), f(864), f(872), f(880)], // ns
  ];

  const ctl = [
    bit(921, 0), // nr
    bit(921, 1), // pre
    bit(921, 2), // dst
    bit(921, 3), // amp
    bit(920, 0), // cab
    bit(920, 1), // eq
    bit(920, 2), // mod
    bit(920, 3), // dly
    bit(923, 0), // rvb
    bit(923, 1), // ns
  ];

  const order = [
    data[157],
    data[159],
    data[161],
    data[163],
    data[165],
    data[167],
    data[169],
    data[171],
    data[173],
    data[175],
  ];

  return {
    enabled,
    selected,
    params,
    ctl,
    order,
    patchVOL: hexToSignedInt(data[100] * 16 + data[101]),
  };
}

/** Дефолти параметрів блока для ефекту (cab/ns завжди використовують layout 0). */
export function paramDefs(
  blockIndex: number,
  effectIndex: number,
): import('./constants').ParamDef[] {
  const eff = blockIndex === 9 || blockIndex === 4 ? 0 : effectIndex;
  return defaultsLIST[blockIndex][eff] ?? [];
}
