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

export type VoiceReply = {
  text: string;
  /// Absolute filesystem paths returned by deterministic slash-commands
  /// (e.g. `/screenshot`). Empty for free-text LLM replies.
  documents: string[];
};

/// Hand a prompt to the shared assistant pipeline (same one Telegram
/// uses) and get back the AI reply plus any file attachments produced
/// by the matching slash-command.
export const ask = (
  prompt: string,
  attachments?: string[],
): Promise<VoiceReply> =>
  invoke('voice_ask', { prompt, attachments: attachments ?? [] });

/// Persist arbitrary bytes (clipboard paste, etc.) to a temp file and
/// return its absolute path. The path is suitable for `convertFileSrc`
/// previews and gets fed back into `ask` as an attachment reference.
export const saveAttachment = (
  bytes: Uint8Array,
  extension?: string,
): Promise<string> =>
  invoke('voice_save_attachment', {
    bytes: Array.from(bytes),
    extension: extension ?? null,
  });

export const getVoiceSettings = (): Promise<VoiceSettings> =>
  invoke('voice_get_settings');

export const setVoiceSettings = (settings: VoiceSettings): Promise<void> =>
  invoke('voice_set_settings', { settings });

/// Hide the floating popup. Used by Esc / click-outside / "X" affordances
/// so the React side doesn't have to know about Tauri windows.
export const hidePopup = (): Promise<void> => invoke('voice_popup_hide');

/// Pin / unpin the voice popup. When pinned the popup floats above
/// other apps (NSStatusWindowLevel = 25) and stops auto-hiding on blur,
/// mirroring the main Stash popup's pin behaviour.
export const setPopupPinned = (pinned: boolean): Promise<void> =>
  invoke('voice_popup_set_pinned', { pinned });

export const getPopupPinned = (): Promise<boolean> =>
  invoke('voice_popup_get_pinned');

export type VoiceCommand = {
  name: string;
  usage: string;
  description: string;
};

/// Catalog of registered slash-commands, mirroring the Telegram bot
/// registry. Used by the popup composer to render an autocomplete
/// dropdown when the user types `/`.
export const listCommands = (): Promise<VoiceCommand[]> =>
  invoke('voice_list_commands');

export type QuickCommand = {
  id: string;
  label: string;
  icon: string;
  prompt: string;
};

/// User-defined quick-action pills shown above the composer. Persisted
/// in the telegram KV table so they survive restarts and travel with
/// the settings backup.
export const getQuickCommands = (): Promise<QuickCommand[]> =>
  invoke('voice_get_quick_commands');

export const setQuickCommands = (commands: QuickCommand[]): Promise<void> =>
  invoke('voice_set_quick_commands', { commands });
