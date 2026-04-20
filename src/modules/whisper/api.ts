import { invoke } from '@tauri-apps/api/core';

export type ModelRow = {
  id: string;
  label: string;
  size_bytes: number;
  ram_mb: number;
  language: 'en' | 'multi';
  quantized: boolean;
  accuracy: number;
  realtime_intel_2018: number;
  recommended_intel: boolean;
  url: string;
  downloaded: boolean;
  active: boolean;
};

export type DownloadEvent = {
  id: string;
  received: number;
  total: number;
  done: boolean;
};

export const whisperListModels = (): Promise<ModelRow[]> =>
  invoke('whisper_list_models');

export const whisperDownloadModel = (id: string): Promise<void> =>
  invoke('whisper_download_model', { id });

export const whisperDeleteModel = (id: string): Promise<void> =>
  invoke('whisper_delete_model', { id });

export const whisperSetActive = (id: string | null): Promise<void> =>
  invoke('whisper_set_active', { id });

export const whisperGetActive = (): Promise<string | null> =>
  invoke('whisper_get_active');

export const whisperTranscribe = (noteId: number, language: string = 'uk'): Promise<string> =>
  invoke('whisper_transcribe', { noteId, language });
