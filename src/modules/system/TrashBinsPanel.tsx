import { useCallback, useMemo, useState } from 'react';
import { useAsync } from '../../shared/hooks/useAsync';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { RevealButton } from '../../shared/ui/RevealButton';
import { useToast } from '../../shared/ui/Toast';
import { emptyTrash, listTrashBins } from './api';
import { formatBytes } from './format';

export const TrashBinsPanel = () => {
  const { data: bins, error, reload: refresh } = useAsync(listTrashBins);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const total = useMemo(
    () => (bins ?? []).reduce((acc, b) => acc + b.size_bytes, 0),
    [bins],
  );
  const totalItems = useMemo(
    () => (bins ?? []).reduce((acc, b) => acc + b.item_count, 0),
    [bins],
  );

  const empty = useCallback(async () => {
    setConfirm(false);
    setBusy(true);
    try {
      await emptyTrash();
      toast({
        title: 'Trash emptied',
        description: `Freed ${formatBytes(total)}`,
        variant: 'success',
      });
      refresh();
    } catch (e) {
      toast({ title: 'Failed to empty', description: String(e), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [total, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#ff8a5b', '#ff3a6f']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18M8 6l1-3h6l1 3M6 6l1 14h10l1-14M10 11v6M14 11v6" />
          </svg>
        }
        title="Trash bins"
        description={`Internal and all external volumes · ${totalItems.toLocaleString()} items`}
        trailing={
          <>
            <div className="t-primary tabular-nums text-title font-semibold">
              {formatBytes(total)}
            </div>
            <Button
              size="sm"
              variant="solid"
              tone="danger"
              loading={busy}
              disabled={total === 0}
              onClick={() => setConfirm(true)}
            >
              Empty all
            </Button>
          </>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Error: {error}</div>}
        {!error && !bins && <CenterSpinner />}
        {bins && bins.length === 0 && (
          <EmptyState title="Trash is empty" description="Nothing found on any volume." />
        )}
        {bins && bins.length > 0 && (
          <ul className="divide-y hair">
            {bins.map((b) => (
              <ListItemRow
                key={b.path}
                leading={
                  <div
                    aria-hidden
                    className="w-8 h-8 rounded-lg inline-flex items-center justify-center"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255,138,91,0.25), rgba(255,58,111,0.35))',
                      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)',
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff8080" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18M6 6l1 14h10l1-14" />
                    </svg>
                  </div>
                }
                title={b.volume}
                meta={
                  <span title={b.path}>
                    {b.path} · {b.item_count} items
                  </span>
                }
                trailing={
                  <>
                    <div className="t-primary tabular-nums font-medium shrink-0">
                      {formatBytes(b.size_bytes)}
                    </div>
                    <RevealButton path={b.path} />
                  </>
                }
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        title="Empty all trash bins?"
        description={`${totalItems} items (${formatBytes(total)}) will be permanently deleted. This action cannot be undone.`}
        confirmLabel="Empty"
        tone="danger"
        onConfirm={empty}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
};
