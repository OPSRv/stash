/* Глобальний vanilla-стор модуля. Доступний поза React (протокол/драйвери —
   getState/setState), а хук useStore(selector) дає реактивну підписку в
   компонентах через useSyncExternalStore (React 19). Зміна одного поля
   (напр. selected[block]) синхронно оновлює всі місця, що його читають.

   Власна крихітна реалізація (без zustand) — щоб не тягти зайву залежність
   у бандл Stash. Семантика селекторів збігається із zustand: результат
   порівнюється через Object.is, тож стабільні посилання не викликають
   зайвих ререндерів. */
import { useSyncExternalStore } from 'react';
import type { AppState } from './types';

const DEFAULT_ORDER = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8];

export const initialState: AppState = {
  transport: null,
  connected: false,
  connecting: false,
  deviceName: '',
  statusText: 'Not connected. Connect your GP-5 via USB or Bluetooth.',
  loadStatusText: 'Syncing with GP-5 …',
  locked: true,
  saveEnabled: false,
  loadModalOpen: false,

  patchNames: [],
  currentPatchNumber: 0,
  currentPatchName: '',

  enabled: Array(10).fill(false),
  selected: Array(10).fill(0),
  params: Array.from({ length: 10 }, () => []),
  ctl: Array(10).fill(false),
  order: [...DEFAULT_ORDER],

  cabModels: [],
  nsModels: [],

  globalInput: 0,
  globalCab: 0,
  globalFoot: 0,
  globalRec: 0,
  globalBt: 0,
  globalMon: 0,
  globalVol: 0,
  patchVOL: 50,

  bpm: 120,
  delayTime: 500,
  tapDivision: 'quarter',
  globalBPMOn: false,

  openCard: 'nr',
  liveView: false,
};

type Listener = () => void;

let state: AppState = { ...initialState };
const listeners = new Set<Listener>();

export const getState = (): AppState => state;

export function setState(
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
): void {
  const next = typeof partial === 'function' ? partial(state) : partial;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/** Логування статусу (порт protocol.log → два статус-рядки). */
export function log(msg: string): void {
  setState({ statusText: msg, loadStatusText: msg });
}

/** Порт ui.enableSaveButton. */
export function enableSaveButton(status: boolean | number = false): void {
  setState({ saveEnabled: Boolean(status) });
}
