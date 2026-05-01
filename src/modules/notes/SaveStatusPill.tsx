import { IconButton } from '../../shared/ui/IconButton';

export type SaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'error'
  | 'transcribing'
  | 'polishing';

const statusLabel: Record<SaveStatus, string> = {
  idle: 'Saved',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
  transcribing: 'Transcribing…',
  polishing: 'Polishing with AI…',
};

type Props = {
  status: SaveStatus;
  /** Optional cancel handler — rendered as an inline ✕ when status is
   *  `transcribing` or `polishing`. Whisper runs can take minutes on a
   *  long recording, and users need a way out without waiting. */
  onCancel?: () => void;
};

/** Refresh-2026-04 SaveIndicator: a 6 × 6 dot + 11 px label that fades
 *  through states. Replaces the prior pill chrome (chip-with-fill).
 *
 *  - idle / saved → success-green dot
 *  - saving / transcribing / polishing → amber dot with `dot-pulse` keyframes
 *  - error → danger-red dot
 *
 *  The component name (and re-exported type) stays `SaveStatusPill` so
 *  every caller keeps working without an import sweep — the on-screen
 *  treatment is what changed, not the API surface. */
export const SaveStatusPill = ({ status, onCancel }: Props) => {
  // We render even at `idle` now — the green "Saved" indicator is the
  // bundle's resting state. Caller passes `idle` when nothing has happened
  // yet, and we collapse that into the same Saved label for visual calm.
  const cancellable = !!onCancel && (status === 'transcribing' || status === 'polishing');
  return (
    <span
      className="save-ind inline-flex items-center gap-1.5 px-1 h-5"
      data-state={status}
      aria-live="polite"
      data-testid="notes-save-status"
    >
      <span className="save-dot" aria-hidden />
      <span className="text-meta t-tertiary leading-none">{statusLabel[status]}</span>
      {cancellable && (
        <IconButton
          onClick={onCancel!}
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
