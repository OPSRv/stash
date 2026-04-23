import { invoke } from '@tauri-apps/api/core';

export interface DataPayload {
  id: string;
  data: string;
}

export interface ExitPayload {
  id: string;
  code: number | null;
}

export interface ProcPayload {
  id: string;
  /// Foreground-process `comm` (e.g. `claude`, `vim`, `cargo`). Empty
  /// string when the shell idle-prompt owns the foreground.
  name: string;
}

export const ptyOpen = (
  id: string,
  cols: number,
  rows: number,
  cwd?: string | null,
) => invoke<null>('pty_open', { id, cols, rows, cwd: cwd ?? null });

export const ptyWrite = (id: string, data: string) =>
  invoke<null>('pty_write', { id, data });

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<null>('pty_resize', { id, cols, rows });

export const ptyClose = (id: string) => invoke<null>('pty_close', { id });

/// Persist the latest CWD the shell announced via OSC 7. Used by
/// Restart to respawn the shell in the same directory.
export const ptySetCwd = (id: string, cwd: string) =>
  invoke<null>('pty_set_cwd', { id, cwd });

export const ptyGetCwd = (id: string) =>
  invoke<string | null>('pty_get_cwd', { id });

/** Persist a binary blob (usually a clipboard image) to Stash's cache
 *  and return the absolute path. `extension` is a hint ("png", "jpg"…);
 *  the backend sanitises it to a narrow allow-list before writing. */
export const terminalSavePasteBlob = (bytes: Uint8Array, extension: string) =>
  invoke<string>('terminal_save_paste_blob', {
    bytes: Array.from(bytes),
    extension,
  });
