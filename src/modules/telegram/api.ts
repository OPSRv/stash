import { invoke } from '@tauri-apps/api/core';
import type {
  AiSettings,
  ConnectionStatus,
  InboxItem,
  MemoryRow,
  NotificationSettings,
  RouteTarget,
} from './types';

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

/** Create a Notes entry from an inbox row and copy any attached file
 *  into that note's attachments directory. Returns the new note_id. */
export const sendInboxToNotes = (id: number): Promise<number> =>
  invoke('telegram_send_inbox_to_notes', { id });

export const revealInboxFile = (id: number): Promise<void> =>
  invoke('telegram_reveal_inbox_file', { id });

export const getNotificationSettings = (): Promise<NotificationSettings> =>
  invoke('telegram_get_notification_settings');

export const setNotificationSettings = (
  settings: NotificationSettings,
): Promise<void> => invoke('telegram_set_notification_settings', { settings });

export const getAiSettings = (): Promise<AiSettings> =>
  invoke('telegram_get_ai_settings');

export const setAiSettings = (settings: AiSettings): Promise<void> =>
  invoke('telegram_set_ai_settings', { settings });

export const listMemory = (): Promise<MemoryRow[]> =>
  invoke('telegram_list_memory');

export const deleteMemory = (id: number): Promise<boolean> =>
  invoke('telegram_delete_memory', { id });
