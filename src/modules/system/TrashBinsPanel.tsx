import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { RevealButton } from '../../shared/ui/RevealButton';
import { useToast } from '../../shared/ui/Toast';
import { emptyTrash, listTrashBins, type TrashBin } from './api';
import { formatBytes } from './format';

export const TrashBinsPanel = () => {
  const [bins, setBins] = useState<TrashBin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      setBins(await listTrashBins());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
        title: 'Кошик очищено',
        description: `Звільнено ${formatBytes(total)}`,
        variant: 'success',
      });
      refresh();
    } catch (e) {
      toast({ title: 'Не вдалося очистити', description: String(e), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [total, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(255,138,91,0.12), rgba(255,58,111,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(255,58,111,0.35), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#ff8a5b,#ff3a6f)',
              boxShadow: '0 8px 24px -8px rgba(255,58,111,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18M8 6l1-3h6l1 3M6 6l1 14h10l1-14M10 11v6M14 11v6" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Кошики</div>
            <div className="t-tertiary text-meta">
              Внутрішній і всі зовнішні томи · {totalItems.toLocaleString()} елементів
            </div>
          </div>
          <div className="text-right">
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
              Очистити всі
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && !bins && (
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        )}
        {bins && bins.length === 0 && (
          <EmptyState title="Кошик порожній" description="Нічого не знайдено на жодному томі." />
        )}
        {bins && bins.length > 0 && (
          <ul className="divide-y hair">
            {bins.map((b) => (
              <li key={b.path} className="px-4 py-2 flex items-center gap-3">
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
                <div className="min-w-0 flex-1">
                  <div className="t-primary text-body font-medium truncate">{b.volume}</div>
                  <div className="t-tertiary text-meta truncate" title={b.path}>
                    {b.path} · {b.item_count} елементів
                  </div>
                </div>
                <div className="t-primary tabular-nums font-medium shrink-0">
                  {formatBytes(b.size_bytes)}
                </div>
                <RevealButton path={b.path} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        title="Очистити всі кошики?"
        description={`Буде видалено ${totalItems} елементів (${formatBytes(total)}). Цю дію не можна скасувати.`}
        confirmLabel="Очистити"
        tone="danger"
        onConfirm={empty}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
};
