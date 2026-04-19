import { invoke } from '@tauri-apps/api/core';

export type RecorderMode = 'screen' | 'screen+cam' | 'cam';

export type RecorderStatus = {
  available: boolean;
  recording: boolean;
  last_saved: string | null;
};

export type RecorderEvent = {
  event:
    | 'ready'
    | 'recording_started'
    | 'stopped'
    | 'error'
    | 'status'
    | 'permissions';
  path?: string;
  message?: string;
  recording?: boolean;
  screen?: boolean;
  microphone?: boolean;
  camera?: boolean;
};

export const recStart = (args: {
  mode?: RecorderMode;
  mic?: boolean;
  fps?: number;
  filename?: string;
}): Promise<string> => invoke('rec_start', args);

export const recStop = (): Promise<void> => invoke('rec_stop');
export const recStatus = (): Promise<RecorderStatus> => invoke('rec_status');
export const recProbePermissions = (): Promise<void> => invoke('rec_probe_permissions');
export const recSetOutputDir = (path: string | null): Promise<void> =>
  invoke('rec_set_output_dir', { path });

export type Recording = {
  path: string;
  created_at: number;
  bytes: number;
  thumbnail: string | null;
};

export const recList = (): Promise<Recording[]> => invoke('rec_list');
export const recDelete = (path: string): Promise<void> =>
  invoke('rec_delete', { path });
export const recTrim = (
  source: string,
  start: number,
  end: number
): Promise<string> => invoke('rec_trim', { source, start, end });
