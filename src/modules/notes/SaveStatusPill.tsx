export type SaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'error'
  | 'transcribing'
  | 'polishing';

const statusLabel: Record<Exclude<SaveStatus, 'idle'>, string> = {
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
  transcribing: 'Transcribing…',
  polishing: 'Polishing…',
};

type Props = {
  status: SaveStatus;
  /** Optional cancel handler — rendered as an inline ✕ when status is
   *  `transcribing` or `polishing`. Whisper runs can take minutes on a
   *  long recording, and users need a way out without waiting. */
  onCancel?: () => void;
};

export const SaveStatusPill = ({ status, onCancel }: Props) => {
  if (status === 'idle') return null;
  const tone = status === 'error' ? 'stash-badge--danger' : 'stash-badge--neutral';
  const cancellable = onCancel && (status === 'transcribing' || status === 'polishing');
  return (
    <span
      className={`stash-badge ${tone} ${cancellable ? 'inline-flex items-center gap-1.5' : ''}`}
      aria-live="polite"
      data-testid="notes-save-status"
    >
      {statusLabel[status]}
      {cancellable && (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel transcription"
          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-white/20 leading-none"
          style={{ fontSize: 11, lineHeight: 1 }}
          data-testid="notes-save-status-cancel"
        >
          ×
        </button>
      )}
    </span>
  );
};
