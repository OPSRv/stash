import { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../shared/ui/Button';
import { SearchInput } from '../../shared/ui/SearchInput';
import { Spinner } from '../../shared/ui/Spinner';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { listConnections, killProcess, type NetConnection } from './api';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { usePausedInterval } from './usePausedInterval';

export const NetworkPanel = () => {
  const [rows, setRows] = useState<NetConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [killing, setKilling] = useState<NetConnection | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(() => {
    listConnections().then(setRows).catch((e) => setError(String(e)));
  }, []);

  usePausedInterval(refresh, 5000);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.process.toLowerCase().includes(q) ||
        r.local.toLowerCase().includes(q) ||
        r.remote.toLowerCase().includes(q) ||
        r.state.toLowerCase().includes(q) ||
        String(r.pid) === q,
    );
  }, [rows, query]);

  // Virtualise — active connection counts easily go 300+ on a busy browser
  // session. Rendering that every 5 s is noticeable.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 36;
  const rowCount = filtered?.length ?? 0;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    // See ProcessesPanel: wrap the default rect observer so jsdom (where
    // ResizeObserver never fires) still sees a non-zero viewport.
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement as HTMLElement | null;
      if (el) cb({ width: el.clientWidth, height: el.clientHeight });
      if (typeof ResizeObserver === 'undefined' || !el) return () => undefined;
      const ro = new ResizeObserver(() => {
        cb({ width: el.clientWidth, height: el.clientHeight });
      });
      ro.observe(el);
      return () => ro.disconnect();
    },
  });
  const virtualRows = virtualizer.getVirtualItems();

  const confirmKill = useCallback(async () => {
    if (!killing) return;
    const pid = killing.pid;
    const name = killing.process;
    setKilling(null);
    try {
      await killProcess(pid, true);
      toast({ title: 'Процес завершено', description: `${name} (${pid})`, variant: 'success' });
      refresh();
    } catch (e) {
      toast({ title: 'Помилка', description: String(e), variant: 'error' });
    }
  }, [killing, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(94,226,196,0.12), rgba(42,163,255,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(42,163,255,0.35), transparent)',
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
              <path d="M5 12a14 14 0 0 1 14 0M3 8a20 20 0 0 1 18 0M7 16a8 8 0 0 1 10 0" />
              <circle cx="12" cy="20" r="1.2" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Мережа</div>
            <div className="t-tertiary text-meta">
              Усі TCP/UDP-зʼєднання · {rows ? `${rows.length}` : '…'} активних · оновлення 5 с
            </div>
          </div>
        </div>
      </header>

      <SearchInput
        compact
        value={query}
        onChange={setQuery}
        placeholder="Пошук за процесом, адресою, PID, станом"
      />

      <div className="flex-1 min-h-0 flex flex-col">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && !rows && <div className="flex items-center justify-center py-6"><Spinner /></div>}
        {filtered && filtered.length === 0 && <EmptyState title="Нічого не знайдено" />}
        {filtered && filtered.length > 0 && (
          <>
            <div
              className="grid border-b hair py-1.5 t-tertiary text-meta"
              style={{
                gridTemplateColumns: '1fr 70px 60px 1fr 1fr 110px 80px',
              }}
              role="row"
            >
              <div className="px-3">Процес</div>
              <div className="px-2">PID</div>
              <div className="px-2">Proto</div>
              <div className="px-2">Локальна</div>
              <div className="px-2">Віддалена</div>
              <div className="px-2">Стан</div>
              <div />
            </div>
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-auto"
              role="table"
              aria-rowcount={rowCount}
            >
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualRows.map((vrow) => {
                  const r = filtered[vrow.index];
                  return (
                    <div
                      key={`${r.pid}-${r.local}-${r.remote}-${vrow.index}`}
                      role="row"
                      className="grid items-center border-t hair hover:bg-white/[0.03] text-meta absolute inset-x-0"
                      style={{
                        gridTemplateColumns: '1fr 70px 60px 1fr 1fr 110px 80px',
                        transform: `translateY(${vrow.start}px)`,
                        height: ROW_HEIGHT,
                      }}
                    >
                      <div className="px-3 t-primary truncate">{r.process}</div>
                      <div className="px-2 tabular-nums t-tertiary">{r.pid}</div>
                      <div className="px-2 t-secondary">{r.protocol}</div>
                      <div className="px-2 t-secondary truncate" title={r.local}>{r.local}</div>
                      <div className="px-2 t-secondary truncate" title={r.remote}>{r.remote || '—'}</div>
                      <div className="px-2 t-tertiary truncate">{r.state || '—'}</div>
                      <div className="px-2 flex items-center justify-end">
                        <Button
                          size="sm"
                          variant="soft"
                          tone="danger"
                          onClick={() => setKilling(r)}
                          disabled={r.pid <= 1}
                          title="Завершити процес"
                        >
                          Kill
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={killing !== null}
        title="Завершити процес?"
        description={
          killing
            ? `${killing.process} (PID ${killing.pid}) — SIGKILL. Активні зʼєднання розірвуться.`
            : undefined
        }
        confirmLabel="Force quit"
        tone="danger"
        onConfirm={confirmKill}
        onCancel={() => setKilling(null)}
      />
    </div>
  );
};
