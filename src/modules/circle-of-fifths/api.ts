/* Tauri command wrappers for the Circle of Fifths module. Components never
 * call `invoke` directly — every IPC crossing goes through here. */

import { invoke } from '@tauri-apps/api/core';

export type AiMode = 'compose' | 'explain' | 'suggest';

/** Ask the configured AI assistant for help. `mode` selects the system prompt
 * on the Rust side; `payload` is the user-side text (a music description, or
 * a progression plus its key). Resolves to the raw model reply. */
export const circleAiAssist = (mode: AiMode, payload: string): Promise<string> =>
  invoke<string>('circle_ai_assist', { mode, payload });

/** Subset of the tuner module's persisted state we care about (snake_case on
 * the wire, mirroring Rust `TunerState`). Duplicated here instead of imported
 * from `src/modules/tuner` — cross-module imports are forbidden. */
export type TunerStateDto = { tuning_id: string };

/** Read the tuner module's saved state, used once to seed our tuning. */
export const tunerGetState = (): Promise<TunerStateDto> => invoke('tuner_get_state');
