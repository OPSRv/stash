export type ConnectionStatus =
  | { kind: 'no_token' }
  | { kind: 'token_only' }
  | { kind: 'pairing'; code: string; expires_at: number }
  | { kind: 'paired'; chat_id: number };

export type InboxKind =
  | 'text'
  | 'voice'
  | 'photo'
  | 'document'
  | 'video'
  | 'video_note'
  | 'sticker';

export type InboxItem = {
  id: number;
  telegram_message_id: number;
  kind: InboxKind;
  text_content: string | null;
  file_path: string | null;
  mime_type: string | null;
  duration_sec: number | null;
  transcript: string | null;
  caption: string | null;
  received_at: number;
  routed_to: string | null;
};

export type RouteTarget = 'notes' | 'clipboard';

export type NotificationSettings = {
  pomodoro: boolean;
  download_complete: boolean;
  battery_low: boolean;
  calendar: boolean;
  calendar_lead_minutes: number;
  battery_threshold_pct: number;
};

export type AiSettings = {
  system_prompt: string;
  context_window: number;
  /// When true voice/video/video_note transcripts are routed through
  /// the speaker-diarization pipeline before storage. Default `false`
  /// — the model pair downloads on first opt-in.
  diarization_enabled: boolean;
};

/// Status of one downloadable diarization asset. Five total: two
/// ONNX models, the `stash-diarize` sidecar binary, and two dylibs
/// (sherpa-onnx + ONNX Runtime). The sidecar trio used to ship inside
/// the bundle; pulling them out shaves ~56 MB off the .app and gates
/// diarization behind an explicit opt-in install.
export type DiarAssetStatus = {
  kind: 'segmentation' | 'embedding' | 'sidecar' | 'sherpalib' | 'onnxlib';
  label: string;
  size_bytes: number;
  downloaded: boolean;
  local_path: string | null;
};

export type DiarStatus = {
  ready: boolean;
  assets: DiarAssetStatus[];
};

/// User-tunable inbox storage caps. Both fields are megabytes; the
/// backend clamps against `[1, 2048]` for per-file and `[10, 10240]`
/// for per-day on save, so the UI doesn't have to police the bounds.
export type InboxLimits = {
  per_file_mb: number;
  per_day_mb: number;
  /// Days kept on disk before the retention sweeper drops the row +
  /// file. `0` disables auto-deletion.
  retention_days: number;
};

export type MemoryRow = {
  id: number;
  fact: string;
  created_at: number;
};
