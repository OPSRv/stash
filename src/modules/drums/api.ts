/* Tauri wrappers for the Drums module — components never call `invoke`
 * directly. Mirrors `src-tauri/src/modules/drums/commands.rs`. */

import { invoke } from '@tauri-apps/api/core';
import type { DrumsState, ExportFormat } from './lib/model';

export const drumsGetState = (): Promise<DrumsState> => invoke('drums_get_state');

export const drumsSaveState = (payload: DrumsState): Promise<void> =>
  invoke('drums_save_state', { payload });

export const drumsFfmpegAvailable = (): Promise<boolean> => invoke('drums_ffmpeg_available');

export const drumsDefaultExportDir = (): Promise<string> => invoke('drums_default_export_dir');

/** Write a rendered WAV to `path` (transcoded via ffmpeg for mp3). Bytes go
 *  over the raw-binary IPC body — no JSON number-array tax on multi-MB
 *  loops. Resolves to the final absolute path. */
export const drumsExport = (wav: Uint8Array, path: string, format: ExportFormat): Promise<string> =>
  invoke('drums_export', wav, {
    headers: { 'x-drums-path': encodeURIComponent(path), 'x-drums-format': format },
  });
