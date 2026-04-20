import { invoke } from '@tauri-apps/api/core';

export type Posture = 'sit' | 'stand' | 'walk';

export type SessionStatus = 'idle' | 'running' | 'paused';

/** Library flavor: short one-shot runs vs full multi-posture day plans. */
export type PresetKind = 'session' | 'daily';

export interface Block {
  id: string;
  name: string;
  duration_sec: number;
  posture: Posture;
  mid_nudge_sec: number | null;
}

export interface Preset {
  id: number;
  name: string;
  kind: PresetKind;
  blocks: Block[];
  updated_at: number;
}

export interface SessionSnapshot {
  status: SessionStatus;
  blocks: Block[];
  current_idx: number;
  remaining_ms: number;
  started_at: number;
  preset_id: number | null;
}

export interface SessionRow {
  id: number;
  preset_id: number | null;
  started_at: number;
  ended_at: number | null;
  blocks: Block[];
  completed_idx: number;
}

export type BlockChangedEvent = {
  kind: 'block_changed';
  from_idx: number;
  to_idx: number;
  from_posture: Posture;
  to_posture: Posture;
  block_name: string;
};

export type NudgeEvent = {
  kind: 'nudge';
  block_idx: number;
  block_name: string;
  text: string;
};

export type SessionDoneEvent = {
  kind: 'session_done';
  blocks_completed: number;
  total_sec: number;
};

export const listPresets = (): Promise<Preset[]> =>
  invoke('pomodoro_list_presets');

export const savePreset = (
  name: string,
  kind: PresetKind,
  blocks: Block[],
): Promise<Preset> => invoke('pomodoro_save_preset', { name, kind, blocks });

export const deletePreset = (id: number): Promise<void> =>
  invoke('pomodoro_delete_preset', { id });

export const listHistory = (limit?: number): Promise<SessionRow[]> =>
  invoke('pomodoro_list_history', { limit: limit ?? null });

export const getState = (): Promise<SessionSnapshot> =>
  invoke('pomodoro_get_state');

export const startSession = (
  blocks: Block[],
  presetId: number | null = null,
): Promise<SessionSnapshot> =>
  invoke('pomodoro_start', { blocks, presetId });

export const pauseSession = (): Promise<SessionSnapshot> =>
  invoke('pomodoro_pause');

export const resumeSession = (): Promise<SessionSnapshot> =>
  invoke('pomodoro_resume');

export const stopSession = (): Promise<SessionSnapshot> =>
  invoke('pomodoro_stop');

export const skipTo = (idx: number): Promise<SessionSnapshot> =>
  invoke('pomodoro_skip_to', { idx });

export const editBlocks = (blocks: Block[]): Promise<SessionSnapshot> =>
  invoke('pomodoro_edit_blocks', { blocks });
