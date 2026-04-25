import { AudioPlayer } from '../../../../shared/ui/AudioPlayer';
import { TranscriptArea } from '../../../../shared/ui/TranscriptArea';

type VoiceItemProps = {
  filePath: string;
  durationSec: number | null;
  transcript: string | null;
  /// When true, the backend is currently running Whisper on this file.
  /// Surfaces a shimmer banner under the player so the user knows a
  /// transcript is on the way.
  transcribing: boolean;
  /// When true, Whisper rejected the audio — no transcript is coming.
  /// Rendered as a subdued warning; the audio itself still plays.
  failed?: boolean;
  /// Retry the transcription. Wired only when the backend supports it.
  onRetry?: () => void;
  /// Persist a user-edited transcript. When omitted the block becomes
  /// read-only (e.g. tests or contexts where editing isn't wired yet).
  onEditTranscript?: (next: string) => Promise<void> | void;
};

/// Inbox voice row — shared `AudioPlayer` (compact) on top, transcript
/// status + editor below. Keeps the inbox-specific transcript lifecycle
/// (transcribing / failed / retry / manual edit) here while delegating
/// the actual playback UI to the app-wide player and the transcript UI
/// to the shared `TranscriptArea` primitive.
export const VoiceItem = ({
  filePath,
  durationSec,
  transcript,
  transcribing,
  failed,
  onRetry,
  onEditTranscript,
}: VoiceItemProps) => (
  <div className="flex flex-col gap-2">
    <AudioPlayer src={filePath} durationHint={durationSec} />
    <TranscriptArea
      transcript={transcript}
      transcribing={transcribing}
      failed={failed}
      onRetry={onRetry}
      onEdit={onEditTranscript}
    />
  </div>
);
