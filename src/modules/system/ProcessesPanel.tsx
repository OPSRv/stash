import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchInput } from '../../shared/ui/SearchInput';
import { Button } from '../../shared/ui/Button';
import { Toggle } from '../../shared/ui/Toggle';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';
import { killProcess, listProcesses, type ProcessInfo } from './api';
import { HEAVY_RSS_BYTES, formatBytes, formatCpu } from './format';

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
    fetchOnce();
    const id = window.setInterval(fetchOnce, REFRESH_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, [fetchOnce]);

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
          title: target.force ? 'Процес примусово завершено' : 'Сигнал завершення надіслано',
          description: `${target.proc.name} (PID ${target.proc.pid})`,
          variant: 'success',
        });
        fetchOnce();
      } catch (e) {
        toast({
          title: 'Не вдалося завершити процес',
          description: String(e),
          variant: 'error',
        });
      }
    },
    [fetchOnce, toast],
  );

  const heavyCount = rows?.filter((p) => p.rss_bytes >= HEAVY_RSS_BYTES).length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Фільтр за назвою, командою або PID"
        compact
        trailing={
          <div className="flex items-center gap-2 pr-1">
            <label className="flex items-center gap-1.5 t-secondary text-meta select-none cursor-pointer">
              <span>≥500 MB</span>
              <Toggle
                checked={heavyOnly}
                onChange={setHeavyOnly}
                label="Показувати лише важкі процеси"
              />
            </label>
          </div>
        }
      />

      <div className="flex items-center justify-between px-3 py-1.5 border-b hair t-secondary text-meta">
        <div className="flex items-center gap-2">
          <span>
            Сортування:
          </span>
          {(['rss', 'cpu', 'name'] as const).map((k) => {
            const active = sortKey === k;
            const label = k === 'rss' ? 'RAM' : k === 'cpu' ? 'CPU' : 'Назва';
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
          {rows ? `${heavyCount} важких / ${rows.length} усього` : 'Завантаження…'}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="p-4 t-danger text-body">Помилка: {error}</div>
        )}
        {!error && rows === null && (
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        )}
        {!error && filtered && filtered.length === 0 && (
          <EmptyState
            title={heavyOnly ? 'Важких процесів не знайдено' : 'Нічого не знайдено'}
            description={
              heavyOnly
                ? 'Зараз жоден процес не перевищує 500 MB RAM.'
                : 'Спробуйте змінити фільтр.'
            }
          />
        )}
        {!error && filtered && filtered.length > 0 && (
          <table className="w-full text-meta" role="table">
            <thead className="sticky top-0 z-[1]" style={{ background: 'var(--color-surface)' }}>
              <tr className="t-tertiary">
                <th className="text-left font-normal px-3 py-1.5">Процес</th>
                <th className="text-right font-normal px-2 py-1.5 w-[80px]">RAM</th>
                <th className="text-right font-normal px-2 py-1.5 w-[60px]">CPU</th>
                <th className="text-left font-normal px-2 py-1.5 w-[80px]">PID</th>
                <th className="px-2 py-1.5 w-[130px]" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.pid}
                  className="border-t hair hover:bg-[var(--color-surface-hover)]"
                >
                  <td className="px-3 py-1.5 t-primary">
                    <div className="font-medium truncate max-w-[260px]" title={p.command}>
                      {p.name}
                    </div>
                    <div className="t-tertiary text-[11px] truncate max-w-[260px]" title={p.command}>
                      {p.user}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums t-primary">
                    {formatBytes(p.rss_bytes)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums t-secondary">
                    {formatCpu(p.cpu_percent)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums t-tertiary">{p.pid}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setKill({ proc: p, force: false })}
                        title="Надіслати SIGTERM (чемне завершення)"
                      >
                        Завершити
                      </Button>
                      <Button
                        size="sm"
                        variant="soft"
                        tone="danger"
                        onClick={() => setKill({ proc: p, force: true })}
                        title="Надіслати SIGKILL (примусово)"
                      >
                        Force
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={kill !== null}
        title={kill?.force ? 'Примусово завершити процес?' : 'Завершити процес?'}
        description={
          kill
            ? `${kill.proc.name} (PID ${kill.proc.pid})\n${
                kill.force
                  ? 'SIGKILL завершить процес миттєво, без збереження стану.'
                  : 'SIGTERM дозволить застосунку коректно завершити роботу.'
              }`
            : undefined
        }
        confirmLabel={kill?.force ? 'Force quit' : 'Завершити'}
        tone="danger"
        onConfirm={() => kill && handleKill(kill)}
        onCancel={() => setKill(null)}
      />
    </div>
  );
};
