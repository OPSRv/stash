import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { Checkbox } from '../../shared/ui/Checkbox';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { SelectionHeader } from '../../shared/ui/SelectionHeader';
import { useToast } from '../../shared/ui/Toast';
import { useSetSelection } from '../../shared/hooks/useSetSelection';
import { listCaches, trashPath, type CacheEntry, type CacheKind } from './api';
import { formatBytes } from './format';

const KIND_TINT: Record<CacheKind, { pill: string; dot: string; label: string }> = {
  safe: { pill: 'rgba(94,226,196,0.18)', dot: '#5ee2c4', label: 'Safe' },
  regeneratable: {
    pill: 'rgba(255,216,107,0.18)',
    dot: '#ffd86b',
    label: 'Regeneratable',
  },
  browser: { pill: 'rgba(142,197,255,0.18)', dot: '#8ec5ff', label: 'Browser' },
};

export const CachesPanel = () => {
  const [caches, setCaches] = useState<CacheEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selected, size: selectedSize, toggleOne, toggleAll, clear } =
    useSetSelection<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listCaches();
      setCaches(list);
      clear();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [clear]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onToggleAll = useCallback(
    (next: boolean) => {
      if (!caches) return;
      if (next) toggleAll(caches.map((c) => c.path));
      else clear();
    },
    [caches, toggleAll, clear],
  );

  const totalSelected = useMemo(() => {
    if (!caches) return 0;
    return caches
      .filter((c) => selected.has(c.path))
      .reduce((acc, c) => acc + c.size_bytes, 0);
  }, [caches, selected]);

  const grandTotal = useMemo(
    () => (caches ?? []).reduce((acc, c) => acc + c.size_bytes, 0),
    [caches],
  );

  const clean = useCallback(async () => {
    setConfirmOpen(false);
    if (!caches) return;
    const targets = caches.filter((c) => selected.has(c.path));
    let freed = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        await trashPath(t.path);
        freed += t.size_bytes;
      } catch {
        failed += 1;
      }
    }
    if (failed === 0) {
      toast({
        title: `Freed ${formatBytes(freed)}`,
        description: `Cleaned ${targets.length} caches`,
        variant: 'success',
      });
    } else {
      toast({
        title: `Freed ${formatBytes(freed)}`,
        description: `Failed to delete ${failed} items`,
        variant: 'error',
      });
    }
    refresh();
  }, [caches, selected, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#5ee2c4', '#2aa3ff']}
        icon={
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
          </svg>
        }
        title="Caches"
        description="Dev-tooling, browser, and system caches. Deletion moves items to trash."
        trailing={
          <>
            <div className="t-primary font-semibold text-title tabular-nums">
              {formatBytes(grandTotal)}
            </div>
            <Button size="sm" variant="ghost" onClick={refresh} loading={loading}>
              Refresh
            </Button>
          </>
        }
      />

      {caches && caches.length > 0 && (
        <SelectionHeader
          total={caches.length}
          selected={selectedSize}
          onToggleAll={onToggleAll}
          separated
          trailing={
            <div className="flex items-center gap-3 t-secondary text-meta">
              <span>
                Selected{' '}
                <span className="t-primary font-medium tabular-nums">
                  {formatBytes(totalSelected)}
                </span>
              </span>
              <Button
                size="sm"
                variant="soft"
                tone="danger"
                disabled={selectedSize === 0}
                onClick={() => setConfirmOpen(true)}
              >
                Trash
              </Button>
            </div>
          }
        />
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Error: {error}</div>}
        {!error && !caches && loading && <CenterSpinner />}
        {!error && caches && caches.length === 0 && (
          <EmptyState
            title="No caches found"
            description="Your system looks clean — or Stash lacks access (Full Disk Access)."
          />
        )}
        {!error && caches && caches.length > 0 && (
          <ul className="divide-y hair">
            {caches.map((c) => {
              const tint = KIND_TINT[c.kind];
              const checked = selected.has(c.path);
              return (
                <ListItemRow
                  key={c.path}
                  selected={checked}
                  onClick={() => toggleOne(c.path)}
                  leading={
                    <span onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="sm"
                        checked={checked}
                        onChange={() => toggleOne(c.path)}
                        ariaLabel={c.label}
                      />
                    </span>
                  }
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{c.label}</span>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] t-secondary font-normal"
                        style={{ background: tint.pill }}
                      >
                        <span
                          aria-hidden
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: tint.dot }}
                        />
                        {tint.label}
                      </span>
                    </span>
                  }
                  meta={<span title={c.path}>{c.path}</span>}
                  trailing={
                    <div className="t-primary tabular-nums font-medium shrink-0">
                      {formatBytes(c.size_bytes)}
                    </div>
                  }
                />
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Clear selected caches?"
        description={`${selectedSize} items (${formatBytes(totalSelected)}) will be moved to trash. Apps will regenerate these files on next launch.`}
        confirmLabel="Trash"
        tone="danger"
        onConfirm={clean}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
