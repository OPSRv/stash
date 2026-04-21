import { invoke } from '@tauri-apps/api/core';
import type { ConnectionStatus } from './types';

export const setToken = (token: string): Promise<void> =>
  invoke('telegram_set_token', { token });

export const clearToken = (): Promise<void> => invoke('telegram_clear_token');

export const hasToken = (): Promise<boolean> => invoke('telegram_has_token');

export const status = (): Promise<ConnectionStatus> => invoke('telegram_status');

export const startPairing = (): Promise<ConnectionStatus> =>
  invoke('telegram_start_pairing');

export const cancelPairing = (): Promise<ConnectionStatus> =>
  invoke('telegram_cancel_pairing');

export const unpair = (): Promise<ConnectionStatus> => invoke('telegram_unpair');
