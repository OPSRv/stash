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

export const SaveStatusPill = ({ status }: { status: SaveStatus }) => {
  if (status === 'idle') return null;
  const tone = status === 'error' ? 'stash-badge--danger' : 'stash-badge--neutral';
  return (
    <span
      className={`stash-badge ${tone}`}
      aria-live="polite"
      data-testid="notes-save-status"
    >
      {statusLabel[status]}
    </span>
  );
};
