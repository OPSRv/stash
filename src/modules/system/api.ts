import { invoke } from '@tauri-apps/api/core';

export interface ProcessInfo {
  pid: number;
  rss_bytes: number;
  cpu_percent: number;
  user: string;
  name: string;
  command: string;
}

export const listProcesses = (): Promise<ProcessInfo[]> =>
  invoke('system_list_processes');

export const killProcess = (pid: number, force: boolean): Promise<void> =>
  invoke('system_kill_process', { pid, force });
