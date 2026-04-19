import { invoke } from '@tauri-apps/api/core';
import type { MetronomeState } from './metronome.constants';

export const metronomeGetState = (): Promise<MetronomeState> =>
  invoke('metronome_get_state');

export const metronomeSaveState = (payload: MetronomeState): Promise<void> =>
  invoke('metronome_save_state', { payload });
