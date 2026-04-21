import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { listCaches, trashPath, type CacheEntry, type CacheKind } from './api';
import { formatBytes } from './format';

const KIND_TINT: Record<CacheKind, { pill: string; dot: string; label: string }> = {
  safe: { pill: 'rgba(94,226,196,0.18)', dot: '#5ee2c4', label: 'Безпечно' },
  regeneratable: {
    pill: 'rgba(255,216,107,0.18)',
    dot: '#ffd86b',
    label: 'Перегенерується',
  },
  browser: { pill: 'rgba(142,197,255,0.18)', dot: '#8ec5ff', label: 'Браузер' },
};

export const CachesPanel = () => {
  const [caches, setCaches] = useState<CacheEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listCaches();
      setCaches(list);
      setSelected(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleOne = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (!caches) return;
    if (selected.size === caches.length) setSelected(new Set());
    else setSelected(new Set(caches.map((c) => c.path)));
  };

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
        title: `Звільнено ${formatBytes(freed)}`,
        description: `Очищено ${targets.length} кешів`,
        variant: 'success',
      });
    } else {
      toast({
        title: `Звільнено ${formatBytes(freed)}`,
        description: `Не вдалося видалити ${failed} елементів`,
        variant: 'error',
      });
    }
    refresh();
  }, [caches, selected, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(94,226,196,0.14), rgba(42,163,255,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-12 -right-8 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(42,163,255,0.4), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#5ee2c4,#2aa3ff)',
              boxShadow: '0 8px 24px -8px rgba(42,163,255,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Кеші</div>
            <div className="t-tertiary text-meta">
              Dev-tooling, браузерні та системні кеші. Видалення переносить у кошик.
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="t-primary font-semibold text-title tabular-nums">
              {formatBytes(grandTotal)}
            </div>
            <Button size="sm" variant="ghost" onClick={refresh} loading={loading}>
              Перечитати
            </Button>
          </div>
        </div>
      </header>

      {caches && caches.length > 0 && (
        <div className="px-4 py-1.5 border-b hair flex items-center justify-between t-secondary text-meta">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={selected.size === caches.length}
              onChange={toggleAll}
              className="ring-focus"
            />
            Обрати все
          </label>
          <div className="flex items-center gap-3">
            <span>
              Обрано{' '}
              <span className="t-primary font-medium">
                {formatBytes(totalSelected)}
              </span>
            </span>
            <Button
              size="sm"
              variant="soft"
              tone="danger"
              disabled={selected.size === 0}
              onClick={() => setConfirmOpen(true)}
            >
              У кошик
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && !caches && loading && (
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        )}
        {!error && caches && caches.length === 0 && (
          <EmptyState
            title="Кешів не знайдено"
            description="Схоже, ваша система чиста — або Stash не має доступу (Full Disk Access)."
          />
        )}
        {!error && caches && caches.length > 0 && (
          <ul className="divide-y hair">
            {caches.map((c) => {
              const tint = KIND_TINT[c.kind];
              const checked = selected.has(c.path);
              return (
                <li
                  key={c.path}
                  className={`px-4 py-2 flex items-center gap-3 cursor-pointer transition-colors ${
                    checked ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
                  }`}
                  onClick={() => toggleOne(c.path)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(c.path)}
                    onClick={(e) => e.stopPropagation()}
                    className="ring-focus shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="t-primary text-body font-medium truncate">
                        {c.label}
                      </span>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] t-secondary"
                        style={{ background: tint.pill }}
                      >
                        <span
                          aria-hidden
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: tint.dot }}
                        />
                        {tint.label}
                      </span>
                    </div>
                    <div className="t-tertiary text-meta truncate" title={c.path}>
                      {c.path}
                    </div>
                  </div>
                  <div className="t-primary tabular-nums font-medium shrink-0">
                    {formatBytes(c.size_bytes)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Очистити обрані кеші?"
        description={`Буде переміщено у кошик ${selected.size} елементів (${formatBytes(totalSelected)}). Застосунки перегенерують ці файли при наступному запуску.`}
        confirmLabel="У кошик"
        tone="danger"
        onConfirm={clean}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
