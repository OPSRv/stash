import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { SearchInput } from '../../shared/ui/SearchInput';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import {
  findLeftovers,
  listApps,
  trashPath,
  type Application,
  type Leftover,
} from './api';
import { formatBytes } from './format';

export const UninstallerPanel = () => {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Application | null>(null);
  const [leftovers, setLeftovers] = useState<Leftover[] | null>(null);
  const [leftoversLoading, setLeftoversLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    listApps().then(setApps).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLeftovers(null);
    setLeftoversLoading(true);
    findLeftovers(selected.bundle_id, selected.name)
      .then(setLeftovers)
      .catch(() => setLeftovers([]))
      .finally(() => setLeftoversLoading(false));
  }, [selected]);

  const filtered = useMemo(() => {
    if (!apps) return null;
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.bundle_id ?? '').toLowerCase().includes(q),
    );
  }, [apps, query]);

  const leftoversSize = useMemo(
    () => (leftovers ?? []).reduce((acc, l) => acc + l.size_bytes, 0),
    [leftovers],
  );

  const handleUninstall = useCallback(async () => {
    if (!selected) return;
    setConfirmOpen(false);
    setUninstalling(true);
    let failed = 0;
    let freed = selected.size_bytes;
    try {
      await trashPath(selected.path);
    } catch {
      failed += 1;
      freed -= selected.size_bytes;
    }
    for (const l of leftovers ?? []) {
      try {
        await trashPath(l.path);
        freed += l.size_bytes;
      } catch {
        failed += 1;
      }
    }
    setUninstalling(false);
    if (failed === 0) {
      toast({
        title: 'Застосунок видалено',
        description: `${selected.name} · звільнено ${formatBytes(freed)}`,
        variant: 'success',
      });
    } else {
      toast({
        title: `Частково видалено (${failed} помилок)`,
        description: `${selected.name} · звільнено ${formatBytes(freed)}`,
        variant: 'error',
      });
    }
    // Reload both the apps list and reset selection.
    setSelected(null);
    setLeftovers(null);
    listApps().then(setApps).catch(() => undefined);
  }, [selected, leftovers, toast]);

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-1/2 min-w-0 border-r hair flex flex-col">
        <header
          className="px-4 py-3 relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, rgba(208,140,255,0.12), rgba(122,75,255,0.18))',
            boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
          }}
        >
          <div
            aria-hidden
            className="absolute -top-10 -right-4 w-32 h-32 rounded-full"
            style={{
              background: 'radial-gradient(closest-side, rgba(122,75,255,0.4), transparent)',
              filter: 'blur(10px)',
            }}
          />
          <div className="relative flex items-center gap-3">
            <div
              aria-hidden
              className="w-10 h-10 rounded-xl inline-flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg,#d08cff,#7a4bff)',
                boxShadow: '0 6px 18px -6px rgba(122,75,255,0.5), inset 0 0 0 1px rgba(255,255,255,0.18)',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 7V4h6v3M5 7h14l-1 13H6z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="t-primary text-body font-semibold">Застосунки</div>
              <div className="t-tertiary text-meta">
                {apps ? `${apps.length} знайдено` : 'Завантаження…'}
              </div>
            </div>
          </div>
        </header>
        <SearchInput
          compact
          value={query}
          onChange={setQuery}
          placeholder="Пошук за назвою або bundle id"
        />
        <div className="flex-1 min-h-0 overflow-auto">
          {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
          {!error && !apps && (
            <div className="flex items-center justify-center py-6">
              <Spinner />
            </div>
          )}
          {filtered && filtered.length === 0 && (
            <EmptyState title="Нічого не знайдено" />
          )}
          <ul>
            {(filtered ?? []).map((a) => {
              const active = selected?.path === a.path;
              return (
                <li key={a.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(a)}
                    className={`w-full text-left px-4 py-1.5 flex items-center gap-2 ${
                      active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="t-primary text-body font-medium truncate">
                        {a.name}
                      </div>
                      <div className="t-tertiary text-meta truncate">
                        {a.bundle_id ?? a.path}
                      </div>
                    </div>
                    <div className="t-secondary tabular-nums text-meta shrink-0">
                      {formatBytes(a.size_bytes)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {!selected ? (
          <EmptyState
            title="Оберіть застосунок"
            description="У правій панелі ви побачите його залишки по всіх Library/ локаціях."
          />
        ) : (
          <>
            <div className="px-4 py-3 border-b hair">
              <div className="t-primary text-title font-semibold">{selected.name}</div>
              <div className="t-tertiary text-meta truncate">
                {selected.bundle_id ?? selected.path}
              </div>
              <div className="mt-2 flex items-center gap-4">
                <div>
                  <div className="t-tertiary text-[10px] uppercase tracking-wider">App</div>
                  <div className="t-primary tabular-nums font-medium">
                    {formatBytes(selected.size_bytes)}
                  </div>
                </div>
                <div>
                  <div className="t-tertiary text-[10px] uppercase tracking-wider">
                    Залишки
                  </div>
                  <div className="t-primary tabular-nums font-medium">
                    {leftovers ? formatBytes(leftoversSize) : '…'}
                  </div>
                </div>
                <div>
                  <div className="t-tertiary text-[10px] uppercase tracking-wider">
                    Всього
                  </div>
                  <div className="t-primary tabular-nums font-medium">
                    {leftovers ? formatBytes(selected.size_bytes + leftoversSize) : '…'}
                  </div>
                </div>
                <div className="flex-1" />
                <Button
                  tone="danger"
                  variant="solid"
                  size="sm"
                  loading={uninstalling}
                  onClick={() => setConfirmOpen(true)}
                >
                  Деінсталювати
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <div className="px-4 py-1.5 t-tertiary text-meta uppercase tracking-wider border-b hair">
                Знайдені залишки
              </div>
              {leftoversLoading && (
                <div className="flex items-center justify-center py-4">
                  <Spinner />
                </div>
              )}
              {!leftoversLoading && leftovers && leftovers.length === 0 && (
                <div className="p-4 t-tertiary text-meta">
                  Залишки не знайдено — застосунок чистий.
                </div>
              )}
              {leftovers && leftovers.length > 0 && (
                <ul className="divide-y hair">
                  {leftovers.map((l) => (
                    <li key={l.path} className="px-4 py-1.5 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="t-secondary text-meta truncate" title={l.path}>
                          {l.path}
                        </div>
                      </div>
                      <div className="t-primary tabular-nums text-meta shrink-0">
                        {formatBytes(l.size_bytes)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Видалити застосунок і залишки?"
        description={
          selected
            ? `${selected.name} (${formatBytes(selected.size_bytes + leftoversSize)}) буде переміщено у кошик. Ви зможете відновити його з кошика macOS.`
            : undefined
        }
        confirmLabel="Деінсталювати"
        tone="danger"
        onConfirm={handleUninstall}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
