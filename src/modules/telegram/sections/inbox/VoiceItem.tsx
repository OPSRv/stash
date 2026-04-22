import { useEffect, useState } from 'react';

import { AudioPlayer } from '../../../../shared/ui/AudioPlayer';
import { Spinner } from '../../../../shared/ui/Spinner';

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
/// the actual playback UI to the app-wide player.
export const VoiceItem = ({
  filePath,
  durationSec,
  transcript,
  transcribing,
  failed,
  onRetry,
  onEditTranscript,
}: VoiceItemProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(transcript ?? '');
  useEffect(() => {
    if (!editing) setDraft(transcript ?? '');
  }, [transcript, editing]);

  return (
    <div className="flex flex-col gap-2">
      <AudioPlayer src={filePath} durationHint={durationSec} />
      {transcribing && (
        <div
          className="text-[11px] text-white/60 flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <Spinner size={12} />
          Транскрибую…
        </div>
      )}
      {!transcribing && failed && !transcript && (
        <div className="flex items-center gap-2 text-[11px] text-amber-300/80">
          <span>⚠ Не вдалося транскрибувати</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-amber-200/90 hover:text-amber-100 underline decoration-dotted underline-offset-2"
            >
              Спробувати ще раз
            </button>
          )}
        </div>
      )}
      {transcript && !editing && (
        <div className="flex items-start gap-2 group/transcript">
          <p
            className="flex-1 text-[13px] leading-[18px] text-white/90 whitespace-pre-wrap bg-white/3 rounded-md px-3 py-2 border border-white/5"
            onDoubleClick={() => onEditTranscript && setEditing(true)}
            title={onEditTranscript ? 'Double-click to edit' : undefined}
          >
            {transcript}
          </p>
          {onEditTranscript && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit transcript"
              className="opacity-0 group-hover/transcript:opacity-100 focus:opacity-100 mt-1 text-[11px] text-white/50 hover:text-white/90 transition-opacity"
            >
              edit
            </button>
          )}
        </div>
      )}
      {transcript && editing && onEditTranscript && (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="text-[13px] leading-[18px] text-white/90 bg-white/3 rounded-md px-3 py-2 border border-white/10 focus:border-[rgba(var(--stash-accent-rgb),0.4)] outline-none min-h-[72px] font-sans resize-y"
            aria-label="Edit transcript"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded bg-[rgba(var(--stash-accent-rgb),0.15)] hover:bg-[rgba(var(--stash-accent-rgb),0.25)] text-[rgb(var(--stash-accent-rgb))]"
              onClick={async () => {
                await onEditTranscript(draft);
                setEditing(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded text-white/60 hover:text-white/90"
              onClick={() => {
                setDraft(transcript);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
