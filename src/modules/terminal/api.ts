import { invoke } from '@tauri-apps/api/core';

export interface DataPayload {
  id: string;
  data: string;
}

export interface ExitPayload {
  id: string;
  code: number | null;
}

export const ptyOpen = (id: string, cols: number, rows: number) =>
  invoke<null>('pty_open', { id, cols, rows });

export const ptyWrite = (id: string, data: string) =>
  invoke<null>('pty_write', { id, data });

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<null>('pty_resize', { id, cols, rows });

export const ptyClose = (id: string) => invoke<null>('pty_close', { id });

/** Persist a binary blob (usually a clipboard image) to Stash's cache
 *  and return the absolute path. `extension` is a hint ("png", "jpg"…);
 *  the backend sanitises it to a narrow allow-list before writing. */
export const terminalSavePasteBlob = (bytes: Uint8Array, extension: string) =>
  invoke<string>('terminal_save_paste_blob', {
    bytes: Array.from(bytes),
    extension,
  });
