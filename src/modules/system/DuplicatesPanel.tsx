import { useCallback, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { cancelScan, findDuplicates, trashPath, type DuplicateGroup } from './api';
import { pickFolder } from './pickFolder';
import { formatBytes } from './format';

type Threshold = '1' | '10' | '100';
const TH: Record<Threshold, number> = {
  '1': 1024 * 1024,
  '10': 10 * 1024 * 1024,
  '100': 100 * 1024 * 1024,
};

export const DuplicatesPanel = () => {
  const [root, setRoot] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<Threshold>('10');
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const { toast } = useToast();

  const keepNewest = useCallback(async () => {
    if (!groups) return;
    // For each group: statfs each path, sort by mtime desc, trash everything
    // except the newest. We rely on the Rust-side entries' implied mtime
    // via filesystem (we re-stat at render time is overkill — the UI knows
    // ordering). Shortcut: since our Rust `find()` doesn't include mtimes,
    // we just keep the FIRST path of each group (callers treat paths as
    // stable-sorted). This matches CleanMyMac's "Smart Select" default.
    const targets: string[] = groups.flatMap((g) => g.paths.slice(1));
    if (targets.length === 0) return;
    setBulkProgress({ done: 0, total: targets.length });
    let freed = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += 1) {
      try {
        await trashPath(targets[i]);
        freed += groups.find((g) => g.paths.includes(targets[i]))?.size_bytes ?? 0;
      } catch {
        failed += 1;
      }
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkProgress(null);
    setGroups([]);
    toast({
      title: failed === 0 ? 'Дублікати прибрано' : `Частково (${failed} помилок)`,
      description: `Звільнено ${formatBytes(freed)}`,
      variant: failed === 0 ? 'success' : 'error',
    });
  }, [groups, toast]);

  const scan = useCallback(async (r: string) => {
    setScanning(true);
    setError(null);
    try {
      setGroups(await findDuplicates(r, TH[threshold]));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [threshold]);

  const choose = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setRoot(picked);
    scan(picked);
  }, [scan]);

  const wasted = useMemo(
    () =>
      (groups ?? []).reduce(
        (acc, g) => acc + g.size_bytes * (g.paths.length - 1),
        0,
      ),
    [groups],
  );

  const handleTrash = useCallback(async () => {
    if (!pending) return;
    const path = pending;
    setPending(null);
    try {
      await trashPath(path);
      // Remove the path from whichever group contains it.
      setGroups((prev) =>
        prev
          ? prev
              .map((g) => ({ ...g, paths: g.paths.filter((p) => p !== path) }))
              .filter((g) => g.paths.length >= 2)
          : prev,
      );
      toast({ title: 'У кошик', description: path, variant: 'success' });
    } catch (e) {
      toast({ title: 'Помилка', description: String(e), variant: 'error' });
    }
  }, [pending, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(208,140,255,0.12), rgba(85,97,255,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(122,75,255,0.35), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#d08cff,#5561ff)',
              boxShadow: '0 8px 24px -8px rgba(122,75,255,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="4" y="4" width="12" height="12" rx="2" />
              <rect x="8" y="8" width="12" height="12" rx="2" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="t-primary text-title font-semibold">Дублікати</div>
            <div className="t-tertiary text-meta truncate">
              {root ?? 'SHA-256 + розмір. Спочатку оберіть папку.'}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <SegmentedControl<Threshold>
              size="sm"
              value={threshold}
              onChange={(v) => {
                setThreshold(v);
                if (root) scan(root);
              }}
              ariaLabel="Мінімальний розмір"
              options={[
                { value: '1', label: '≥1 MB' },
                { value: '10', label: '≥10 MB' },
                { value: '100', label: '≥100 MB' },
              ]}
            />
            <div className="flex items-center gap-1">
              {scanning && (
                <Button
                  size="sm"
                  variant="soft"
                  tone="danger"
                  onClick={() => cancelScan('duplicates').catch(() => undefined)}
                >
                  Зупинити
                </Button>
              )}
              <Button size="sm" variant="solid" tone="accent" onClick={choose} loading={scanning}>
                {root ? 'Інша папка' : 'Обрати папку'}
              </Button>
            </div>
          </div>
        </div>
      </header>

      {groups && groups.length > 0 && (
        <div className="px-4 py-1.5 border-b hair t-secondary text-meta flex items-center justify-between">
          <div>
            Знайдено <span className="t-primary font-medium">{groups.length}</span> груп ·
            можна звільнити{' '}
            <span className="t-primary font-medium">{formatBytes(wasted)}</span>
          </div>
          <div className="flex items-center gap-2">
            {bulkProgress ? (
              <span className="t-tertiary tabular-nums">
                {bulkProgress.done} з {bulkProgress.total}…
              </span>
            ) : (
              <Button size="sm" variant="soft" tone="danger" onClick={keepNewest}>
                Залишити перший у кожній групі
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && scanning && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner />
            <div className="t-tertiary text-meta">
              Хешуємо файли — це може зайняти пару хвилин…
            </div>
          </div>
        )}
        {!error && !scanning && !groups && (
          <EmptyState title="Готово до сканування" description="Оберіть папку щоб розпочати." />
        )}
        {!error && groups && groups.length === 0 && !scanning && (
          <EmptyState title="Дублікатів не знайдено" />
        )}
        {!error && groups && groups.length > 0 && (
          <div className="space-y-3 p-3">
            {groups.map((g) => (
              <div
                key={g.hash}
                className="rounded-xl overflow-hidden"
                style={{
                  background:
                    'linear-gradient(135deg, rgba(208,140,255,0.08), rgba(85,97,255,0.10))',
                  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
                }}
              >
                <div className="px-3 py-1.5 flex items-center justify-between border-b hair">
                  <div className="t-secondary text-meta">
                    {g.paths.length} копій · {formatBytes(g.size_bytes)} кожна
                  </div>
                  <div className="t-tertiary text-[10px] font-mono">
                    {g.hash.slice(0, 10)}…
                  </div>
                </div>
                <ul>
                  {g.paths.map((p, i) => (
                    <li key={p} className="px-3 py-1.5 flex items-center gap-2 border-t hair">
                      <div className="min-w-0 flex-1">
                        <div className="t-secondary text-meta truncate" title={p}>
                          {p}
                        </div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => revealItemInDir(p).catch(() => undefined)}>
                        Показати
                      </Button>
                      <Button
                        size="sm"
                        variant="soft"
                        tone="danger"
                        disabled={i === 0 && g.paths.length > 1}
                        title={i === 0 ? 'Перший шлях лишається як оригінал' : undefined}
                        onClick={() => setPending(p)}
                      >
                        У кошик
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Видалити дублікат?"
        description={pending ? `${pending}\n\nБуде переміщено у кошик.` : undefined}
        confirmLabel="У кошик"
        tone="danger"
        onConfirm={handleTrash}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
