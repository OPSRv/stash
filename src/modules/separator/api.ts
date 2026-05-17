import { invoke } from '@tauri-apps/api/core';

export type SeparatorAssetKind =
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

/** Status payload from `separator_status`. `ready` is the conjunction
 *  of `runtime_ready` (uv + venv + pip packages staged) and the
 *  required model being on disk; `runtime_ready` is exposed
 *  separately so the UI can render the staged install card without
 *  having to derive it from the asset list. */
export type SeparatorStatus = {
  ready: boolean;
  runtime_ready: boolean;
  ft_ready: boolean;
  assets: SeparatorAssetStatus[];
  default_output_dir: string;
};

/** Phase of the multi-step install. Mirrors `installer::InstallPhase`
 *  on the Rust side; UI translates to ukrainian copy via a phase-map. */
export type SeparatorInstallPhase =
  | 'uv'
  | 'python'
  | 'venv'
  | 'packages'
  | 'models'
  | 'done';

export type SeparatorInstallEvent = {
  phase: SeparatorInstallPhase;
  message: string;
  progress?: number;
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

/** Walk the user's stems output directory and reconstruct one job per
 *  manifest.json found. Merged with any in-memory state by the Rust
 *  side so a fresh popup process still surfaces historical runs. */
export const scanDisk = (): Promise<SeparatorJob[]> => invoke('separator_scan_disk');

/** Delete one completed/failed job — both the in-memory entry and the
 *  on-disk output directory. Active runs (queued/running) should be
 *  cancelled first via `cancel`. */
export const removeJob = (jobId: string): Promise<void> =>
  invoke('separator_remove_job', { jobId });

export const clearCompleted = (): Promise<void> => invoke('separator_clear_completed');

export type ChordSegment = {
  start: number;
  end: number;
  label: string;
};

/// Run beat-synchronous chord recognition on the given audio file.
/// The sidecar does template-matching on a CENS chromagram (no extra
/// pip deps). Best on the full input mix; results on isolated stems
/// can be noisy because drums/vocals carry little harmonic info.
export const extractChords = (inputPath: string): Promise<ChordSegment[]> =>
  invoke('separator_extract_chords', { inputPath });

/// Resolve (and lazily materialise) a small PNG used as the ghost icon
/// for drag-out. tauri-plugin-drag insists on a real filesystem path,
/// so we cache one inside APPDATA on first call.
export const dragIconPath = (): Promise<string> =>
  invoke('separator_drag_icon_path');

/** Delete one stem file from a completed job — both the .wav on disk
 *  and its `.peaks` sidecar, then drop the entry from the job manifest
 *  so the mixer lane disappears on the next render. Use for empty /
 *  silent stems demucs produces on tracks that don't contain that
 *  instrument. The backend re-emits `separator:job` with the trimmed
 *  stems map. */
export const deleteStem = (jobId: string, stemName: string): Promise<void> =>
  invoke('separator_delete_stem', { jobId, stemName });

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
 *  model emits something we don't recognise. Capitalised so a row in
 *  the stems grid reads as a proper title rather than a raw token. */
export const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other',
};

/** RGB triplets per stem — used for the accent dots / left-border on
 *  stem cards and the compact summary chips on collapsed rows. Picked
 *  for legibility on the dark theme. Falls through to `other` for
 *  anything not in the map. */
export const STEM_COLORS: Record<string, string> = {
  vocals: '236, 72, 153',
  drums: '244, 114, 22',
  bass: '139, 92, 246',
  guitar: '34, 197, 94',
  piano: '14, 165, 233',
  other: '148, 163, 184',
};

export const stemColor = (key: string): string =>
  STEM_COLORS[key.toLowerCase()] ?? STEM_COLORS.other;

/// Extract MIDI from a single stem via basic-pitch in the separator
/// venv. Returns the path of the freshly-written .mid (placed next to
/// the input stem so the user can drag-and-drop straight to Guitar Pro).
export const extractMidi = (stemPath: string): Promise<string> =>
  invoke('separator_extract_midi', { stemPath });

/// Sum a set of stems via ffmpeg amix at the supplied per-stem gains
/// into a single .wav. Gain is linear (0..1.5+); muted lanes should be
/// dropped from the array before sending. Returns the final path.
export const mixdown = (
  outPath: string,
  stems: { path: string; gain: number }[],
): Promise<string> =>
  invoke('separator_mixdown', { outPath, stems });

/// Load cached peak summary written next to the stem by a previous
/// session. Returns null on cache miss / stale cache so the caller
/// computes a fresh one.
export const readPeaks = (stemPath: string): Promise<Float32Array | null> =>
  invoke<number[] | null>('separator_read_peaks', { stemPath }).then((p) =>
    p ? Float32Array.from(p) : null,
  );

export const writePeaks = (stemPath: string, peaks: Float32Array): Promise<void> =>
  invoke('separator_write_peaks', {
    stemPath,
    peaks: Array.from(peaks),
  });

/// Resolve a file path to a streamable http://127.0.0.1:<port>/audio?…
/// URL served by the in-process MediaServer. Used by the Stems mixer
/// to fetch stem bytes as a binary ArrayBuffer — avoids the
/// `Vec<u8>→Vec<number>→JSON→Uint8Array` round-trip the previous
/// invoke('notes_read_audio_path') path paid (≈4x byte traffic + GC
/// spikes for any non-trivial stem).
export const mediaStreamUrl = (path: string): Promise<string> =>
  invoke('media_stream_url', { path });
