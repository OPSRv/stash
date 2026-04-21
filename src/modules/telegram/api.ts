import { invoke } from '@tauri-apps/api/core';
import type { ConnectionStatus, InboxItem, RouteTarget } from './types';

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

export const listInbox = (limit?: number): Promise<InboxItem[]> =>
  invoke('telegram_list_inbox', { limit });

export const deleteInboxItem = (id: number): Promise<void> =>
  invoke('telegram_delete_inbox_item', { id });

export const markInboxRouted = (id: number, target: RouteTarget): Promise<void> =>
  invoke('telegram_mark_inbox_routed', { id, target });
