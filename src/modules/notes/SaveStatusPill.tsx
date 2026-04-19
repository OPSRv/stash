export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const statusLabel: Record<Exclude<SaveStatus, 'idle'>, string> = {
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
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
