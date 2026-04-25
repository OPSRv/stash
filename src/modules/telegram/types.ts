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
  /// When true the assistant runs on every voice-note transcript.
  /// Default `true` — matches the original behaviour.
  reply_on_voice: boolean;
  /// When true voice/video/video_note transcripts are routed through
  /// the speaker-diarization pipeline before storage. Default `false`
  /// — the model pair downloads on first opt-in.
  diarization_enabled: boolean;
};

/// Status of the on-disk diarization model pair.
export type DiarModelStatus = {
  kind: 'segmentation' | 'embedding';
  label: string;
  size_bytes: number;
  downloaded: boolean;
  local_path: string | null;
};

export type DiarStatus = {
  ready: boolean;
  models: DiarModelStatus[];
};

export type MemoryRow = {
  id: number;
  fact: string;
  created_at: number;
};
