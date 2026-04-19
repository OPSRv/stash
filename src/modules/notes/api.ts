import { invoke } from '@tauri-apps/api/core';

export type Note = {
  id: number;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
};

export const notesList = (): Promise<Note[]> => invoke('notes_list');
export const notesSearch = (query: string): Promise<Note[]> =>
  invoke('notes_search', { query });
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
