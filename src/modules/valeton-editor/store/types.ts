/* Форма стану застосунку. Індекси блоків 0..9 збігаються з blocksLIST:
   0 nr · 1 pre · 2 dst · 3 amp · 4 cab · 5 eq · 6 mod · 7 dly · 8 rvb · 9 ns */

export type BlockKey =
  | 'nr'
  | 'pre'
  | 'dst'
  | 'amp'
  | 'cab'
  | 'eq'
  | 'mod'
  | 'dly'
  | 'rvb'
  | 'ns';
export type Transport = 'ble' | 'usb' | null;
export type TapDivision = 'quarter' | 'eighth' | 'dotted';

export interface AppState {
  // зʼєднання / статус
  transport: Transport;
  connected: boolean;
  connecting: boolean; // порт відкрито, чекаємо першу відповідь пристрою
  deviceName: string;
  statusText: string;
  loadStatusText: string;
  locked: boolean; // disableGUI(true)
  saveEnabled: boolean;
  loadModalOpen: boolean;

  // список пресетів
  patchNames: string[];
  currentPatchNumber: number;
  currentPatchName: string;

  // на блок (індекс 0..9)
  enabled: boolean[];
  selected: number[];
  params: number[][];
  ctl: boolean[];
  order: number[]; // індекси блоків у порядку відображення

  // динамічні списки моделей із пристрою
  cabModels: string[]; // IR-назви (value 20+)
  nsModels: string[]; // snaptone-назви (value 0..)

  // глобальні параметри
  globalInput: number;
  globalCab: number;
  globalFoot: number;
  globalRec: number;
  globalBt: number;
  globalMon: number;
  globalVol: number;
  patchVOL: number;

  // темп
  bpm: number;
  delayTime: number;
  tapDivision: TapDivision;
  globalBPMOn: boolean;

  // UI
  openCard: BlockKey; // відкрита картка ефекту (live-off)
  liveView: boolean;
  circleView: boolean; // circle-of-fifths workspace (mutually exclusive with live)
}
