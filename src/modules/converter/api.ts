import { invoke } from '@tauri-apps/api/core';

export type ConverterPresetKind = 'audio' | 'video' | 'extract_audio';

export type ConverterPreset = {
  id: string;
  label: string;
  description: string;
  kind: ConverterPresetKind;
  ext: string;
};

export type ConverterStatus = {
  ffmpeg_ready: boolean;
  ffmpeg_dir: string | null;
  default_output_dir: string;
  presets: ConverterPreset[];
};

export type ConverterJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ConverterJobKind = 'convert' | 'transcribe';

export type ConverterJob = {
  id: string;
  input_path: string;
  output_path: string;
  kind: ConverterJobKind;
  preset_id?: string;
  status: ConverterJobStatus;
  progress: number;
  duration_sec?: number;
  started_at: number;
  finished_at?: number;
  error?: string;
};

export type ConverterRunArgs = {
  inputPath: string;
  presetId: string;
  outputDir?: string;
};

export const status = (): Promise<ConverterStatus> => invoke('converter_status');

export const run = (args: ConverterRunArgs): Promise<string> =>
  invoke('converter_run', {
    args: {
      inputPath: args.inputPath,
      presetId: args.presetId,
      outputDir: args.outputDir ?? null,
    },
  });

export const cancel = (jobId: string): Promise<void> =>
  invoke('converter_cancel', { jobId });

export const listJobs = (): Promise<ConverterJob[]> => invoke('converter_list_jobs');

export const removeJob = (jobId: string, deleteFile = true): Promise<void> =>
  invoke('converter_remove_job', { jobId, deleteFile });

export const clearCompleted = (deleteFiles = true): Promise<void> =>
  invoke('converter_clear_completed', { deleteFiles });

export type TranscribeFormat = 'txt' | 'md';

export type TranscribeArgs = {
  inputPath: string;
  format?: TranscribeFormat;
  language?: string;
  /** Opt-in speaker diarization. Falls back to a flat transcript when
   *  the sidecar/models aren't installed yet. */
  diarize?: boolean;
  /** Pin the speaker count (1–10). Omit or pass 0 for auto. */
  numSpeakers?: number;
  /** Run AI polish (typo/punctuation fixes only — never reword). */
  aiPolish?: boolean;
  /** Override the polish system prompt. */
  aiPrompt?: string;
  /** Also persist the transcript as a Stash note. */
  saveAsNote?: boolean;
};

export type TranscribeResult = {
  output_path: string;
  note_id: number | null;
  polished: boolean;
};

/** Run whisper against the input and write the transcript next to the
 *  source file. Optionally diarizes, polishes via the active AI
 *  provider, and persists the result as a Stash note. Resolves with
 *  the absolute path of the written transcript plus optional note id.
 *  Throws when no whisper model is active. */
export const transcribeToFile = (args: TranscribeArgs): Promise<TranscribeResult> =>
  invoke('converter_transcribe_to_file', {
    args: {
      inputPath: args.inputPath,
      format: args.format ?? 'txt',
      language: args.language ?? null,
      diarize: args.diarize ?? false,
      numSpeakers: args.numSpeakers && args.numSpeakers > 0 ? args.numSpeakers : null,
      aiPolish: args.aiPolish ?? false,
      aiPrompt: args.aiPrompt ?? null,
      saveAsNote: args.saveAsNote ?? false,
    },
  });

/// Audio extensions ffmpeg understands. Mirrors the separator list plus
/// a couple of less-common containers we accept on input even though we
/// don't expose them as outputs.
export const SUPPORTED_AUDIO_EXTENSIONS = [
  'mp3',
  'm4a',
  'flac',
  'ogg',
  'oga',
  'wav',
  'aac',
  'aiff',
  'aif',
  'opus',
  'wma',
  'amr',
];

/// Video containers we accept on input. Output extensions live on the
/// preset table — we don't reuse this list for the picker.
export const SUPPORTED_VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  '3gp',
  'ts',
  'mts',
  'm2ts',
];

export const SUPPORTED_EXTENSIONS = [
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS,
];

export const extOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
};

export const isSupportedMedia = (path: string): boolean =>
  SUPPORTED_EXTENSIONS.includes(extOf(path));

export const isVideoFile = (path: string): boolean =>
  SUPPORTED_VIDEO_EXTENSIONS.includes(extOf(path));

export const isAudioFile = (path: string): boolean =>
  SUPPORTED_AUDIO_EXTENSIONS.includes(extOf(path));
