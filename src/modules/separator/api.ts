import { invoke } from '@tauri-apps/api/core';

export type SeparatorAssetKind =
  | 'sidecar'
  | 'htdemucs_6s'
  | 'htdemucs_ft_vocals'
  | 'htdemucs_ft_drums'
  | 'htdemucs_ft_bass'
  | 'htdemucs_ft_other';

export type SeparatorAssetStatus = {
  kind: SeparatorAssetKind;
  label: string;
  size_bytes: number;
  optional: boolean;
  downloaded: boolean;
  local_path: string | null;
};

export type SeparatorStatus = {
  ready: boolean;
  ft_ready: boolean;
  assets: SeparatorAssetStatus[];
  default_output_dir: string;
};

export type SeparatorJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SeparatorJobMode = 'analyze' | 'separate' | 'bpm';

export type SeparatorAnalysis = {
  stems_dir?: string;
  stems?: Record<string, string>;
  bpm?: number;
  beats?: number[];
  duration_sec?: number;
  model?: string;
  device?: string;
};

export type SeparatorJob = {
  id: string;
  input_path: string;
  model: string;
  mode: SeparatorJobMode;
  stems?: string[];
  output_dir: string;
  status: SeparatorJobStatus;
  progress: number;
  phase: string;
  started_at: number;
  finished_at?: number;
  error?: string;
  result?: SeparatorAnalysis;
};

export type SeparatorRunArgs = {
  inputPath: string;
  model?: string;
  mode?: SeparatorJobMode;
  stems?: string[];
  outputDir?: string;
};

export type SeparatorDownloadEvent = {
  id: string;
  received: number;
  total: number;
  done: boolean;
};

export const status = (): Promise<SeparatorStatus> => invoke('separator_status');

export const download = (withFt: boolean): Promise<void> =>
  invoke('separator_download', { withFt });

export const remove = (ftOnly: boolean): Promise<void> =>
  invoke('separator_delete', { ftOnly });

export const run = (args: SeparatorRunArgs): Promise<string> =>
  invoke('separator_run', {
    args: {
      inputPath: args.inputPath,
      model: args.model ?? null,
      mode: args.mode ?? null,
      stems: args.stems ?? null,
      outputDir: args.outputDir ?? null,
    },
  });

export const cancel = (jobId: string): Promise<void> =>
  invoke('separator_cancel', { jobId });

export const listJobs = (): Promise<SeparatorJob[]> => invoke('separator_list_jobs');

export const clearCompleted = (): Promise<void> => invoke('separator_clear_completed');

/** Audio extensions ffmpeg / soundfile can read. We don't validate
 *  content type here — demucs / soundfile fail loudly on a misnamed
 *  file, and the alternative (sniffing magic bytes from the renderer)
 *  would force us to read the file twice. Keep this list permissive. */
export const SUPPORTED_EXTENSIONS = [
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
];

export const isSupportedAudio = (path: string): boolean => {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
};

/** Display labels for the six htdemucs_6s stems. The 4-stem htdemucs /
 *  htdemucs_ft models drop the `guitar` and `piano` entries — UI code
 *  that maps a stem name should fall through to the raw key when the
 *  model emits something we don't have a translation for. */
export const STEM_LABELS: Record<string, string> = {
  vocals: 'Вокал',
  drums: 'Барабани',
  bass: 'Бас',
  guitar: 'Гітара',
  piano: 'Фортепіано',
  other: 'Інше',
};
