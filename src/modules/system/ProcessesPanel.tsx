import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SearchInput } from '../../shared/ui/SearchInput';
import { Button } from '../../shared/ui/Button';
import { Toggle } from '../../shared/ui/Toggle';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';
import { killProcess, listProcesses, type ProcessInfo } from './api';
import { HEAVY_RSS_BYTES, formatBytes, formatCpu } from './format';
import { usePausedInterval } from './usePausedInterval';

/// Tints the RAM bar green → yellow → red as a process grows heavier. The
/// thresholds are tuned for typical Mac RAM footprints: under 500 MB is
/// unremarkable, 1 GB starts to matter, ≥2 GB is actively expensive.
const rssColour = (bytes: number): string => {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 2) return '#ff3a6f';
  if (gb >= 1) return '#ff914d';
  if (gb >= 0.5) return '#ffd86b';
  return '#5ee2c4';
};

const REFRESH_MS = 2000;

type SortKey = 'rss' | 'cpu' | 'name';

type KillTarget = { proc: ProcessInfo; force: boolean };

export const ProcessesPanel = () => {
  const [rows, setRows] = useState<ProcessInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [heavyOnly, setHeavyOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('rss');
  const [kill, setKill] = useState<KillTarget | null>(null);
  const { toast } = useToast();
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const next = await listProcesses();
      if (!mountedRef.current) return;
      setRows(next);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  usePausedInterval(fetchOnce, REFRESH_MS);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    let list = rows;
    if (heavyOnly) list = list.filter((p) => p.rss_bytes >= HEAVY_RSS_BYTES);
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.command.toLowerCase().includes(q) ||
          String(p.pid) === q,
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sortKey === 'rss') return b.rss_bytes - a.rss_bytes;
      if (sortKey === 'cpu') return b.cpu_percent - a.cpu_percent;
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [rows, query, heavyOnly, sortKey]);

  const handleKill = useCallback(
    async (target: KillTarget) => {
      setKill(null);
      try {
        await killProcess(target.proc.pid, target.force);
        toast({
          title: target.force ? 'Process force-quit' : 'Quit signal sent',
          description: `${target.proc.name} (PID ${target.proc.pid})`,
          variant: 'success',
        });
        fetchOnce();
      } catch (e) {
        toast({
          title: 'Failed to quit process',
          description: String(e),
          variant: 'error',
        });
      }
    },
    [fetchOnce, toast],
  );

  const heavyCount = rows?.filter((p) => p.rss_bytes >= HEAVY_RSS_BYTES).length ?? 0;

  // Virtualize the rows so a 500-process list doesn't force React to
  // reconcile 500 table rows every 2 s. @tanstack/react-virtual renders
  // only what fits in the scroll viewport + a small overscan window.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ROW_HEIGHT = 44;
  const rowCount = filtered?.length ?? 0;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // jsdom never fires ResizeObserver, which leaves the virtualizer with
    // an empty viewport and zero rendered rows in tests. Wrap the default
    // observer so we publish an initial rect from `clientWidth/Height`
    // synchronously — real browsers still get live updates via the
    // ResizeObserver subscription below, tests get a stable 600×600 from
    // setup.ts's clientHeight stub.
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

  return (
    <div className="flex flex-col h-full min-h-0">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Filter by name, command, or PID"
        compact
        trailing={
          <div className="flex items-center gap-2 pr-1">
            <label className="flex items-center gap-1.5 t-secondary text-meta select-none cursor-pointer">
              <span>≥500 MB</span>
              <Toggle
                checked={heavyOnly}
                onChange={setHeavyOnly}
                label="Show only heavy processes"
              />
            </label>
          </div>
        }
      />

      <div className="flex items-center justify-between px-3 py-1.5 border-b hair t-secondary text-meta">
        <div className="flex items-center gap-2">
          <span>
            Sort:
          </span>
          {(['rss', 'cpu', 'name'] as const).map((k) => {
            const active = sortKey === k;
            const label = k === 'rss' ? 'RAM' : k === 'cpu' ? 'CPU' : 'Name';
            const arrow = k === 'name' ? '↑' : '↓';
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setSortKey(k)}
                className={`px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${active ? 't-primary font-medium' : 't-tertiary hover:t-secondary'}`}
              >
                {label}
                {active && <span aria-hidden className="text-[10px]">{arrow}</span>}
              </button>
            );
          })}
        </div>
        <div>
          {rows ? `${heavyCount} heavy / ${rows.length} total` : 'Loading…'}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {error && (
          <div className="p-4 t-danger text-body">Error: {error}</div>
        )}
        {!error && rows === null && (
          <div className="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        )}
        {!error && filtered && filtered.length === 0 && (
          <EmptyState
            title={heavyOnly ? 'No heavy processes found' : 'Nothing found'}
            description={
              heavyOnly
                ? 'No process currently exceeds 500 MB RAM.'
                : 'Try adjusting the filter.'
            }
          />
        )}
        {!error && filtered && filtered.length > 0 && (
          <>
            {/* Header row — kept outside the virtualizer so it stays pinned
                regardless of scroll position. Grid template matches the
                rows below so columns align. */}
            <div
              className="grid border-b hair px-0 py-1.5 t-tertiary text-meta"
              style={{ gridTemplateColumns: '1fr 90px 60px 70px 140px' }}
              role="row"
            >
              <div className="px-3">Process</div>
              <div className="px-2 text-right">RAM</div>
              <div className="px-2 text-right">CPU</div>
              <div className="px-2">PID</div>
              <div />
            </div>
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-auto"
              role="table"
              aria-rowcount={rowCount}
            >
              <div
                style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              >
                {virtualRows.map((vrow) => {
                  const p = filtered[vrow.index];
                  return (
                    <div
                      key={p.pid}
                      role="row"
                      className="grid items-center border-t hair hover:bg-[var(--color-surface-hover)] text-meta absolute inset-x-0"
                      style={{
                        gridTemplateColumns: '1fr 90px 60px 70px 140px',
                        transform: `translateY(${vrow.start}px)`,
                        height: ROW_HEIGHT,
                      }}
                    >
                      <div className="px-3 min-w-0">
                        <div className="t-primary font-medium truncate" title={p.command}>
                          {p.name}
                        </div>
                        <div className="t-tertiary text-meta truncate" title={p.command}>
                          {p.user}
                        </div>
                      </div>
                      <div className="px-2 text-right tabular-nums">
                        <span
                          className="inline-flex items-center gap-1.5 t-primary"
                          title={`${(p.rss_bytes / (1024 * 1024)).toFixed(1)} MB`}
                        >
                          <span
                            aria-hidden
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{
                              background: rssColour(p.rss_bytes),
                              boxShadow: `0 0 6px ${rssColour(p.rss_bytes)}99`,
                            }}
                          />
                          {formatBytes(p.rss_bytes)}
                        </span>
                      </div>
                      <div className="px-2 text-right tabular-nums t-secondary">
                        {formatCpu(p.cpu_percent)}
                      </div>
                      <div className="px-2 tabular-nums t-tertiary">{p.pid}</div>
                      <div className="px-2 flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setKill({ proc: p, force: false })}
                          title="Send SIGTERM (graceful quit)"
                        >
                          Quit
                        </Button>
                        <Button
                          size="sm"
                          variant="soft"
                          tone="danger"
                          onClick={() => setKill({ proc: p, force: true })}
                          title="Send SIGKILL (force)"
                        >
                          Force
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
        open={kill !== null}
        title={kill?.force ? 'Force quit process?' : 'Quit process?'}
        description={
          kill
            ? `${kill.proc.name} (PID ${kill.proc.pid})\n${
                kill.force
                  ? 'SIGKILL will terminate the process immediately, without saving state.'
                  : 'SIGTERM lets the app quit gracefully.'
              }`
            : undefined
        }
        confirmLabel={kill?.force ? 'Force quit' : 'Quit'}
        tone="danger"
        onConfirm={() => kill && handleKill(kill)}
        onCancel={() => setKill(null)}
      />
    </div>
  );
};
