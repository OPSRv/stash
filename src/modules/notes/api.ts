import { invoke } from '@tauri-apps/api/core';

export type Note = {
  id: number;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  /** User-pinned notes float to the top of the side-list. */
  pinned: boolean;
};

/** Lightweight projection returned by the list / search endpoints — carries a
 *  short body preview instead of the full markdown so opening Notes stays cheap
 *  even when a user has hundreds of long entries. Fetch the full body via
 *  `notesGet(id)` only when a note is actually activated. */
export type NoteSummary = {
  id: number;
  title: string;
  preview: string;
  created_at: number;
  updated_at: number;
  pinned: boolean;
};

export const notesList = (): Promise<NoteSummary[]> => invoke('notes_list');
export const notesSetPinned = (id: number, pinned: boolean): Promise<void> =>
  invoke('notes_set_pinned', { id, pinned });
export const notesSearch = (query: string): Promise<NoteSummary[]> =>
  invoke('notes_search', { query });
export const notesGet = (id: number): Promise<Note | null> =>
  invoke('notes_get', { id });
export const notesCreate = (title: string, body: string): Promise<number> =>
  invoke('notes_create', { title, body });
export const notesUpdate = (
  id: number,
  title: string,
  body: string
): Promise<void> => invoke('notes_update', { id, title, body });
export const notesDelete = (id: number): Promise<void> =>
  invoke('notes_delete', { id });

export type ReadFileResult = { name: string; contents: string };

export const notesReadFile = (path: string): Promise<ReadFileResult> =>
  invoke('notes_read_file', { path });

export const notesWriteFile = (path: string, content: string): Promise<void> =>
  invoke('notes_write_file', { path, content });

/** Persist audio bytes (from the recorder) into the managed audio directory.
 *  Returns the absolute path so the caller can embed it into a note's body
 *  via markdown: `![voice note](/abs/path)`. */
export const notesSaveAudioBytes = (bytes: Uint8Array, ext: string): Promise<string> =>
  invoke('notes_save_audio_bytes', { bytes: Array.from(bytes), ext });

/** Copy an audio file at `path` (e.g. dropped from Finder) into the managed
 *  audio directory. Returns the new absolute path for markdown-embed use. */
export const notesSaveAudioFile = (path: string): Promise<string> =>
  invoke('notes_save_audio_file', { path });

/** Read raw audio bytes by absolute path. Only paths under the managed audio
 *  dir are accepted (the Rust side enforces this). Used by the inline
 *  markdown audio player, which references files by path from `![](…)`. */
export const notesReadAudioByPath = (path: string): Promise<Uint8Array> =>
  invoke<number[]>('notes_read_audio_path', { path }).then((arr) => new Uint8Array(arr));
