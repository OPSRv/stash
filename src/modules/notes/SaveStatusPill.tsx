import { IconButton } from '../../shared/ui/IconButton';

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
        <IconButton
          onClick={onCancel}
          title="Cancel transcription"
          data-testid="notes-save-status-cancel"
          tooltipSide="bottom"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </IconButton>
      )}
    </span>
  );
};
