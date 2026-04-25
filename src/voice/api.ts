import { invoke } from '@tauri-apps/api/core';

export type VoiceSettings = {
  /// When true, recording auto-stops after `autostop_silence_ms` of
  /// silence. Default false — explicit tap-to-stop is the primary UX.
  autostop_enabled: boolean;
  autostop_silence_ms: number;
};

/// Transcribe a recorded audio blob via the active Whisper model.
/// Returns the plain transcript text.
export const transcribe = (
  bytes: Uint8Array,
  extension: string,
  language?: string,
): Promise<string> =>
  invoke('voice_transcribe', {
    audioBytes: Array.from(bytes),
    extension,
    language: language ?? null,
  });

/// Hand a prompt to the shared assistant pipeline (same one Telegram
/// uses) and get back the AI reply.
export const ask = (prompt: string): Promise<string> =>
  invoke('voice_ask', { prompt });

export const getVoiceSettings = (): Promise<VoiceSettings> =>
  invoke('voice_get_settings');

export const setVoiceSettings = (settings: VoiceSettings): Promise<void> =>
  invoke('voice_set_settings', { settings });

/// Hide the floating popup. Used by Esc / click-outside / "X" affordances
/// so the React side doesn't have to know about Tauri windows.
export const hidePopup = (): Promise<void> => invoke('voice_popup_hide');
