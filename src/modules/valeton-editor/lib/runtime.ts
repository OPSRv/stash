/* Нереактивний рантайм: буфери дампів і прапорці синхронізації. Те, що у
   vanilla жило в state, але не рендериться напряму. Хендли пристрою більше
   тут не зберігаються — сире I/O живе в Rust (див. api.ts / модуль `valeton`). */

export interface Runtime {
  // буфери дампів
  dumpPatchNames: number[][];
  dumpPatchInfo: number[][];
  dumpGlobal: number[][];
  dumpIR: number[][];
  dumpSnaptones: number[][];
  // прапорці керування синком
  initialSync: boolean;
  userChangedPatch: boolean;
  patchChanged: number;
  saveGp5: boolean;
  saveGp50: boolean;
  // tap-tempo
  taps: number[];
}

export const runtime: Runtime = {
  dumpPatchNames: [],
  dumpPatchInfo: [],
  dumpGlobal: [],
  dumpIR: [],
  dumpSnaptones: [],
  initialSync: true,
  userChangedPatch: false,
  patchChanged: 0,
  saveGp5: false,
  saveGp50: false,
  taps: [],
};

export function resetDumps(): void {
  runtime.dumpPatchNames = [];
  runtime.dumpPatchInfo = [];
  runtime.dumpGlobal = [];
  runtime.dumpIR = [];
  runtime.dumpSnaptones = [];
}
