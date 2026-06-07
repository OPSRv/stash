import { invoke } from '@tauri-apps/api/core';
import type { TunerState } from './tuner.constants';

export const tunerGetState = (): Promise<TunerState> => invoke('tuner_get_state');

export const tunerSaveState = (payload: TunerState): Promise<void> =>
  invoke('tuner_save_state', { payload });
