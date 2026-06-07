import { invoke } from '@tauri-apps/api/core';
import type { Recording } from './recorder.constants';

export const recorderList = (): Promise<Recording[]> => invoke('recorder_list');

export const recorderSave = (args: {
  bytes: number[];
  ext: string;
  durationMs: number;
  name?: string;
  device?: string;
}): Promise<Recording> => invoke('recorder_save', args);

export const recorderRename = (id: string, name: string): Promise<Recording> =>
  invoke('recorder_rename', { id, name });

export const recorderSetFavorite = (id: string, favorite: boolean): Promise<Recording> =>
  invoke('recorder_set_favorite', { id, favorite });

export const recorderDelete = (id: string): Promise<void> =>
  invoke('recorder_delete', { id });

/** Playback rides the shared media server — the recorder audio dir is
 *  registered as an Audio root in `lib.rs`, so the generic command resolves it. */
export const recorderStreamUrl = (path: string): Promise<string> =>
  invoke('media_stream_url', { path });
