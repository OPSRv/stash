import { invoke } from '@tauri-apps/api/core';

export type Note = {
  id: number;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  /** Absolute path to the recorded audio file, if this note is a voice memo. */
  audio_path: string | null;
  /** Recording length in ms, when known. */
  audio_duration_ms: number | null;
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
  audio_path: string | null;
  audio_duration_ms: number | null;
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

/** Create a new note backed by a recorded audio blob. Returns the full note. */
export const notesCreateAudio = (args: {
  title: string;
  bytes: Uint8Array;
  ext: string;
  durationMs: number | null;
}): Promise<Note> =>
  invoke('notes_create_audio', {
    title: args.title,
    bytes: Array.from(args.bytes),
    ext: args.ext,
    durationMs: args.durationMs,
  });

/** Fetch the raw audio bytes for a voice-note so the frontend can wrap them
 *  in a Blob URL for `<audio>` playback. */
export const notesReadAudio = (id: number): Promise<Uint8Array> =>
  invoke<number[]>('notes_read_audio', { id }).then((arr) => new Uint8Array(arr));
