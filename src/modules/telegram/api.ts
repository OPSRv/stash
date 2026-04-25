import { invoke } from '@tauri-apps/api/core';
import type {
  AiSettings,
  ConnectionStatus,
  DiarStatus,
  InboxItem,
  InboxLimits,
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

/** Replace the stored transcript for a voice inbox row (manual edit). */
export const setInboxTranscript = (id: number, transcript: string): Promise<void> =>
  invoke('telegram_set_inbox_transcript', { id, transcript });

/** Ask the backend to re-run Whisper on an existing voice item. Fires
 *  `telegram:transcribing` / `telegram:inbox_updated` / `transcribe_failed`
 *  events exactly like the first-pass flow — no return value. */
export const retryTranscribe = (id: number): Promise<void> =>
  invoke('telegram_retry_transcribe', { id });

/** Push a text message to the paired Telegram chat. Returns `false`
 *  when the bot isn't paired yet — callers typically toast the result. */
export const sendText = (text: string): Promise<boolean> =>
  invoke('telegram_send_text', { text });

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

export const getInboxLimits = (): Promise<InboxLimits> =>
  invoke('telegram_get_inbox_limits');

export const setInboxLimits = (limits: InboxLimits): Promise<void> =>
  invoke('telegram_set_inbox_limits', { limits });

/// Wipe every inbox row and the file each one points at. Returns
/// `[rows_removed, files_removed]` for the toast.
export const clearInbox = (): Promise<[number, number]> =>
  invoke('telegram_clear_inbox');

/// Manually trigger the retention sweep — drops rows older than
/// `retention_days`. Normally fires hourly in the background.
export const sweepInbox = (): Promise<void> => invoke('telegram_sweep_inbox');

export const listMemory = (): Promise<MemoryRow[]> =>
  invoke('telegram_list_memory');

export const deleteMemory = (id: number): Promise<boolean> =>
  invoke('telegram_delete_memory', { id });

/// Diarization model status — which ONNX files are on disk and ready
/// for the speaker-labeling pipeline.
export const diarizationStatus = (): Promise<DiarStatus> =>
  invoke('diarization_status');

/// Download whichever segmentation/embedding files are missing.
/// Emits `diarization:download` events with `{id, received, total, done}`.
export const diarizationDownload = (): Promise<void> =>
  invoke('diarization_download');

export const diarizationDelete = (): Promise<void> =>
  invoke('diarization_delete');
