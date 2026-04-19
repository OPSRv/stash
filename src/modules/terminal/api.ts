import { invoke } from '@tauri-apps/api/core';

export interface DataPayload {
  data: string;
}

export interface ExitPayload {
  code: number | null;
}

export const ptyOpen = (cols: number, rows: number) =>
  invoke<null>('pty_open', { cols, rows });

export const ptyWrite = (data: string) => invoke<null>('pty_write', { data });

export const ptyResize = (cols: number, rows: number) =>
  invoke<null>('pty_resize', { cols, rows });

export const ptyClose = () => invoke<null>('pty_close');
